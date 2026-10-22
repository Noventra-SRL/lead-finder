import { bandOf, DEFAULT_AI_CONFIG } from '../ai/config.ts';
import { activityLabel, CLOSED_SQL, PRIORITIES, stageLabel, STAGES, todayInRome, toEuro } from '../crm/model.ts';
import {
  crmQuery,
  followUpQuery,
  FOLLOWUP_LIST_COLUMNS,
  OPP_COLUMNS,
  serviceNameMap,
  type CrmFilters,
  type FollowUpFilters,
  type FollowUpListRow,
  type OppColumns,
} from '../crm/store.ts';
import type { Queryable } from '../db/client.ts';
import { CATEGORIES, type CategoryId } from '../discovery/categories.ts';
import { AUDIT_COLUMNS, listQuery, type BusinessFilters, type BusinessRow } from '../discovery/businesses.ts';
import { sectorById } from '../discovery/sectors.ts';
import { geo } from '../geo/geo.ts';
import { primaryServices } from '../matching/store.ts';
import { buildExport, dateTime, day, pickColumns, readAll, yesNo, type Column, type ExportFormat } from './format.ts';

/*
 * Elenchi esportabili: aziende (con gli stessi filtri dell'elenco), opportunità del CRM (anche raggruppate per fase),
 * follow-up e cronologia delle attività. Ogni elenco ha il suo catalogo di colonne in italiano.
 */

const WEBSITE_STATUS: Record<string, string> = {
  not_checked: 'Sito indicato, non verificato',
  not_found: 'Nessun sito proprio indicato (non verificato)',
  valid: 'Raggiungibile',
  redirected: 'Raggiungibile (reindirizzato)',
  unreachable: 'Irraggiungibile all’ultimo controllo',
  timeout: 'Non risponde in tempo',
  blocked: 'Accesso negato al controllo',
  invalid_url: 'Indirizzo non valido',
  audit_failed: 'Verifica non riuscita',
};
const RULES_STATUS: Record<string, string> = {
  ranked: 'Classificato',
  needs_review: 'Da verificare',
  insufficient_data: 'Dati insufficienti',
  not_suitable: 'Non adatto',
};
const LEVEL: Record<string, string> = { high: 'alta', medium: 'media', low: 'bassa' };
const PRIORITY: Record<string, string> = Object.fromEntries(PRIORITIES.map((p) => [p.id, p.label]));
const FOLLOWUP_STATUS: Record<string, string> = { pending: 'Da fare', completed: 'Completato', cancelled: 'Annullato' };
const CANCEL_REASON: Record<string, string> = {
  manual: 'Annullato da una persona',
  opportunity_closed: 'Opportunità chiusa',
};
/** Attività che contano come "contatto" con l'azienda. */
const CONTACT_TYPES = `('call', 'contact_attempt', 'conversation', 'meeting', 'email_sent', 'email_reply')`;

const provinceOf = (code: string | null) => {
  const p = code ? geo().province(code) : null;
  return p ? `${p.name} (${p.sigla})` : null;
};
const regionOf = (code: string | null) => (code ? (geo().region(code)?.name ?? null) : null);
const sectorOf = (row: { sector?: string | null; category: string }) =>
  row.sector
    ? (sectorById(row.sector)?.label ?? row.sector)
    : (CATEGORIES[row.category as CategoryId]?.label ?? row.category);
/** Punteggio commerciale come nel resto dell'applicazione: AI, altrimenti punteggio a regole (riserva). */
function commercial(row: BusinessRow) {
  if (row.ai_id) return row.ai_exclusion ? null : { score: row.ai_score!, source: 'Valutazione AI', band: row.ai_band };
  if (row.score !== null && row.score !== undefined && ['ranked', 'needs_review'].includes(row.score_status ?? ''))
    return { score: row.score, source: 'Punteggio a regole', band: bandOf(DEFAULT_AI_CONFIG, row.score).id };
  return null;
}
const BAND_LABEL = new Map(DEFAULT_AI_CONFIG.bands.map((b) => [b.id, b.label]));

// ---------------------------------------------------------------- aziende

type BusinessExportRow = BusinessRow & {
  explanation: string | null;
  source_url: string | null;
  ai_components: Record<string, { score: number }> | null;
  ai_service_ids: string[] | null;
  crm_stage: string | null;
  crm_owner: string | null;
  crm_value: string | null;
  crm_last_contact: Date | null;
  crm_next_due: string | null;
  crm_next_title: string | null;
  matched: string;
  ai_services: string;
};

const aiComp = (key: string) => (r: BusinessExportRow) => r.ai_components?.[key]?.score ?? null;

export const BUSINESS_COLUMNS: Column<BusinessExportRow>[] = [
  { id: 'name', label: 'Azienda', default: true, get: (r) => r.name },
  {
    id: 'sector',
    label: 'Settore',
    default: true,
    get: (r) => (r.sector ? (sectorById(r.sector)?.label ?? r.sector) : null),
  },
  {
    id: 'category',
    label: 'Categoria',
    default: true,
    get: (r) => CATEGORIES[r.category as CategoryId]?.label ?? r.category,
  },
  {
    id: 'address',
    label: 'Indirizzo',
    default: true,
    get: (r) => [r.address_street, r.address_housenumber].filter(Boolean).join(' ') || null,
  },
  { id: 'postcode', label: 'CAP', default: false, get: (r) => r.address_postcode },
  { id: 'municipality', label: 'Comune', default: true, get: (r) => r.municipality_name },
  { id: 'province', label: 'Provincia', default: true, get: (r) => provinceOf(r.province_code) },
  { id: 'region', label: 'Regione', default: true, get: (r) => regionOf(r.region_code) },
  { id: 'website', label: 'Sito web', default: true, get: (r) => r.website_url },
  {
    id: 'website_status',
    label: 'Stato del sito',
    default: true,
    get: (r) => WEBSITE_STATUS[r.website_status ?? ''] ?? r.website_status ?? null,
  },
  { id: 'last_audit', label: 'Ultimo audit', default: false, get: (r) => day(r.last_audit_at) },
  { id: 'findings', label: 'Rilievi utili dell’audit', default: true, get: (r) => r.actionable_count ?? null },
  { id: 'commercial_score', label: 'Punteggio commerciale', default: true, get: (r) => commercial(r)?.score ?? null },
  { id: 'commercial_source', label: 'Fonte del punteggio', default: true, get: (r) => commercial(r)?.source ?? null },
  {
    id: 'commercial_band',
    label: 'Fascia commerciale',
    default: true,
    get: (r) => {
      const c = commercial(r);
      return c?.band
        ? (BAND_LABEL.get(c.band) ?? c.band)
        : r.ai_exclusion === 'inactive'
          ? 'Esclusa: attività cessata'
          : null;
    },
  },
  {
    id: 'ai_confidence',
    label: 'Affidabilità della valutazione AI',
    default: true,
    get: (r) => (r.ai_confidence ? LEVEL[r.ai_confidence] : null),
  },
  {
    id: 'ai_acquisition',
    label: 'AI: probabilità stimata di acquisizione',
    default: false,
    get: aiComp('acquisition'),
  },
  { id: 'ai_service_fit', label: 'AI: compatibilità con i servizi', default: false, get: aiComp('service_fit') },
  {
    id: 'ai_improvement',
    label: 'AI: opportunità di miglioramento digitale',
    default: false,
    get: aiComp('improvement'),
  },
  { id: 'ai_attractiveness', label: 'AI: attrattività commerciale', default: false, get: aiComp('attractiveness') },
  { id: 'ai_evidence', label: 'AI: qualità delle prove', default: false, get: aiComp('evidence_quality') },
  { id: 'ai_services', label: 'Servizi consigliati dall’AI', default: true, get: (r) => r.ai_services || null },
  { id: 'rules_score', label: 'Punteggio a regole', default: false, get: (r) => r.score ?? null },
  {
    id: 'rules_status',
    label: 'Stato del punteggio a regole',
    default: false,
    get: (r) => (r.score_status ? RULES_STATUS[r.score_status] : null),
  },
  { id: 'rules_explanation', label: 'Spiegazione del punteggio a regole', default: false, get: (r) => r.explanation },
  {
    id: 'matched_services',
    label: 'Servizi consigliati (abbinamento a regole)',
    default: false,
    get: (r) => r.matched || null,
  },
  { id: 'phone', label: 'Telefono (pubblico)', default: true, get: (r) => r.phone ?? null },
  { id: 'email', label: 'Email generica (pubblica)', default: true, get: (r) => r.email ?? null },
  { id: 'crm_stage', label: 'Fase CRM', default: true, get: (r) => (r.crm_stage ? stageLabel(r.crm_stage) : null) },
  { id: 'crm_owner', label: 'Responsabile', default: false, get: (r) => r.crm_owner },
  { id: 'crm_last_contact', label: 'Ultimo contatto', default: false, get: (r) => day(r.crm_last_contact) },
  {
    id: 'crm_next',
    label: 'Prossimo follow-up',
    default: true,
    get: (r) => (r.crm_next_due ? `${r.crm_next_due} — ${r.crm_next_title}` : null),
  },
  { id: 'crm_value', label: 'Valore stimato (€)', default: false, get: (r) => toEuro(r.crm_value) },
  { id: 'source', label: 'Fonte', default: true, get: () => 'OpenStreetMap (ODbL 1.0)' },
  { id: 'source_ref', label: 'Riferimento della fonte', default: true, get: (r) => r.source_url },
  { id: 'verified', label: 'Ultima conferma della fonte', default: true, get: (r) => day(r.last_verified_at) },
];

export async function exportBusinesses(
  db: Queryable,
  f: BusinessFilters,
  opts: { format: ExportFormat; fields?: string[]; name?: string; userId: string },
) {
  const { from, whereSql, params, order } = listQuery(f);
  const sql = `SELECT b.*${AUDIT_COLUMNS}, ls.explanation,
      (SELECT s.source_url FROM business_sources s WHERE s.business_id = b.id ORDER BY s.is_primary DESC, s.first_seen_at LIMIT 1) AS source_url,
      aa.components AS ai_components, aa.output->'recommended_service_ids' AS ai_service_ids,
      co.stage AS crm_stage, cu.display_name AS crm_owner, co.estimated_value_cents AS crm_value,
      (SELECT max(a.occurred_at) FROM crm_activities a WHERE a.opportunity_id = co.id AND a.type IN ${CONTACT_TYPES}) AS crm_last_contact,
      cf.due_date::text AS crm_next_due, cf.description AS crm_next_title
    FROM ${from}
      LEFT JOIN LATERAL (SELECT * FROM crm_opportunities x WHERE x.business_id = b.id
         ORDER BY (x.stage NOT IN ${CLOSED_SQL}) DESC, x.created_at DESC LIMIT 1) co ON true
      LEFT JOIN users cu ON cu.id = co.owner_id
      LEFT JOIN LATERAL (SELECT y.due_date, y.description FROM crm_followups y WHERE y.opportunity_id = co.id AND y.status = 'pending'
         ORDER BY y.due_date, y.due_time NULLS LAST LIMIT 1) cf ON true
    WHERE ${whereSql} ORDER BY ${order}`;
  const { rows, truncated } = await readAll((limit, offset) =>
    db
      .query<BusinessExportRow>(`${sql} LIMIT $${params.length + 1} OFFSET $${params.length + 2}`, [
        ...params,
        limit,
        offset,
      ])
      .then((r) => r.rows),
  );
  // servizi: abbinamento a regole e servizi indicati dall'AI, con i nomi del catalogo (una sola lettura per blocco)
  const names = await serviceNameMap(db);
  for (let i = 0; i < rows.length; i += 1000) {
    const chunk = rows.slice(i, i + 1000);
    const matched = await primaryServices(
      db,
      chunk.map((r) => r.id),
    );
    for (const r of chunk) {
      r.matched = (matched.get(r.id)?.shortlist ?? []).map((x) => `${x.name} (${x.score})`).join(', ');
      r.ai_services = (r.ai_service_ids ?? []).map((id) => names.get(id) ?? id).join(', ');
    }
  }
  return buildExport(db, {
    dataset: 'businesses',
    name: opts.name ?? 'aziende',
    format: opts.format,
    columns: pickColumns(BUSINESS_COLUMNS, opts.fields),
    rows,
    truncated,
    userId: opts.userId,
    filters: { ...f, ids: f.ids ? `${f.ids.length} selezionate` : undefined },
  });
}

// ---------------------------------------------------------------- opportunità

type OpportunityExportRow = BusinessRow &
  OppColumns & { opp_notes: string | null; opp_last_contact: Date | null; service_names: string };

const commercialOfOpp = (r: OpportunityExportRow) => commercial(r);

export const OPPORTUNITY_COLUMNS: Column<OpportunityExportRow>[] = [
  { id: 'name', label: 'Azienda', default: true, get: (r) => r.name },
  { id: 'sector', label: 'Settore', default: true, get: (r) => sectorOf(r) },
  { id: 'municipality', label: 'Comune', default: true, get: (r) => r.municipality_name },
  { id: 'region', label: 'Regione', default: true, get: (r) => regionOf(r.region_code) },
  { id: 'website', label: 'Sito web', default: true, get: (r) => r.website_url },
  { id: 'phone', label: 'Telefono (pubblico)', default: true, get: (r) => r.phone ?? null },
  { id: 'email', label: 'Email generica (pubblica)', default: true, get: (r) => r.email ?? null },
  { id: 'stage', label: 'Fase', default: true, get: (r) => stageLabel(r.opp_stage) },
  { id: 'priority', label: 'Priorità commerciale', default: true, get: (r) => PRIORITY[r.opp_priority] },
  { id: 'owner', label: 'Responsabile', default: true, get: (r) => r.opp_owner_name },
  { id: 'value', label: 'Valore stimato (€)', default: true, get: (r) => toEuro(r.opp_value_cents) },
  { id: 'services', label: 'Servizi proposti', default: true, get: (r) => r.service_names || null },
  {
    id: 'commercial_score',
    label: 'Punteggio commerciale',
    default: true,
    get: (r) => commercialOfOpp(r)?.score ?? null,
  },
  {
    id: 'commercial_source',
    label: 'Fonte del punteggio',
    default: true,
    get: (r) => commercialOfOpp(r)?.source ?? null,
  },
  {
    id: 'ai_confidence',
    label: 'Affidabilità della valutazione AI',
    default: false,
    get: (r) => (r.ai_confidence ? LEVEL[r.ai_confidence] : null),
  },
  { id: 'created', label: 'Creata il', default: true, get: (r) => day(r.opp_created_at) },
  { id: 'last_activity', label: 'Ultima attività', default: true, get: (r) => dateTime(r.opp_last_activity_at) },
  { id: 'last_contact', label: 'Ultimo contatto', default: true, get: (r) => day(r.opp_last_contact) },
  {
    id: 'next_due',
    label: 'Prossimo follow-up (data)',
    default: true,
    get: (r) => (r.nf_due_date ? r.nf_due_date.slice(0, 10) : null),
  },
  { id: 'next_title', label: 'Prossimo follow-up', default: true, get: (r) => r.nf_description },
  {
    id: 'overdue',
    label: 'Follow-up scaduto',
    default: true,
    get: (r) => (r.nf_due_date ? yesNo(r.nf_due_date.slice(0, 10) < todayInRome()) : null),
  },
  { id: 'lost_reason', label: 'Motivo della perdita', default: false, get: (r) => r.opp_lost_reason },
  { id: 'closed', label: 'Chiusa il', default: false, get: (r) => day(r.opp_closed_at) },
  { id: 'notes', label: 'Note interne', default: false, get: (r) => r.opp_notes },
];

export async function exportOpportunities(
  db: Queryable,
  f: Omit<CrmFilters, 'page' | 'pageSize'>,
  opts: { format: ExportFormat; fields?: string[]; name?: string; groupByStage: boolean; userId: string },
) {
  const today = todayInRome();
  // raggruppate per fase: ordine della pipeline, poi l'ordinamento scelto
  const q = crmQuery(
    { ...f, sort: opts.groupByStage ? 'stage' : f.sort, dir: opts.groupByStage ? 'asc' : f.dir, page: 1, pageSize: 1 },
    today,
  );
  const sql = `SELECT b.*${AUDIT_COLUMNS}${OPP_COLUMNS}, o.notes AS opp_notes,
      (SELECT max(a.occurred_at) FROM crm_activities a WHERE a.opportunity_id = o.id AND a.type IN ${CONTACT_TYPES}) AS opp_last_contact
    FROM ${q.from} WHERE ${q.whereSql} ORDER BY ${q.order}`;
  const { rows, truncated } = await readAll((limit, offset) =>
    db
      .query<OpportunityExportRow>(`${sql} LIMIT $${q.params.length + 1} OFFSET $${q.params.length + 2}`, [
        ...q.params,
        limit,
        offset,
      ])
      .then((r) => r.rows),
  );
  const names = await serviceNameMap(db);
  for (const r of rows) r.service_names = (r.opp_services ?? []).map((id) => names.get(id) ?? id).join(', ');
  return buildExport(db, {
    dataset: 'opportunities',
    name: opts.name ?? (opts.groupByStage ? 'pipeline_per_fase' : 'opportunita'),
    format: opts.format,
    columns: pickColumns(OPPORTUNITY_COLUMNS, opts.fields),
    rows,
    truncated,
    ...(opts.groupByStage
      ? { groupBy: (r: OpportunityExportRow) => stageLabel(r.opp_stage), groupOrder: STAGES.map((s) => s.label) }
      : {}),
    userId: opts.userId,
    filters: { ...f, groupByStage: opts.groupByStage },
  });
}

// ---------------------------------------------------------------- follow-up

export const FOLLOWUP_COLUMNS: Column<FollowUpListRow>[] = [
  { id: 'title', label: 'Titolo', default: true, get: (r) => r.description },
  { id: 'notes', label: 'Descrizione', default: true, get: (r) => r.notes },
  { id: 'business', label: 'Azienda', default: true, get: (r) => r.b_name },
  { id: 'municipality', label: 'Comune', default: true, get: (r) => r.b_municipality },
  { id: 'region', label: 'Regione', default: false, get: (r) => regionOf(r.b_region) },
  { id: 'stage', label: 'Fase dell’opportunità', default: true, get: (r) => stageLabel(r.o_stage) },
  { id: 'owner', label: 'Responsabile', default: true, get: (r) => r.o_owner_name },
  { id: 'priority', label: 'Priorità', default: true, get: (r) => PRIORITY[r.priority] },
  { id: 'status', label: 'Stato', default: true, get: (r) => FOLLOWUP_STATUS[r.status] },
  { id: 'due_date', label: 'Scadenza', default: true, get: (r) => r.due_date.slice(0, 10) },
  { id: 'due_time', label: 'Ora', default: true, get: (r) => (r.due_time ? r.due_time.slice(0, 5) : null) },
  {
    id: 'overdue',
    label: 'Scaduto',
    default: true,
    get: (r) => (r.status === 'pending' ? yesNo(r.due_date.slice(0, 10) < todayInRome()) : null),
  },
  { id: 'created', label: 'Creato il', default: false, get: (r) => dateTime(r.created_at) },
  { id: 'created_by', label: 'Creato da', default: false, get: (r) => r.created_by_name },
  { id: 'completed', label: 'Completato il', default: true, get: (r) => dateTime(r.completed_at) },
  { id: 'completed_by', label: 'Completato da', default: false, get: (r) => r.completed_by_name },
  { id: 'cancelled', label: 'Annullato il', default: false, get: (r) => dateTime(r.cancelled_at) },
  {
    id: 'cancel_reason',
    label: 'Motivo dell’annullamento',
    default: false,
    get: (r) => (r.cancel_reason ? CANCEL_REASON[r.cancel_reason] : null),
  },
];

export async function exportFollowUps(
  db: Queryable,
  f: FollowUpFilters,
  opts: { format: ExportFormat; fields?: string[]; name?: string; userId: string },
) {
  const q = followUpQuery(f, todayInRome());
  const sql = `SELECT ${FOLLOWUP_LIST_COLUMNS} FROM ${q.from} WHERE ${q.whereSql} ORDER BY ${q.order}`;
  const { rows, truncated } = await readAll((limit, offset) =>
    db
      .query<FollowUpListRow>(`${sql} LIMIT $${q.params.length + 1} OFFSET $${q.params.length + 2}`, [
        ...q.params,
        limit,
        offset,
      ])
      .then((r) => r.rows),
  );
  return buildExport(db, {
    dataset: 'followups',
    name: opts.name ?? 'follow-up',
    format: opts.format,
    columns: pickColumns(FOLLOWUP_COLUMNS, opts.fields),
    rows,
    truncated,
    userId: opts.userId,
    filters: f as Record<string, unknown>,
  });
}

// ---------------------------------------------------------------- cronologia delle attività

interface ActivityExportRow {
  occurred_at: Date;
  type: string;
  summary: string;
  notes: string | null;
  from_stage: string | null;
  to_stage: string | null;
  user_name: string | null;
  b_name: string;
  b_municipality: string | null;
  o_stage: string;
}

export const ACTIVITY_COLUMNS: Column<ActivityExportRow>[] = [
  { id: 'when', label: 'Data e ora', default: true, get: (r) => dateTime(r.occurred_at) },
  { id: 'type', label: 'Tipo', default: true, get: (r) => activityLabel(r.type) },
  { id: 'summary', label: 'Sintesi', default: true, get: (r) => r.summary },
  { id: 'notes', label: 'Note', default: true, get: (r) => r.notes },
  { id: 'business', label: 'Azienda', default: true, get: (r) => r.b_name },
  { id: 'municipality', label: 'Comune', default: false, get: (r) => r.b_municipality },
  { id: 'from_stage', label: 'Da fase', default: false, get: (r) => (r.from_stage ? stageLabel(r.from_stage) : null) },
  { id: 'to_stage', label: 'A fase', default: false, get: (r) => (r.to_stage ? stageLabel(r.to_stage) : null) },
  { id: 'current_stage', label: 'Fase attuale dell’opportunità', default: true, get: (r) => stageLabel(r.o_stage) },
  { id: 'user', label: 'Registrata da', default: true, get: (r) => r.user_name },
];

export async function exportActivities(
  db: Queryable,
  f: { from?: string; to?: string; types?: string[]; businessId?: string },
  opts: { format: ExportFormat; fields?: string[]; name?: string; userId: string },
) {
  const where: string[] = [];
  const params: unknown[] = [];
  const add = (sql: (p: string) => string, v: unknown) => {
    params.push(v);
    where.push(sql(`$${params.length}`));
  };
  // date italiane: dall'inizio del giorno "da" alla fine del giorno "a"
  if (f.from) add((p) => `a.occurred_at >= (${p}::date)::timestamp AT TIME ZONE 'Europe/Rome'`, f.from);
  if (f.to) add((p) => `a.occurred_at < ((${p}::date + 1)::timestamp AT TIME ZONE 'Europe/Rome')`, f.to);
  if (f.types?.length) add((p) => `a.type = ANY(${p})`, f.types);
  if (f.businessId) add((p) => `o.business_id = ${p}`, f.businessId);
  const sql = `SELECT a.occurred_at, a.type, a.summary, a.notes, a.from_stage, a.to_stage, u.display_name AS user_name,
      b.name AS b_name, b.municipality_name AS b_municipality, o.stage AS o_stage
    FROM crm_activities a JOIN crm_opportunities o ON o.id = a.opportunity_id JOIN businesses b ON b.id = o.business_id
      LEFT JOIN users u ON u.id = a.user_id
    WHERE ${where.length ? where.join(' AND ') : 'true'} ORDER BY a.occurred_at DESC, a.id`;
  const { rows, truncated } = await readAll((limit, offset) =>
    db
      .query<ActivityExportRow>(`${sql} LIMIT $${params.length + 1} OFFSET $${params.length + 2}`, [
        ...params,
        limit,
        offset,
      ])
      .then((r) => r.rows),
  );
  return buildExport(db, {
    dataset: 'activities',
    name: opts.name ?? 'attivita_commerciali',
    format: opts.format,
    columns: pickColumns(ACTIVITY_COLUMNS, opts.fields),
    rows,
    truncated,
    userId: opts.userId,
    filters: f,
  });
}
