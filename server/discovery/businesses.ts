import { audit } from '../audit.ts';
import {
  CONTACT_STATUS_LABEL,
  CONTACT_STATUS_SQL,
  DO_NOT_CONTACT_SQL,
  HAS_EMAIL_SQL,
  LAST_CONTACT_SQL,
  type ContactStatus,
} from '../crm/contactStatus.ts';
import { AI_STATE_LABEL, AI_STATE_SQL, type AiState } from '../ai/state.ts';
import type { Db, Queryable } from '../db/client.ts';
import { fold, geo } from '../geo/geo.ts';
import { primaryServices } from '../matching/store.ts';
import { bandOf, DEFAULT_AI_CONFIG } from '../ai/config.ts';
import { CLOSED_SQL, CLOSED_STAGES, type StageId } from '../crm/model.ts';
import { CATEGORIES, type CategoryId } from './categories.ts';
import { sectorById } from './sectors.ts';
import { JobError } from './jobs.ts';
import { BUSINESS_CATEGORY_LABEL, type BusinessCategoryId } from '../categories/catalog.ts';
import {
  CONTACTABILITY_LABEL,
  CONTACTABILITY_SQL,
  prioritySql,
  type Contactability,
} from '../enrichment/contactability.ts';

/*
 * Lettura delle aziende salvate (elenco, scheda con provenienza e cronologia), revisione dei possibili duplicati
 * e statistiche reali per la dashboard. Solo dati presenti nel database.
 */

/**
 * Punteggio commerciale in SQL: AI (se l'azienda non è esclusa dalle classifiche), altrimenti il punteggio a regole
 * presentabile. Un'azienda valutata come cessata o da non contattare non ha punteggio di classifica.
 */
export const COMMERCIAL_SCORE = `CASE WHEN aa.id IS NOT NULL THEN CASE WHEN aa.exclusion IS NULL THEN aa.final_score END
  WHEN ls.status IN ('ranked', 'needs_review') THEN ls.score END`;

export const SORTS = {
  name: 'b.search_name',
  municipality: 'b.municipality_name',
  category: 'b.category',
  completeness: 'b.completeness',
  verified: 'b.last_verified_at',
  discovered: 'b.first_seen_at',
  audited: 'w.last_checked_at',
  score: 'ls.score',
  confidence: 'ls.confidence',
  // corrispondenza con un servizio (Fase 5): del servizio filtrato, altrimenti la migliore proponibile
  match: 'match_score',
  // punteggio commerciale: valutazione AI, altrimenti punteggio a regole come riserva dichiarata
  commercial: `(${COMMERCIAL_SCORE})`,
  acquisition: "(aa.components->'acquisition'->>'score')::int",
  serviceFit: "(aa.components->'service_fit'->>'score')::int",
  // ultimo contatto (email accettata o attività di contatto nel CRM)
  lastContact: LAST_CONTACT_SQL,
  // «Priorità: aziende con email disponibile»: fascia di contattabilità, poi punteggio commerciale decrescente
  priority: `((${prioritySql(COMMERCIAL_SCORE)}) * 1000 - COALESCE((${COMMERCIAL_SCORE}), -1))`,
  // città (comune ISTAT, altrimenti la città dell'indirizzo)
  city: 'COALESCE(b.municipality_name, b.address_city)',
  // categoria commerciale (vista «Tutte le aziende»)
  businessCategory: 'b.primary_category',
  // stato della valutazione: prima le aziende valutate, poi quelle da aggiornare, in corso, in attesa, non riuscite
  assessment: `CASE (${AI_STATE_SQL}) WHEN 'assessed' THEN 0 WHEN 'outdated' THEN 1 WHEN 'incomplete' THEN 2
    WHEN 'running' THEN 3 WHEN 'pending' THEN 4 WHEN 'failed' THEN 5 ELSE 6 END`,
} as const;
export type SortKey = keyof typeof SORTS;

export interface BusinessFilters {
  q?: string;
  region?: string;
  province?: string;
  municipality?: string;
  categories?: CategoryId[];
  website?: 'any' | 'yes' | 'own' | 'no';
  minCompleteness?: number;
  review?: boolean;
  /** Solo le aziende viste dall'ultima esecuzione di questa ricerca. */
  job?: string;
  /** Stato dell'audit del sito (Fase 3). */
  audit?: 'audited' | 'unaudited' | 'failed' | 'unavailable' | 'no_website' | 'problems';
  /** Punteggio del lead (Fase 4): fasce A/B/C/low (solo classificati) o stati. */
  priority?: ('A' | 'B' | 'C' | 'low' | 'needs_review' | 'insufficient_data' | 'not_suitable' | 'unscored')[];
  minScore?: number;
  confidence?: ('high' | 'medium' | 'low')[];
  /** Abbinamento ai servizi (Fase 5): servizio, corrispondenza minima, stato dell'abbinamento o della revisione. */
  service?: string;
  minMatch?: number;
  matchStatus?: MatchFilterStatus[];
  /** Lead Hunter (Fase 6). */
  hunt?: string;
  sectors?: string[];
  /** Aziende escluse dal contatto: nascoste (predefinito), solo loro, oppure tutte. */
  excluded?: 'hide' | 'only' | 'include';
  /** Solo queste aziende (selezione per l'esportazione). */
  ids?: string[];
  contact?: 'phone' | 'any';
  maxPerSector?: number;
  maxPerRegion?: number;
  /** CRM (Fase 7): aziende senza opportunità aperta, con un'opportunità aperta, oppure con almeno un'opportunità. */
  crm?: 'none' | 'open' | 'any';
  /** Stato di contatto (server/crm/contactStatus.ts), uno o più. */
  contactStatus?: ContactStatus[];
  /** Email generica pubblica disponibile (yes) o assente (no). */
  email?: 'yes' | 'no';
  /** Categoria commerciale (server/categories/catalog.ts); 'pending' = non ancora classificate. */
  businessCategory?: BusinessCategoryId | 'pending';
  /** Solo le aziende con la categoria da verificare. */
  categoryReview?: boolean;
  /** Contattabilità via email (server/enrichment/contactability.ts), una o più. */
  contactability?: Contactability[];
  /** Solo le aziende con un divieto di contatto (true) o senza (false). */
  doNotContact?: boolean;
  /** Anche le aziende unite a un'altra (solo per le opportunità del CRM, che restano visibili). */
  includeMerged?: boolean;
  /** Punteggio commerciale (AI o riserva a regole) in un intervallo, es. una fascia. */
  minCommercial?: number;
  maxCommercial?: number;
  /** Stato della valutazione AI. */
  aiStatus?: 'assessed' | 'not_assessed' | 'needs_review' | 'failed' | 'excluded' | AiStateFilter;
  aiConfidence?: ('high' | 'medium' | 'low')[];
  minAcquisition?: number;
  minServiceFit?: number;
  sort: SortKey;
  dir: 'asc' | 'desc';
  page: number;
  pageSize: number;
}

/** Filtri sugli stati della valutazione (prefisso per non confondersi con i filtri storici). */
export const AI_STATE_FILTERS = [
  'state_pending',
  'state_running',
  'state_assessed',
  'state_incomplete',
  'state_failed',
  'state_outdated',
] as const;
export type AiStateFilter = (typeof AI_STATE_FILTERS)[number];

export const MATCH_FILTER_STATUSES = [
  'recommended',
  'possible',
  'needs_review',
  'insufficient_evidence',
  'not_relevant',
  'accepted_for_review',
  'dismissed',
] as const;
export type MatchFilterStatus = (typeof MATCH_FILTER_STATUSES)[number];
const PROPOSED = "('recommended', 'possible', 'needs_review')";
/** Ultima decisione di una persona sull'abbinamento m (null se nessuna o riaperto). */
const REVIEW_OF = (m: string) => `(SELECT r.action FROM service_match_reviews r
   WHERE r.business_id = ${m}.business_id AND r.service_id = ${m}.service_id AND r.action <> 'note'
   ORDER BY r.created_at DESC, r.id DESC LIMIT 1)`;

const iso = (d: Date | string | null) => (d ? new Date(d).toISOString() : null);
const likeEscape = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

function placeOf(row: {
  municipality_code: string | null;
  municipality_name: string | null;
  province_code: string | null;
  region_code: string | null;
}) {
  const p = row.province_code ? geo().province(row.province_code) : null;
  const r = row.region_code ? geo().region(row.region_code) : null;
  return {
    municipalityCode: row.municipality_code,
    municipality: row.municipality_name,
    provinceCode: row.province_code,
    province: p?.name ?? null,
    provinceSigla: p?.sigla ?? null,
    regionCode: row.region_code,
    region: r?.name ?? null,
  };
}

interface BusinessRow {
  id: string;
  name: string;
  category: string;
  website_url: string | null;
  website_domain: string | null;
  website_shared: boolean;
  address_street: string | null;
  address_housenumber: string | null;
  address_postcode: string | null;
  address_city: string | null;
  municipality_code: string | null;
  municipality_name: string | null;
  province_code: string | null;
  region_code: string | null;
  latitude: number | null;
  longitude: number | null;
  has_website: boolean;
  has_address: boolean;
  has_phone: boolean;
  has_email: boolean;
  has_opening_hours: boolean;
  completeness: number;
  merged_into: string | null;
  first_seen_at: Date;
  last_verified_at: Date;
  pending_reviews: number;
  // dati dell'audit del sito (presenti negli elenchi e nella scheda)
  website_status?: string;
  last_audit_at?: Date | null;
  last_audit_id?: string | null;
  last_run_status?: string | null;
  actionable_count?: number | null;
  performance_score?: string | null;
  // punteggio attuale del lead (Fase 4)
  score_id?: string | null;
  score?: number | null;
  score_band?: string | null;
  score_status?: string | null;
  score_confidence?: number | null;
  score_confidence_level?: string | null;
  score_completeness?: number | null;
  score_next_step?: string | null;
  score_at?: Date | null;
  score_outdated?: boolean | null;
  // Fase 6
  sector?: string | null;
  phone?: string | null;
  email?: string | null;
  email_kind?: 'generic' | 'personal' | null;
  excluded_at?: Date | null;
  excluded_reason?: string | null;
  exclusion_code?: ExclusionCode | null;
  do_not_contact_at?: Date | null;
  do_not_contact_scope?: DoNotContactScope | null;
  do_not_contact_note?: string | null;
  fax?: string | null;
  phones_extra?: string[] | null;
  // Fase 7: opportunità del CRM (aperta, altrimenti la più recente)
  crm?: { id: string; stage: string } | null;
  // valutazione commerciale AI corrente
  ai_id?: string | null;
  ai_score?: number | null;
  ai_band?: string | null;
  ai_confidence?: string | null;
  ai_needs_review?: boolean | null;
  ai_exclusion?: string | null;
  ai_at?: Date | null;
  ai_state?: AiState | null;
  contact_status?: ContactStatus | null;
  last_contact_at?: Date | null;
  ai_summary?: string | null;
  primary_category?: BusinessCategoryId | null;
  category_status?: 'classificata' | 'da_verificare' | null;
  category_source?: 'automatica' | 'manuale' | null;
  category_evidence?: string | null;
  contactability?: Contactability | null;
  email_source?: 'osm' | 'website' | 'manuale' | null;
  email_status?: 'pubblicata' | 'verificata' | 'da_verificare' | null;
  email_source_url?: string | null;
  email_found_at?: Date | null;
  email_domain_status?: 'mx' | 'a_only' | 'none' | 'error' | null;
  contact_name?: string | null;
  contact_role?: string | null;
  notes?: string | null;
  operating_status?: 'attiva' | 'chiusa_temporaneamente' | 'chiusa_definitivamente' | null;
  edited_fields?: string[] | null;
  edited_at?: Date | null;
  updated_at?: Date | null;
  email_domain_checked_for?: string | null;
  email_domain_checked_at?: Date | null;
  ai_last_error?: string | null;
  ai_next_attempt?: Date | null;
  ai_acquisition?: number | null;
  ai_service_fit?: number | null;
  ai_outdated?: boolean | null;
  commercial_score?: number | null;
}

const BAND_LABEL = new Map(DEFAULT_AI_CONFIG.bands.map((b) => [b.id, b.label]));

/**
 * Punteggio commerciale mostrato ovunque (elenco, Lead Hunter, CRM, dashboard): la valutazione AI se c'è, altrimenti
 * il punteggio a regole della Fase 4 come riserva dichiarata (`source: 'rules'`). Le fasce sono le stesse.
 */
function commercialOf(row: BusinessRow) {
  if (row.ai_id) {
    const excluded = row.ai_exclusion as 'do_not_contact' | 'inactive' | null;
    return {
      source: 'ai' as const,
      score: row.ai_score!,
      band: row.ai_band ? { id: row.ai_band, label: BAND_LABEL.get(row.ai_band) ?? row.ai_band } : null,
      confidence: row.ai_confidence as 'high' | 'medium' | 'low',
      acquisition: row.ai_acquisition ?? null,
      serviceFit: row.ai_service_fit ?? null,
      needsReview: Boolean(row.ai_needs_review),
      exclusion: excluded,
      assessedAt: iso(row.ai_at ?? null),
      outdated: Boolean(row.ai_outdated),
    };
  }
  if (
    row.score !== null &&
    row.score !== undefined &&
    (row.score_status === 'ranked' || row.score_status === 'needs_review')
  ) {
    const band = bandOf(DEFAULT_AI_CONFIG, row.score);
    return {
      source: 'rules' as const,
      score: row.score,
      band: { id: band.id, label: band.label },
      confidence: (row.score_confidence_level ?? 'low') as 'high' | 'medium' | 'low',
      acquisition: null,
      serviceFit: null,
      needsReview: false,
      exclusion: null,
      assessedAt: iso(row.score_at ?? null),
      outdated: Boolean(row.score_outdated),
    };
  }
  return null;
}

export type { BusinessRow };

export const EMAIL_VERIFICATION_LABEL = {
  delivery_verified: 'Consegna verificata',
  domain_checked: 'Dominio che riceve posta',
  publicly_listed: 'Pubblicata in una fonte pubblica',
  syntax_valid: 'Indirizzo formalmente valido',
  unverified: 'Non verificata',
} as const;

/**
 * Livello di verifica dell'email, dal più forte. Un'email pubblicata o con un dominio valido NON è garantita: solo una
 * conferma di consegna (oggi mai automatica) la rende «verificata». Il dominio è controllato solo via DNS.
 */
function emailVerification(row: BusinessRow) {
  if (!row.email) return null;
  const domain = row.email_domain_checked_for === row.email ? (row.email_domain_status ?? null) : null;
  const level =
    row.email_status === 'verificata'
      ? 'delivery_verified'
      : domain === 'mx' || domain === 'a_only'
        ? 'domain_checked'
        : row.email_source === 'osm' || row.email_source === 'website'
          ? 'publicly_listed'
          : /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(row.email)
            ? 'syntax_valid'
            : 'unverified';
  return {
    level,
    label: EMAIL_VERIFICATION_LABEL[level],
    publiclyListed: row.email_source === 'osm' || row.email_source === 'website',
    domain,
    domainCheckedAt: iso(row.email_domain_checked_at ?? null),
  } as const;
}

export function summary(row: BusinessRow) {
  return {
    id: row.id,
    name: row.name,
    category: row.category,
    categoryLabel: CATEGORIES[row.category as CategoryId]?.label ?? row.category,
    website: row.website_url ? { url: row.website_url, domain: row.website_domain, shared: row.website_shared } : null,
    place: placeOf(row),
    completeness: row.completeness,
    has: {
      website: row.has_website,
      address: row.has_address,
      phone: row.has_phone,
      email: row.has_email,
      openingHours: row.has_opening_hours,
    },
    pendingReviews: Number(row.pending_reviews ?? 0),
    audit: {
      websiteStatus: row.website_status ?? (!row.website_url || row.website_shared ? 'not_found' : 'not_checked'),
      lastAuditAt: iso(row.last_audit_at ?? null),
      lastAuditId: row.last_audit_id ?? null,
      runStatus: row.last_run_status ?? null,
      actionableFindings: row.actionable_count ?? null,
      performanceScore:
        row.performance_score === null || row.performance_score === undefined ? null : Number(row.performance_score),
    },
    sector: row.sector ? { id: row.sector, label: sectorById(row.sector)?.label ?? row.sector } : null,
    // contattabilità via email: stato, provenienza e prova del recapito (separata dal punteggio)
    emailInfo: row.contactability
      ? {
          status: row.contactability,
          label: CONTACTABILITY_LABEL[row.contactability],
          source: row.email_source ?? null,
          sourceUrl: row.email_source_url ?? null,
          foundAt: iso(row.email_found_at ?? null),
          verification: emailVerification(row),
        }
      : null,
    // categoria commerciale di «Trova aziende», con lo stato e la prova (null finché non è classificata)
    businessCategory: row.primary_category
      ? {
          id: row.primary_category,
          label: BUSINESS_CATEGORY_LABEL[row.primary_category],
          status: row.category_status ?? 'da_verificare',
          source: row.category_source ?? 'automatica',
          evidence: row.category_evidence ?? null,
        }
      : null,
    // recapiti pubblici dell'attività indicati dalla fonte; email solo se generica (vedi discovery/contacts.ts)
    contacts: {
      phone: row.phone ?? null,
      email: row.email ?? null,
      emailKind: row.email_kind ?? null,
      fax: row.fax ?? null,
      phonesExtra: row.phones_extra ?? [],
    },
    // esclusione dalla prospezione: motivo codificato e nota (l'azienda e la sua storia restano)
    excluded: row.excluded_at
      ? {
          at: iso(row.excluded_at),
          reason: row.excluded_reason ?? null,
          code: row.exclusion_code ?? 'altro',
          label: EXCLUSION_LABEL[row.exclusion_code ?? 'altro'],
        }
      : null,
    // divieto di contatto (rifiuto commerciale): separato dall'esclusione, resta anche se l'azienda viene reinclusa
    doNotContact: row.do_not_contact_at
      ? {
          at: iso(row.do_not_contact_at),
          scope: row.do_not_contact_scope ?? 'tutti',
          note: row.do_not_contact_note ?? null,
        }
      : null,
    crm: row.crm
      ? { opportunityId: row.crm.id, stage: row.crm.stage, open: !CLOSED_STAGES.includes(row.crm.stage as StageId) }
      : null,
    lead: row.score_id
      ? {
          scoreId: row.score_id,
          status: row.score_status!,
          score: row.score ?? null,
          band: row.score_band ?? null,
          confidence: { value: row.score_confidence!, level: row.score_confidence_level! },
          completeness: row.score_completeness!,
          nextStep: row.score_next_step!,
          calculatedAt: iso(row.score_at ?? null),
          outdated: Boolean(row.score_outdated),
        }
      : null,
    commercial: commercialOf(row),
    // motivo principale della valutazione AI (sintesi del modello, già validata)
    commercialReason: row.ai_id ? (row.ai_summary ?? null) : null,
    // stato di contatto: solo da email accettate e attività registrate, mai da bozze
    contact: row.contact_status
      ? {
          status: row.contact_status,
          label: CONTACT_STATUS_LABEL[row.contact_status],
          lastContactAt: iso(row.last_contact_at ?? null),
        }
      : null,
    // stato della valutazione commerciale, distinto dal punteggio e dall'affidabilità
    assessment: row.ai_state
      ? {
          state: row.ai_state,
          label: AI_STATE_LABEL[row.ai_state],
          lastError: row.ai_state === 'failed' ? (row.ai_last_error ?? null) : null,
          nextAttemptAt: row.ai_state === 'failed' ? iso(row.ai_next_attempt ?? null) : null,
        }
      : null,
    firstSeenAt: iso(row.first_seen_at),
    lastVerifiedAt: iso(row.last_verified_at),
    // dati inseriti da una persona in «Modifica» (mai dalla fonte)
    contactPerson:
      row.contact_name || row.contact_role ? { name: row.contact_name ?? null, role: row.contact_role ?? null } : null,
    notes: row.notes ?? null,
    operatingStatus: row.operating_status ?? null,
    editedFields: row.edited_fields ?? [],
    editedAt: iso(row.edited_at ?? null),
    // versione della scheda per la modifica (protezione dalle sovrascritture)
    updatedAt: iso(row.updated_at ?? null),
  };
}

/** Aziende con il loro sito e l'ultimo audit (Fase 3). */
const FROM_BUSINESSES = `businesses b
  LEFT JOIN business_websites bw ON bw.business_id = b.id
  LEFT JOIN websites w ON w.id = bw.website_id
  LEFT JOIN website_audits la ON la.id = w.last_audit_id
  LEFT JOIN lead_scores ls ON ls.business_id = b.id AND ls.is_current
  LEFT JOIN ai_assessments aa ON aa.business_id = b.id AND aa.is_current
  LEFT JOIN ai_business_states ast ON ast.business_id = b.id`;
/** Stato del sito: dall'audit, oppure dedotto dall'indirizzo indicato dalla fonte (nessuno o solo social = not_found). */
const WEBSITE_STATUS = `COALESCE(w.status, bw.status, CASE WHEN b.website_url IS NULL OR b.website_shared THEN 'not_found' ELSE 'not_checked' END)`;
const AUDIT_COLUMNS = `, ${WEBSITE_STATUS} AS website_status, w.last_checked_at AS last_audit_at, w.last_audit_id, la.run_status AS last_run_status,
  la.actionable_count, la.summary->'performance'->'mobile'->>'score' AS performance_score,
  ls.id AS score_id, ls.score, ls.band AS score_band, ls.status AS score_status, ls.confidence AS score_confidence,
  ls.confidence_level AS score_confidence_level, ls.completeness AS score_completeness, ls.next_step AS score_next_step,
  ls.calculated_at AS score_at,
  -- da ricalcolare: configurazione nuova, audit più recente o dati dell'azienda cambiati dopo il calcolo
  (ls.id IS NOT NULL AND (ls.config_version <> (SELECT max(version) FROM scoring_configs)
     OR (w.last_audit_id IS NOT NULL AND ls.audit_id IS DISTINCT FROM w.last_audit_id)
     OR b.updated_at > ls.calculated_at)) AS score_outdated,
  aa.id AS ai_id, aa.final_score AS ai_score, aa.band AS ai_band, aa.confidence_level AS ai_confidence,
  aa.needs_review AS ai_needs_review, aa.exclusion AS ai_exclusion, aa.created_at AS ai_at,
  (aa.components->'acquisition'->>'score')::int AS ai_acquisition, (aa.components->'service_fit'->>'score')::int AS ai_service_fit,
  -- da rivalutare: l'impronta delle prove di oggi è diversa da quella della valutazione corrente (server/ai/queue.ts)
  (aa.id IS NOT NULL AND ast.fingerprint IS NOT NULL AND aa.cache_key <> ast.fingerprint) AS ai_outdated,
  ${AI_STATE_SQL} AS ai_state, ast.last_error AS ai_last_error, ast.next_attempt_at AS ai_next_attempt,
  ${CONTACT_STATUS_SQL} AS contact_status, ${LAST_CONTACT_SQL} AS last_contact_at, aa.output->>'summary' AS ai_summary,
  ${CONTACTABILITY_SQL} AS contactability`;

const PENDING_REVIEWS = `(SELECT count(*)::int FROM duplicate_candidates d
   WHERE d.status = 'pending' AND (d.business_a = b.id OR d.business_b = b.id)) AS pending_reviews`;

/** Opportunità del CRM dell'azienda: quella aperta, altrimenti la più recente (Fase 7). */
export const CRM_COLUMN = `, (SELECT json_build_object('id', o.id, 'stage', o.stage) FROM crm_opportunities o
   WHERE o.business_id = b.id ORDER BY (o.stage NOT IN ${CLOSED_SQL}) DESC, o.created_at DESC LIMIT 1) AS crm`;

/** Filtri dell'elenco tradotti in SQL (usati dall'elenco e dall'esportazione CSV: sempre gli stessi risultati). */
export function listQuery(f: BusinessFilters) {
  const where = f.includeMerged ? ['true'] : ['b.merged_into IS NULL'];
  const params: unknown[] = [];
  const add = (sql: (n: string) => string, value: unknown) => {
    params.push(value);
    where.push(sql(`$${params.length}`));
  };
  // ---- valutazione commerciale (AI o riserva a regole) ----
  if (f.minCommercial !== undefined) add((p) => `(${COMMERCIAL_SCORE}) >= ${p}`, f.minCommercial);
  if (f.maxCommercial !== undefined) add((p) => `(${COMMERCIAL_SCORE}) <= ${p}`, f.maxCommercial);
  if (f.aiStatus === 'assessed') where.push('aa.id IS NOT NULL');
  if (f.aiStatus === 'not_assessed') where.push('aa.id IS NULL');
  if (f.aiStatus === 'needs_review')
    where.push(
      `aa.needs_review AND NOT EXISTS (SELECT 1 FROM ai_assessment_reviews r WHERE r.assessment_id = aa.id AND r.verdict = 'confirmed')`,
    );
  if (f.aiStatus === 'excluded') where.push('aa.exclusion IS NOT NULL');
  if (f.aiStatus === 'failed') where.push(`(${AI_STATE_SQL}) = 'failed'`);
  // stati della valutazione di ogni azienda (server/ai/state.ts)
  if (f.aiStatus && (AI_STATE_FILTERS as readonly string[]).includes(f.aiStatus))
    add((p) => `(${AI_STATE_SQL}) = ${p}`, f.aiStatus.replace('state_', ''));
  if (f.aiConfidence?.length) add((p) => `aa.confidence_level = ANY(${p})`, f.aiConfidence);
  if (f.minAcquisition) add((p) => `(aa.components->'acquisition'->>'score')::int >= ${p}`, f.minAcquisition);
  if (f.minServiceFit) add((p) => `(aa.components->'service_fit'->>'score')::int >= ${p}`, f.minServiceFit);
  // ---- CRM (Fase 7) ----
  const openOpportunity = `EXISTS (SELECT 1 FROM crm_opportunities o WHERE o.business_id = b.id AND o.stage NOT IN ${CLOSED_SQL})`;
  if (f.contactStatus?.length) add((p) => `(${CONTACT_STATUS_SQL}) = ANY(${p})`, f.contactStatus);
  if (f.email === 'yes') where.push(HAS_EMAIL_SQL);
  if (f.email === 'no') where.push(`NOT ${HAS_EMAIL_SQL}`);
  // ---- categoria commerciale ----
  if (f.businessCategory === 'pending') where.push('b.primary_category IS NULL');
  else if (f.businessCategory) add((p) => `b.primary_category = ${p}`, f.businessCategory);
  if (f.categoryReview) where.push("b.category_status = 'da_verificare'");
  if (f.contactability?.length) add((p) => `(${CONTACTABILITY_SQL}) = ANY(${p})`, f.contactability);
  if (f.doNotContact === true) where.push(DO_NOT_CONTACT_SQL);
  if (f.doNotContact === false) where.push(`NOT ${DO_NOT_CONTACT_SQL}`);
  if (f.crm === 'none') where.push(`NOT ${openOpportunity}`);
  if (f.crm === 'open') where.push(openOpportunity);
  if (f.crm === 'any') where.push('EXISTS (SELECT 1 FROM crm_opportunities o WHERE o.business_id = b.id)');
  // ---- Lead Hunter (Fase 6): ricerca di lead, settori, aziende escluse dal contatto ----
  if (f.hunt)
    add(
      (p) => `EXISTS (SELECT 1 FROM hunt_run_businesses hb WHERE hb.business_id = b.id AND hb.run_id = ${p})`,
      f.hunt,
    );
  if (f.sectors?.length) add((p) => `b.sector = ANY(${p})`, f.sectors);
  // chi filtra per «Non contattare» vuole vedere proprio le aziende escluse: senza una scelta esplicita le include
  const defaultExcluded = f.contactStatus?.includes('non_contattare') ? 'include' : 'hide';
  if ((f.excluded ?? defaultExcluded) === 'hide') where.push('b.excluded_at IS NULL');
  if (f.excluded === 'only') where.push('b.excluded_at IS NOT NULL');
  if (f.ids?.length) add((p) => `b.id = ANY(${p})`, f.ids);
  if (f.contact === 'phone') where.push('b.phone IS NOT NULL');
  if (f.contact === 'any') where.push('(b.phone IS NOT NULL OR b.email IS NOT NULL)');
  if (f.q) {
    const q = fold(f.q);
    if (q)
      add(
        (p) => `(b.search_name LIKE ${p} OR b.website_domain LIKE ${p} OR lower(b.municipality_name) LIKE ${p})`,
        `%${likeEscape(q)}%`,
      );
  }
  if (f.region) add((p) => `b.region_code = ${p}`, f.region);
  if (f.province) add((p) => `b.province_code = ${p}`, f.province);
  if (f.municipality) add((p) => `b.municipality_code = ${p}`, f.municipality);
  if (f.categories?.length) add((p) => `b.category = ANY(${p})`, f.categories);
  if (f.website === 'yes') where.push('b.has_website');
  if (f.website === 'own') where.push('b.has_website AND NOT b.website_shared');
  if (f.website === 'no') where.push('NOT b.has_website');
  if (f.minCompleteness) add((p) => `b.completeness >= ${p}`, f.minCompleteness);
  if (f.job)
    add((p) => `EXISTS (SELECT 1 FROM business_sources s WHERE s.business_id = b.id AND s.last_job_id = ${p})`, f.job);
  if (f.audit === 'audited') where.push("w.last_audit_id IS NOT NULL AND w.status IN ('valid', 'redirected')");
  if (f.audit === 'unaudited') where.push(`${WEBSITE_STATUS} = 'not_checked'`);
  if (f.audit === 'failed') where.push("w.status = 'audit_failed'");
  if (f.audit === 'unavailable')
    where.push(`${WEBSITE_STATUS} IN ('unreachable', 'timeout', 'blocked', 'invalid_url')`);
  if (f.audit === 'no_website') where.push(`${WEBSITE_STATUS} = 'not_found'`);
  // sito raggiungibile con almeno un rilievo di gravità alta nell'ultimo audit
  if (f.audit === 'problems')
    where.push(
      "w.status IN ('valid', 'redirected') AND COALESCE((la.summary->'findings'->'bySeverity'->>'high')::int, 0) > 0",
    );
  if (f.priority?.length) {
    const parts: string[] = [];
    const bands = f.priority.filter((x) => ['A', 'B', 'C', 'low'].includes(x));
    if (bands.length) {
      params.push(bands);
      parts.push(`(ls.status = 'ranked' AND ls.band = ANY($${params.length}))`);
    }
    const statuses = f.priority.filter((x) => ['needs_review', 'insufficient_data', 'not_suitable'].includes(x));
    if (statuses.length) {
      params.push(statuses);
      parts.push(`ls.status = ANY($${params.length})`);
    }
    if (f.priority.includes('unscored')) parts.push('ls.id IS NULL');
    where.push(`(${parts.join(' OR ')})`);
  }
  if (f.minScore) add((p) => `ls.score >= ${p}`, f.minScore);
  if (f.confidence?.length) add((p) => `ls.confidence_level = ANY(${p})`, f.confidence);
  if (f.review)
    where.push(
      "EXISTS (SELECT 1 FROM duplicate_candidates d WHERE d.status = 'pending' AND (d.business_a = b.id OR d.business_b = b.id))",
    );
  // ---- abbinamento ai servizi (Fase 5): un servizio indicato, oppure qualsiasi servizio ----
  let from = FROM_BUSINESSES;
  let matchScore: string;
  if (f.service) {
    params.push(f.service);
    from += `\n  LEFT JOIN service_matches sm ON sm.business_id = b.id AND sm.is_current AND sm.service_id = $${params.length}`;
    matchScore = `CASE WHEN sm.status IN ${PROPOSED} AND ${REVIEW_OF('sm')} IS DISTINCT FROM 'dismissed' THEN sm.score END`;
    const statuses = f.matchStatus ?? [];
    const parts = statuses.map((s) =>
      s === 'accepted_for_review' || s === 'dismissed'
        ? `${REVIEW_OF('sm')} = '${s}'`
        : `(sm.status = '${s}' AND ${REVIEW_OF('sm')} IS DISTINCT FROM 'dismissed')`,
    );
    // senza stato indicato: il servizio deve essere proponibile e non archiviato
    where.push(parts.length ? `(${parts.join(' OR ')})` : `(${matchScore}) IS NOT NULL`);
  } else {
    matchScore = `(SELECT max(m.score) FROM service_matches m WHERE m.business_id = b.id AND m.is_current
                     AND m.status IN ${PROPOSED} AND ${REVIEW_OF('m')} IS DISTINCT FROM 'dismissed')`;
    if (f.matchStatus?.length) {
      const parts = f.matchStatus.map((s) =>
        s === 'accepted_for_review' || s === 'dismissed'
          ? `${REVIEW_OF('m')} = '${s}'`
          : `(m.status = '${s}' AND ${REVIEW_OF('m')} IS DISTINCT FROM 'dismissed')`,
      );
      where.push(
        `EXISTS (SELECT 1 FROM service_matches m WHERE m.business_id = b.id AND m.is_current AND (${parts.join(' OR ')}))`,
      );
    }
  }
  if (f.minMatch) add((p) => `(${matchScore}) >= ${p}`, f.minMatch);
  const sortExpr = f.sort === 'match' ? `(${matchScore})` : SORTS[f.sort];
  const order = `${SORTS[f.sort]} ${f.dir === 'desc' ? 'DESC' : 'ASC'} NULLS LAST, b.id`;
  let whereSql = where.join(' AND ');
  // varietà (Fase 6): al massimo N aziende per settore e/o per regione, scelte nell'ordine corrente.
  // Il punteggio non cambia: si scelgono solo quali righe mostrare.
  if (f.maxPerSector || f.maxPerRegion) {
    const caps: string[] = [];
    if (f.maxPerSector) {
      params.push(f.maxPerSector);
      caps.push(`x.rs <= $${params.length}`);
    }
    if (f.maxPerRegion) {
      params.push(f.maxPerRegion);
      caps.push(`x.rr <= $${params.length}`);
    }
    const win = `${sortExpr} ${f.dir === 'desc' ? 'DESC' : 'ASC'} NULLS LAST, b.id`;
    whereSql += ` AND b.id IN (SELECT x.id FROM (
        SELECT b.id, row_number() OVER (PARTITION BY COALESCE(b.sector, b.category) ORDER BY ${win}) AS rs,
               row_number() OVER (PARTITION BY b.region_code ORDER BY ${win}) AS rr
          FROM ${from} WHERE ${whereSql}) x WHERE ${caps.join(' AND ')})`;
  }
  return { from, whereSql, params, order, matchScore };
}

export { AUDIT_COLUMNS, FROM_BUSINESSES };

export async function listBusinesses(db: Queryable, f: BusinessFilters) {
  const { from, whereSql, params, order, matchScore } = listQuery(f);
  const { rows: total } = await db.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM ${from} WHERE ${whereSql}`,
    params,
  );
  const { rows } = await db.query<BusinessRow & { match_score: number | null }>(
    `SELECT b.*, ${PENDING_REVIEWS}${AUDIT_COLUMNS}${CRM_COLUMN}, ${matchScore} AS match_score FROM ${from} WHERE ${whereSql} ORDER BY ${order}
      LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, f.pageSize, (f.page - 1) * f.pageSize],
  );
  const primary = await primaryServices(
    db,
    rows.map((r) => r.id),
  );
  return {
    items: rows.map((r) => ({
      ...summary(r),
      // servizio principale della lista breve e corrispondenza usata per filtro e ordinamento
      services: { primary: primary.get(r.id) ?? null, matchScore: r.match_score ?? null },
    })),
    total: total[0]!.n,
    page: f.page,
    pageSize: f.pageSize,
  };
}

export async function getBusiness(db: Queryable, id: string) {
  const { rows } = await db.query<BusinessRow>(
    `SELECT b.*, ${PENDING_REVIEWS}${AUDIT_COLUMNS}${CRM_COLUMN} FROM ${FROM_BUSINESSES} WHERE b.id = $1`,
    [id],
  );
  const row = rows[0];
  if (!row) throw new JobError(404, 'NOT_FOUND', 'Azienda non trovata.');
  const sources = await db.query<{
    provider: string;
    provider_ref: string;
    source_url: string;
    license: string;
    is_primary: boolean;
    tags: Record<string, string>;
    first_seen_at: Date;
    last_seen_at: Date;
    source_data_at: Date | null;
    last_job_id: string | null;
  }>(
    `SELECT provider, provider_ref, source_url, license, is_primary, tags, first_seen_at, last_seen_at, source_data_at, last_job_id
       FROM business_sources WHERE business_id = $1 ORDER BY is_primary DESC, first_seen_at`,
    [id],
  );
  const candidates = await db.query<{
    id: string;
    reason: string;
    distance_m: number | null;
    status: string;
    created_at: Date;
    resolved_at: Date | null;
    other_id: string;
    other_name: string;
    other_municipality: string | null;
    other_merged_into: string | null;
  }>(
    `SELECT d.id, d.reason, d.distance_m, d.status, d.created_at, d.resolved_at,
            o.id AS other_id, o.name AS other_name, o.municipality_name AS other_municipality, o.merged_into AS other_merged_into
       FROM duplicate_candidates d
       JOIN businesses o ON o.id = CASE WHEN d.business_a = $1 THEN d.business_b ELSE d.business_a END
      WHERE (d.business_a = $1 OR d.business_b = $1) AND d.status <> 'obsolete'
      ORDER BY d.status = 'pending' DESC, d.created_at DESC`,
    [id],
  );
  const history = await db.query<{
    occurred_at: Date;
    action: string;
    details: Record<string, unknown>;
    user_name: string | null;
  }>(
    `SELECT a.occurred_at, a.action, a.details, u.display_name AS user_name
       FROM audit_log a LEFT JOIN users u ON u.id = a.user_id
      WHERE a.entity_type = 'business' AND a.entity_id = $1 ORDER BY a.id DESC LIMIT 50`,
    [id],
  );
  // email scritte sul sito (tutte quelle conservate, anche non più presenti), con la pagina e le date
  const websiteEmails = await db.query<{
    email: string;
    relation: string;
    via: string;
    page_url: string;
    first_seen_at: Date;
    last_seen_at: Date;
    checked_at: Date | null;
  }>(
    `SELECT we.email, we.relation, we.via, we.page_url, we.first_seen_at, we.last_seen_at, w.emails_checked_at AS checked_at
       FROM business_websites bw JOIN website_emails we ON we.website_id = bw.website_id JOIN websites w ON w.id = bw.website_id
      WHERE bw.business_id = $1 ORDER BY we.relation, we.email`,
    [id],
  );
  return {
    ...summary(row),
    websiteEmails: websiteEmails.rows.map((e) => ({
      email: e.email,
      relation: e.relation,
      via: e.via,
      pageUrl: e.page_url,
      firstSeenAt: iso(e.first_seen_at),
      lastSeenAt: iso(e.last_seen_at),
      // presente nell'ultimo controllo delle pagine del sito
      current: e.checked_at ? new Date(e.last_seen_at).getTime() >= new Date(e.checked_at).getTime() : false,
    })),
    address: {
      street: row.address_street,
      housenumber: row.address_housenumber,
      postcode: row.address_postcode,
      city: row.address_city,
    },
    position: row.latitude !== null && row.longitude !== null ? { lat: row.latitude, lon: row.longitude } : null,
    mergedInto: row.merged_into,
    sources: sources.rows.map((s) => ({
      provider: s.provider,
      ref: s.provider_ref,
      url: s.source_url,
      license: s.license,
      primary: s.is_primary,
      tags: s.tags,
      firstSeenAt: iso(s.first_seen_at),
      lastSeenAt: iso(s.last_seen_at),
      sourceDataAt: iso(s.source_data_at),
      lastJobId: s.last_job_id,
    })),
    duplicates: candidates.rows.map((c) => ({
      id: c.id,
      reason: c.reason,
      distanceM: c.distance_m,
      status: c.status,
      createdAt: iso(c.created_at),
      resolvedAt: iso(c.resolved_at),
      other: {
        id: c.other_id,
        name: c.other_name,
        municipality: c.other_municipality,
        mergedInto: c.other_merged_into,
      },
    })),
    hunts: await huntsOf(db, id),
    history: history.rows.map((h) => ({
      at: iso(h.occurred_at),
      action: h.action,
      details: h.details,
      user: h.user_name,
    })),
  };
}

export async function listCandidates(db: Queryable, status: 'pending' | 'resolved', page: number, pageSize: number) {
  const cond = status === 'pending' ? "d.status = 'pending'" : "d.status IN ('merged', 'distinct')";
  const { rows: total } = await db.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM duplicate_candidates d WHERE ${cond}`,
  );
  const { rows } = await db.query<{
    id: string;
    reason: string;
    distance_m: number | null;
    status: string;
    created_at: Date;
    a: BusinessRow;
    b: BusinessRow;
  }>(
    `SELECT d.id, d.reason, d.distance_m, d.status, d.created_at, to_jsonb(a.*) AS a, to_jsonb(b.*) AS b
       FROM duplicate_candidates d JOIN businesses a ON a.id = d.business_a JOIN businesses b ON b.id = d.business_b
      WHERE ${cond} ORDER BY d.created_at DESC, d.id LIMIT $1 OFFSET $2`,
    [pageSize, (page - 1) * pageSize],
  );
  return {
    items: rows.map((r) => ({
      id: r.id,
      reason: r.reason,
      distanceM: r.distance_m,
      status: r.status,
      createdAt: iso(r.created_at),
      a: summary({ ...r.a, pending_reviews: 0 }),
      b: summary({ ...r.b, pending_reviews: 0 }),
    })),
    total: total[0]!.n,
    page,
    pageSize,
  };
}

async function lockCandidate(tx: Queryable, id: string) {
  const { rows } = await tx.query<{ business_a: string; business_b: string; status: string }>(
    'SELECT business_a, business_b, status FROM duplicate_candidates WHERE id = $1 FOR UPDATE',
    [id],
  );
  const c = rows[0];
  if (!c) throw new JobError(404, 'NOT_FOUND', 'Segnalazione non trovata.');
  if (c.status !== 'pending') throw new JobError(409, 'ALREADY_RESOLVED', 'Questa segnalazione è già stata gestita.');
  return c;
}

/**
 * Unione confermata da una persona: l'azienda scelta resta, l'altra diventa un rimando (non viene cancellata).
 * Le fonti passano all'azienda che resta (come secondarie) e completano i suoi dati mancanti.
 */
export async function mergeCandidate(db: Db, candidateId: string, keepId: string, userId: string) {
  return db.transaction(async (tx) => {
    const c = await lockCandidate(tx, candidateId);
    if (keepId !== c.business_a && keepId !== c.business_b)
      throw new JobError(400, 'INVALID_KEEP', 'L’azienda da mantenere deve essere una delle due della segnalazione.');
    const dropId = keepId === c.business_a ? c.business_b : c.business_a;
    const { rows } = await tx.query<BusinessRow>('SELECT * FROM businesses WHERE id = ANY($1) FOR UPDATE', [
      [keepId, dropId],
    ]);
    const keep = rows.find((r) => r.id === keepId)!;
    const drop = rows.find((r) => r.id === dropId)!;
    if (keep.merged_into || drop.merged_into)
      throw new JobError(409, 'ALREADY_MERGED', 'Una delle due aziende è già stata unita a un’altra.');

    const fill: Record<string, unknown> = {};
    const fields = [
      'website_url',
      'address_street',
      'address_housenumber',
      'address_postcode',
      'address_city',
      'latitude',
      'longitude',
    ] as const;
    for (const k of fields) if (keep[k] === null && drop[k] !== null) fill[k] = drop[k];
    if (fill.website_url !== undefined) {
      fill.website_domain = drop.website_domain;
      fill.website_shared = drop.website_shared;
    }
    if (keep.municipality_code === null && drop.municipality_code !== null) {
      fill.municipality_code = drop.municipality_code;
      fill.municipality_name = drop.municipality_name;
      fill.province_code = drop.province_code;
      fill.region_code = drop.region_code;
    }
    for (const k of ['has_website', 'has_address', 'has_phone', 'has_email', 'has_opening_hours'] as const)
      if (!keep[k] && drop[k]) fill[k] = true;
    const merged = { ...keep, ...fill } as BusinessRow;
    fill.completeness = [
      merged.has_website,
      merged.has_address,
      merged.has_phone,
      merged.has_email,
      merged.has_opening_hours,
    ].filter(Boolean).length;
    const entries = Object.entries(fill);
    await tx.query(
      `UPDATE businesses SET ${[...entries.map(([k], i) => `${k} = $${i + 3}`), 'last_verified_at = GREATEST(last_verified_at, $2)', 'first_seen_at = LEAST(first_seen_at, $2)', 'updated_at = now()'].join(', ')} WHERE id = $1`,
      [keepId, drop.last_verified_at, ...entries.map(([, v]) => v)],
    );
    await tx.query('UPDATE business_sources SET business_id = $1, is_primary = false WHERE business_id = $2', [
      keepId,
      dropId,
    ]);
    await tx.query('UPDATE businesses SET merged_into = $1, updated_at = now() WHERE id = $2', [keepId, dropId]);
    // opportunità del CRM (Fase 7): passano all'azienda che resta, tranne una aperta se anche quella ne ha una
    // aperta (due trattative aperte vanno chiuse o unite da una persona: la scheda dell'opportunità lo segnala)
    const { rows: movedCrm } = await tx.query(
      `UPDATE crm_opportunities SET business_id = $1, updated_at = now()
        WHERE business_id = $2 AND (stage IN ${CLOSED_SQL} OR NOT EXISTS (
          SELECT 1 FROM crm_opportunities k WHERE k.business_id = $1 AND k.stage NOT IN ${CLOSED_SQL}))
        RETURNING id`,
      [keepId, dropId],
    );
    // rimandi precedenti verso l'azienda unita puntano ora a quella che resta
    await tx.query('UPDATE businesses SET merged_into = $1 WHERE merged_into = $2', [keepId, dropId]);
    await tx.query(
      "UPDATE duplicate_candidates SET status = 'merged', resolved_at = now(), resolved_by = $2 WHERE id = $1",
      [candidateId, userId],
    );
    await tx.query(
      `UPDATE duplicate_candidates SET status = 'obsolete', resolved_at = now()
        WHERE status = 'pending' AND id <> $1 AND (business_a = $2 OR business_b = $2)`,
      [candidateId, dropId],
    );
    await audit(tx, {
      userId,
      action: 'business.merged',
      entityType: 'business',
      entityId: keepId,
      details: {
        mergedBusiness: dropId,
        mergedName: drop.name,
        candidateId,
        filled: Object.keys(fill),
        crmOpportunitiesMoved: movedCrm.length,
      },
    });
    await audit(tx, {
      userId,
      action: 'business.merged',
      entityType: 'business',
      entityId: dropId,
      details: { mergedInto: keepId, candidateId },
    });
    return { keepId, mergedId: dropId };
  });
}

export async function markDistinct(db: Db, candidateId: string, userId: string) {
  await db.transaction(async (tx) => {
    const c = await lockCandidate(tx, candidateId);
    await tx.query(
      "UPDATE duplicate_candidates SET status = 'distinct', resolved_at = now(), resolved_by = $2 WHERE id = $1",
      [candidateId, userId],
    );
    for (const id of [c.business_a, c.business_b])
      await audit(tx, {
        userId,
        action: 'duplicate.marked_distinct',
        entityType: 'business',
        entityId: id,
        details: { candidateId },
      });
  });
}

/** Statistiche reali per la dashboard. */
export async function discoveryStats(db: Queryable) {
  const { rows: totals } = await db.query<{
    total: number;
    with_website: number;
    own_website: number;
    pending_reviews: number;
    active_jobs: number;
  }>(
    `SELECT (SELECT count(*)::int FROM businesses WHERE merged_into IS NULL) AS total,
            (SELECT count(*)::int FROM businesses WHERE merged_into IS NULL AND has_website) AS with_website,
            (SELECT count(*)::int FROM businesses WHERE merged_into IS NULL AND has_website AND NOT website_shared) AS own_website,
            (SELECT count(*)::int FROM duplicate_candidates WHERE status = 'pending') AS pending_reviews,
            (SELECT count(*)::int FROM discovery_jobs WHERE status IN ('pending', 'running', 'paused')) AS active_jobs`,
  );
  const { rows: byCategory } = await db.query<{ category: string; n: number }>(
    'SELECT category, count(*)::int AS n FROM businesses WHERE merged_into IS NULL GROUP BY category ORDER BY n DESC',
  );
  const { rows: byRegion } = await db.query<{ region_code: string | null; n: number }>(
    'SELECT region_code, count(*)::int AS n FROM businesses WHERE merged_into IS NULL GROUP BY region_code ORDER BY n DESC',
  );
  const { rows: lastJob } = await db.query<{
    id: string;
    status: string;
    area_name: string;
    finished_at: Date | null;
    created_at: Date;
  }>('SELECT id, status, area_name, finished_at, created_at FROM discovery_jobs ORDER BY created_at DESC LIMIT 1');
  const t = totals[0]!;
  return {
    businesses: t.total,
    withWebsite: t.with_website,
    withOwnWebsite: t.own_website,
    pendingReviews: t.pending_reviews,
    activeJobs: t.active_jobs,
    byCategory: byCategory.map((r) => ({
      category: r.category,
      label: CATEGORIES[r.category as CategoryId]?.label ?? r.category,
      count: r.n,
    })),
    byRegion: byRegion.map((r) => ({
      regionCode: r.region_code,
      region: r.region_code ? (geo().region(r.region_code)?.name ?? r.region_code) : null,
      count: r.n,
    })),
    lastJob: lastJob[0]
      ? {
          id: lastJob[0].id,
          status: lastJob[0].status,
          area: lastJob[0].area_name,
          createdAt: iso(lastJob[0].created_at),
          finishedAt: iso(lastJob[0].finished_at),
        }
      : null,
  };
}

/**
 * Esclusione dalla ricerca di lead e dal contatto (Fase 6): l'azienda resta nel database (una nuova ricerca la
 * riconosce e non la ripropone), ma non compare negli elenchi, nelle ricerche di lead e nelle esportazioni.
 */
/** Motivi dell'esclusione dalla prospezione (codici canonici, etichette italiane). */
export const EXCLUSION_CODES = [
  'nessun_contatto',
  'contatti_non_validi',
  'rifiuto_commerciale',
  'attivita_chiusa',
  'non_pertinente',
  'duplicato',
  'altro',
] as const;
export type ExclusionCode = (typeof EXCLUSION_CODES)[number];
export const EXCLUSION_LABEL: Record<ExclusionCode, string> = {
  nessun_contatto: 'Nessun contatto disponibile',
  contatti_non_validi: 'Contatti non validi',
  rifiuto_commerciale: 'Rifiuto commerciale',
  attivita_chiusa: 'Attività chiusa',
  non_pertinente: 'Azienda non pertinente',
  duplicato: 'Duplicato',
  altro: 'Altro',
};
export type DoNotContactScope = 'tutti' | 'email' | 'telefono';

export interface ExclusionInput {
  excluded: boolean;
  /** Obbligatorio per escludere (le chiamate precedenti senza motivo diventano «altro»). */
  code?: ExclusionCode;
  note?: string | null;
  /** Solo per il rifiuto commerciale: canali vietati (predefinito: tutti, il più prudente). */
  scope?: DoNotContactScope;
}

export async function setExclusion(db: Db, id: string, input: ExclusionInput, userId: string) {
  await db.transaction((tx) => applyExclusion(tx, id, input, userId));
}

/**
 * Esclusione dalla prospezione e divieto di contatto, in una transazione esistente (usata anche dal CRM per la fase
 * «non contattare»). L'azienda e tutta la sua storia restano: si cambia solo lo stato.
 *  - escludere: motivo obbligatorio; l'azienda esce da elenchi, conteggi, esportazioni, ricerche e invii;
 *  - rifiuto commerciale: in più il divieto di contatto (data, canali, nota), che resta anche se l'azienda torna tra
 *    i potenziali clienti o viene ritrovata da una ricerca;
 *  - reincludere: toglie solo l'esclusione, mai il divieto di contatto (lo revoca un amministratore, revokeDoNotContact).
 */
export async function applyExclusion(tx: Queryable, id: string, input: ExclusionInput, userId: string) {
  const { rows } = await tx.query<{ merged_into: string | null; do_not_contact_at: Date | null }>(
    'SELECT merged_into, do_not_contact_at FROM businesses WHERE id = $1 FOR UPDATE',
    [id],
  );
  if (!rows[0]) throw new JobError(404, 'NOT_FOUND', 'Azienda non trovata.');
  const note = input.note?.trim().slice(0, 300) || null;
  if (input.excluded) {
    const code = input.code ?? 'altro';
    await tx.query(
      `UPDATE businesses SET excluded_at = now(), excluded_reason = $2, excluded_by = $3, exclusion_code = $4, updated_at = now()
        WHERE id = $1`,
      [id, note, userId, code],
    );
    if (code === 'rifiuto_commerciale' && !rows[0].do_not_contact_at)
      await tx.query(
        `UPDATE businesses SET do_not_contact_at = now(), do_not_contact_scope = $2, do_not_contact_note = $3,
                do_not_contact_by = $4 WHERE id = $1`,
        [id, input.scope ?? 'tutti', note, userId],
      );
  } else
    await tx.query(
      `UPDATE businesses SET excluded_at = NULL, excluded_reason = NULL, excluded_by = NULL, exclusion_code = NULL,
              updated_at = now() WHERE id = $1`,
      [id],
    );
  await audit(tx, {
    userId,
    action: input.excluded ? 'business.excluded' : 'business.included',
    entityType: 'business',
    entityId: id,
    details: input.excluded
      ? {
          code: input.code ?? 'altro',
          reason: note,
          ...(input.code === 'rifiuto_commerciale' ? { doNotContact: input.scope ?? 'tutti' } : {}),
        }
      : rows[0].do_not_contact_at
        ? { doNotContactKept: true }
        : {},
  });
}

/** Revoca del divieto di contatto: solo amministratori, con un motivo registrato (es. consenso ricevuto per iscritto). */
export async function revokeDoNotContact(db: Db, id: string, note: string, userId: string) {
  await db.transaction(async (tx) => {
    const { rows } = await tx.query<{ do_not_contact_at: Date | null; do_not_contact_scope: string | null }>(
      'SELECT do_not_contact_at, do_not_contact_scope FROM businesses WHERE id = $1 FOR UPDATE',
      [id],
    );
    if (!rows[0]) throw new JobError(404, 'NOT_FOUND', 'Azienda non trovata.');
    if (!rows[0].do_not_contact_at)
      throw new JobError(409, 'NO_DO_NOT_CONTACT', 'Per questa azienda non c’è un divieto di contatto da revocare.');
    await tx.query(
      `UPDATE businesses SET do_not_contact_at = NULL, do_not_contact_scope = NULL, do_not_contact_note = NULL,
              do_not_contact_by = NULL WHERE id = $1`,
      [id],
    );
    await audit(tx, {
      userId,
      action: 'business.do_not_contact_revoked',
      entityType: 'business',
      entityId: id,
      details: { note: note.slice(0, 300), since: rows[0].do_not_contact_at, scope: rows[0].do_not_contact_scope },
    });
  });
}

/** Ricerche di lead che hanno trovato l'azienda (provenienza nella scheda). */
export async function huntsOf(db: Queryable, id: string) {
  const { rows } = await db.query<{ id: string; area_name: string; created_at: Date; is_new: boolean; status: string }>(
    `SELECT r.id, r.area_name, r.created_at, hb.is_new, r.status FROM hunt_run_businesses hb JOIN hunt_runs r ON r.id = hb.run_id
      WHERE hb.business_id = $1 ORDER BY r.created_at DESC LIMIT 20`,
    [id],
  );
  return rows.map((r) => ({
    id: r.id,
    area: r.area_name,
    createdAt: iso(r.created_at),
    isNew: r.is_new,
    status: r.status,
  }));
}
