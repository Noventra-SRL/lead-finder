import { createHash } from 'node:crypto';
import { audit as auditLog } from '../audit.ts';
import type { Db, Queryable } from '../db/client.ts';
import { JobError } from '../discovery/jobs.ts';
import {
  DEFAULT_SCORING_CONFIG,
  SCORING_ALGORITHM_VERSION,
  validateScoringConfig,
  type ScoringConfig,
} from './config.ts';
import { activeCatalog, writeMatchRun } from '../matching/store.ts';
import { scoreLead, type ScoreResult, type ScoringAudit, type ScoringFinding, type ScoringInput } from './engine.ts';

/*
 * Persistenza del punteggio dei lead.
 *  - configurazione: versioni immutabili in scoring_configs (la più alta è attiva; la prima è creata dai valori predefiniti);
 *  - dati in ingresso letti a lotti (5 query per lotto, indipendenti dal numero di rilievi);
 *  - istantanea nuova solo se l'impronta dei dati in ingresso cambia, o su richiesta esplicita; le precedenti restano.
 */

export const SCORING_BATCH_SIZE = 200;
const DAY = 86_400_000;
const iso = (d: Date | string | null) => (d ? new Date(d).toISOString() : null);

export interface ActiveConfig {
  version: number;
  config: ScoringConfig;
  createdAt: string;
  createdBy: string | null;
  note: string | null;
}

/** Configurazione attiva; al primo uso registra i valori predefiniti come versione 1. */
export async function activeConfig(db: Queryable): Promise<ActiveConfig> {
  const read = () =>
    db.query<{
      version: number;
      config: unknown;
      created_at: Date;
      created_by_name: string | null;
      note: string | null;
    }>(
      `SELECT c.version, c.config, c.created_at, c.note, u.display_name AS created_by_name
         FROM scoring_configs c LEFT JOIN users u ON u.id = c.created_by ORDER BY c.version DESC LIMIT 1`,
    );
  let { rows } = await read();
  if (!rows[0]) {
    await db.query(
      "INSERT INTO scoring_configs (version, config, note) VALUES (1, $1, 'Valori predefiniti') ON CONFLICT (version) DO NOTHING",
      [JSON.stringify(DEFAULT_SCORING_CONFIG)],
    );
    ({ rows } = await read());
  }
  const r = rows[0]!;
  const v = validateScoringConfig(r.config);
  // una configurazione salvata è sempre stata validata: se non lo è più (codice cambiato), è un errore da correggere
  if (!v.ok)
    throw new Error(
      `Configurazione del punteggio v${r.version} non valida: ${Object.entries(v.errors)
        .map(([k, m]) => `${k}: ${m}`)
        .join('; ')}`,
    );
  return {
    version: r.version,
    config: v.config,
    createdAt: iso(r.created_at)!,
    createdBy: r.created_by_name,
    note: r.note,
  };
}

export async function configHistory(db: Queryable) {
  const { rows } = await db.query<{
    version: number;
    created_at: Date;
    created_by_name: string | null;
    note: string | null;
    scores: number;
  }>(
    `SELECT c.version, c.created_at, c.note, u.display_name AS created_by_name,
            (SELECT count(*)::int FROM lead_scores s WHERE s.config_version = c.version AND s.is_current) AS scores
       FROM scoring_configs c LEFT JOIN users u ON u.id = c.created_by ORDER BY c.version DESC LIMIT 50`,
  );
  return rows.map((r) => ({
    version: r.version,
    createdAt: iso(r.created_at),
    createdBy: r.created_by_name,
    note: r.note,
    currentScores: r.scores,
  }));
}

/** Nuova versione della configurazione (solo amministratori, controllato dalla rotta). */
export async function saveConfig(db: Db, input: unknown, ctx: { userId: string; note?: string }) {
  const v = validateScoringConfig(input);
  if (!v.ok) throw new JobError(400, 'INVALID_CONFIG', 'La configurazione non è valida: nessuna modifica salvata.');
  await activeConfig(db);
  return db.transaction(async (tx) => {
    // lock della tabella: due salvataggi contemporanei non possono ottenere lo stesso numero di versione
    await tx.query('LOCK TABLE scoring_configs IN EXCLUSIVE MODE');
    const { rows } = await tx.query<{ v: number }>('SELECT max(version)::int AS v FROM scoring_configs');
    const version = (rows[0]?.v ?? 0) + 1;
    await tx.query('INSERT INTO scoring_configs (version, config, note, created_by) VALUES ($1, $2, $3, $4)', [
      version,
      JSON.stringify(v.config),
      ctx.note ?? null,
      ctx.userId,
    ]);
    await auditLog(tx, {
      userId: ctx.userId,
      action: 'scoring.config_updated',
      entityType: 'scoring_config',
      entityId: String(version),
      details: { note: ctx.note ?? null },
    });
    return version;
  });
}

interface BusinessInputRow {
  id: string;
  category: string;
  municipality_code: string | null;
  website_url: string | null;
  website_shared: boolean;
  has_website: boolean;
  has_address: boolean;
  has_phone: boolean;
  has_email: boolean;
  has_opening_hours: boolean;
  completeness: number;
  last_verified_at: Date;
  merged_into: string | null;
  website_id: string | null;
  original_url: string | null;
  link_status: string | null;
  last_audit_id: string | null;
  pending_reviews: number;
}

/** Dati in ingresso per un lotto di aziende, con un numero fisso di query. Le aziende unite sono escluse. */
export async function loadInputs(db: Queryable, ids: string[]): Promise<Map<string, ScoringInput>> {
  const out = new Map<string, ScoringInput>();
  if (!ids.length) return out;
  const { rows } = await db.query<BusinessInputRow>(
    `SELECT b.id, b.category, b.municipality_code, b.website_url, b.website_shared, b.has_website, b.has_address, b.has_phone,
            b.has_email, b.has_opening_hours, b.completeness, b.last_verified_at, b.merged_into,
            bw.website_id, bw.original_url, bw.status AS link_status, w.last_audit_id,
            (SELECT count(*)::int FROM duplicate_candidates d
              WHERE d.status = 'pending' AND (d.business_a = b.id OR d.business_b = b.id)) AS pending_reviews
       FROM businesses b
       LEFT JOIN business_websites bw ON bw.business_id = b.id
       LEFT JOIN websites w ON w.id = bw.website_id
      WHERE b.id = ANY($1) AND b.merged_into IS NULL`,
    [ids],
  );
  const auditIds = [...new Set(rows.map((r) => r.last_audit_id).filter((x): x is string => Boolean(x)))];
  const websiteIds = [...new Set(rows.map((r) => r.website_id).filter((x): x is string => Boolean(x)))];
  const audits = new Map<string, ScoringAudit>();
  if (auditIds.length) {
    const { rows: a } = await db.query<{
      id: string;
      run_status: 'completed' | 'partial' | 'failed';
      website_status: string;
      finished_at: Date;
      pages_inspected: number;
      summary: ScoringAudit['summary'] | null;
    }>(
      'SELECT id, run_status, website_status, finished_at, pages_inspected, summary FROM website_audits WHERE id = ANY($1)',
      [auditIds],
    );
    for (const r of a)
      audits.set(r.id, {
        id: r.id,
        runStatus: r.run_status,
        websiteStatus: r.website_status,
        finishedAt: iso(r.finished_at)!,
        pagesInspected: r.pages_inspected,
        summary: {
          homepage: r.summary?.homepage ?? null,
          hasViewport: r.summary?.hasViewport ?? null,
          signals: r.summary?.signals ?? null,
          platforms: r.summary?.platforms ?? null,
        },
        findings: [],
      });
    const { rows: f } = await db.query<{
      audit_id: string;
      code: string;
      category: string;
      severity: ScoringFinding['severity'];
      confidence: ScoringFinding['confidence'];
      observation: string;
      actionable: boolean;
      service: string | null;
      page_url: string;
    }>(
      `SELECT audit_id, code, category, severity, confidence, observation, actionable, service, page_url
         FROM audit_findings WHERE audit_id = ANY($1) ORDER BY audit_id, code, page_url`,
      [auditIds],
    );
    for (const r of f)
      audits.get(r.audit_id)?.findings.push({
        code: r.code,
        category: r.category,
        severity: r.severity,
        confidence: r.confidence,
        observation: r.observation,
        actionable: r.actionable,
        service: r.service,
        page: r.page_url,
      });
  }
  const statuses = new Map<string, string[]>();
  if (websiteIds.length) {
    const { rows: s } = await db.query<{ website_id: string; website_status: string }>(
      `SELECT website_id, website_status FROM (
         SELECT website_id, website_status, finished_at, id,
                row_number() OVER (PARTITION BY website_id ORDER BY finished_at DESC, id) AS n
           FROM website_audits WHERE website_id = ANY($1) AND run_status <> 'failed') x
        WHERE n <= 5 ORDER BY website_id, finished_at DESC, id`,
      [websiteIds],
    );
    for (const r of s) statuses.set(r.website_id, [...(statuses.get(r.website_id) ?? []), r.website_status]);
  }
  for (const r of rows)
    out.set(r.id, {
      business: {
        id: r.id,
        category: r.category,
        municipalityCode: r.municipality_code,
        websiteUrl: r.website_url,
        websiteShared: r.website_shared,
        has: {
          website: r.has_website,
          address: r.has_address,
          phone: r.has_phone,
          email: r.has_email,
          openingHours: r.has_opening_hours,
        },
        completeness: r.completeness,
        lastVerifiedAt: iso(r.last_verified_at)!,
        pendingReviews: r.pending_reviews,
      },
      website: { websiteId: r.website_id, linkedUrl: r.original_url, linkStatus: r.link_status },
      audit: r.last_audit_id ? (audits.get(r.last_audit_id) ?? null) : null,
      recentStatuses: r.website_id ? (statuses.get(r.website_id) ?? []) : [],
    });
  return out;
}

/**
 * Impronta dei dati in ingresso: le date entrano solo come fasce (recente / invecchiato / superato), così il
 * passare dei giorni crea un'istantanea nuova solo quando cambia davvero la valutazione.
 */
export function inputHash(input: ScoringInput, cfg: ActiveConfig, now: Date): string {
  const f = cfg.config.freshness;
  const auditAge = input.audit ? (now.getTime() - Date.parse(input.audit.finishedAt)) / DAY : null;
  const normalized = {
    algorithm: SCORING_ALGORITHM_VERSION,
    config: cfg.version,
    business: {
      ...input.business,
      lastVerifiedAt: undefined,
      sourceFresh: now.getTime() - Date.parse(input.business.lastVerifiedAt) <= f.sourceFreshDays * DAY,
    },
    website: input.website,
    audit: input.audit
      ? {
          ...input.audit,
          finishedAt: undefined,
          freshness: auditAge! <= f.auditFreshDays ? 'fresh' : auditAge! <= f.auditStaleDays ? 'aging' : 'stale',
          findings: input.audit.findings.map((x) => [
            x.code,
            x.page,
            x.severity,
            x.confidence,
            x.observation,
            x.actionable,
            x.service,
            x.category,
          ]),
        }
      : null,
    recentStatuses: input.recentStatuses,
  };
  return createHash('sha256').update(JSON.stringify(normalized)).digest('hex');
}

export type ScoreTrigger = 'manual' | 'audit' | 'discovery' | 'bulk';

export interface ScoreBatchResult {
  created: number;
  unchanged: number;
  /** Aziende inesistenti o unite a un'altra (nessun punteggio). */
  skipped: number;
  /** Nuove esecuzioni dell'abbinamento ai servizi (Fase 5). */
  matchesCreated: number;
  results: Map<string, { snapshotId: string; created: boolean }>;
}

/** Calcola (o conferma) il punteggio di un elenco di aziende, a lotti, una transazione per lotto. */
export async function scoreBusinesses(
  db: Db,
  ids: string[],
  opts: { trigger: ScoreTrigger; userId?: string | null; force?: boolean; now?: Date },
): Promise<ScoreBatchResult> {
  const out: ScoreBatchResult = { created: 0, unchanged: 0, skipped: 0, matchesCreated: 0, results: new Map() };
  const unique = [...new Set(ids)].sort();
  const cfg = await activeConfig(db);
  const catalog = await activeCatalog(db);
  for (let i = 0; i < unique.length; i += SCORING_BATCH_SIZE) {
    const chunk = unique.slice(i, i + SCORING_BATCH_SIZE);
    const now = opts.now ?? new Date();
    await db.transaction(async (tx) => {
      // le righe delle aziende fanno da lucchetto: due calcoli contemporanei della stessa azienda si mettono in fila
      await tx.query('SELECT id FROM businesses WHERE id = ANY($1) ORDER BY id FOR UPDATE', [chunk]);
      const inputs = await loadInputs(tx, chunk);
      const { rows: current } = await tx.query<{ business_id: string; id: string; input_hash: string }>(
        'SELECT business_id, id, input_hash FROM lead_scores WHERE is_current AND business_id = ANY($1)',
        [chunk],
      );
      const currentBy = new Map(current.map((r) => [r.business_id, r]));
      const { rows: runs } = await tx.query<{ business_id: string; id: string; input_hash: string }>(
        'SELECT business_id, id, input_hash FROM service_match_runs WHERE is_current AND business_id = ANY($1)',
        [chunk],
      );
      const runBy = new Map(runs.map((r) => [r.business_id, r]));
      for (const id of chunk) {
        const input = inputs.get(id);
        if (!input) {
          out.skipped++;
          continue;
        }
        const hash = inputHash(input, cfg, now);
        const cur = currentBy.get(id);
        // il risultato serve anche all'abbinamento ai servizi (affidabilità delle prove), anche se il punteggio non cambia
        const r = scoreLead(input, cfg.config, now);
        const match = (leadScoreId: string) =>
          writeMatchRun(tx, {
            input,
            lead: r,
            leadScoreId,
            scoringConfig: cfg.config,
            catalog,
            scoringHash: hash,
            trigger: opts.trigger,
            userId: opts.userId ?? null,
            force: opts.force ?? false,
            now,
            current: runBy.get(id),
          }).then((created) => void (created && out.matchesCreated++));
        if (cur && cur.input_hash === hash && !opts.force) {
          out.unchanged++;
          out.results.set(id, { snapshotId: cur.id, created: false });
          await match(cur.id);
          continue;
        }
        if (cur) await tx.query('UPDATE lead_scores SET is_current = false WHERE id = $1', [cur.id]);
        const { rows } = await tx.query<{ id: string }>(
          `INSERT INTO lead_scores (business_id, audit_id, website_id, algorithm_version, config_version, input_hash, status, score,
                                    raw_score, band, confidence, confidence_level, completeness, breakdown, explanation, next_step,
                                    trigger, requested_by, calculated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19) RETURNING id`,
          [
            id,
            r.evidence.auditId,
            r.evidence.websiteId,
            r.algorithmVersion,
            cfg.version,
            hash,
            r.status,
            r.score,
            r.rawScore,
            r.band,
            r.confidence.value,
            r.confidence.level,
            r.completeness.value,
            JSON.stringify(breakdownOf(r)),
            r.explanation,
            r.nextStep,
            opts.trigger,
            opts.userId ?? null,
            now,
          ],
        );
        out.created++;
        out.results.set(id, { snapshotId: rows[0]!.id, created: true });
        await match(rows[0]!.id);
      }
    });
  }
  return out;
}

/** Parte salvata come dettaglio (i campi principali hanno colonne proprie). */
function breakdownOf(r: ScoreResult) {
  return {
    rawScore: r.rawScore,
    dimensions: r.dimensions,
    confidence: r.confidence,
    completeness: r.completeness,
    capabilities: r.capabilities,
    services: r.services,
    topFindings: r.topFindings,
    signals: r.signals,
    reasons: r.reasons,
    evidence: r.evidence,
  };
}

interface ScoreRow {
  id: string;
  business_id: string;
  audit_id: string | null;
  website_id: string | null;
  algorithm_version: number;
  config_version: number;
  status: string;
  score: number | null;
  raw_score: string | null;
  band: string | null;
  confidence: number;
  confidence_level: string;
  completeness: number;
  breakdown: Record<string, unknown>;
  explanation: string;
  next_step: string;
  trigger: string;
  requested_by_name: string | null;
  is_current: boolean;
  calculated_at: Date;
}

const SCORE_SELECT = `SELECT s.*, u.display_name AS requested_by_name FROM lead_scores s LEFT JOIN users u ON u.id = s.requested_by`;

function scoreDto(r: ScoreRow, withBreakdown: boolean) {
  return {
    id: r.id,
    businessId: r.business_id,
    auditId: r.audit_id,
    websiteId: r.website_id,
    algorithmVersion: r.algorithm_version,
    configVersion: r.config_version,
    status: r.status,
    score: r.score,
    rawScore: r.raw_score === null ? null : Number(r.raw_score),
    band: r.band,
    confidence: { value: r.confidence, level: r.confidence_level },
    completeness: r.completeness,
    explanation: r.explanation,
    nextStep: r.next_step,
    trigger: r.trigger,
    requestedBy: r.requested_by_name,
    isCurrent: r.is_current,
    calculatedAt: iso(r.calculated_at),
    ...(withBreakdown ? { breakdown: r.breakdown } : {}),
  };
}

/** Motivi per cui il punteggio attuale potrebbe non riflettere più i dati (da ricalcolare). */
async function outdatedReasons(db: Queryable, r: ScoreRow): Promise<string[]> {
  const cfg = await activeConfig(db);
  const { rows } = await db.query<{ last_audit_id: string | null; updated_at: Date }>(
    `SELECT w.last_audit_id, b.updated_at FROM businesses b
       LEFT JOIN business_websites bw ON bw.business_id = b.id LEFT JOIN websites w ON w.id = bw.website_id
      WHERE b.id = $1`,
    [r.business_id],
  );
  const reasons: string[] = [];
  if (r.config_version !== cfg.version)
    reasons.push(`Calcolato con la configurazione v${r.config_version}; attiva: v${cfg.version}.`);
  if (rows[0] && (rows[0].last_audit_id ?? null) !== (r.audit_id ?? null) && rows[0].last_audit_id)
    reasons.push('Il sito ha un audit più recente.');
  if (rows[0] && rows[0].updated_at > r.calculated_at)
    reasons.push('I dati dell’azienda sono cambiati dopo il calcolo.');
  return reasons;
}

export async function latestScore(db: Queryable, businessId: string) {
  const { rows } = await db.query<ScoreRow>(`${SCORE_SELECT} WHERE s.business_id = $1 AND s.is_current`, [businessId]);
  if (!rows[0]) return null;
  return { ...scoreDto(rows[0], true), outdated: await outdatedReasons(db, rows[0]) };
}

export async function scoreDetail(db: Queryable, id: string) {
  const { rows } = await db.query<ScoreRow>(`${SCORE_SELECT} WHERE s.id = $1`, [id]);
  if (!rows[0]) throw new JobError(404, 'NOT_FOUND', 'Punteggio non trovato.');
  return { ...scoreDto(rows[0], true), outdated: rows[0].is_current ? await outdatedReasons(db, rows[0]) : [] };
}

export async function scoreHistory(db: Queryable, businessId: string, page: number, pageSize: number) {
  const { rows: total } = await db.query<{ n: number }>(
    'SELECT count(*)::int AS n FROM lead_scores WHERE business_id = $1',
    [businessId],
  );
  const { rows } = await db.query<ScoreRow>(
    `${SCORE_SELECT} WHERE s.business_id = $1 ORDER BY s.calculated_at DESC, s.id LIMIT $2 OFFSET $3`,
    [businessId, pageSize, (page - 1) * pageSize],
  );
  return { items: rows.map((r) => scoreDto(r, false)), total: total[0]!.n, page, pageSize };
}

/** Conteggi per fascia e stato dei punteggi attuali, e quanti sono su una configurazione superata. */
export async function scoringStats(db: Queryable) {
  const cfg = await activeConfig(db);
  const { rows } = await db.query<{ status: string; band: string | null; n: number }>(
    `SELECT s.status, s.band, count(*)::int AS n FROM lead_scores s JOIN businesses b ON b.id = s.business_id
      WHERE s.is_current AND b.merged_into IS NULL GROUP BY s.status, s.band`,
  );
  const { rows: other } = await db.query<{ unscored: number; old_config: number }>(
    `SELECT (SELECT count(*)::int FROM businesses b WHERE b.merged_into IS NULL
               AND NOT EXISTS (SELECT 1 FROM lead_scores s WHERE s.business_id = b.id AND s.is_current)) AS unscored,
            (SELECT count(*)::int FROM lead_scores s JOIN businesses b ON b.id = s.business_id
              WHERE s.is_current AND b.merged_into IS NULL AND s.config_version <> $1) AS old_config`,
    [cfg.version],
  );
  return {
    configVersion: cfg.version,
    byStatus: rows.map((r) => ({ status: r.status, band: r.band, count: r.n })),
    unscored: other[0]!.unscored,
    outdatedConfig: other[0]!.old_config,
  };
}

/** Dopo un audit: ricalcola le aziende che condividono il sito (l'audit è del sito, non della singola azienda). */
export async function rescoreAfterAudit(db: Db, businessId: string) {
  const { rows } = await db.query<{ business_id: string }>(
    `SELECT other.business_id FROM business_websites bw
       JOIN business_websites other ON other.website_id = bw.website_id
      WHERE bw.business_id = $1 AND bw.website_id IS NOT NULL`,
    [businessId],
  );
  return scoreBusinesses(db, [businessId, ...rows.map((r) => r.business_id)], { trigger: 'audit' });
}
