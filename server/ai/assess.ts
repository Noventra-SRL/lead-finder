import { randomUUID } from 'node:crypto';
import { audit } from '../audit.ts';
import type { AiConfig } from '../config.ts';
import type { Db, Queryable } from '../db/client.ts';
import { JobError } from '../discovery/jobs.ts';
import { activeAiConfig, COMPONENT_LABEL, COMPONENTS, PENALTIES } from './config.ts';
import { buildContext, cacheKey, type AssessmentContext } from './context.ts';
import { acquireLease, finishLease } from './lease.ts';
import { AI_STATE_LABEL, AI_STATE_SQL, type AiState } from './state.ts';
import { AiError, type AiProvider } from './provider.ts';
import { PROMPT_VERSION, SYSTEM_PROMPT, userMessage, type AiOutput } from './prompt.ts';
import { computeScore, validateOutput, type ScoreResult } from './score.ts';

/*
 * Valutazione commerciale di un'azienda:
 *  1. contesto dalle prove esistenti (context.ts) e impronta per la cache;
 *  2. se esiste una valutazione riuscita con la stessa impronta, si riusa (nessuna chiamata, nessun costo);
 *  3. chiamata al modello; se la risposta non supera la validazione, UN secondo tentativo con l'elenco degli errori;
 *  4. calcolo deterministico del punteggio (score.ts) e salvataggio.
 * Ogni tentativo è salvato; un tentativo fallito non sostituisce mai la valutazione valida precedente e non
 * produce mai un punteggio.
 *
 * Concorrenza e freschezza (valutazione di ogni azienda):
 *  - un lease per azienda: una sola valutazione alla volta (singola, lotto o coda automatica), anche tra processi;
 *  - un risultato diventa «corrente» solo se le prove non sono cambiate durante la chiamata e nessuna valutazione più
 *    recente è già stata salvata: un risultato vecchio non sovrascrive mai uno nuovo (resta nello storico).
 */

export type AssessOutcome =
  | { status: 'assessed' | 'cached'; assessmentId: string; current: boolean }
  | { status: 'failed'; assessmentId: string; code: string; message: string }
  | { status: 'skipped'; reason: 'not_found' | 'merged' | 'busy' };

const MAX_VALIDATION_ATTEMPTS = 2;

export function costOf(config: AiConfig, inputTokens: number | null, outputTokens: number | null): number | null {
  if (!config.price || inputTokens === null || outputTokens === null) return null;
  return (inputTokens * config.price.inputPerMTok + outputTokens * config.price.outputPerMTok) / 1_000_000;
}

export async function assessBusiness(
  db: Db,
  provider: AiProvider | null,
  aiConfig: AiConfig,
  businessId: string,
  opts: {
    trigger: 'manual' | 'batch' | 'auto';
    userId: string | null;
    force?: boolean;
    signal?: AbortSignal;
    /** Lease già preso dal chiamante (coda automatica); altrimenti lo prende questa funzione. */
    leaseHolder?: string;
  },
): Promise<AssessOutcome> {
  if (!provider)
    throw new JobError(503, 'AI_NOT_CONFIGURED', 'Valutazione AI non configurata: imposta AI_API_KEY sul server.');
  const { rows: b } = await db.query<{ merged_into: string | null }>(
    'SELECT merged_into FROM businesses WHERE id = $1',
    [businessId],
  );
  if (!b[0]) return { status: 'skipped', reason: 'not_found' };
  if (b[0].merged_into) return { status: 'skipped', reason: 'merged' };
  const holder = opts.leaseHolder ?? `${opts.trigger}-${randomUUID()}`;
  if (!opts.leaseHolder && !(await acquireLease(db, businessId, holder))) return { status: 'skipped', reason: 'busy' };
  let outcome: AssessOutcome | null = null;
  let fingerprint: string | null = null;
  try {
    const r = await assessLocked(db, provider, aiConfig, businessId, opts);
    outcome = r.outcome;
    fingerprint = r.fingerprint;
    return r.outcome;
  } finally {
    await finishLease(
      db,
      businessId,
      holder,
      !outcome
        ? { kind: 'failed', code: 'unknown', message: 'Errore imprevisto durante la valutazione.' }
        : outcome.status === 'failed'
          ? { kind: 'failed', code: outcome.code, message: outcome.message }
          : outcome.status === 'skipped' || !outcome.current
            ? { kind: 'requeue' }
            : { kind: 'done', fingerprint: fingerprint! },
    );
  }
}

async function assessLocked(
  db: Db,
  provider: AiProvider,
  aiConfig: AiConfig,
  businessId: string,
  opts: { trigger: 'manual' | 'batch' | 'auto'; userId: string | null; force?: boolean; signal?: AbortSignal },
): Promise<{ outcome: AssessOutcome; fingerprint: string }> {
  const ctx = (await buildContext(db, businessId))!;
  const config = await activeAiConfig(db);
  const key = cacheKey(ctx, { configVersion: config.version, promptVersion: PROMPT_VERSION, model: provider.model });

  if (!opts.force) {
    const { rows } = await db.query<{ id: string; is_current: boolean }>(
      `SELECT id, is_current FROM ai_assessments WHERE business_id = $1 AND cache_key = $2 AND status = 'succeeded'
        ORDER BY created_at DESC LIMIT 1`,
      [businessId, key],
    );
    if (rows[0]) {
      if (!rows[0].is_current)
        await db.transaction(async (tx) => {
          await tx.query('UPDATE ai_assessments SET is_current = false WHERE business_id = $1 AND is_current', [
            businessId,
          ]);
          await tx.query('UPDATE ai_assessments SET is_current = true WHERE id = $1', [rows[0]!.id]);
        });
      return { outcome: { status: 'cached', assessmentId: rows[0].id, current: true }, fingerprint: key };
    }
  }

  const started = Date.now();
  let output: AiOutput | null = null;
  let warnings: string[] = [];
  let feedback: string | undefined;
  let inputTokens = 0;
  let outputTokens = 0;
  let tokensKnown = true;
  let attempts = 0;
  let model = provider.model;
  let failure: { code: string; message: string } | null = null;
  while (attempts < MAX_VALIDATION_ATTEMPTS) {
    attempts++;
    try {
      const r = await provider.assess({ system: SYSTEM_PROMPT, user: userMessage(ctx, feedback), signal: opts.signal });
      model = r.model;
      if (r.inputTokens === null || r.outputTokens === null) tokensKnown = false;
      inputTokens += r.inputTokens ?? 0;
      outputTokens += r.outputTokens ?? 0;
      const v = validateOutput(r.output, ctx);
      if (v.ok) {
        output = v.output;
        warnings = v.warnings;
        failure = null;
        break;
      }
      failure = { code: 'invalid_output', message: `Risposta non valida: ${v.errors.join('; ')}`.slice(0, 500) };
      feedback = v.errors.join('; ');
    } catch (error) {
      const e =
        error instanceof AiError ? error : new AiError('unknown', 'Errore imprevisto durante la valutazione AI.');
      failure = { code: e.code, message: e.message };
      // errori di rete e limiti sono già stati ripetuti dall'SDK con attesa crescente; un JSON non valido si ripete qui
      if (e.code !== 'invalid_output' && e.code !== 'truncated') break;
      feedback = e.message;
    }
  }
  const duration = Date.now() - started;
  const cost = tokensKnown ? costOf(aiConfig, inputTokens, outputTokens) : null;
  const base = {
    business_id: businessId,
    cache_key: key,
    provider: provider.name,
    model,
    prompt_version: PROMPT_VERSION,
    config_version: config.version,
    context: JSON.stringify({ evidence: ctx.evidence, catalog: ctx.catalog.map((c) => c.id), facts: ctx.facts }),
    input_tokens: tokensKnown ? inputTokens : null,
    output_tokens: tokensKnown ? outputTokens : null,
    cost_usd: cost,
    attempts,
    duration_ms: duration,
    trigger: opts.trigger,
    requested_by: opts.userId,
  };

  if (!output) {
    const { rows } = await db.query<{ id: string }>(
      `INSERT INTO ai_assessments (business_id, status, cache_key, provider, model, prompt_version, config_version, context,
         input_tokens, output_tokens, cost_usd, attempts, duration_ms, error_code, error_message, trigger, requested_by)
       VALUES ($1, 'failed', $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16) RETURNING id`,
      [
        base.business_id,
        base.cache_key,
        base.provider,
        base.model,
        base.prompt_version,
        base.config_version,
        base.context,
        base.input_tokens,
        base.output_tokens,
        base.cost_usd,
        base.attempts,
        base.duration_ms,
        failure!.code,
        failure!.message,
        base.trigger,
        base.requested_by,
      ],
    );
    return { outcome: { status: 'failed', assessmentId: rows[0]!.id, ...failure! }, fingerprint: key };
  }

  const score = computeScore(output, ctx, config.config);
  // prove cambiate durante la chiamata (es. un audit appena concluso): il risultato si salva ma non diventa corrente
  const after = await buildContext(db, businessId);
  const latestConfig = await activeAiConfig(db);
  const stillFresh =
    after !== null &&
    cacheKey(after, { configVersion: latestConfig.version, promptVersion: PROMPT_VERSION, model: provider.model }) ===
      key;
  const startedAt = new Date(started);
  const saved = await db.transaction(async (tx) => {
    // una valutazione corrente salvata dopo l'inizio di questa è più nuova: non si sovrascrive
    const { rows: cur } = await tx.query<{ created_at: Date }>(
      'SELECT created_at FROM ai_assessments WHERE business_id = $1 AND is_current FOR UPDATE',
      [businessId],
    );
    const makeCurrent = stillFresh && !(cur[0] && new Date(cur[0].created_at) > startedAt);
    if (makeCurrent)
      await tx.query('UPDATE ai_assessments SET is_current = false WHERE business_id = $1 AND is_current', [
        businessId,
      ]);
    const { rows } = await tx.query<{ id: string }>(
      `INSERT INTO ai_assessments (business_id, status, is_current, cache_key, provider, model, prompt_version, config_version,
         context, output, components, weighted_score, penalties, adjustments, final_score, band, confidence_level, needs_review,
         exclusion, input_tokens, output_tokens, cost_usd, attempts, duration_ms, trigger, requested_by)
       VALUES ($1, 'succeeded', $25, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20,
               $21, $22, $23, $24) RETURNING id`,
      [
        base.business_id,
        base.cache_key,
        base.provider,
        base.model,
        base.prompt_version,
        base.config_version,
        base.context,
        JSON.stringify({ ...output, warnings }),
        JSON.stringify(score.components),
        score.weighted,
        JSON.stringify(score.penalties),
        JSON.stringify({
          adjustments: score.adjustments,
          confidence: score.confidence,
          reviewReasons: score.reviewReasons,
        }),
        score.final,
        score.band.id,
        score.confidence.level,
        score.needsReview,
        score.exclusion,
        base.input_tokens,
        base.output_tokens,
        base.cost_usd,
        base.attempts,
        base.duration_ms,
        base.trigger,
        base.requested_by,
        makeCurrent,
      ],
    );
    return { id: rows[0]!.id, current: makeCurrent };
  });
  return { outcome: { status: 'assessed', assessmentId: saved.id, current: saved.current }, fingerprint: key };
}

// ---------------------------------------------------------------- lettura

interface AssessmentRow {
  id: string;
  business_id: string;
  status: 'succeeded' | 'failed';
  is_current: boolean;
  provider: string;
  model: string;
  prompt_version: number;
  config_version: number;
  context: { evidence: AssessmentContext['evidence'] };
  output: (AiOutput & { warnings?: string[] }) | null;
  components: ScoreResult['components'] | null;
  weighted_score: string | null;
  penalties: ScoreResult['penalties'] | null;
  adjustments: { adjustments: string[]; confidence: ScoreResult['confidence']; reviewReasons: string[] } | null;
  final_score: number | null;
  band: string | null;
  confidence_level: string | null;
  needs_review: boolean;
  exclusion: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  cost_usd: string | null;
  attempts: number;
  duration_ms: number | null;
  error_code: string | null;
  error_message: string | null;
  trigger: string;
  requested_by_name: string | null;
  created_at: Date;
}

const SELECT = `SELECT a.*, u.display_name AS requested_by_name FROM ai_assessments a LEFT JOIN users u ON u.id = a.requested_by`;

function assessmentOut(r: AssessmentRow, bandLabels: Map<string, string>, serviceNames: Map<string, string>) {
  const base = {
    id: r.id,
    status: r.status,
    current: r.is_current,
    provider: r.provider,
    model: r.model,
    promptVersion: r.prompt_version,
    configVersion: r.config_version,
    usage: {
      inputTokens: r.input_tokens,
      outputTokens: r.output_tokens,
      costUsd: r.cost_usd === null ? null : Number(r.cost_usd),
      attempts: r.attempts,
      durationMs: r.duration_ms,
    },
    trigger: r.trigger,
    requestedBy: r.requested_by_name,
    createdAt: new Date(r.created_at).toISOString(),
  };
  if (r.status === 'failed') return { ...base, error: { code: r.error_code, message: r.error_message } };
  const o = r.output!;
  return {
    ...base,
    score: r.final_score!,
    weighted: Number(r.weighted_score),
    band: { id: r.band!, label: bandLabels.get(r.band!) ?? r.band! },
    components: COMPONENTS.map((c) => ({ id: c, label: COMPONENT_LABEL[c], ...r.components![c] })),
    penalties: (r.penalties ?? []).map((p) => ({ ...p, label: PENALTIES[p.type]?.label ?? p.type })),
    adjustments: r.adjustments?.adjustments ?? [],
    confidence: r.adjustments?.confidence ?? null,
    needsReview: r.needs_review,
    reviewReasons: r.adjustments?.reviewReasons ?? [],
    exclusion: r.exclusion,
    summary: o.summary,
    positiveSignals: o.positive_signals,
    negativeSignals: o.negative_signals,
    obstacles: o.obstacles,
    recommendedServices: o.recommended_service_ids.map((id) => ({ id, name: serviceNames.get(id) ?? id })),
    verifiedFacts: o.verified_facts,
    inferences: o.inferences,
    unknowns: o.unknowns,
    businessStatus: o.business_status,
    nextStep: o.next_step,
    warnings: o.warnings ?? [],
    evidence: r.context.evidence,
  };
}

export async function assessmentOf(db: Queryable, businessId: string, serviceNames: Map<string, string>) {
  const config = await activeAiConfig(db);
  const bandLabels = new Map(config.config.bands.map((b) => [b.id, b.label]));
  const { rows } = await db.query<AssessmentRow>(
    `${SELECT} WHERE a.business_id = $1 ORDER BY a.created_at DESC LIMIT 20`,
    [businessId],
  );
  const current = rows.find((r) => r.is_current);
  const latest = rows[0];
  const { rows: reviews } = await db.query<{
    id: string;
    assessment_id: string;
    verdict: string;
    note: string | null;
    user_name: string | null;
    created_at: Date;
  }>(
    `SELECT r.id, r.assessment_id, r.verdict, r.note, u.display_name AS user_name, r.created_at FROM ai_assessment_reviews r
       LEFT JOIN users u ON u.id = r.user_id WHERE r.business_id = $1 ORDER BY r.created_at DESC LIMIT 50`,
    [businessId],
  );
  // stato della valutazione (stessa definizione degli elenchi): aggiornata, da aggiornare, in coda, errore…
  const { rows: st } = await db.query<{ state: AiState; last_error: string | null; next_attempt_at: Date | null }>(
    `SELECT ${AI_STATE_SQL} AS state, ast.last_error, ast.next_attempt_at FROM businesses b
       LEFT JOIN ai_business_states ast ON ast.business_id = b.id
       LEFT JOIN ai_assessments aa ON aa.business_id = b.id AND aa.is_current WHERE b.id = $1`,
    [businessId],
  );
  const s = st[0];
  return {
    state: s
      ? {
          state: s.state,
          label: AI_STATE_LABEL[s.state],
          lastError: s.state === 'failed' ? s.last_error : null,
          nextAttemptAt: s.state === 'failed' && s.next_attempt_at ? new Date(s.next_attempt_at).toISOString() : null,
        }
      : null,
    current: current ? assessmentOut(current, bandLabels, serviceNames) : null,
    // l'ultimo tentativo, se è fallito dopo la valutazione valida (mostrato come avviso)
    lastFailure:
      latest && latest.status === 'failed' && (!current || latest.created_at > current.created_at)
        ? assessmentOut(latest, bandLabels, serviceNames)
        : null,
    history: rows.map((r) => ({
      id: r.id,
      status: r.status,
      current: r.is_current,
      score: r.final_score,
      band: r.band ? (bandLabels.get(r.band) ?? r.band) : null,
      model: r.model,
      promptVersion: r.prompt_version,
      configVersion: r.config_version,
      costUsd: r.cost_usd === null ? null : Number(r.cost_usd),
      error: r.error_message,
      createdAt: new Date(r.created_at).toISOString(),
    })),
    reviews: reviews.map((x) => ({
      id: x.id,
      assessmentId: x.assessment_id,
      verdict: x.verdict,
      note: x.note,
      user: x.user_name,
      createdAt: new Date(x.created_at).toISOString(),
    })),
  };
}

export async function addReview(
  db: Db,
  businessId: string,
  input: { assessmentId: string; verdict: 'inaccurate' | 'confirmed' | 'note'; note?: string },
  userId: string,
) {
  await db.transaction(async (tx) => {
    const { rows } = await tx.query('SELECT 1 FROM ai_assessments WHERE id = $1 AND business_id = $2', [
      input.assessmentId,
      businessId,
    ]);
    if (!rows[0]) throw new JobError(404, 'NOT_FOUND', 'Valutazione non trovata.');
    if (input.verdict !== 'confirmed' && !input.note?.trim())
      throw new JobError(400, 'NOTE_REQUIRED', 'Scrivi una nota per spiegare la segnalazione.');
    await tx.query(
      'INSERT INTO ai_assessment_reviews (assessment_id, business_id, verdict, note, user_id) VALUES ($1, $2, $3, $4, $5)',
      [input.assessmentId, businessId, input.verdict, input.note?.trim() || null, userId],
    );
    await audit(tx, {
      userId,
      action: 'ai.assessment_reviewed',
      entityType: 'business',
      entityId: businessId,
      details: { assessmentId: input.assessmentId, verdict: input.verdict },
    });
  });
}

/**
 * Stima prima di un lotto: quante aziende hanno già una valutazione valida per le prove attuali (riusata, gratis) e
 * quante vanno valutate, con il costo stimato dai token medi delle valutazioni precedenti (o da una stima prudente).
 */
export async function estimate(db: Db, aiConfig: AiConfig, model: string, businessIds: string[], force: boolean) {
  const config = await activeAiConfig(db);
  let cached = 0;
  let missing = 0;
  let toAssess = 0;
  for (const id of businessIds) {
    const ctx = await buildContext(db, id);
    if (!ctx) {
      missing++;
      continue;
    }
    if (!force) {
      const key = cacheKey(ctx, { configVersion: config.version, promptVersion: PROMPT_VERSION, model });
      const { rows } = await db.query(
        "SELECT 1 FROM ai_assessments WHERE business_id = $1 AND cache_key = $2 AND status = 'succeeded' LIMIT 1",
        [id, key],
      );
      if (rows[0]) {
        cached++;
        continue;
      }
    }
    toAssess++;
  }
  const { rows: avg } = await db.query<{ i: string | null; o: string | null; n: number }>(
    `SELECT avg(input_tokens) AS i, avg(output_tokens) AS o, count(*)::int AS n FROM (
       SELECT input_tokens, output_tokens FROM ai_assessments WHERE status = 'succeeded' AND input_tokens IS NOT NULL
        ORDER BY created_at DESC LIMIT 200) x`,
  );
  const measured = avg[0]!.n >= 3;
  // stima prudente senza storico: contesto e istruzioni ~4.000 token, risposta ~2.500 (ragionamento compreso)
  const perInput = measured ? Number(avg[0]!.i) : 4000;
  const perOutput = measured ? Number(avg[0]!.o) : 2500;
  const each = costOf(aiConfig, perInput, perOutput);
  return {
    total: businessIds.length,
    cached,
    missing,
    toAssess,
    estimatedCostUsd: each === null ? null : Math.round(each * toAssess * 10_000) / 10_000,
    basis: measured ? `media delle ultime ${avg[0]!.n} valutazioni` : 'stima prudente (nessuna valutazione precedente)',
    pricePerMTok: aiConfig.price,
  };
}
