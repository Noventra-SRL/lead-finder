import { z } from 'zod';
import { RULES } from '../../auth/rateLimit.ts';
import { createAuditJob } from '../../audit/jobs.ts';
import { listQuery } from '../../discovery/businesses.ts';
import { created, limit, parseBody, sessionOf, type Route } from '../core.ts';
import { filtersFromQuery } from './discovery.ts';

/*
 * Arricchimento dei siti per le email pubblicate, da «Trova aziende».
 *
 *  POST /api/enrichment/start  { scope, filters }
 *    scope = 'pending'  aziende con un sito proprio non ancora controllato per le email
 *            'retry'    aziende con il sito non accessibile (nuovo tentativo, anche se controllato da poco)
 *    filters = la query string dei filtri di «Trova aziende» (categoria, area, punteggio…): stesse aziende dell'elenco
 *
 * Il lavoro è un job di audit (server/audit): in sottofondo, un sito alla volta per host con intervallo minimo,
 * robots.txt rispettato, protezione SSRF, pagine e dimensioni limitate, riprendibile dopo un riavvio, mai due audit
 * dello stesso sito insieme. Al massimo AUDIT_MAX_BUSINESSES_PER_JOB aziende per avvio, nell'ordine di priorità.
 * Nessuna email viene inviata.
 */

const schema = z
  .object({
    scope: z.enum(['pending', 'retry'], { error: 'Scegli cosa arricchire.' }),
    filters: z.string().max(2000).default(''),
  })
  .strict();

export const enrichmentRoutes: Route[] = [
  {
    method: 'POST',
    pattern: /^\/api\/enrichment\/start$/,
    async handle(ctx) {
      const session = sessionOf(ctx);
      const body = parseBody(schema, ctx.body);
      limit(ctx, `audit:${session.user.id}`, RULES.auditJobsByUser);
      const { config, policy, wake } = ctx.state.audit;
      const params = new URLSearchParams(body.filters);
      for (const k of ['contactability', 'sort', 'dir', 'page', 'pageSize']) params.delete(k);
      const f = {
        ...filtersFromQuery(params),
        contactability: body.scope === 'pending' ? (['da_arricchire'] as const) : (['sito_non_accessibile'] as const),
        sort: 'priority' as const,
        dir: 'asc' as const,
        page: 1,
        pageSize: config.maxBusinessesPerJob,
      };
      const q = listQuery({ ...f, contactability: [...f.contactability] });
      const { rows } = await ctx.db.query<{ id: string }>(
        `SELECT b.id FROM ${q.from} WHERE ${q.whereSql} ORDER BY ${q.order} LIMIT $${q.params.length + 1}`,
        [...q.params, config.maxBusinessesPerJob],
      );
      if (!rows.length)
        return created({
          job: null,
          queued: 0,
          alreadyQueued: 0,
          message:
            body.scope === 'pending'
              ? 'Nessun sito da controllare con questi filtri.'
              : 'Nessun sito non accessibile da riprovare con questi filtri.',
        });
      const result = await createAuditJob(
        ctx.db,
        { businessIds: rows.map((r) => r.id), force: body.scope === 'retry' },
        { userId: session.user.id, config, policy },
      );
      wake();
      return created({ job: { id: result.jobId }, queued: result.queued, alreadyQueued: result.alreadyQueued });
    },
  },
];
