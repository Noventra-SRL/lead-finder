import { createHash } from 'node:crypto';
import { audit as auditLog } from '../audit.ts';
import type { Db, Queryable } from '../db/client.ts';
import { JobError } from '../discovery/jobs.ts';
import type { ScoringConfig } from '../scoring/config.ts';
import type { ScoreResult, ScoringInput } from '../scoring/engine.ts';
import { DEFAULT_CATALOG, MATCHING_ALGORITHM_VERSION, validateCatalog, type ServiceCatalog } from './catalog.ts';
import { matchServices, shortlist, type MatchStatus, type ReviewStatus, type ShortlistCandidate } from './engine.ts';

/*
 * Persistenza dell'abbinamento ai servizi.
 *  - catalogo: versioni immutabili in service_catalog_versions (la più alta è attiva; la prima dai valori del codice);
 *  - esecuzioni: nuove solo se cambiano dati, punteggio delle prove, catalogo o regole (o su richiesta);
 *  - revisioni delle persone: solo aggiunte, valgono per azienda e servizio anche dopo un ricalcolo.
 * Il calcolo avviene nello stesso lotto del punteggio (stessi dati in ingresso, una transazione per lotto).
 */

const iso = (d: Date | string | null) => (d ? new Date(d).toISOString() : null);

export interface ActiveCatalog {
  version: number;
  catalog: ServiceCatalog;
  createdAt: string;
  createdBy: string | null;
  note: string | null;
}

export async function activeCatalog(db: Queryable): Promise<ActiveCatalog> {
  const read = () =>
    db.query<{
      version: number;
      catalog: unknown;
      created_at: Date;
      created_by_name: string | null;
      note: string | null;
    }>(
      `SELECT c.version, c.catalog, c.created_at, c.note, u.display_name AS created_by_name
         FROM service_catalog_versions c LEFT JOIN users u ON u.id = c.created_by ORDER BY c.version DESC LIMIT 1`,
    );
  let { rows } = await read();
  if (!rows[0]) {
    await db.query(
      "INSERT INTO service_catalog_versions (version, catalog, note) VALUES (1, $1, 'Servizi pubblicati su noventra.it (21/10/2026)') ON CONFLICT (version) DO NOTHING",
      [JSON.stringify(DEFAULT_CATALOG)],
    );
    ({ rows } = await read());
  }
  const r = rows[0]!;
  const v = validateCatalog(r.catalog);
  if (!v.ok)
    throw new Error(
      `Catalogo dei servizi v${r.version} non valido: ${Object.entries(v.errors)
        .map(([k, m]) => `${k}: ${m}`)
        .join('; ')}`,
    );
  return {
    version: r.version,
    catalog: v.catalog,
    createdAt: iso(r.created_at)!,
    createdBy: r.created_by_name,
    note: r.note,
  };
}

export async function catalogHistory(db: Queryable) {
  const { rows } = await db.query<{
    version: number;
    created_at: Date;
    created_by_name: string | null;
    note: string | null;
  }>(
    `SELECT c.version, c.created_at, c.note, u.display_name AS created_by_name
       FROM service_catalog_versions c LEFT JOIN users u ON u.id = c.created_by ORDER BY c.version DESC LIMIT 50`,
  );
  return rows.map((r) => ({
    version: r.version,
    createdAt: iso(r.created_at),
    createdBy: r.created_by_name,
    note: r.note,
  }));
}

export async function saveCatalog(db: Db, input: unknown, ctx: { userId: string; note?: string }) {
  const v = validateCatalog(input);
  if (!v.ok) throw new JobError(400, 'INVALID_CATALOG', 'Il catalogo non è valido: nessuna modifica salvata.');
  await activeCatalog(db);
  return db.transaction(async (tx) => {
    await tx.query('LOCK TABLE service_catalog_versions IN EXCLUSIVE MODE');
    const { rows } = await tx.query<{ v: number }>('SELECT max(version)::int AS v FROM service_catalog_versions');
    const version = (rows[0]?.v ?? 0) + 1;
    await tx.query(
      'INSERT INTO service_catalog_versions (version, catalog, note, created_by) VALUES ($1, $2, $3, $4)',
      [version, JSON.stringify(v.catalog), ctx.note ?? null, ctx.userId],
    );
    await auditLog(tx, {
      userId: ctx.userId,
      action: 'services.catalog_updated',
      entityType: 'service_catalog',
      entityId: String(version),
      details: { note: ctx.note ?? null },
    });
    return version;
  });
}

/** Impronta dell'abbinamento: dati in ingresso del punteggio (con le loro versioni) + catalogo + algoritmo. */
export const matchHash = (scoringHash: string, catalogVersion: number) =>
  createHash('sha256')
    .update(`${scoringHash}|catalog:${catalogVersion}|match:${MATCHING_ALGORITHM_VERSION}`)
    .digest('hex');

/** Scrive (o conferma) l'abbinamento di un'azienda dentro la transazione del lotto. true = nuova esecuzione. */
export async function writeMatchRun(
  tx: Queryable,
  args: {
    input: ScoringInput;
    lead: ScoreResult;
    leadScoreId: string;
    scoringConfig: ScoringConfig;
    catalog: ActiveCatalog;
    scoringHash: string;
    trigger: 'manual' | 'audit' | 'discovery' | 'bulk';
    userId: string | null;
    force: boolean;
    now: Date;
    current: { id: string; input_hash: string } | undefined;
  },
): Promise<boolean> {
  const hash = matchHash(args.scoringHash, args.catalog.version);
  if (args.current && args.current.input_hash === hash && !args.force) return false;
  const businessId = args.input.business.id;
  const result = matchServices(args.input, args.lead, args.scoringConfig, args.catalog.catalog);
  if (args.current) {
    await tx.query('UPDATE service_match_runs SET is_current = false WHERE id = $1', [args.current.id]);
    await tx.query('UPDATE service_matches SET is_current = false WHERE run_id = $1', [args.current.id]);
  }
  const { rows } = await tx.query<{ id: string }>(
    `INSERT INTO service_match_runs (business_id, lead_score_id, audit_id, catalog_version, algorithm_version, input_hash, confidence_level,
                                     trigger, requested_by, calculated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
    [
      businessId,
      args.leadScoreId,
      args.lead.evidence.auditId,
      args.catalog.version,
      result.algorithmVersion,
      hash,
      result.confidenceLevel,
      args.trigger,
      args.userId,
      args.now,
    ],
  );
  const runId = rows[0]!.id;
  for (const m of result.matches)
    await tx.query(
      `INSERT INTO service_matches (run_id, business_id, service_id, status, strength, score, raw_score, confidence, confidence_level,
                                    completeness, dedupe_group, dimensions, evidence, signals, reasons, problem, explanation, next_step, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19)`,
      [
        runId,
        businessId,
        m.serviceId,
        m.status,
        m.strength,
        m.score,
        m.rawScore,
        m.confidence.value,
        m.confidence.level,
        m.completeness,
        m.dedupeGroup,
        JSON.stringify(m.dimensions),
        JSON.stringify(m.evidence),
        JSON.stringify(m.signals),
        JSON.stringify(m.reasons),
        m.problem,
        m.explanation,
        m.nextStep,
        args.now,
      ],
    );
  return true;
}

// ---------- revisioni ----------

export type ReviewAction = 'accepted_for_review' | 'dismissed' | 'needs_review' | 'reopened' | 'note';

export async function addReview(
  db: Db,
  args: { businessId: string; serviceId: string; action: ReviewAction; note?: string; userId: string },
) {
  const cat = await activeCatalog(db);
  const svc = cat.catalog.services.find((s) => s.id === args.serviceId);
  if (!svc || !svc.verified) throw new JobError(404, 'UNKNOWN_SERVICE', 'Servizio non presente nel catalogo.');
  if (args.action === 'note' && !args.note?.trim())
    throw new JobError(400, 'NOTE_REQUIRED', 'Scrivi la nota da salvare.');
  return db.transaction(async (tx) => {
    const { rows: b } = await tx.query<{ merged_into: string | null }>(
      'SELECT merged_into FROM businesses WHERE id = $1',
      [args.businessId],
    );
    if (!b[0]) throw new JobError(404, 'NOT_FOUND', 'Azienda non trovata.');
    const { rows: m } = await tx.query<{ id: string }>(
      'SELECT id FROM service_matches WHERE business_id = $1 AND service_id = $2 AND is_current',
      [args.businessId, args.serviceId],
    );
    const { rows } = await tx.query<{ id: string }>(
      'INSERT INTO service_match_reviews (business_id, service_id, action, note, match_id, user_id) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id',
      [args.businessId, args.serviceId, args.action, args.note?.trim() || null, m[0]?.id ?? null, args.userId],
    );
    await auditLog(tx, {
      userId: args.userId,
      action: 'services.match_reviewed',
      entityType: 'business',
      entityId: args.businessId,
      details: { service: args.serviceId, action: args.action },
    });
    return rows[0]!.id;
  });
}

interface ReviewRow {
  service_id: string;
  action: ReviewAction;
  note: string | null;
  created_at: Date;
  user_name: string | null;
  match_id: string | null;
}

/** Stato di revisione attuale per servizio: l'ultima azione diversa da "nota" ("riaperto" azzera). */
function reviewStatusOf(rows: ReviewRow[]): ReviewStatus {
  const last = rows.find((r) => r.action !== 'note');
  if (!last || last.action === 'reopened' || last.action === 'note') return null;
  return last.action;
}

// ---------- letture ----------

interface MatchRow {
  id: string;
  run_id: string;
  service_id: string;
  status: MatchStatus;
  strength: 'recommended' | 'possible' | null;
  score: number | null;
  raw_score: string | null;
  confidence: number;
  confidence_level: 'high' | 'medium' | 'low';
  completeness: number;
  dedupe_group: string;
  dimensions: unknown;
  evidence: unknown;
  signals: unknown;
  reasons: string[];
  problem: string | null;
  explanation: string;
  next_step: string;
  created_at: Date;
}

const matchDto = (m: MatchRow) => ({
  id: m.id,
  serviceId: m.service_id,
  status: m.status,
  strength: m.strength,
  score: m.score,
  rawScore: m.raw_score === null ? null : Number(m.raw_score),
  confidence: { value: m.confidence, level: m.confidence_level },
  completeness: m.completeness,
  dedupeGroup: m.dedupe_group,
  dimensions: m.dimensions,
  evidence: m.evidence,
  signals: m.signals,
  reasons: m.reasons,
  problem: m.problem,
  explanation: m.explanation,
  nextStep: m.next_step,
  calculatedAt: iso(m.created_at),
});

/** Servizi per un'azienda: lista breve, tutte le corrispondenze, revisioni, servizi solo manuali, contesto. */
export async function businessServices(db: Queryable, businessId: string) {
  const { rows: b } = await db.query<{ id: string; updated_at: Date; last_audit_id: string | null }>(
    `SELECT b.id, b.updated_at, w.last_audit_id FROM businesses b
       LEFT JOIN business_websites bw ON bw.business_id = b.id LEFT JOIN websites w ON w.id = bw.website_id WHERE b.id = $1`,
    [businessId],
  );
  if (!b[0]) throw new JobError(404, 'NOT_FOUND', 'Azienda non trovata.');
  const cat = await activeCatalog(db);
  const { rows: runs } = await db.query<{
    id: string;
    catalog_version: number;
    algorithm_version: number;
    confidence_level: 'high' | 'medium' | 'low';
    audit_id: string | null;
    lead_score_id: string | null;
    trigger: string;
    calculated_at: Date;
  }>('SELECT * FROM service_match_runs WHERE business_id = $1 AND is_current', [businessId]);
  const run = runs[0];
  const matches = run
    ? (
        await db.query<MatchRow>(
          'SELECT * FROM service_matches WHERE run_id = $1 ORDER BY score DESC NULLS LAST, service_id',
          [run.id],
        )
      ).rows
    : [];
  const { rows: reviews } = await db.query<ReviewRow>(
    `SELECT r.service_id, r.action, r.note, r.created_at, r.match_id, u.display_name AS user_name
       FROM service_match_reviews r LEFT JOIN users u ON u.id = r.user_id
      WHERE r.business_id = $1 ORDER BY r.created_at DESC, r.id DESC LIMIT 500`,
    [businessId],
  );
  const reviewsBy = new Map<string, ReviewRow[]>();
  for (const r of reviews) reviewsBy.set(r.service_id, [...(reviewsBy.get(r.service_id) ?? []), r]);
  const services = new Map(cat.catalog.services.map((s) => [s.id, s]));
  const reviewDto = (id: string) => {
    const rows = reviewsBy.get(id) ?? [];
    const status = reviewStatusOf(rows);
    const last = rows.find((r) => r.action !== 'note');
    return {
      status,
      // archiviato prima del calcolo attuale: le prove potrebbero essere cambiate da allora
      changedSince: Boolean(
        status &&
        run &&
        last &&
        last.created_at < run.calculated_at &&
        last.match_id !== null &&
        !matches.some((m) => m.id === last.match_id),
      ),
      history: rows
        .slice(0, 20)
        .map((r) => ({ action: r.action, note: r.note, at: iso(r.created_at), user: r.user_name })),
    };
  };
  const candidates: ShortlistCandidate[] = matches.map((m) => ({
    serviceId: m.service_id,
    status: m.status,
    strength: m.strength,
    score: m.score,
    dedupeGroup: m.dedupe_group,
    review: reviewStatusOf(reviewsBy.get(m.service_id) ?? []),
  }));
  const list = run ? shortlist(candidates, cat.catalog, run.confidence_level) : [];
  const outdated: string[] = [];
  if (run) {
    if (run.catalog_version !== cat.version)
      outdated.push(`Calcolato con il catalogo v${run.catalog_version}; attivo: v${cat.version}.`);
    if (b[0].last_audit_id && b[0].last_audit_id !== run.audit_id) outdated.push('Il sito ha un audit più recente.');
    if (b[0].updated_at > run.calculated_at) outdated.push('I dati dell’azienda sono cambiati dopo il calcolo.');
  }
  const svcInfo = (id: string) => {
    const s = services.get(id);
    return s
      ? {
          id: s.id,
          name: s.name,
          category: s.category,
          description: s.description,
          source: s.source,
          problems: s.problems,
          nextSteps: s.nextSteps,
          requiresTeamConfirmation: s.requiresTeamConfirmation,
        }
      : {
          id,
          name: id,
          category: null,
          description: null,
          source: null,
          problems: [],
          nextSteps: [],
          requiresTeamConfirmation: false,
        };
  };
  return {
    catalogVersion: cat.version,
    run: run
      ? {
          id: run.id,
          catalogVersion: run.catalog_version,
          algorithmVersion: run.algorithm_version,
          confidenceLevel: run.confidence_level,
          auditId: run.audit_id,
          leadScoreId: run.lead_score_id,
          trigger: run.trigger,
          calculatedAt: iso(run.calculated_at),
          outdated,
        }
      : null,
    shortlist: list,
    matches: matches.map((m) => ({ ...matchDto(m), service: svcInfo(m.service_id), review: reviewDto(m.service_id) })),
    manualServices: cat.catalog.services
      .filter((s) => s.active && s.verified && !s.autoMatch)
      .map((s) => ({ service: svcInfo(s.id), review: reviewDto(s.id) })),
  };
}

export async function matchHistory(db: Queryable, businessId: string, page: number, pageSize: number) {
  const { rows: total } = await db.query<{ n: number }>(
    'SELECT count(*)::int AS n FROM service_match_runs WHERE business_id = $1',
    [businessId],
  );
  const { rows } = await db.query<{
    id: string;
    catalog_version: number;
    algorithm_version: number;
    confidence_level: string;
    trigger: string;
    is_current: boolean;
    calculated_at: Date;
    proposed: { serviceId: string; status: string; score: number | null }[] | null;
  }>(
    `SELECT r.id, r.catalog_version, r.algorithm_version, r.confidence_level, r.trigger, r.is_current, r.calculated_at,
            (SELECT json_agg(json_build_object('serviceId', m.service_id, 'status', m.status, 'score', m.score) ORDER BY m.score DESC)
               FROM service_matches m WHERE m.run_id = r.id AND m.status IN ('recommended', 'possible', 'needs_review')) AS proposed
       FROM service_match_runs r WHERE r.business_id = $1 ORDER BY r.calculated_at DESC, r.id LIMIT $2 OFFSET $3`,
    [businessId, pageSize, (page - 1) * pageSize],
  );
  return {
    items: rows.map((r) => ({
      id: r.id,
      catalogVersion: r.catalog_version,
      algorithmVersion: r.algorithm_version,
      confidenceLevel: r.confidence_level,
      trigger: r.trigger,
      isCurrent: r.is_current,
      calculatedAt: iso(r.calculated_at),
      proposed: r.proposed ?? [],
    })),
    total: total[0]!.n,
    page,
    pageSize,
  };
}

/** Catalogo con il numero di aziende per cui ogni servizio è attualmente proposto (non archiviato). */
export async function listServices(db: Queryable) {
  const cat = await activeCatalog(db);
  const { rows } = await db.query<{ service_id: string; recommended: number; possible: number; review: number }>(
    `SELECT m.service_id,
            count(*) FILTER (WHERE m.status = 'recommended')::int AS recommended,
            count(*) FILTER (WHERE m.status = 'possible')::int AS possible,
            count(*) FILTER (WHERE m.status = 'needs_review')::int AS review
       FROM service_matches m JOIN businesses b ON b.id = m.business_id AND b.merged_into IS NULL
      WHERE m.is_current AND NOT ${DISMISSED('m')}
      GROUP BY m.service_id`,
  );
  const counts = new Map(rows.map((r) => [r.service_id, r]));
  return {
    version: cat.version,
    createdAt: cat.createdAt,
    createdBy: cat.createdBy,
    note: cat.note,
    settings: { weights: cat.catalog.weights, thresholds: cat.catalog.thresholds, shortlist: cat.catalog.shortlist },
    services: cat.catalog.services.map((s) => ({
      ...s,
      counts: {
        recommended: counts.get(s.id)?.recommended ?? 0,
        possible: counts.get(s.id)?.possible ?? 0,
        needsReview: counts.get(s.id)?.review ?? 0,
      },
    })),
  };
}

/** Condizione SQL: l'abbinamento m è stato archiviato da una persona (ultima azione diversa da "nota"). */
export const DISMISSED = (m: string) => `COALESCE((SELECT r.action FROM service_match_reviews r
   WHERE r.business_id = ${m}.business_id AND r.service_id = ${m}.service_id AND r.action <> 'note'
   ORDER BY r.created_at DESC, r.id DESC LIMIT 1) = 'dismissed', false)`;

/**
 * Servizio principale (primo della lista breve) per una pagina di aziende, con una query per lotto.
 * Stessa logica della scheda: proponibili, non archiviati, uno per problema, meno voci con prove poco affidabili.
 */
export async function primaryServices(db: Queryable, businessIds: string[]) {
  const out = new Map<
    string,
    {
      serviceId: string;
      name: string;
      score: number | null;
      status: MatchStatus;
      review: ReviewStatus;
      others: number;
      /** Lista breve completa (per l'esportazione). */
      shortlist: { serviceId: string; name: string; score: number | null }[];
    }
  >();
  if (!businessIds.length) return out;
  const cat = await activeCatalog(db);
  const names = new Map(cat.catalog.services.map((s) => [s.id, s.name]));
  const { rows } = await db.query<{
    business_id: string;
    service_id: string;
    status: MatchStatus;
    strength: 'recommended' | 'possible' | null;
    score: number | null;
    dedupe_group: string;
    confidence_level: 'high' | 'medium' | 'low';
    review: ReviewStatus | 'reopened' | null;
  }>(
    `SELECT m.business_id, m.service_id, m.status, m.strength, m.score, m.dedupe_group, r.confidence_level,
            (SELECT x.action FROM service_match_reviews x
              WHERE x.business_id = m.business_id AND x.service_id = m.service_id AND x.action <> 'note'
              ORDER BY x.created_at DESC, x.id DESC LIMIT 1) AS review
       FROM service_matches m JOIN service_match_runs r ON r.id = m.run_id
      WHERE m.is_current AND m.business_id = ANY($1) AND m.status IN ('recommended', 'possible', 'needs_review')`,
    [businessIds],
  );
  const by = new Map<string, typeof rows>();
  for (const r of rows) by.set(r.business_id, [...(by.get(r.business_id) ?? []), r]);
  for (const [id, list] of by) {
    const candidates: ShortlistCandidate[] = list.map((r) => ({
      serviceId: r.service_id,
      status: r.status,
      strength: r.strength,
      score: r.score,
      dedupeGroup: r.dedupe_group,
      review: r.review === 'reopened' ? null : r.review,
    }));
    const ids = shortlist(candidates, cat.catalog, list[0]!.confidence_level);
    const first = ids[0] && candidates.find((c) => c.serviceId === ids[0]);
    if (first)
      out.set(id, {
        serviceId: first.serviceId,
        name: names.get(first.serviceId) ?? first.serviceId,
        score: first.score,
        status: first.status,
        review: first.review,
        others: ids.length - 1,
        shortlist: ids.map((sid) => ({
          serviceId: sid,
          name: names.get(sid) ?? sid,
          score: candidates.find((c) => c.serviceId === sid)?.score ?? null,
        })),
      });
  }
  return out;
}
