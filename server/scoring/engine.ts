import { CATEGORIES, type CategoryId } from '../discovery/categories.ts';
import { FINDINGS, SERVICE_AREAS, type ServiceArea } from '../audit/findings.ts';
import {
  CAPABILITIES,
  DIMENSIONS,
  SCORING_ALGORITHM_VERSION,
  type Capability,
  type Dimension,
  type ScoringConfig,
} from './config.ts';

/*
 * Motore del punteggio dei lead: funzione PURA e deterministica (stessi dati + stessa configurazione + stesso
 * giorno di calcolo → stesso risultato). Nessun accesso al database, nessuna chiamata esterna.
 *
 *   punteggio grezzo = Σ (valore_dimensione × peso) / Σ pesi delle dimensioni CON PROVE
 *
 * Una dimensione senza prove è "sconosciuta": non vale né 0 né 100, esce dal calcolo e abbassa la completezza.
 * Opportunità (il punteggio) e affidabilità delle prove sono calcolate separatamente.
 * Ogni frase delle spiegazioni deriva da un dato presente nell'input: nessun testo generico che affermi fatti.
 */

export type Severity = 'info' | 'low' | 'medium' | 'high';
export type Confidence = 'high' | 'medium' | 'low';
export type ScoreStatus = 'ranked' | 'needs_review' | 'insufficient_data' | 'not_suitable';
export type Band = 'A' | 'B' | 'C' | 'low';
export type CapabilityState = 'present' | 'missing' | 'not_detected' | 'unknown';
export type Freshness = 'fresh' | 'aging' | 'stale';

export interface ScoringFinding {
  code: string;
  category: string;
  severity: Severity;
  confidence: Confidence;
  observation: string;
  actionable: boolean;
  service: string | null;
  page: string;
}

export interface ScoringAudit {
  id: string;
  runStatus: 'completed' | 'partial' | 'failed';
  websiteStatus: string;
  finishedAt: string;
  pagesInspected: number;
  /** Sintesi strutturata salvata dall'audit (Fase 3). */
  summary: {
    homepage?: { jsRendered: boolean | null } | null;
    hasViewport?: boolean | null;
    signals?: Record<string, boolean> | null;
    /** Piattaforme riconosciute nel codice (es. Magento, Shopify). */
    platforms?: string[] | null;
  };
  findings: ScoringFinding[];
}

export interface ScoringInput {
  business: {
    id: string;
    category: string;
    municipalityCode: string | null;
    websiteUrl: string | null;
    websiteShared: boolean;
    has: { website: boolean; address: boolean; phone: boolean; email: boolean; openingHours: boolean };
    completeness: number;
    lastVerifiedAt: string;
    pendingReviews: number;
  };
  website: {
    websiteId: string | null;
    /** Indirizzo con cui il sito è stato collegato all'ultimo audit (null se mai collegato). */
    linkedUrl: string | null;
    /** Stato registrato per il collegamento senza sito (not_found / invalid_url), se presente. */
    linkStatus: string | null;
  };
  /** Ultimo audit valido del sito collegato (null se mai verificato). */
  audit: ScoringAudit | null;
  /** Stato del sito negli ultimi audit, dal più recente (per riconoscere un problema ripetuto). */
  recentStatuses: string[];
}

export interface Signal {
  /** fact = osservato e registrato; inference = opportunità dedotta dai fatti. */
  kind: 'fact' | 'inference';
  dimension: Dimension | 'status';
  text: string;
  ref?: { auditId?: string; codes?: string[]; page?: string; capability?: Capability };
}

export interface DimensionResult {
  score: number | null;
  weight: number;
  /** Peso effettivo dopo la normalizzazione sulle sole dimensioni con prove (in %). */
  effectiveWeight: number;
  /** Punti portati al punteggio grezzo. */
  contribution: number;
  basis: string[];
}

export interface ScoreResult {
  algorithmVersion: number;
  status: ScoreStatus;
  /** Punteggio intero 0–100; null con dati insufficienti o settore escluso (il valore provvisorio resta in rawScore). */
  score: number | null;
  rawScore: number | null;
  band: Band | null;
  confidence: { value: number; level: Confidence; components: Record<string, number> };
  completeness: { value: number; components: Record<string, number> };
  dimensions: Record<Dimension, DimensionResult>;
  capabilities: {
    capability: Capability;
    label: string;
    state: CapabilityState;
    importance: number;
    service: ServiceArea;
  }[];
  services: { service: ServiceArea; label: string; relevance: number; supported: boolean; evidence: string[] }[];
  topFindings: {
    group: string;
    points: number;
    codes: string[];
    title: string;
    severity: Severity;
    page: string;
    auditId: string;
  }[];
  signals: { positive: Signal[]; negative: Signal[]; unknown: Signal[] };
  reasons: string[];
  nextStep: string;
  explanation: string;
  evidence: {
    auditId: string | null;
    auditFinishedAt: string | null;
    auditAgeDays: number | null;
    freshness: Freshness | null;
    websiteId: string | null;
  };
}

const DAY = 86_400_000;
const round1 = (n: number) => Math.round(n * 10) / 10;
const TECHNICAL_CATEGORIES = new Set(['availability', 'security', 'seo', 'mobile', 'performance']);
const FAILURE_STATUSES = new Set(['unreachable', 'timeout']);

const SIGNAL_OF: Partial<Record<Capability, string[]>> = {
  contact_route: ['contactPage', 'phoneLink', 'emailLink', 'contactForm'],
  call_to_action: ['callToAction'],
  services_info: ['servicesSection'],
  opening_hours: ['openingHours'],
  booking: ['booking'],
  appointment: ['appointment', 'booking'],
  reservation: ['booking', 'ordering'],
  direct_booking: ['booking'],
  online_ordering: ['ordering'],
  menu: ['menu'],
  rooms: ['rooms'],
  schedule: ['schedule'],
  catalog: ['catalog', 'ecommerce'],
  ecommerce: ['ecommerce'],
  quote_request: ['contactForm'],
};

export function freshnessOf(ageDays: number, config: ScoringConfig): Freshness {
  if (ageDays <= config.freshness.auditFreshDays) return 'fresh';
  return ageDays <= config.freshness.auditStaleDays ? 'aging' : 'stale';
}

export type WebsiteSituation = ReturnType<typeof websiteSituation>;

/** Piattaforme usate per vendere online (riconosciute dall'audit, Fase 3). */
export const ECOMMERCE_PLATFORMS = ['Shopify', 'WooCommerce', 'Magento', 'PrestaShop'];

export const hasEcommercePlatform = (audit: ScoringAudit | null) =>
  Boolean(audit?.summary.platforms?.some((p) => ECOMMERCE_PLATFORMS.includes(p)));

/**
 * Stato di una capacità digitale con le prove disponibili (usato anche dall'abbinamento ai servizi, Fase 5).
 *  - present: rilevata; missing: assente in modo misurato (proprietà del codice della pagina principale);
 *  - not_detected: cercata nelle pagine esaminate e non trovata; unknown: non valutabile.
 * L'audit passato deve essere quello valido per l'indirizzo attuale (vedi websiteSituation).
 */
export function capabilityState(
  capability: Capability,
  situation: WebsiteSituation,
  audit: ScoringAudit | null,
): CapabilityState {
  if (capability === 'website') {
    if (situation.noOwnWebsite) return 'not_detected';
    return situation.reachable ? 'present' : 'unknown';
  }
  if (!situation.reachable || !audit) return 'unknown';
  const signals = audit.summary.signals ?? null;
  const codes = new Set(audit.findings.map((f) => f.code));
  if (capability === 'mobile') {
    // proprietà misurata nel codice della pagina principale: "assente" è un fatto, non una supposizione
    if (audit.summary.hasViewport === null || audit.summary.hasViewport === undefined) return 'unknown';
    return codes.has('MOBILE_NO_VIEWPORT') || codes.has('MOBILE_VIEWPORT_FIXED') ? 'missing' : 'present';
  }
  // una piattaforma di e-commerce nel codice del sito è una prova diretta di vendita online (anche se il carrello
  // non compare nelle pagine esaminate)
  if ((capability === 'ecommerce' || capability === 'catalog') && hasEcommercePlatform(audit)) return 'present';
  if (!signals) return 'unknown';
  if (capability === 'local_seo')
    return signals.address && !codes.has('SEO_NO_STRUCTURED_DATA') ? 'present' : 'not_detected';
  const keys = SIGNAL_OF[capability] ?? [];
  // contenuto cercato nelle pagine esaminate: se non c'è è "non rilevato", mai "assente"
  if (keys.some((k) => signals[k])) return 'present';
  return audit.summary.homepage?.jsRendered ? 'unknown' : 'not_detected';
}

/** Situazione del sito per il punteggio: cosa sappiamo davvero. */
export function websiteSituation(input: ScoringInput, config: ScoringConfig) {
  const b = input.business;
  const noOwnWebsite = !b.websiteUrl || b.websiteShared;
  const a = input.audit;
  // l'audit vale solo per l'indirizzo con cui è stato fatto: se la fonte indica ora un altro sito, va ripetuto
  const changed = Boolean(a && input.website.linkedUrl && b.websiteUrl && input.website.linkedUrl !== b.websiteUrl);
  const auditApplies = Boolean(a) && !changed && !noOwnWebsite;
  const reachable =
    auditApplies && a!.runStatus !== 'failed' && (a!.websiteStatus === 'valid' || a!.websiteStatus === 'redirected');
  const n = config.technical.repeatedFailureAudits;
  const repeatedFailure =
    auditApplies &&
    input.recentStatuses.length >= n &&
    input.recentStatuses.slice(0, n).every((s) => FAILURE_STATUSES.has(s));
  return { noOwnWebsite, changed, auditApplies, reachable, repeatedFailure };
}

/** Raggruppa i rilievi dello stesso problema di fondo: conta il più forte, più una frazione degli altri. */
function technicalPoints(audit: ScoringAudit, config: ScoringConfig) {
  const t = config.technical;
  const groupOf = new Map<string, string>();
  for (const [g, codes] of Object.entries(t.groups)) for (const c of codes) groupOf.set(c, g);
  const byCode = new Map<string, { points: number; f: ScoringFinding; pages: Set<string> }>();
  for (const f of audit.findings) {
    if (!TECHNICAL_CATEGORIES.has(f.category) || !f.actionable || f.observation === 'not_inspected') continue;
    const points = t.severityPoints[f.severity] * t.confidenceFactor[f.confidence];
    if (points <= 0) continue;
    const cur = byCode.get(f.code);
    // lo stesso rilievo su più pagine è un solo problema (le pagine servono come conferma)
    if (!cur) byCode.set(f.code, { points, f, pages: new Set([f.page]) });
    else {
      cur.pages.add(f.page);
      if (points > cur.points) Object.assign(cur, { points, f });
    }
  }
  const groups = new Map<string, { codes: { code: string; points: number; f: ScoringFinding; pages: number }[] }>();
  for (const [code, v] of byCode) {
    const g = groupOf.get(code) ?? code;
    const entry = groups.get(g) ?? { codes: [] };
    entry.codes.push({ code, points: v.points, f: v.f, pages: v.pages.size });
    groups.set(g, entry);
  }
  const result = [...groups.entries()].map(([group, { codes }]) => {
    codes.sort((x, y) => y.points - x.points || x.code.localeCompare(y.code));
    const [top, ...rest] = codes;
    const points = Math.min(
      t.severityPoints.high,
      top!.points + t.secondaryFactor * rest.reduce((s, c) => s + c.points, 0),
    );
    return {
      group,
      points: round1(points),
      top: top!,
      codes: codes.map((c) => c.code),
      corroborated: codes.some((c) => c.pages > 1),
    };
  });
  result.sort((x, y) => y.points - x.points || x.group.localeCompare(y.group));
  return result;
}

export function scoreLead(input: ScoringInput, config: ScoringConfig, now: Date): ScoreResult {
  const b = input.business;
  const category = b.category as CategoryId;
  const rules = config.categories[category];
  const situation = websiteSituation(input, config);
  const audit = situation.auditApplies ? input.audit : null;
  const positive: Signal[] = [];
  const negative: Signal[] = [];
  const unknown: Signal[] = [];
  const reasons: string[] = [];
  const auditRef = audit ? { auditId: audit.id } : undefined;

  const ageDays = audit ? Math.max(0, Math.floor((now.getTime() - Date.parse(audit.finishedAt)) / DAY)) : null;
  const freshness = ageDays === null ? null : freshnessOf(ageDays, config);
  const sourceFresh = now.getTime() - Date.parse(b.lastVerifiedAt) <= config.freshness.sourceFreshDays * DAY;

  // ---------- situazione del sito (fatti) ----------
  if (situation.noOwnWebsite) {
    unknown.push({
      kind: 'fact',
      dimension: 'status',
      text: b.websiteShared
        ? 'La fonte indica solo una pagina su una piattaforma condivisa (social o directory): un sito proprio non è stato trovato, ma la sua assenza non è verificata.'
        : 'La fonte non indica un sito web: l’assenza di un sito non è verificata.',
    });
  } else if (input.audit && situation.changed) {
    unknown.push({
      kind: 'fact',
      dimension: 'status',
      text: 'L’indirizzo del sito indicato dalla fonte è cambiato dopo l’ultimo audit: le prove precedenti non valgono più.',
    });
  } else if (!input.audit) {
    unknown.push({
      kind: 'fact',
      dimension: 'status',
      text: 'Il sito indicato dalla fonte non è ancora stato verificato con un audit.',
    });
  } else if (situation.repeatedFailure) {
    positive.push({
      kind: 'fact',
      dimension: 'technical',
      text: `Il sito non ha risposto in ${config.technical.repeatedFailureAudits} audit consecutivi.`,
      ref: auditRef,
    });
  } else if (!situation.reachable) {
    unknown.push({
      kind: 'fact',
      dimension: 'status',
      text:
        input.audit.websiteStatus === 'blocked'
          ? 'Il sito ha negato l’accesso al controllo: non è possibile valutarlo (non significa che manchi).'
          : 'Il sito non ha risposto all’ultimo audit: un singolo controllo non basta a considerarlo assente o guasto.',
      ref: auditRef,
    });
  } else {
    positive.push({
      kind: 'fact',
      dimension: 'status',
      text: `Sito ufficiale raggiungibile, verificato dall’audit del ${audit!.finishedAt.slice(0, 10)}.`,
      ref: auditRef,
    });
  }

  // ---------- A. problemi tecnici del sito ----------
  let technical: number | null = null;
  const technicalBasis: string[] = [];
  const groups = audit && situation.reachable ? technicalPoints(audit, config) : [];
  if (audit && situation.reachable) {
    const total = groups.reduce((s, g) => s + g.points, 0);
    technical = Math.min(100, Math.round((total / config.technical.saturationPoints) * 100));
    technicalBasis.push(
      `${groups.length} ${groups.length === 1 ? 'problema' : 'problemi'} distinti dai rilievi dell’audit (${round1(total)} punti su ${config.technical.saturationPoints}).`,
    );
    if (groups.length === 0)
      negative.push({
        kind: 'fact',
        dimension: 'technical',
        text: 'Nessun rilievo tecnico rilevante nell’ultimo audit.',
        ref: auditRef,
      });
    for (const g of groups.slice(0, 4)) {
      const def = FINDINGS[g.top.code as keyof typeof FINDINGS];
      positive.push({
        kind: 'fact',
        dimension: 'technical',
        text: `${def?.title ?? g.top.code}${g.codes.length > 1 ? ` (e altri ${g.codes.length - 1} rilievi dello stesso problema)` : ''}.`,
        ref: { auditId: audit.id, codes: g.codes, page: g.top.f.page },
      });
    }
  } else if (situation.repeatedFailure) {
    technical = config.technical.repeatedFailureScore;
    technicalBasis.push('Sito non raggiungibile in audit consecutivi.');
  } else {
    unknown.push({
      kind: 'fact',
      dimension: 'technical',
      text: 'Problemi tecnici del sito: non valutabili senza un audit riuscito.',
    });
  }

  // ---------- B. capacità digitali ----------
  const signals = audit?.summary.signals ?? null;
  const jsRendered = Boolean(audit?.summary.homepage?.jsRendered);
  const capabilityList = (Object.entries(rules?.capabilities ?? {}) as [Capability, number][]).sort(
    (x, y) => y[1] - x[1] || x[0].localeCompare(y[0]),
  );
  const capabilities: ScoreResult['capabilities'] = capabilityList.map(([capability, importance]) => {
    const state = capabilityState(capability, situation, audit);
    return {
      capability,
      label: CAPABILITIES[capability],
      state,
      importance,
      service: config.capabilities.services[capability],
    };
  });
  let capabilitiesScore: number | null = null;
  const known = capabilities.filter((c) => c.state !== 'unknown');
  if (known.length) {
    const gap = known.reduce(
      (s, c) =>
        s +
        c.importance *
          (c.state === 'present' ? 0 : config.capabilities.gapFactor[c.state as 'missing' | 'not_detected']),
      0,
    );
    capabilitiesScore = Math.round((gap / known.reduce((s, c) => s + c.importance, 0)) * 100);
  }
  for (const c of capabilities) {
    const service = SERVICE_AREAS[c.service];
    if (c.state === 'missing')
      positive.push({
        kind: 'inference',
        dimension: 'capabilities',
        text: `${c.label}: assente (misurato). Possibile intervento: ${service}.`,
        ref: { ...auditRef, capability: c.capability },
      });
    else if (c.state === 'not_detected' && c.capability !== 'website')
      positive.push({
        kind: 'inference',
        dimension: 'capabilities',
        text: `${c.label}: non rilevato nelle pagine esaminate. Possibile intervento: ${service}.`,
        ref: { ...auditRef, capability: c.capability },
      });
    else if (c.state === 'present' && c.capability !== 'website')
      negative.push({
        kind: 'fact',
        dimension: 'capabilities',
        text: `${c.label}: presente.`,
        ref: { ...auditRef, capability: c.capability },
      });
    else if (c.state === 'unknown' && c.capability !== 'website')
      unknown.push({
        kind: 'fact',
        dimension: 'capabilities',
        text: `${c.label}: non valutabile${jsRendered ? ' (contenuti generati da JavaScript)' : ''}.`,
      });
  }

  // ---------- C. opportunità di settore ----------
  let industry: number | null = null;
  const services: ScoreResult['services'] = [];
  const evidenceAvailable = situation.reachable || situation.repeatedFailure || situation.noOwnWebsite;
  if (rules && evidenceAvailable) {
    for (const [service, relevance] of Object.entries(rules.services) as [ServiceArea, number][]) {
      const ev: string[] = [];
      for (const g of groups)
        if (g.top.f.service === service) ev.push(FINDINGS[g.top.code as keyof typeof FINDINGS]?.title ?? g.top.code);
      for (const c of capabilities)
        if (c.service === service && (c.state === 'missing' || c.state === 'not_detected'))
          ev.push(`${c.label} ${c.state === 'missing' ? 'assente' : 'non rilevato'}`);
      if (situation.repeatedFailure && service === 'hosting_assistenza')
        ev.push('Sito non raggiungibile in audit consecutivi');
      services.push({
        service,
        label: SERVICE_AREAS[service],
        relevance,
        supported: ev.length > 0,
        evidence: ev.slice(0, 4),
      });
    }
    services.sort(
      (x, y) =>
        Number(y.supported) - Number(x.supported) || y.relevance - x.relevance || x.service.localeCompare(y.service),
    );
    const totalRel = services.reduce((s, x) => s + x.relevance, 0);
    const supportedRel = services.filter((x) => x.supported).reduce((s, x) => s + x.relevance, 0);
    // il settore da solo non basta: senza lacune collegate ai suoi servizi la dimensione vale 0
    industry = totalRel ? Math.round((rules.baseRelevance * supportedRel) / totalRel) : 0;
  } else
    unknown.push({
      kind: 'fact',
      dimension: 'industry',
      text: 'Opportunità di settore: nessuna prova sul sito su cui basarla.',
    });

  // ---------- D. affidabilità delle prove (anche dimensione del punteggio) ----------
  const conf: Record<string, number> = {};
  conf.audit = situation.reachable
    ? audit!.runStatus === 'completed'
      ? 35
      : 20
    : situation.repeatedFailure
      ? 20
      : input.audit && !situation.changed && !situation.noOwnWebsite
        ? 5
        : 0;
  conf.freshness = freshness === 'fresh' ? 25 : freshness === 'aging' ? 12 : 0;
  const contributing = groups.reduce((s, g) => s + g.points, 0);
  conf.findings = situation.reachable
    ? contributing > 0
      ? Math.round(
          (20 * groups.filter((g) => g.top.f.confidence === 'high').reduce((s, g) => s + g.points, 0)) / contributing,
        )
      : 10
    : 0;
  conf.source = (b.municipalityCode ? 5 : 0) + (sourceFresh ? 5 : 0);
  conf.corroboration = situation.reachable
    ? (audit!.pagesInspected >= 2 ? 5 : 0) + (groups.some((g) => g.corroborated) ? 5 : 0)
    : 0;
  const confidenceValue = Math.min(
    100,
    Object.values(conf).reduce((s, v) => s + v, 0),
  );
  const confidenceLevel: Confidence =
    confidenceValue >= config.thresholds.confidenceHigh
      ? 'high'
      : confidenceValue >= config.thresholds.confidenceMedium
        ? 'medium'
        : 'low';
  if (freshness === 'stale')
    unknown.push({
      kind: 'fact',
      dimension: 'evidence',
      text: `L’audit ha ${ageDays} giorni: le prove potrebbero non descrivere più il sito.`,
      ref: auditRef,
    });
  else if (freshness === 'aging')
    unknown.push({
      kind: 'fact',
      dimension: 'evidence',
      text: `L’audit ha ${ageDays} giorni: conviene aggiornarlo prima di un contatto.`,
      ref: auditRef,
    });
  if (situation.reachable && audit!.runStatus === 'partial')
    unknown.push({
      kind: 'fact',
      dimension: 'evidence',
      text: 'L’ultimo audit è parziale: alcuni controlli non sono stati completati.',
      ref: auditRef,
    });
  if (!sourceFresh)
    unknown.push({
      kind: 'fact',
      dimension: 'evidence',
      text: 'I dati della fonte non sono stati riconfermati di recente.',
    });

  // ---------- E. indicatori commerciali osservabili ----------
  const cw = config.commercial.weights;
  const indicators: { key: keyof typeof cw; state: boolean | null; text: string }[] = [
    {
      key: 'activeOperation',
      state: sourceFresh ? true : null,
      text: 'Attività confermata di recente dalla fonte pubblica',
    },
    { key: 'onlinePresence', state: situation.reachable ? true : null, text: 'Sito ufficiale attivo' },
    {
      key: 'identifiableOffer',
      state:
        signals && situation.reachable
          ? Boolean(signals.servicesSection || signals.catalog || signals.menu || signals.rooms)
          : null,
      text: 'Servizi o prodotti chiaramente presentati',
    },
    {
      key: 'contactChannel',
      state:
        b.has.phone ||
        b.has.email ||
        (signals &&
          situation.reachable &&
          (signals.contactPage || signals.phoneLink || signals.emailLink || signals.contactForm))
          ? true
          : null,
      text: 'Canale di contatto aziendale pubblico',
    },
    {
      key: 'existingOnlineProcess',
      state:
        signals && situation.reachable
          ? Boolean(signals.booking || signals.ordering || signals.ecommerce || hasEcommercePlatform(audit))
          : null,
      text: 'Processo di prenotazione o vendita online già presente (migliorabile)',
    },
    {
      key: 'actionableProblem',
      state: situation.reachable
        ? groups.some(
            (g) => g.top.f.confidence === 'high' && (g.top.f.severity === 'high' || g.top.f.severity === 'medium'),
          )
        : situation.repeatedFailure
          ? true
          : null,
      text: 'Problema digitale specifico e documentato',
    },
  ];
  const knownW = indicators.filter((i) => i.state !== null).reduce((s, i) => s + cw[i.key], 0);
  let commercial: number | null = null;
  if (knownW >= config.commercial.minKnownWeight && knownW > 0) {
    commercial = Math.round(
      (indicators.filter((i) => i.state === true).reduce((s, i) => s + cw[i.key], 0) / knownW) * 100,
    );
    for (const i of indicators.filter((x) => x.state === true))
      positive.push({ kind: 'fact', dimension: 'commercial', text: `${i.text}.` });
  }
  for (const i of indicators.filter((x) => x.state === null))
    unknown.push({ kind: 'fact', dimension: 'commercial', text: `${i.text}: non verificabile con i dati attuali.` });
  unknown.push({ kind: 'fact', dimension: 'commercial', text: 'Numero di sedi: non disponibile in modo affidabile.' });

  // ---------- combinazione ----------
  const values: Record<Dimension, number | null> = {
    technical,
    capabilities: capabilitiesScore,
    industry,
    evidence: confidenceValue,
    commercial,
  };
  const basis: Record<Dimension, string[]> = {
    technical: technicalBasis,
    capabilities: known.length
      ? [`${known.length} di ${capabilities.length} capacità pertinenti valutate.`]
      : ['Nessuna capacità valutabile.'],
    industry:
      industry === null
        ? ['Nessuna prova su cui basare l’opportunità di settore.']
        : [
            `Pertinenza di base del settore ${rules?.baseRelevance ?? 0}/100, applicata solo ai servizi sostenuti da prove.`,
          ],
    evidence: [`Affidabilità delle prove ${confidenceValue}/100.`],
    commercial:
      commercial === null
        ? ['Indicatori commerciali verificabili insufficienti.']
        : [`Indicatori verificabili: peso ${knownW}.`],
  };
  const totalWeight = DIMENSIONS.reduce((s, d) => s + config.weights[d], 0);
  const activeWeight = DIMENSIONS.reduce((s, d) => s + (values[d] === null ? 0 : config.weights[d]), 0);
  const dimensions = {} as Record<Dimension, DimensionResult>;
  let raw: number | null = null;
  if (activeWeight > 0) raw = DIMENSIONS.reduce((s, d) => s + (values[d] ?? 0) * config.weights[d], 0) / activeWeight;
  for (const d of DIMENSIONS) {
    const active = values[d] !== null && activeWeight > 0;
    const eff = active ? config.weights[d] / activeWeight : 0;
    dimensions[d] = {
      score: values[d],
      weight: config.weights[d],
      effectiveWeight: round1(eff * 100),
      contribution: active ? round1(values[d]! * eff) : 0,
      basis: basis[d],
    };
  }
  const rawScore = raw === null ? null : Math.round(raw * 100) / 100;

  // ---------- completezza dei dati ----------
  const cc = config.completeness;
  const capTotal = capabilities.reduce((s, c) => s + c.importance, 0);
  const comp: Record<string, number> = {
    audit: round1(
      cc.audit *
        (situation.reachable
          ? audit!.runStatus === 'completed'
            ? 1
            : 0.6
          : situation.repeatedFailure
            ? 0.75
            : input.audit && !situation.changed && !situation.noOwnWebsite
              ? 0.25
              : 0),
    ),
    capabilities: round1(capTotal ? (cc.capabilities * known.reduce((s, c) => s + c.importance, 0)) / capTotal : 0),
    businessData: round1((cc.businessData * b.completeness) / 5),
    location: b.municipalityCode ? cc.location : 0,
  };
  const compTotal = cc.audit + cc.capabilities + cc.businessData + cc.location;
  const completeness = compTotal ? Math.round((Object.values(comp).reduce((s, v) => s + v, 0) / compTotal) * 100) : 0;

  // ---------- stato e fascia ----------
  let status: ScoreStatus = 'ranked';
  if (config.rules.notSuitableCategories.includes(category)) {
    status = 'not_suitable';
    reasons.push(`Settore escluso dalla configurazione (${CATEGORIES[category]?.label ?? category}).`);
  } else if (!rules) {
    status = 'insufficient_data';
    reasons.push('Settore senza regole di punteggio configurate.');
  } else if (
    completeness < config.thresholds.minCompleteness ||
    (activeWeight / totalWeight) * 100 < config.thresholds.minActiveWeightPct
  ) {
    status = 'insufficient_data';
    reasons.push(
      `Dati insufficienti per un punteggio affidabile (completezza ${completeness}/100, minimo ${config.thresholds.minCompleteness}).`,
    );
  }
  const provisional = rawScore === null ? null : Math.max(0, Math.min(100, Math.round(rawScore)));
  const bandOf = (s: number): Band =>
    s >= config.bands.A ? 'A' : s >= config.bands.B ? 'B' : s >= config.bands.C ? 'C' : 'low';
  if (status === 'ranked' && provisional !== null) {
    if (b.pendingReviews > 0) {
      status = 'needs_review';
      reasons.push('Possibile duplicato da verificare.');
    }
    if (confidenceValue < config.thresholds.minConfidence && provisional >= config.bands.C) {
      status = 'needs_review';
      reasons.push(
        `Opportunità apparente ma prove poco affidabili (affidabilità ${confidenceValue}/100): verificare prima di classificare.`,
      );
    }
  }
  const score = status === 'ranked' || status === 'needs_review' ? provisional : null;
  const band = score === null ? null : bandOf(score);

  // ---------- prossimo passo ----------
  let nextStep: string;
  if (status === 'not_suitable') nextStep = 'Nessuna azione: settore escluso dalla configurazione del punteggio.';
  else if (status === 'insufficient_data')
    nextStep = situation.noOwnWebsite
      ? 'Verifica se l’azienda ha un sito proprio: la fonte non ne indica uno.'
      : situation.changed
        ? 'Ripeti l’audit: l’indirizzo del sito è cambiato.'
        : !input.audit
          ? 'Avvia l’audit del sito per raccogliere le prove.'
          : !situation.reachable && !situation.repeatedFailure
            ? 'Ripeti l’audit più tardi: il sito non era raggiungibile o ha negato l’accesso.'
            : 'Completa i dati dell’azienda prima di valutarla.';
  else if (status === 'needs_review')
    nextStep =
      b.pendingReviews > 0
        ? 'Risolvi il possibile duplicato, poi rivaluta il lead.'
        : 'Verifica le prove (ad esempio ripetendo l’audit) prima di un contatto.';
  else
    nextStep =
      band === 'A'
        ? 'Rivedi le prove e dai priorità al contatto.'
        : band === 'B'
          ? 'Esamina le prove e valuta un contatto.'
          : band === 'C'
            ? 'Approfondisci prima di decidere.'
            : 'Nessuna azione: le prove attuali indicano un’opportunità debole.';
  if ((status === 'ranked' || status === 'needs_review') && freshness && freshness !== 'fresh')
    nextStep += ' Aggiorna l’audit prima del contatto.';

  // ---------- spiegazione (solo da dati presenti) ----------
  const parts: string[] = [];
  if (situation.reachable) {
    const actionable = groups.length;
    const highs = groups.filter((g) => g.top.f.severity === 'high').length;
    parts.push(
      actionable
        ? `sito ufficiale raggiungibile con ${actionable} ${actionable === 1 ? 'problema tecnico documentato' : 'problemi tecnici documentati'}${highs ? ` (${highs} di gravità alta)` : ''}`
        : 'sito ufficiale raggiungibile senza problemi tecnici rilevanti',
    );
  } else if (situation.repeatedFailure) parts.push('sito non raggiungibile in audit consecutivi');
  else if (situation.noOwnWebsite) parts.push('nessun sito proprio indicato dalla fonte (non verificato)');
  else if (!input.audit) parts.push('sito non ancora verificato');
  else parts.push('sito non valutabile nell’ultimo audit');
  const gaps = capabilities
    .filter((c) => c.capability !== 'website' && (c.state === 'missing' || c.state === 'not_detected'))
    .slice(0, 2);
  // "assenti: …" / "non rilevati nelle pagine esaminate: …": nessun accordo di genere con le etichette, sigle intatte
  const lower = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);
  const missing = gaps.filter((g) => g.state === 'missing').map((g) => lower(g.label));
  const notDetected = gaps.filter((g) => g.state === 'not_detected').map((g) => lower(g.label));
  if (missing.length) parts.push(`assenti: ${missing.join(', ')}`);
  if (notDetected.length) parts.push(`non rilevati nelle pagine esaminate: ${notDetected.join(', ')}`);
  if (freshness)
    parts.push(
      `prove da un audit ${freshness === 'fresh' ? 'recente' : freshness === 'aging' ? `di ${ageDays} giorni fa` : `superato (${ageDays} giorni)`}`,
    );
  const head =
    status === 'ranked'
      ? band === 'low'
        ? 'Priorità bassa'
        : `Priorità ${band}`
      : status === 'needs_review'
        ? `Da verificare (punteggio provvisorio ${score})`
        : status === 'insufficient_data'
          ? 'Dati insufficienti'
          : 'Non adatta';
  const levelLabel = { high: 'alta', medium: 'media', low: 'bassa' }[confidenceLevel];
  const explanation = `${head}: ${parts.join('; ')}. Affidabilità delle prove: ${levelLabel}.${reasons.length ? ` ${reasons.join(' ')}` : ''}`;

  return {
    algorithmVersion: SCORING_ALGORITHM_VERSION,
    status,
    score,
    rawScore,
    band,
    confidence: { value: confidenceValue, level: confidenceLevel, components: conf },
    completeness: { value: completeness, components: comp },
    dimensions,
    capabilities,
    services,
    topFindings: groups.slice(0, 5).map((g) => ({
      group: g.group,
      points: g.points,
      codes: g.codes,
      title: FINDINGS[g.top.code as keyof typeof FINDINGS]?.title ?? g.top.code,
      severity: g.top.f.severity,
      page: g.top.f.page,
      auditId: audit!.id,
    })),
    signals: { positive, negative, unknown },
    reasons,
    nextStep,
    explanation,
    evidence: {
      auditId: audit?.id ?? (situation.auditApplies ? (input.audit?.id ?? null) : null),
      auditFinishedAt: audit?.finishedAt ?? null,
      auditAgeDays: ageDays,
      freshness,
      websiteId: input.website.websiteId,
    },
  };
}
