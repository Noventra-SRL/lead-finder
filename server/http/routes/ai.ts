import { z } from 'zod';
import { addReview, assessmentOf, estimate } from '../../ai/assess.ts';
import {
  activeAiConfig,
  COMPONENT_LABEL,
  COMPONENTS,
  PENALTIES,
  saveAiConfig,
  validateAiConfig,
} from '../../ai/config.ts';
import { controlAiJob, createAiJob, getAiJob, listAiJobs, MAX_JOB_SIZE } from '../../ai/jobs.ts';
import { PROMPT_VERSION } from '../../ai/prompt.ts';
import { coverage, recheckAll, retryFailed, setAutoEnabled } from '../../ai/queue.ts';
import { costOf } from '../../ai/assess.ts';
import { RULES } from '../../auth/rateLimit.ts';
import { activeCatalog } from '../../matching/store.ts';
import { created, HttpError, limit, ok, parseBody, parseQuery, sessionOf, type Context, type Route } from '../core.ts';

/*
 * Valutazione commerciale con AI. Tutte le rotte richiedono una sessione; la configurazione la modificano solo gli
 * amministratori. La chiave del fornitore non compare mai nelle risposte: lo stato dice solo se è configurata.
 *
 *  GET  /api/ai/status                         configurazione (senza segreti), ultimo esito, esecutore
 *  GET  /api/ai/config  · PUT (admin) · POST /api/ai/config/validate (admin)
 *  GET  /api/businesses/:id/assessment         valutazione corrente con prove, storico, revisioni, stato
 *  POST /api/businesses/:id/assessment         avvia la valutazione (in background); { force } per rifarla
 *  POST /api/businesses/:id/assessment/review  segnalazione o conferma di una persona
 *  POST /api/ai/estimate                       stima prima di un lotto: da valutare, riusate, costo stimato
 *  GET  /api/ai/coverage                       valutazione di ogni azienda: conteggi per stato, coda automatica
 *  POST /api/ai/auto (admin)                   attiva o mette in pausa la valutazione automatica { enabled }
 *  POST /api/ai/coverage/retry-failed · /recheck  errori di nuovo in coda; ricontrollo delle prove di tutte
 *  POST /api/ai/jobs · GET /api/ai/jobs · GET /api/ai/jobs/:id · POST /api/ai/jobs/:id/{pause|resume|cancel}
 */

const UUID = '([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})';
const ids = z
  .array(z.uuid('Identificativo non valido.'))
  .min(1, 'Seleziona almeno un’azienda.')
  .max(MAX_JOB_SIZE, `Al massimo ${MAX_JOB_SIZE} aziende per volta.`);

const requireProvider = (ctx: Context) => {
  if (!ctx.state.ai.provider)
    throw new HttpError(
      503,
      'AI_NOT_CONFIGURED',
      'Valutazione AI non disponibile: il server non ha una chiave del fornitore (AI_API_KEY).',
    );
};

export const aiRoutes: Route[] = [
  {
    method: 'GET',
    pattern: /^\/api\/ai\/coverage$/,
    async handle(ctx) {
      const ai = ctx.state.ai;
      const c = await coverage(ctx.db, {
        providerConfigured: ai.provider !== null,
        dailyLimit: ai.config.autoDailyLimit,
      });
      // stima del costo per completare: media dei token delle ultime valutazioni, altrimenti stima prudente
      const { rows: avg } = await ctx.db.query<{ i: string | null; o: string | null; n: number }>(
        `SELECT avg(input_tokens) AS i, avg(output_tokens) AS o, count(*)::int AS n FROM (
           SELECT input_tokens, output_tokens FROM ai_assessments WHERE status = 'succeeded' AND input_tokens IS NOT NULL
            ORDER BY created_at DESC LIMIT 200) x`,
      );
      const measured = avg[0]!.n >= 3;
      const each = costOf(ai.config, measured ? Number(avg[0]!.i) : 4000, measured ? Number(avg[0]!.o) : 2500);
      const remaining = c.counts.pending + c.counts.outdated + c.counts.failed;
      return ok({
        ...c,
        autoActive: ai.config.autoAssess,
        remaining,
        estimatedRemainingCostUsd: each === null ? null : Math.round(each * remaining * 100) / 100,
        costBasis: measured
          ? `media delle ultime ${avg[0]!.n} valutazioni`
          : 'stima prudente (nessuna valutazione precedente)',
        model: ai.config.model,
      });
    },
  },
  {
    method: 'POST',
    pattern: /^\/api\/ai\/auto$/,
    access: 'admin',
    async handle(ctx) {
      const session = sessionOf(ctx);
      limit(ctx, `ai-jobs:${session.user.id}`, RULES.aiJobsByUser);
      const body = parseBody(z.object({ enabled: z.boolean() }).strict(), ctx.body);
      await setAutoEnabled(ctx.db, body.enabled, session.user.id);
      return ok({ enabled: body.enabled });
    },
  },
  {
    method: 'POST',
    pattern: /^\/api\/ai\/coverage\/(retry-failed|recheck)$/,
    async handle(ctx) {
      const session = sessionOf(ctx);
      limit(ctx, `ai-jobs:${session.user.id}`, RULES.aiJobsByUser);
      const n = ctx.match[1] === 'retry-failed' ? await retryFailed(ctx.db) : await recheckAll(ctx.db);
      return ok({ affected: n });
    },
  },
  {
    method: 'GET',
    pattern: /^\/api\/ai\/status$/,
    async handle(ctx) {
      const ai = ctx.state.ai;
      const { rows } = await ctx.db.query<{ status: string; error_code: string | null; created_at: Date }>(
        'SELECT status, error_code, created_at FROM ai_assessments ORDER BY created_at DESC LIMIT 1',
      );
      const { rows: counts } = await ctx.db.query<{ current: number; review: number }>(
        `SELECT count(*) FILTER (WHERE is_current)::int AS current,
                count(*) FILTER (WHERE is_current AND needs_review)::int AS review FROM ai_assessments`,
      );
      const last = rows[0];
      return ok({
        configured: ai.provider !== null,
        provider: ai.provider ? 'Anthropic (Claude)' : null,
        model: ai.config.model,
        effort: ai.config.effort,
        promptVersion: PROMPT_VERSION,
        workerActive: ai.workerActive,
        price: ai.config.price,
        // "error" se l'ultima chiamata è fallita per un problema del fornitore (non per una risposta scartata)
        state: !ai.provider
          ? 'not_configured'
          : last?.status === 'failed' &&
              last.error_code &&
              !['invalid_output', 'refusal', 'truncated'].includes(last.error_code)
            ? 'error'
            : 'available',
        lastResult: last
          ? { status: last.status, code: last.error_code, at: new Date(last.created_at).toISOString() }
          : null,
        assessed: counts[0]!.current,
        needsReview: counts[0]!.review,
      });
    },
  },
  {
    method: 'GET',
    pattern: /^\/api\/ai\/config$/,
    async handle(ctx) {
      const c = await activeAiConfig(ctx.db);
      return ok({
        ...c,
        components: COMPONENTS.map((id) => ({ id, label: COMPONENT_LABEL[id] })),
        penalties: Object.entries(PENALTIES).map(([id, p]) => ({ id, ...p })),
      });
    },
  },
  {
    method: 'POST',
    pattern: /^\/api\/ai\/config\/validate$/,
    access: 'admin',
    async handle(ctx) {
      const body = parseBody(z.object({ config: z.unknown() }).strict(), ctx.body);
      const v = validateAiConfig(body.config);
      return ok(v.ok ? { valid: true, errors: {} } : { valid: false, errors: v.errors });
    },
  },
  {
    method: 'PUT',
    pattern: /^\/api\/ai\/config$/,
    access: 'admin',
    async handle(ctx) {
      const session = sessionOf(ctx);
      const body = parseBody(
        z.object({ config: z.unknown(), note: z.string().trim().max(300).optional() }).strict(),
        ctx.body,
      );
      const v = validateAiConfig(body.config);
      if (!v.ok) throw new HttpError(400, 'INVALID_CONFIG', 'Configurazione non valida.', v.errors);
      await saveAiConfig(ctx.db, body.config, { userId: session.user.id, note: body.note });
      return ok(await activeAiConfig(ctx.db));
    },
  },
  {
    method: 'GET',
    pattern: new RegExp(`^/api/businesses/${UUID}/assessment$`),
    async handle(ctx) {
      const id = ctx.match[1]!;
      const { rows } = await ctx.db.query('SELECT 1 FROM businesses WHERE id = $1', [id]);
      if (!rows[0]) throw new HttpError(404, 'NOT_FOUND', 'Azienda non trovata.');
      const names = new Map((await activeCatalog(ctx.db)).catalog.services.map((s) => [s.id, s.name]));
      const outcome = ctx.state.ai.lastOutcome.get(id);
      return ok({
        ...(await assessmentOf(ctx.db, id, names)),
        running: ctx.state.ai.running.has(id),
        configured: ctx.state.ai.provider !== null,
        lastError: outcome && (outcome.status === 'error' || outcome.status === 'failed') ? outcome.message : null,
      });
    },
  },
  {
    method: 'POST',
    pattern: new RegExp(`^/api/businesses/${UUID}/assessment$`),
    async handle(ctx) {
      const session = sessionOf(ctx);
      requireProvider(ctx);
      const body = parseBody(z.object({ force: z.boolean().default(false) }).strict(), ctx.body);
      limit(ctx, `ai:${session.user.id}`, RULES.aiAssessmentsByUser);
      const id = ctx.match[1]!;
      const { rows } = await ctx.db.query<{ merged_into: string | null }>(
        'SELECT merged_into FROM businesses WHERE id = $1',
        [id],
      );
      if (!rows[0]) throw new HttpError(404, 'NOT_FOUND', 'Azienda non trovata.');
      if (rows[0].merged_into) throw new HttpError(409, 'BUSINESS_MERGED', 'L’azienda è stata unita a un’altra.');
      const r = ctx.state.ai.start(id, { userId: session.user.id, force: body.force });
      if (r === 'already_running')
        throw new HttpError(409, 'ALREADY_RUNNING', 'La valutazione di questa azienda è già in corso.');
      if (r === 'busy') throw new HttpError(429, 'AI_BUSY', 'Troppe valutazioni in corso: riprova tra poco.');
      return { status: 202, body: { started: true } };
    },
  },
  {
    method: 'POST',
    pattern: new RegExp(`^/api/businesses/${UUID}/assessment/review$`),
    async handle(ctx) {
      const session = sessionOf(ctx);
      const body = parseBody(
        z
          .object({
            assessmentId: z.uuid(),
            verdict: z.enum(['inaccurate', 'confirmed', 'note']),
            note: z.string().trim().max(2000, 'Usa al massimo 2000 caratteri.').optional(),
          })
          .strict(),
        ctx.body,
      );
      limit(ctx, `ai-review:${session.user.id}`, RULES.reviewWritesByUser);
      await addReview(ctx.db, ctx.match[1]!, body, session.user.id);
      return created({ reviewed: true });
    },
  },
  {
    method: 'POST',
    pattern: /^\/api\/ai\/estimate$/,
    async handle(ctx) {
      sessionOf(ctx);
      const body = parseBody(z.object({ businessIds: ids, force: z.boolean().default(false) }).strict(), ctx.body);
      const model = ctx.state.ai.provider?.model ?? ctx.state.ai.config.model;
      return ok({
        ...(await estimate(ctx.db, ctx.state.ai.config, model, body.businessIds, body.force)),
        configured: ctx.state.ai.provider !== null,
      });
    },
  },
  {
    method: 'POST',
    pattern: /^\/api\/ai\/jobs$/,
    async handle(ctx) {
      const session = sessionOf(ctx);
      requireProvider(ctx);
      const body = parseBody(z.object({ businessIds: ids, force: z.boolean().default(false) }).strict(), ctx.body);
      limit(ctx, `ai-jobs:${session.user.id}`, RULES.aiJobsByUser);
      const e = await estimate(ctx.db, ctx.state.ai.config, ctx.state.ai.provider!.model, body.businessIds, body.force);
      const id = await createAiJob(ctx.db, { ...body, estimatedCostUsd: e.estimatedCostUsd }, session.user.id);
      ctx.state.ai.wake();
      return created(await getAiJob(ctx.db, id));
    },
  },
  {
    method: 'GET',
    pattern: /^\/api\/ai\/jobs$/,
    async handle(ctx) {
      const q = parseQuery(
        z.object({
          page: z.coerce.number().int().min(1).max(10_000).default(1),
          pageSize: z.coerce.number().int().min(1).max(100).default(10),
        }),
        ctx.url.searchParams,
      );
      return ok(await listAiJobs(ctx.db, q.page, q.pageSize));
    },
  },
  {
    method: 'GET',
    pattern: new RegExp(`^/api/ai/jobs/${UUID}$`),
    async handle(ctx) {
      return ok(await getAiJob(ctx.db, ctx.match[1]!));
    },
  },
  ...(['pause', 'resume', 'cancel'] as const).map((action): Route => ({
    method: 'POST',
    pattern: new RegExp(`^/api/ai/jobs/${UUID}/${action}$`),
    async handle(ctx) {
      const session = sessionOf(ctx);
      limit(ctx, `ai-jobs:${session.user.id}`, RULES.aiJobsByUser);
      await controlAiJob(ctx.db, ctx.match[1]!, action, session.user.id);
      ctx.state.ai.wake();
      return ok(await getAiJob(ctx.db, ctx.match[1]!));
    },
  })),
];
