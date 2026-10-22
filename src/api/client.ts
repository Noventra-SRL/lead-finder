/*
 * Client dell'API: stessa origine (/api), cookie di sessione HttpOnly gestito dal browser,
 * nessun token in JavaScript. Gli errori arrivano come ApiError con codice, messaggio ed errori per campo.
 */

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly fields: Record<string, string>;
  readonly requestId?: string;
  /** Dati aggiuntivi dell'errore (es. l'id della ricerca identica già attiva). */
  readonly data?: Record<string, unknown>;
  constructor(
    status: number,
    code: string,
    message: string,
    fields: Record<string, string> = {},
    requestId?: string,
    data?: Record<string, unknown>,
  ) {
    super(message);
    this.status = status;
    this.code = code;
    this.fields = fields;
    this.requestId = requestId;
    this.data = data;
  }
}

type Listener = (error: ApiError) => void;
const authListeners = new Set<Listener>();

/** Notifica sessione scaduta o cambio password obbligatorio (gestiti dal contesto di autenticazione). */
export function onAuthProblem(listener: Listener): () => void {
  authListeners.add(listener);
  return () => authListeners.delete(listener);
}

const AUTH_CODES = new Set(['UNAUTHENTICATED', 'SESSION_EXPIRED', 'PASSWORD_CHANGE_REQUIRED']);

export async function api<T>(
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
  path: string,
  body?: unknown,
): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`/api${path}`, {
      method,
      credentials: 'same-origin',
      headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new ApiError(0, 'NETWORK_ERROR', 'Server non raggiungibile. Controlla la connessione e riprova.');
  }
  if (res.status === 204) return undefined as T;
  let data: unknown = null;
  const text = await res.text();
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      throw new ApiError(res.status, 'INVALID_RESPONSE', `Risposta non valida dal server (HTTP ${res.status}).`);
    }
  }
  if (!res.ok) {
    const e =
      (data as {
        error?: { code?: string; message?: string; fields?: Record<string, string>; data?: Record<string, unknown> };
        requestId?: string;
      } | null) ?? {};
    const error = new ApiError(
      res.status,
      e.error?.code ?? 'HTTP_ERROR',
      e.error?.message ?? `Richiesta non riuscita (HTTP ${res.status}).`,
      e.error?.fields ?? {},
      e.requestId,
      e.error?.data,
    );
    if (AUTH_CODES.has(error.code) && !path.startsWith('/auth/login')) for (const l of authListeners) l(error);
    throw error;
  }
  return data as T;
}

export const get = <T>(path: string) => api<T>('GET', path);
export const post = <T>(path: string, body?: unknown) => api<T>('POST', path, body ?? {});
export const patch = <T>(path: string, body: unknown) => api<T>('PATCH', path, body);
export const put = <T>(path: string, body: unknown) => api<T>('PUT', path, body);
export const del = <T>(path: string) => api<T>('DELETE', path);

/**
 * Scarica un file prodotto dall'API (es. l'esportazione CSV) con il nome indicato dal server.
 * Con body la richiesta è POST. Gli errori hanno la stessa forma di api().
 */
export async function download(path: string, body?: unknown): Promise<{ rows: number | null; truncated: boolean }> {
  let res: Response;
  try {
    res = await fetch(`/api${path}`, {
      method: body !== undefined ? 'POST' : 'GET',
      credentials: 'same-origin',
      headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new ApiError(0, 'NETWORK_ERROR', 'Server non raggiungibile. Controlla la connessione e riprova.');
  }
  if (!res.ok) {
    let e: { error?: { code?: string; message?: string; fields?: Record<string, string> }; requestId?: string } = {};
    try {
      e = (await res.json()) as typeof e;
    } catch {
      // risposta non JSON: resta il messaggio generico
    }
    const error = new ApiError(
      res.status,
      e.error?.code ?? 'HTTP_ERROR',
      e.error?.message ?? `Download non riuscito (HTTP ${res.status}).`,
      e.error?.fields ?? {},
      e.requestId,
    );
    if (AUTH_CODES.has(error.code)) for (const l of authListeners) l(error);
    throw error;
  }
  const filename = /filename="([^"]+)"/.exec(res.headers.get('Content-Disposition') ?? '')?.[1] ?? 'lead.csv';
  const url = URL.createObjectURL(await res.blob());
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  const rows = res.headers.get('X-Export-Rows');
  return { rows: rows === null ? null : Number(rows), truncated: res.headers.get('X-Export-Truncated') === 'true' };
}

/* ---------- Tipi delle risposte ---------- */

export type Role = 'admin' | 'sales';

export interface User {
  id: string;
  email: string;
  displayName: string;
  role: Role;
  mustChangePassword: boolean;
}

export interface SessionInfo {
  current: boolean;
  createdAt: string;
  lastSeenAt: string;
  expiresAt: string;
  userAgent: string;
}

export interface SystemStatus {
  version: string;
  environment: string;
  node: string;
  startedAt: string;
  uptimeSeconds: number;
  database: {
    description: string;
    kind: string;
    latencyMs: number;
    migrationsApplied: { version: string; name: string; appliedAt: string }[];
    migrationsPending: string[];
  };
  counts: { activeUsers: number; activeSessions: number };
}

/* ---------- Scoperta e anagrafica ---------- */

export type AreaType = 'italy' | 'region' | 'province' | 'municipality';
export type Coverage = 'buona' | 'parziale' | 'limitata';
export type JobStatus =
  'pending' | 'running' | 'paused' | 'completed' | 'completed_with_warnings' | 'failed' | 'cancelled';

export interface DiscoveryMeta {
  provider: {
    id: string;
    label: string;
    configured: boolean;
    setupHint?: string;
    endpointHost?: string;
    attribution: { text: string; url: string; license: string; licenseUrl: string };
    supportsRadius: boolean;
  };
  workerActive: boolean;
  categories: { id: string; label: string; description: string; coverage: Coverage; note?: string }[];
  limits: {
    maxResultsPerJob: number;
    maxUnitsPerJob: number;
    municipalitiesPerRequest: number;
    minIntervalSeconds: number;
    completenessMax: number;
  };
  geoSource: { source: string; url: string; license: string; licenseUrl: string; generatedAt: string };
}

export interface JobMessage {
  at: string;
  level: 'info' | 'warning' | 'error';
  message: string;
}

export interface DiscoveryJob {
  id: string;
  status: JobStatus;
  area: { type: AreaType; code: string; name: string; context: string | null };
  radiusKm: number | null;
  categories: { id: string; label: string }[];
  maxResults: number;
  minCompleteness: number;
  requireWebsite: boolean;
  progress: { unitsTotal: number; unitsDone: number };
  counts: {
    discovered: number;
    inserted: number;
    updated: number;
    unchanged: number;
    merged: number;
    duplicatesSkipped: number;
    flaggedForReview: number;
    skippedIncomplete: number;
    requestsSent: number;
    failedRequests: number;
  };
  limitReached: boolean;
  messages: JobMessage[];
  cancelRequested: boolean;
  pauseRequested: boolean;
  pauseReason: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  createdBy: string | null;
}

export interface JobUnit {
  seq: number;
  status: 'pending' | 'running' | 'done' | 'failed' | 'split' | 'skipped';
  municipalities: { code: string; name: string }[];
  attempts: number;
  recordsFound: number;
  missing: string[];
  fromCache: boolean;
  sourceDataAt: string | null;
  error: string | null;
  finishedAt: string | null;
}

export interface Paged<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

export interface Place {
  municipalityCode: string | null;
  municipality: string | null;
  provinceCode: string | null;
  province: string | null;
  provinceSigla: string | null;
  regionCode: string | null;
  region: string | null;
}

export interface BusinessSummary {
  id: string;
  name: string;
  category: string;
  categoryLabel: string;
  website: { url: string; domain: string | null; shared: boolean } | null;
  place: Place;
  completeness: number;
  has: { website: boolean; address: boolean; phone: boolean; email: boolean; openingHours: boolean };
  pendingReviews: number;
  audit: BusinessAudit;
  /** Punteggio attuale del lead; null se mai calcolato. */
  lead: LeadSummary | null;
  /** Solo nell'elenco: servizio principale della lista breve e corrispondenza usata da filtri e ordinamento. */
  services?: { primary: PrimaryService | null; matchScore: number | null };
  /** Fase 6: settore, recapiti pubblici (email solo generica), esclusione dal contatto. */
  sector: { id: string; label: string } | null;
  contacts: { phone: string | null; email: string | null; emailKind: 'generic' | 'personal' | null };
  excluded: { at: string; reason: string | null } | null;
  /** Opportunità del CRM: quella aperta, altrimenti la più recente (Fase 7). */
  crm: { opportunityId: string; stage: StageId; open: boolean } | null;
  /** Punteggio commerciale: valutazione AI, altrimenti punteggio a regole come riserva dichiarata. */
  commercial: CommercialScore | null;
  /** Stato della valutazione commerciale (separato da punteggio e affidabilità). */
  assessment: AssessmentState | null;
  /** Motivo principale della valutazione AI (sintesi), se presente. */
  commercialReason: string | null;
  /** Stato di contatto, dai dati salvati (email accettate e attività del CRM). */
  contact: ContactInfo | null;
  firstSeenAt: string;
  lastVerifiedAt: string;
}

export interface BusinessDetail extends BusinessSummary {
  address: { street: string | null; housenumber: string | null; postcode: string | null; city: string | null };
  position: { lat: number; lon: number } | null;
  mergedInto: string | null;
  sources: {
    provider: string;
    ref: string;
    url: string;
    license: string;
    primary: boolean;
    tags: Record<string, string>;
    firstSeenAt: string;
    lastSeenAt: string;
    sourceDataAt: string | null;
    lastJobId: string | null;
  }[];
  duplicates: {
    id: string;
    reason: string;
    distanceM: number | null;
    status: 'pending' | 'merged' | 'distinct';
    createdAt: string;
    resolvedAt: string | null;
    other: { id: string; name: string; municipality: string | null; mergedInto: string | null };
  }[];
  history: { at: string; action: string; details: Record<string, unknown>; user: string | null }[];
  hunts: { id: string; area: string; createdAt: string; isNew: boolean; status: JobStatus }[];
}

export interface DuplicatePair {
  id: string;
  reason: string;
  distanceM: number | null;
  status: string;
  createdAt: string;
  a: BusinessSummary;
  b: BusinessSummary;
}

export interface DiscoveryStats {
  businesses: number;
  withWebsite: number;
  withOwnWebsite: number;
  pendingReviews: number;
  activeJobs: number;
  byCategory: { category: string; label: string; count: number }[];
  byRegion: { regionCode: string | null; region: string | null; count: number }[];
  lastJob: { id: string; status: JobStatus; area: string; createdAt: string; finishedAt: string | null } | null;
}

export interface UserSummary {
  id: string;
  email: string;
  displayName: string;
  role: Role;
  mustChangePassword: boolean;
  disabled: boolean;
  lastLoginAt: string | null;
  createdAt: string;
}

/* ---------- Audit dei siti ---------- */

export type WebsiteStatus =
  | 'not_checked'
  | 'not_found'
  | 'valid'
  | 'redirected'
  | 'unreachable'
  | 'timeout'
  | 'blocked'
  | 'invalid_url'
  | 'audit_failed';
export type Severity = 'info' | 'low' | 'medium' | 'high';
export type FindingCategory = 'availability' | 'security' | 'seo' | 'mobile' | 'performance' | 'content' | 'industry';

export interface BusinessAudit {
  websiteStatus: WebsiteStatus;
  lastAuditAt: string | null;
  lastAuditId: string | null;
  runStatus: 'completed' | 'partial' | 'failed' | null;
  actionableFindings: number | null;
  /** Punteggio PageSpeed mobile (0–100) dell'ultimo audit; null se non misurato. */
  performanceScore: number | null;
}

export interface AuditMeta {
  version: number;
  workerActive: boolean;
  defaults: { maxPages: number; strategies: string[]; usePerformance: boolean };
  limits: {
    defaultPages: number;
    maxPages: number;
    maxBusinessesPerJob: number;
    reauditHours: number;
    hostIntervalMs: number;
    requestTimeoutMs: number;
    maxResponseKb: number;
    allowedPorts: number[];
  };
  performance: { provider: string; configured: boolean; strategies: string[] };
  findings: Record<string, { category: FindingCategory; title: string; severity: Severity }>;
  services: Record<string, string>;
}

export interface AuditJob {
  id: string;
  status: JobStatus;
  settings: { maxPages: number; strategies: string[]; usePerformance: boolean };
  configKey: string;
  force: boolean;
  progress: { total: number; done: number; failed: number; skipped: number };
  messages: JobMessage[];
  cancelRequested: boolean;
  pauseRequested: boolean;
  pauseReason: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  createdBy: string | null;
}

export interface AuditJobItem {
  seq: number;
  business: { id: string; name: string; website: string | null };
  status: 'pending' | 'running' | 'done' | 'skipped' | 'failed' | 'cancelled';
  attempts: number;
  auditId: string | null;
  outcome: string | null;
  error: string | null;
  actionableFindings: number | null;
  finishedAt: string | null;
}

export interface PerformanceSummary {
  status: 'ok' | 'error';
  score?: number | null;
  lcpMs?: number | null;
  cls?: number | null;
  inpMs?: number | null;
  errorKind?: string;
}

export interface AuditSummary {
  websiteStatus: WebsiteStatus;
  statusReason: string | null;
  finalUrl: string | null;
  homepage: {
    status: number;
    ttfbMs: number | null;
    bytes: number;
    words: number | null;
    jsRendered: boolean | null;
  } | null;
  https: {
    available: boolean | null;
    tlsErrorCode: string | null;
    certDaysToExpiry: number | null;
    httpRedirectsToHttps: boolean | null;
  } | null;
  pagesInspected: number;
  robots: string | null;
  sitemap: boolean | null;
  hasViewport: boolean | null;
  platforms: string[];
  signals: Record<string, boolean> | null;
  findings: {
    total: number;
    actionable: number;
    bySeverity: Partial<Record<Severity, number>>;
    byCategory: Partial<Record<FindingCategory, number>>;
    services: Record<string, number>;
  };
  performance: { mobile: PerformanceSummary | null; desktop: PerformanceSummary | null };
  limitations: string[];
}

export interface AuditRecord {
  id: string;
  websiteId: string;
  businessId: string | null;
  jobId: string | null;
  runStatus: 'completed' | 'partial' | 'failed';
  websiteStatus: WebsiteStatus;
  originalUrl: string;
  finalUrl: string | null;
  auditVersion: number;
  configKey: string;
  settings: { maxPages: number; strategies: string[]; usePerformance: boolean };
  summary: AuditSummary | null;
  limitations: string[];
  error: string | null;
  pagesInspected: number;
  findingsCount: number;
  actionableCount: number;
  startedAt: string;
  finishedAt: string;
}

export interface AuditFinding {
  code: string;
  category: FindingCategory;
  severity: Severity;
  observation: 'missing' | 'problem' | 'not_inspected' | 'info';
  title: string;
  explanation: string;
  evidence: Record<string, unknown>;
  page: string;
  confidence: 'high' | 'medium' | 'low';
  actionable: boolean;
  remediation: string;
  service: string | null;
  detectedAt: string;
}

export interface AuditPage {
  seq: number;
  role: string;
  requestedUrl: string;
  finalUrl: string;
  status: number | null;
  contentType: string | null;
  bytes: number;
  truncated: boolean;
  ttfbMs: number | null;
  totalMs: number | null;
  redirects: { url: string; status: number }[] | null;
  headers: Record<string, string>;
  tls: { protocol: string | null; validTo: string | null; daysToExpiry: number | null; issuer: string | null } | null;
  measurements: Record<string, unknown> | null;
  error: { kind: string; message: string } | null;
}

export interface AuditPerformance {
  provider: string;
  strategy: 'mobile' | 'desktop';
  status: 'ok' | 'error';
  url: string;
  analyzedAt: string;
  lighthouseVersion: string | null;
  lab: {
    performanceScore: number | null;
    lcpMs: number | null;
    cls: number | null;
    fcpMs: number | null;
    speedIndexMs: number | null;
    tbtMs: number | null;
  } | null;
  field: {
    scope: 'url' | 'origin';
    lcpMs: number | null;
    cls: number | null;
    inpMs: number | null;
    fcpMs: number | null;
    ttfbMs: number | null;
    overall: string | null;
  } | null;
  errorKind: string | null;
  errorMessage: string | null;
}

export interface AuditDetail {
  audit: AuditRecord;
  businesses: { id: string; name: string }[];
  findings: AuditFinding[];
  pages: AuditPage[];
  performance: AuditPerformance[];
}

export interface WebsiteLink {
  id: string | null;
  status: WebsiteStatus;
  statusReason: string | null;
  originalUrl: string | null;
  url: string | null;
  finalUrl: string | null;
  lastCheckedAt: string | null;
  lastAuditId: string | null;
}

export interface AuditHistory extends Paged<AuditRecord> {
  website: WebsiteLink | null;
}

/* ---------- Punteggio dei lead ---------- */

export type ScoreStatus = 'ranked' | 'needs_review' | 'insufficient_data' | 'not_suitable';
export type ScoreBand = 'A' | 'B' | 'C' | 'low';
export type ConfidenceLevel = 'high' | 'medium' | 'low';
export type ScoringDimension = 'technical' | 'capabilities' | 'industry' | 'evidence' | 'commercial';
export type CapabilityState = 'present' | 'missing' | 'not_detected' | 'unknown';

/** Punteggio attuale nell'elenco delle aziende. */
export interface LeadSummary {
  scoreId: string;
  status: ScoreStatus;
  score: number | null;
  band: ScoreBand | null;
  confidence: { value: number; level: ConfidenceLevel };
  completeness: number;
  nextStep: string;
  calculatedAt: string;
  outdated: boolean;
}

export interface ScoreSignal {
  kind: 'fact' | 'inference';
  dimension: ScoringDimension | 'status';
  text: string;
  ref?: { auditId?: string; codes?: string[]; page?: string; capability?: string };
}

export interface ScoreBreakdown {
  rawScore: number | null;
  dimensions: Record<
    ScoringDimension,
    { score: number | null; weight: number; effectiveWeight: number; contribution: number; basis: string[] }
  >;
  confidence: { value: number; level: ConfidenceLevel; components: Record<string, number> };
  completeness: { value: number; components: Record<string, number> };
  capabilities: { capability: string; label: string; state: CapabilityState; importance: number; service: string }[];
  services: { service: string; label: string; relevance: number; supported: boolean; evidence: string[] }[];
  topFindings: {
    group: string;
    points: number;
    codes: string[];
    title: string;
    severity: Severity;
    page: string;
    auditId: string;
  }[];
  signals: { positive: ScoreSignal[]; negative: ScoreSignal[]; unknown: ScoreSignal[] };
  reasons: string[];
  evidence: {
    auditId: string | null;
    auditFinishedAt: string | null;
    auditAgeDays: number | null;
    freshness: 'fresh' | 'aging' | 'stale' | null;
    websiteId: string | null;
  };
}

export interface LeadScore {
  id: string;
  businessId: string;
  auditId: string | null;
  websiteId: string | null;
  algorithmVersion: number;
  configVersion: number;
  status: ScoreStatus;
  score: number | null;
  rawScore: number | null;
  band: ScoreBand | null;
  confidence: { value: number; level: ConfidenceLevel };
  completeness: number;
  explanation: string;
  nextStep: string;
  trigger: 'manual' | 'audit' | 'discovery' | 'bulk';
  requestedBy: string | null;
  isCurrent: boolean;
  calculatedAt: string;
  breakdown?: ScoreBreakdown;
  outdated?: string[];
}

export interface ScoringConfigValues {
  weights: Record<ScoringDimension, number>;
  bands: { A: number; B: number; C: number };
  thresholds: {
    minCompleteness: number;
    minActiveWeightPct: number;
    minConfidence: number;
    confidenceHigh: number;
    confidenceMedium: number;
  };
  freshness: { auditFreshDays: number; auditStaleDays: number; sourceFreshDays: number };
  [key: string]: unknown;
}

export interface ScoringConfigResponse {
  algorithmVersion: number;
  active: {
    version: number;
    config: ScoringConfigValues;
    createdAt: string;
    createdBy: string | null;
    note: string | null;
  };
  defaults: ScoringConfigValues;
  versions: {
    version: number;
    createdAt: string;
    createdBy: string | null;
    note: string | null;
    currentScores: number;
  }[];
  catalog: {
    dimensions: ScoringDimension[];
    capabilities: Record<string, string>;
    services: Record<string, string>;
    categories: Record<string, string>;
  };
}

export interface ScoringStats {
  configVersion: number;
  byStatus: { status: ScoreStatus; band: ScoreBand | null; count: number }[];
  unscored: number;
  outdatedConfig: number;
}

export interface ScoringJob {
  id: string;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';
  scope: 'all' | 'businesses' | 'discovery_job';
  force: boolean;
  trigger: string;
  progress: { total: number; processed: number; created: number; unchanged: number };
  error: string | null;
  cancelRequested: boolean;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  createdBy: string | null;
}

/* ---------- Abbinamento ai servizi ---------- */

export type MatchStatus = 'recommended' | 'possible' | 'needs_review' | 'insufficient_evidence' | 'not_relevant';
export type ReviewStatus = 'accepted_for_review' | 'dismissed' | 'needs_review' | null;
export type ReviewAction = 'accepted_for_review' | 'dismissed' | 'needs_review' | 'reopened' | 'note';
export type MatchDimension = 'findings' | 'capabilities' | 'category' | 'evidence' | 'context';

export interface CatalogService {
  id: string;
  name: string;
  category: 'sviluppo' | 'marketing';
  description: string;
  source: string;
  verified: boolean;
  active: boolean;
  autoMatch: boolean;
  requiresTeamConfirmation: boolean;
  problems: string[];
  categories: Record<string, number>;
  findings: Record<string, number>;
  capabilityGaps: Record<string, number>;
  repeatedFailure: boolean;
  context: Record<string, number>;
  disqualifiers: { signal: string; reason: string }[];
  dedupeGroup: string;
  prerequisites: string[];
  nextSteps: string[];
}

export interface CatalogSettings {
  weights: Record<MatchDimension, number>;
  thresholds: { recommended: number; possible: number; minConfidence: number; minActiveWeightPct: number };
  shortlist: { max: number; maxWithLowConfidence: number };
}

export interface ServiceList {
  version: number;
  createdAt: string;
  createdBy: string | null;
  note: string | null;
  settings: CatalogSettings;
  services: (CatalogService & { counts: { recommended: number; possible: number; needsReview: number } })[];
}

export interface ServiceCatalogResponse {
  algorithmVersion: number;
  active: {
    version: number;
    catalog: CatalogSettings & { services: CatalogService[]; [key: string]: unknown };
    createdAt: string;
    createdBy: string | null;
    note: string | null;
  };
  defaults: CatalogSettings & { services: CatalogService[]; [key: string]: unknown };
  versions: { version: number; createdAt: string; createdBy: string | null; note: string | null }[];
  vocabulary: {
    dimensions: MatchDimension[];
    categories: Record<string, string>;
    capabilities: Record<string, string>;
    findings: Record<string, string>;
    signals: string[];
  };
}

export interface ServiceReview {
  status: ReviewStatus;
  changedSince: boolean;
  history: { action: ReviewAction; note: string | null; at: string; user: string | null }[];
}

export interface ServiceInfo {
  id: string;
  name: string;
  category: string | null;
  description: string | null;
  source: string | null;
  problems: string[];
  nextSteps: string[];
  requiresTeamConfirmation: boolean;
}

export interface ServiceMatch {
  id: string;
  serviceId: string;
  status: MatchStatus;
  strength: 'recommended' | 'possible' | null;
  score: number | null;
  rawScore: number | null;
  confidence: { value: number; level: ConfidenceLevel };
  completeness: number;
  dedupeGroup: string;
  dimensions: Record<
    MatchDimension,
    { score: number | null; weight: number; effectiveWeight: number; contribution: number }
  >;
  evidence: {
    auditId: string | null;
    findings: { code: string; title: string; severity: Severity; confidence: string; page: string; points: number }[];
    capabilities: { capability: string; label: string; state: CapabilityState }[];
    repeatedFailure: boolean;
  };
  signals: { positive: ScoreSignal[]; negative: ScoreSignal[]; unknown: ScoreSignal[] };
  reasons: string[];
  problem: string | null;
  explanation: string;
  nextStep: string;
  calculatedAt: string;
  service: ServiceInfo;
  review: ServiceReview;
}

export interface BusinessServices {
  catalogVersion: number;
  run: {
    id: string;
    catalogVersion: number;
    algorithmVersion: number;
    confidenceLevel: ConfidenceLevel;
    auditId: string | null;
    leadScoreId: string | null;
    trigger: string;
    calculatedAt: string;
    outdated: string[];
  } | null;
  shortlist: string[];
  matches: ServiceMatch[];
  manualServices: { service: ServiceInfo; review: ServiceReview }[];
}

export interface PrimaryService {
  serviceId: string;
  name: string;
  score: number | null;
  status: MatchStatus;
  review: ReviewStatus;
  others: number;
}

/* ---------- Lead Hunter (Fase 6) ---------- */

export interface SectorInfo {
  id: string;
  label: string;
  group: string;
  category: string;
  coverage: Coverage;
  note: string | null;
}

export interface HunterMeta {
  sectors: SectorInfo[];
  groups: Record<string, string>;
  defaults: { target: number; area: { type: AreaType; code: string }; options: HuntOptions };
  limits: { maxTarget: number };
  provider: { configured: boolean; label: string };
  workerActive: boolean;
}

export interface HuntOptions {
  minScore: number | null;
  websitePreference: 'any' | 'no_website' | 'website_issues';
  excludeKnown: boolean;
  audit: boolean;
}

export interface HuntProgress {
  discovered: number;
  newBusinesses: number;
  alreadyKnown: number;
  duplicatesAvoided: number;
  requests: number;
  failedRequests: number;
  failedAreas: number;
  linked: number;
  linkedNew: number;
  excluded: number;
  websites: {
    found: number;
    missing: number;
    verified: number;
    unverified: number;
    unreachable: number;
    invalid: number;
  };
  audits: { completed: number; pending: number; failed: number };
  scored: number;
  ranked: number;
  qualified: number;
  remaining: number;
  targetReached: boolean;
}

export interface HuntRun {
  id: string;
  status: JobStatus;
  phase: 'discovery' | 'audit' | 'done';
  target: number;
  area: { type: AreaType; code: string; name: string };
  sectors: { id: string; label: string }[];
  options: HuntOptions;
  plan: { total: number; done: number; current: string | null };
  currentJobId: string | null;
  currentAuditJobId: string | null;
  messages: JobMessage[];
  pauseRequested: boolean;
  cancelRequested: boolean;
  pauseReason: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  createdBy: string | null;
}

export interface HuntRunDetail {
  run: HuntRun;
  progress: HuntProgress;
  currentJob: {
    id: string;
    status: JobStatus;
    area: string;
    unitsDone: number;
    unitsTotal: number;
    messages: JobMessage[];
  } | null;
  distribution: {
    sectors: { sector: string | null; label: string; count: number }[];
    regions: { regionCode: string | null; region: string; count: number }[];
  };
  top: {
    id: string;
    name: string;
    sector: string;
    municipality: string | null;
    score: number;
    source: 'ai' | 'rules';
    band: string;
  }[];
}

/* ---------- CRM (Fase 7) ---------- */

export type StageId =
  | 'da_qualificare'
  | 'da_contattare'
  | 'primo_contatto'
  | 'in_attesa'
  | 'interessato'
  | 'appuntamento'
  | 'preventivo'
  | 'negoziazione'
  | 'vinto'
  | 'perso'
  | 'non_contattare';
export type CommercialPriority = 'alta' | 'media' | 'bassa';
export type ActivityType =
  'call' | 'contact_attempt' | 'conversation' | 'meeting' | 'follow_up' | 'proposal' | 'note' | 'stage_change';

export interface CrmMeta {
  stages: { id: StageId; label: string; closed: boolean }[];
  priorities: { id: CommercialPriority; label: string }[];
  activityTypes: { id: ActivityType; label: string; manual: boolean }[];
  owners: { id: string; name: string }[];
  services: { id: string; name: string; active: boolean }[];
  catalogVersion: number;
  today: string;
}

export interface NextFollowUp {
  id: string;
  description: string;
  dueDate: string;
  dueTime: string | null;
  overdue: boolean;
  dueToday: boolean;
}

export interface OpportunityCard {
  id: string;
  stage: StageId;
  stageLabel: string;
  open: boolean;
  priority: CommercialPriority;
  owner: { id: string; name: string | null } | null;
  estimatedValue: number | null;
  services: { id: string; name: string }[];
  lostReason: string | null;
  closedAt: string | null;
  lastActivityAt: string;
  createdAt: string;
  updatedAt: string;
  nextFollowUp: NextFollowUp | null;
  lastActivity: { type: ActivityType; typeLabel: string; summary: string; occurredAt: string } | null;
  business: BusinessSummary & { mergedInto: string | null };
  /** Lista breve dei servizi consigliati dall'abbinamento (Fase 5). */
  recommended: { serviceId: string; name: string; score: number }[] | null;
}

export interface CrmActivity {
  id: string;
  type: ActivityType;
  typeLabel: string;
  occurredAt: string;
  summary: string;
  notes: string | null;
  fromStage: StageId | null;
  toStage: StageId | null;
  user: { id: string; name: string | null } | null;
  createdAt: string;
  edited: { by: string; at: string } | null;
}

export interface CrmFollowUp {
  id: string;
  opportunityId: string;
  description: string;
  dueDate: string;
  dueTime: string | null;
  notes: string | null;
  priority: CommercialPriority;
  status: 'pending' | 'completed' | 'cancelled';
  /** Perché è stato annullato: da una persona o per la chiusura dell'opportunità. */
  cancelReason: 'manual' | 'opportunity_closed' | null;
  overdue: boolean;
  dueToday: boolean;
  completedAt: string | null;
  completedBy: string | null;
  cancelledAt: string | null;
  createdBy: string | null;
  createdAt: string;
}

export interface OpportunityDetail {
  opportunity: OpportunityCard & { notes: string | null };
  activities: CrmActivity[];
  followUps: CrmFollowUp[];
  otherOpportunities: { id: string; stage: StageId; stageLabel: string; createdAt: string; closedAt: string | null }[];
  today: string;
}

export interface CrmBoard {
  today: string;
  perStage: number;
  stages: { id: StageId; label: string; closed: boolean; total: number; items: OpportunityCard[] }[];
}

export interface CrmDashboard {
  today: string;
  total: number;
  active: number;
  toQualify: number;
  readyToContact: number;
  meetings: number;
  quotes: number;
  won: number;
  lost: number;
  doNotContact: number;
  followUps: { today: number; overdue: number; upcoming: number };
  activeValue: { euro: number | null; withValue: number };
  wonValue: { euro: number | null; withValue: number };
  byStage: { id: StageId; label: string; closed: boolean; count: number }[];
}

export interface FollowUpListItem extends CrmFollowUp {
  opportunity: { id: string; stage: StageId; stageLabel: string; owner?: string | null };
  business: { id: string; name: string; municipality: string | null };
}

export interface BulkAddResult {
  created: { businessId: string; opportunityId: string }[];
  skipped: { businessId: string; reason: string; message: string; opportunityId?: string }[];
  failed: { businessId: string; reason: string; message: string }[];
}

/* ---------- Valutazione commerciale con AI ---------- */

export type AiComponentId = 'acquisition' | 'service_fit' | 'improvement' | 'attractiveness' | 'evidence_quality';
export type Level = 'high' | 'medium' | 'low';

export interface CommercialScore {
  source: 'ai' | 'rules';
  score: number;
  band: { id: string; label: string } | null;
  confidence: Level;
  acquisition: number | null;
  serviceFit: number | null;
  needsReview: boolean;
  exclusion: 'do_not_contact' | 'inactive' | null;
  assessedAt: string | null;
  outdated: boolean;
}

export interface AiStatus {
  configured: boolean;
  provider: string | null;
  model: string;
  effort: string;
  promptVersion: number;
  workerActive: boolean;
  price: { inputPerMTok: number; outputPerMTok: number } | null;
  state: 'not_configured' | 'available' | 'error';
  lastResult: { status: 'succeeded' | 'failed'; code: string | null; at: string } | null;
  assessed: number;
  needsReview: number;
}

export interface AiConfigResponse {
  version: number;
  createdAt: string;
  note: string | null;
  config: {
    weights: Record<AiComponentId, number>;
    penalties: Record<string, number>;
    severity: Record<'low' | 'medium' | 'high', number>;
    bands: { id: string; min: number; label: string }[];
    improvementCapWithoutEvidence: number;
    reviewThreshold: number;
  };
  components: { id: AiComponentId; label: string }[];
  penalties: { id: string; label: string; group: string; rationale: string }[];
}

interface Statement {
  text: string;
  evidence_refs: string[];
}

export interface AiAssessment {
  id: string;
  status: 'succeeded' | 'failed';
  current: boolean;
  provider: string;
  model: string;
  promptVersion: number;
  configVersion: number;
  usage: {
    inputTokens: number | null;
    outputTokens: number | null;
    costUsd: number | null;
    attempts: number;
    durationMs: number | null;
  };
  trigger: string;
  requestedBy: string | null;
  createdAt: string;
  error?: { code: string | null; message: string | null };
  score?: number;
  weighted?: number;
  band?: { id: string; label: string };
  components?: {
    id: AiComponentId;
    label: string;
    score: number;
    weight: number;
    explanation: string;
    evidenceRefs: string[];
    adjustedFrom?: number;
  }[];
  penalties?: {
    type: string;
    label: string;
    group: string;
    severity: 'low' | 'medium' | 'high';
    points: number;
    applied: boolean;
    reason: string | null;
    source: 'ai' | 'crm';
    evidenceRefs: string[];
    rationale: string;
  }[];
  adjustments?: string[];
  confidence?: { level: Level; ai: Level; evidence: Level; explanation: string } | null;
  needsReview?: boolean;
  reviewReasons?: string[];
  exclusion?: 'do_not_contact' | 'inactive' | null;
  summary?: string;
  positiveSignals?: Statement[];
  negativeSignals?: Statement[];
  obstacles?: (Statement & { type: string; severity: 'low' | 'medium' | 'high' })[];
  recommendedServices?: { id: string; name: string }[];
  verifiedFacts?: Statement[];
  inferences?: Statement[];
  unknowns?: string[];
  businessStatus?: 'active' | 'likely_active' | 'unknown' | 'closed';
  nextStep?: string;
  warnings?: string[];
  evidence?: { id: string; kind: string; text: string }[];
}

export interface AiAssessmentDetail {
  state: AssessmentState | null;
  current: AiAssessment | null;
  lastFailure: AiAssessment | null;
  history: {
    id: string;
    status: 'succeeded' | 'failed';
    current: boolean;
    score: number | null;
    band: string | null;
    model: string;
    promptVersion: number;
    configVersion: number;
    costUsd: number | null;
    error: string | null;
    createdAt: string;
  }[];
  reviews: {
    id: string;
    assessmentId: string;
    verdict: 'inaccurate' | 'confirmed' | 'note';
    note: string | null;
    user: string | null;
    createdAt: string;
  }[];
  running: boolean;
  configured: boolean;
  lastError: string | null;
}

export interface AiEstimate {
  total: number;
  cached: number;
  missing: number;
  toAssess: number;
  estimatedCostUsd: number | null;
  basis: string;
  pricePerMTok: { inputPerMTok: number; outputPerMTok: number } | null;
  configured: boolean;
}

export interface AiJob {
  id: string;
  status: JobStatus;
  force: boolean;
  total: number;
  estimatedCostUsd: number | null;
  messages: JobMessage[];
  pauseRequested: boolean;
  cancelRequested: boolean;
  pauseReason: string | null;
  createdBy: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  counts: { pending: number; assessed: number; cached: number; skipped: number; failed: number };
  usage: { inputTokens: number | null; outputTokens: number | null; costUsd: number | null };
}

export interface AiJobDetail {
  job: AiJob;
  items: {
    seq: number;
    businessId: string;
    name: string;
    status: string;
    error: string | null;
    score: number | null;
  }[];
}

/* ---------- Pagina iniziale ---------- */

export interface HomeOverview {
  businesses: number;
  excluded: number;
  commercial: {
    bands: { id: string; label: string; min: number; max: number; count: number }[];
    scored: number;
    unscored: number;
    fromAi: number;
    fromRules: number;
    highPriority: number;
    highPriorityNotInCrm: number;
    topBand: { id: string; label: string; min: number };
  };
  crm: { active: number; readyToContact: number; followUpsToday: number; followUpsOverdue: number };
  ai: { assessed: number; needsReview: number };
  activeHunt: { id: string; target: number; area: string; linked: number } | null;
  recent: {
    kind: 'crm' | 'ai' | 'discovery';
    at: string;
    text: string;
    business: string | null;
    link: string;
    activity: string | null;
  }[];
  sales: {
    found: number;
    readyToContact: number;
    emailsSent: number;
    awaitingReply: number;
    bestProspects: BusinessSummary[];
  };
  workflow: {
    overdue: { items: FollowUpListItem[]; total: number };
    dueSoon: { items: FollowUpListItem[]; total: number };
    priorityNotInCrm: { id: string; name: string; municipality: string | null; score: number }[];
    recentlyUpdated: HomeOpportunity[];
    recentlyClosed: HomeOpportunity[];
    savedFilters: { id: string; scope: SavedFilterScope; name: string; query: string }[];
  };
  aiConfigured: boolean;
}

export interface HomeOpportunity {
  id: string;
  stage: StageId;
  stageLabel: string;
  business: { id: string; name: string };
  updatedAt: string;
  closedAt: string | null;
  estimatedValue: number | null;
}

// ---------------------------------------------------------------- Fase 8: flusso commerciale

export type ExportDataset = 'businesses' | 'opportunities' | 'followups' | 'activities';
export interface ExportColumn {
  id: string;
  label: string;
  default: boolean;
}
export type ExportColumns = Record<ExportDataset, ExportColumn[]> & { limit: number };

export interface ReminderItem {
  id: string;
  kind: 'followup_due_soon' | 'followup_overdue';
  createdAt: string;
  read: boolean;
  followUp: {
    id: string;
    description: string;
    dueDate: string;
    dueTime: string | null;
    priority: CommercialPriority;
    overdue: boolean;
  };
  opportunity: { id: string; stage: StageId; stageLabel: string };
  business: { id: string; name: string };
}
export interface Reminders {
  items: ReminderItem[];
  unread: number;
  unreadOverdue: number;
  today: string;
}

export type SavedFilterScope = 'businesses' | 'opportunities' | 'followups';
export interface SavedFilter {
  id: string;
  scope: SavedFilterScope;
  name: string;
  query: string;
  createdAt: string;
  updatedAt: string;
  valid: boolean;
  invalidReason: string | null;
  /** Risultati di oggi con questi criteri; null se i criteri non sono più validi. */
  count: number | null;
}

export type ReportPeriod = '7d' | '30d' | '90d' | 'month' | 'prev_month' | 'all';
export interface CountRow {
  key: string;
  label: string;
  count: number;
}
export interface CommercialReport {
  period: ReportPeriod;
  periodLabel: string;
  range: { from: string | null; toExclusive: string | null };
  today: string;
  prospecting: {
    total: number;
    excluded: number;
    discovered: number;
    websiteAssessed: number;
    aiAssessed: number;
    scored: number;
    highPriority: number;
    highPriorityShare: number | null;
    topBand: { label: string; min: number };
    bands: { id: string; label: string; min: number; max: number; count: number }[];
    bySector: CountRow[];
    byRegion: CountRow[];
  };
  crm: {
    active: number;
    byStage: { id: StageId; label: string; closed: boolean; count: number }[];
    created: number;
    won: number;
    lost: number;
    winRate: number | null;
    wonValue: number | null;
    wonValued: number;
    openValue: number | null;
    openValued: number;
    avgDaysToClose: number | null;
    closedWithTimes: number;
    minClosedForAverage: number;
    followUps: { overdue: number; dueSoon: number; completed: number; soonDays: number };
  };
  trend: {
    buckets: string[];
    bucket: 'day' | 'week' | 'month';
    discovered: number[];
    created: number[];
    won: number[];
    lost: number[];
  } | null;
  observations: string[];
}

// ---------------------------------------------------------------- Fase 9: email commerciali

export type EmailStatus = 'draft' | 'review' | 'ready' | 'sending' | 'sent' | 'failed' | 'archived';
export type EmailMode = 'standard' | 'ai';
export type EmailObjective =
  'presentazione' | 'nuovo_sito' | 'rinnovo_sito' | 'ecommerce' | 'servizio' | 'call' | 'follow_up';
export type EmailTone = 'diretto' | 'consulenziale' | 'formale' | 'informale';

export interface SendingStatus {
  state: 'ready' | 'missing' | 'verification_needed' | 'provider_error';
  label: string;
  canSend: boolean;
  explanation: string;
  from: { name: string; address: string } | null;
  replyTo: string | null;
  senderAuthorized: boolean;
  missing: string[];
  lastCheck: { at: string; ok: boolean; message: string } | null;
}

export interface EmailMeta {
  template: {
    id: string;
    name: string;
    subject: string;
    body: string;
    contacts: { site: string; email: string; phone: string };
  };
  modes: { id: EmailMode; label: string }[];
  objectives: { id: EmailObjective; label: string }[];
  tones: { id: EmailTone; label: string }[];
  statuses: { id: EmailStatus; label: string }[];
  aiConfigured: boolean;
  sending: SendingStatus;
  reviewCount: number;
}

export interface EmailEvidenceItem {
  id: string;
  kind: string;
  text: string;
  usedFor?: string;
}

export interface CommercialEmail {
  id: string;
  businessId: string;
  businessName: string;
  opportunityId: string | null;
  recipient: string | null;
  recipientSource: 'public_source' | 'manual' | null;
  subject: string;
  body: string;
  templateId: string;
  mode: EmailMode;
  objective: EmailObjective;
  tone: EmailTone;
  serviceId: string | null;
  instructions: string | null;
  evidence: (EmailEvidenceItem & { usedFor: string })[];
  internalNotes: {
    verifiedFacts: { text: string; refs: string[] }[];
    inferences: { text: string; refs: string[] }[];
    unknowns: string[];
  } | null;
  aiModel: string | null;
  generatedAt: string | null;
  editedAfterGeneration: boolean;
  status: EmailStatus;
  statusLabel: string;
  version: number;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
  sentAt: string | null;
  sentBy: string | null;
  sentFrom: string | null;
  providerMessageId: string | null;
  lastError: string | null;
  failureUncertain: boolean;
}

export type EmailListItem = Omit<CommercialEmail, 'body' | 'evidence' | 'internalNotes'>;

export interface EmailList extends Paged<EmailListItem> {
  counts: Partial<Record<EmailStatus | 'all', number>>;
}

export interface EmailDetail {
  email: CommercialEmail;
  business: {
    id: string;
    name: string;
    sector: string | null;
    municipality: string | null;
    website: string | null;
    publicEmail: string | null;
    doNotContact: boolean;
    doNotContactReason: string | null;
    merged: boolean;
  };
  opportunity: { id: string; stage: StageId; stageLabel: string; owner: string | null } | null;
  objectives: { id: EmailObjective; label: string; available: boolean; reason: string | null }[];
  catalog: { id: string; name: string }[];
  history: {
    id: string;
    subject: string;
    status: EmailStatus;
    statusLabel: string;
    updatedAt: string;
    sentAt: string | null;
    recipient: string | null;
  }[];
  revisions: { version: number; source: 'template' | 'ai' | 'user'; at: string; by: string | null }[];
  attempts: {
    at: string;
    outcome: 'pending' | 'accepted' | 'failed' | 'uncertain';
    error: string | null;
    recipient: string;
    by: string | null;
  }[];
}

export interface EmailPrecheck {
  canSend: boolean;
  blockers: string[];
  warnings: string[];
  recipient: string | null;
  recipientState: 'missing' | 'invalid' | 'public_source' | 'manual';
  needsOpportunity: boolean;
  from: { name: string; address: string } | null;
}

export interface EmailSendResult extends EmailDetail {
  outcome: 'accepted' | 'failed' | 'uncertain' | 'pending';
  repeated: boolean;
  message?: string;
}

// ---------------------------------------------------------------- valutazione di ogni azienda

export type AiState = 'pending' | 'running' | 'assessed' | 'incomplete' | 'failed' | 'outdated' | 'excluded';

export interface AssessmentState {
  state: AiState;
  label: string;
  lastError: string | null;
  nextAttemptAt: string | null;
}

export interface AiCoverage {
  total: number;
  counts: Record<AiState, number>;
  eligible: number;
  covered: number;
  coveredShare: number | null;
  unchecked: number;
  failedFinal: number;
  auto: {
    enabled: boolean;
    providerConfigured: boolean;
    pausedReason: string | null;
    backoffUntil: string | null;
    dailyLimit: number;
    usedLast24h: number;
  };
  usageLast24h: { assessments: number; costUsd: number | null };
  autoActive: boolean;
  remaining: number;
  estimatedRemainingCostUsd: number | null;
  costBasis: string;
  model: string;
}

export type ContactStatus = 'da_contattare' | 'in_attesa' | 'in_trattativa' | 'cliente' | 'perso' | 'non_contattare';
export interface ContactInfo {
  status: ContactStatus;
  label: string;
  lastContactAt: string | null;
}
