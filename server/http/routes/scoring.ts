import { z } from 'zod';
import { SERVICE_AREAS } from '../../audit/findings.ts';
import { RULES } from '../../auth/rateLimit.ts';
import { CATEGORIES } from '../../discovery/categories.ts';
import { JobError } from '../../discovery/jobs.ts';
import {
  CAPABILITIES,
  DEFAULT_SCORING_CONFIG,
  DIMENSIONS,
  SCORING_ALGORITHM_VERSION,
  validateScoringConfig,
} from '../../scoring/config.ts';
import {
  cancelScoringJob,
  createScoringJob,
  getScoringJob,
  listScoringJobs,
  MAX_SCOPE_IDS,
} from '../../scoring/jobs.ts';
import {
  activeConfig,
  configHistory,
  latestScore,
  saveConfig,
  scoreBusinesses,
  scoreDetail,
  scoreHistory,
  scoringStats,
} from '../../scoring/store.ts';
import { created, HttpError, limit, ok, parseBody, parseQuery, sessionOf, type Route } from '../core.ts';

/*
 * Punteggio dei lead (tutte le rotte richiedono una sessione; la configurazione si modifica solo da amministratore).
 *
 *  GET  /api/scoring/config                 configurazione attiva, versioni precedenti, cataloghi per l'interfaccia
 *  POST /api/scoring/config/validate        (admin) verifica una configurazione senza salvarla
 *  PUT  /api/scoring/config                 (admin) salva una nuova versione
 *  GET  /api/scoring/stats                  punteggi attuali per fascia e stato, aziende senza punteggio, configurazione superata
 *  POST /api/businesses/:id/score           calcola (o conferma) il punteggio di un'azienda; { force } per un nuovo calcolo
 *  GET  /api/businesses/:id/score           punteggio attuale con dettaglio e motivi per ricalcolarlo (null se mai calcolato)
 *  GET  /api/businesses/:id/scores          storico delle istantanee (paginato)
 *  GET  /api/scores/:id                     istantanea con dettaglio
 *  POST /api/scoring/jobs                   ricalcolo in background (aziende selezionate; tutte: solo admin)
 *  GET  /api/scoring/jobs[/:id]             ricalcoli recenti / stato
 *  POST /api/scoring/jobs/:id/cancel
 * L'elenco dei lead con filtri e ordinamento per punteggio è GET /api/businesses (vedi routes/discovery.ts).
 */

const UUID = '([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})';
const pageQuery = z.object({
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});

const configBody = z.object({ config: z.unknown(), note: z.string().trim().max(300).optional() }).strict();

function invalidConfig(errors: Record<string, string>) {
  return new HttpError(400, 'INVALID_CONFIG', 'La configurazione non è valida: nessuna modifica salvata.', errors);
}

export const scoringRoutes: Route[] = [
  {
    method: 'GET',
    pattern: /^\/api\/scoring\/config$/,
    async handle(ctx) {
      const active = await activeConfig(ctx.db);
      return ok({
        algorithmVersion: SCORING_ALGORITHM_VERSION,
        active,
        defaults: DEFAULT_SCORING_CONFIG,
        versions: await configHistory(ctx.db),
        catalog: {
          dimensions: DIMENSIONS,
          capabilities: CAPABILITIES,
          services: SERVICE_AREAS,
          categories: Object.fromEntries(Object.entries(CATEGORIES).map(([id, c]) => [id, c.label])),
        },
      });
    },
  },
  {
    method: 'POST',
    pattern: /^\/api\/scoring\/config\/validate$/,
    access: 'admin',
    async handle(ctx) {
      const body = parseBody(configBody, ctx.body);
      const v = validateScoringConfig(body.config);
      return ok(v.ok ? { valid: true, errors: {} } : { valid: false, errors: v.errors });
    },
  },
  {
    method: 'PUT',
    pattern: /^\/api\/scoring\/config$/,
    access: 'admin',
    async handle(ctx) {
      const session = sessionOf(ctx);
      const body = parseBody(configBody, ctx.body);
      const v = validateScoringConfig(body.config);
      if (!v.ok) throw invalidConfig(v.errors);
      const version = await saveConfig(ctx.db, v.config, { userId: session.user.id, note: body.note });
      return ok({ version, active: await activeConfig(ctx.db) });
    },
  },
  {
    method: 'GET',
    pattern: /^\/api\/scoring\/stats$/,
    async handle(ctx) {
      return ok(await scoringStats(ctx.db));
    },
  },
  {
    method: 'POST',
    pattern: new RegExp(`^/api/businesses/${UUID}/score$`),
    async handle(ctx) {
      const session = sessionOf(ctx);
      const body = parseBody(z.object({ force: z.boolean().optional() }).strict(), ctx.body);
      limit(ctx, `scoring:${session.user.id}`, RULES.scoringByUser);
      const id = ctx.match[1]!;
      const r = await scoreBusinesses(ctx.db, [id], { trigger: 'manual', userId: session.user.id, force: body.force });
      if (r.skipped) throw new JobError(404, 'NOT_FOUND', 'Azienda non trovata o unita a un’altra.');
      return ok({ created: r.created > 0, score: await latestScore(ctx.db, id) });
    },
  },
  {
    method: 'GET',
    pattern: new RegExp(`^/api/businesses/${UUID}/score$`),
    async handle(ctx) {
      // mai calcolato è uno stato normale, non un errore: { score: null } (404 solo se l'azienda non esiste)
      const score = await latestScore(ctx.db, ctx.match[1]!);
      if (!score) {
        const { rows } = await ctx.db.query('SELECT 1 FROM businesses WHERE id = $1', [ctx.match[1]]);
        if (!rows.length) throw new JobError(404, 'NOT_FOUND', 'Azienda non trovata.');
      }
      return ok({ score });
    },
  },
  {
    method: 'GET',
    pattern: new RegExp(`^/api/businesses/${UUID}/scores$`),
    async handle(ctx) {
      const q = parseQuery(pageQuery, ctx.url.searchParams);
      return ok(await scoreHistory(ctx.db, ctx.match[1]!, q.page, q.pageSize));
    },
  },
  {
    method: 'GET',
    pattern: new RegExp(`^/api/scores/${UUID}$`),
    async handle(ctx) {
      return ok({ score: await scoreDetail(ctx.db, ctx.match[1]!) });
    },
  },
  {
    method: 'POST',
    pattern: /^\/api\/scoring\/jobs$/,
    async handle(ctx) {
      const session = sessionOf(ctx);
      const body = parseBody(
        z
          .object({
            scope: z.enum(['all', 'businesses']),
            businessIds: z.array(z.uuid('Identificativo non valido.')).max(MAX_SCOPE_IDS).optional(),
            force: z.boolean().optional(),
          })
          .strict(),
        ctx.body,
      );
      if (body.scope === 'all' && session.user.role !== 'admin')
        throw new HttpError(403, 'FORBIDDEN', 'Solo un amministratore può ricalcolare tutti i punteggi.');
      if (body.scope === 'businesses' && !body.businessIds?.length)
        throw new HttpError(400, 'VALIDATION_ERROR', 'Controlla i campi evidenziati.', {
          businessIds: 'Seleziona almeno un’azienda.',
        });
      limit(ctx, `scoring-job:${session.user.id}`, RULES.scoringJobsByUser);
      const id = await createScoringJob(
        ctx.db,
        {
          scope: body.scope === 'all' ? { kind: 'all' } : { kind: 'businesses', ids: [...new Set(body.businessIds)] },
          force: body.force,
          trigger: body.scope === 'all' ? 'bulk' : 'manual',
        },
        session.user.id,
      );
      ctx.state.scoring.wake();
      return created({ job: await getScoringJob(ctx.db, id) });
    },
  },
  {
    method: 'GET',
    pattern: /^\/api\/scoring\/jobs$/,
    async handle(ctx) {
      return ok({ items: await listScoringJobs(ctx.db, 10), workerActive: ctx.state.scoring.workerActive });
    },
  },
  {
    method: 'GET',
    pattern: new RegExp(`^/api/scoring/jobs/${UUID}$`),
    async handle(ctx) {
      return ok({ job: await getScoringJob(ctx.db, ctx.match[1]!) });
    },
  },
  {
    method: 'POST',
    pattern: new RegExp(`^/api/scoring/jobs/${UUID}/cancel$`),
    async handle(ctx) {
      const session = sessionOf(ctx);
      await cancelScoringJob(ctx.db, ctx.match[1]!, session.user.id);
      return ok({ job: await getScoringJob(ctx.db, ctx.match[1]!) });
    },
  },
];
