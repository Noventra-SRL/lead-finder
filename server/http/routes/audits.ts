import { z } from 'zod';
import { RULES } from '../../auth/rateLimit.ts';
import { AUDIT_VERSION } from '../../audit/engine.ts';
import { FINDINGS, SERVICE_AREAS } from '../../audit/findings.ts';
import { cancelAuditJob, createAuditJob, pauseAuditJob, resumeAuditJob, settingsFor } from '../../audit/jobs.ts';
import { auditDetail, auditHistory } from '../../audit/store.ts';
import { JobError } from '../../discovery/jobs.ts';
import type { JobMessage } from '../../jobs/messages.ts';
import { created, limit, ok, parseBody, parseQuery, sessionOf, type Context, type Route } from '../core.ts';

/*
 * Audit dei siti (tutte le rotte richiedono una sessione valida).
 *
 *  GET  /api/audits/meta                          limiti, prestazioni configurate (mai la chiave), catalogo dei rilievi
 *  POST /api/audits/jobs                          avvia la verifica di più aziende
 *  POST /api/businesses/:id/audit                 avvia la verifica di un'azienda
 *  GET  /api/audits/jobs                          elenco delle verifiche
 *  GET  /api/audits/jobs/:id                      stato, avanzamento ed esito per azienda
 *  POST /api/audits/jobs/:id/{cancel|pause|resume}
 *  GET  /api/businesses/:id/audits                sito collegato e storico degli audit (paginato)
 *  GET  /api/businesses/:id/audits/latest         ultimo audit completo
 *  GET  /api/audits/:id                           audit con pagine, rilievi (filtrabili) e prestazioni
 */

const UUID = '([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})';
const iso = (d: Date | string | null) => (d ? new Date(d).toISOString() : null);

const optionsSchema = {
  maxPages: z.number().int().min(1, 'Almeno 1 pagina.').max(10, 'Al massimo 10 pagine.').optional(),
  performance: z.boolean().optional(),
  force: z.boolean().optional(),
};
const jobSchema = z
  .object({
    businessIds: z.array(z.uuid('Identificativo non valido.')).min(1, 'Seleziona almeno un’azienda.').max(2000),
    ...optionsSchema,
  })
  .strict();
const singleSchema = z.object(optionsSchema).strict();

interface JobRow {
  id: string;
  status: string;
  settings: Record<string, unknown>;
  config_key: string;
  force: boolean;
  items_total: number;
  items_done: number;
  items_failed: number;
  items_skipped: number;
  messages: JobMessage[];
  cancel_requested: boolean;
  pause_requested: boolean;
  pause_reason: string | null;
  created_at: Date;
  started_at: Date | null;
  finished_at: Date | null;
  created_by_name: string | null;
}

const jobDto = (j: JobRow) => ({
  id: j.id,
  status: j.status,
  settings: j.settings,
  configKey: j.config_key,
  force: j.force,
  progress: { total: j.items_total, done: j.items_done, failed: j.items_failed, skipped: j.items_skipped },
  messages: j.messages,
  cancelRequested: j.cancel_requested,
  pauseRequested: j.pause_requested,
  pauseReason: j.pause_reason,
  createdAt: iso(j.created_at),
  startedAt: iso(j.started_at),
  finishedAt: iso(j.finished_at),
  createdBy: j.created_by_name,
});

const JOB_SELECT =
  'SELECT j.*, u.display_name AS created_by_name FROM audit_jobs j LEFT JOIN users u ON u.id = j.created_by';

async function loadJob(ctx: Context, id: string) {
  const { rows } = await ctx.db.query<JobRow>(`${JOB_SELECT} WHERE j.id = $1`, [id]);
  if (!rows[0]) throw new JobError(404, 'NOT_FOUND', 'Verifica non trovata.');
  return rows[0];
}

async function startJob(ctx: Context, body: z.infer<typeof jobSchema>) {
  const session = sessionOf(ctx);
  limit(ctx, `audit:${session.user.id}`, RULES.auditJobsByUser);
  const { config, policy, wake } = ctx.state.audit;
  const result = await createAuditJob(ctx.db, body, { userId: session.user.id, config, policy });
  wake();
  return created({
    job: jobDto(await loadJob(ctx, result.jobId)),
    queued: result.queued,
    alreadyQueued: result.alreadyQueued,
  });
}

const pageQuery = {
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
};
const list = <T extends string>(values: readonly [T, ...T[]]) =>
  z
    .string()
    .optional()
    .transform((v) => (v ? v.split(',') : []))
    .refine((v) => v.every((x) => (values as readonly string[]).includes(x)), 'Valore non ammesso.')
    .transform((v) => v as T[]);

export const auditRoutes: Route[] = [
  {
    method: 'GET',
    pattern: /^\/api\/audits\/meta$/,
    async handle(ctx) {
      const { config, performance, workerActive } = ctx.state.audit;
      return ok({
        version: AUDIT_VERSION,
        workerActive,
        defaults: settingsFor({ businessIds: [] }, config),
        limits: {
          defaultPages: config.defaultPages,
          maxPages: config.maxPages,
          maxBusinessesPerJob: config.maxBusinessesPerJob,
          reauditHours: config.reauditHours,
          hostIntervalMs: config.hostIntervalMs,
          requestTimeoutMs: config.requestTimeoutMs,
          maxResponseKb: Math.round(config.maxResponseBytes / 1024),
          allowedPorts: config.allowedPorts,
        },
        performance: {
          provider: 'PageSpeed Insights',
          configured: Boolean(performance?.configured),
          strategies: config.pagespeedStrategies,
        },
        findings: Object.fromEntries(
          Object.entries(FINDINGS).map(([code, d]) => [
            code,
            { category: d.category, title: d.title, severity: d.severity },
          ]),
        ),
        services: SERVICE_AREAS,
      });
    },
  },
  {
    method: 'POST',
    pattern: /^\/api\/audits\/jobs$/,
    async handle(ctx) {
      return startJob(ctx, parseBody(jobSchema, ctx.body));
    },
  },
  {
    method: 'POST',
    pattern: new RegExp(`^/api/businesses/${UUID}/audit$`),
    async handle(ctx) {
      const body = parseBody(singleSchema, ctx.body);
      return startJob(ctx, { ...body, businessIds: [ctx.match[1]!] });
    },
  },
  {
    method: 'GET',
    pattern: /^\/api\/audits\/jobs$/,
    async handle(ctx) {
      const q = parseQuery(
        z.object({ ...pageQuery, status: z.enum(['active', 'finished', 'all']).default('all') }),
        ctx.url.searchParams,
      );
      const cond =
        q.status === 'active'
          ? "WHERE j.status IN ('pending', 'running', 'paused')"
          : q.status === 'finished'
            ? "WHERE j.status NOT IN ('pending', 'running', 'paused')"
            : '';
      const { rows: total } = await ctx.db.query<{ n: number }>(`SELECT count(*)::int AS n FROM audit_jobs j ${cond}`);
      const { rows } = await ctx.db.query<JobRow>(
        `${JOB_SELECT} ${cond} ORDER BY j.created_at DESC, j.id LIMIT $1 OFFSET $2`,
        [q.pageSize, (q.page - 1) * q.pageSize],
      );
      return ok({ items: rows.map(jobDto), total: total[0]!.n, page: q.page, pageSize: q.pageSize });
    },
  },
  {
    method: 'GET',
    pattern: new RegExp(`^/api/audits/jobs/${UUID}$`),
    async handle(ctx) {
      const job = await loadJob(ctx, ctx.match[1]!);
      const { rows } = await ctx.db.query<{
        seq: number;
        business_id: string;
        name: string;
        status: string;
        attempts: number;
        audit_id: string | null;
        outcome: string | null;
        error: string | null;
        finished_at: Date | null;
        actionable_count: number | null;
        website_url: string | null;
      }>(
        `SELECT i.seq, i.business_id, b.name, b.website_url, i.status, i.attempts, i.audit_id, i.outcome, i.error, i.finished_at, a.actionable_count
           FROM audit_job_items i JOIN businesses b ON b.id = i.business_id LEFT JOIN website_audits a ON a.id = i.audit_id
          WHERE i.job_id = $1 ORDER BY i.seq LIMIT 2000`,
        [job.id],
      );
      return ok({
        job: jobDto(job),
        items: rows.map((r) => ({
          seq: r.seq,
          business: { id: r.business_id, name: r.name, website: r.website_url },
          status: r.status,
          attempts: r.attempts,
          auditId: r.audit_id,
          outcome: r.outcome,
          error: r.error,
          actionableFindings: r.actionable_count,
          finishedAt: iso(r.finished_at),
        })),
      });
    },
  },
  ...(['cancel', 'pause', 'resume'] as const).map((action): Route => ({
    method: 'POST',
    pattern: new RegExp(`^/api/audits/jobs/${UUID}/${action}$`),
    async handle(ctx) {
      const session = sessionOf(ctx);
      const id = ctx.match[1]!;
      if (action === 'cancel') await cancelAuditJob(ctx.db, id, session.user.id);
      if (action === 'pause') await pauseAuditJob(ctx.db, id, session.user.id);
      if (action === 'resume') {
        limit(ctx, `audit:${session.user.id}`, RULES.auditJobsByUser);
        await resumeAuditJob(ctx.db, id, session.user.id);
        ctx.state.audit.wake();
      }
      return ok({ job: jobDto(await loadJob(ctx, id)) });
    },
  })),
  {
    method: 'GET',
    pattern: new RegExp(`^/api/businesses/${UUID}/audits$`),
    async handle(ctx) {
      const q = parseQuery(z.object(pageQuery), ctx.url.searchParams);
      const { rows } = await ctx.db.query('SELECT 1 FROM businesses WHERE id = $1', [ctx.match[1]]);
      if (!rows.length) throw new JobError(404, 'NOT_FOUND', 'Azienda non trovata.');
      return ok(await auditHistory(ctx.db, ctx.match[1]!, q.page, q.pageSize));
    },
  },
  {
    method: 'GET',
    pattern: new RegExp(`^/api/businesses/${UUID}/audits/latest$`),
    async handle(ctx) {
      const history = await auditHistory(ctx.db, ctx.match[1]!, 1, 1);
      const latest = history.items[0];
      if (!latest) throw new JobError(404, 'NO_AUDIT', 'Il sito di questa azienda non è ancora stato verificato.');
      return ok({ website: history.website, ...(await auditDetail(ctx.db, latest.id)) });
    },
  },
  {
    method: 'GET',
    pattern: new RegExp(`^/api/audits/${UUID}$`),
    async handle(ctx) {
      const q = parseQuery(
        z.object({
          severity: list(['info', 'low', 'medium', 'high'] as const),
          category: list(['availability', 'security', 'seo', 'mobile', 'performance', 'content', 'industry'] as const),
          actionable: z.enum(['0', '1']).optional(),
        }),
        ctx.url.searchParams,
      );
      return ok(
        await auditDetail(ctx.db, ctx.match[1]!, {
          severity: q.severity,
          category: q.category,
          ...(q.actionable ? { actionable: q.actionable === '1' } : {}),
        }),
      );
    },
  },
];
