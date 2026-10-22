import { z } from 'zod';
import { FINDINGS } from '../../audit/findings.ts';
import { RULES } from '../../auth/rateLimit.ts';
import { CATEGORIES } from '../../discovery/categories.ts';
import { JobError } from '../../discovery/jobs.ts';
import {
  AUDIT_SIGNALS,
  DEFAULT_CATALOG,
  MATCH_DIMENSIONS,
  MATCHING_ALGORITHM_VERSION,
  validateCatalog,
} from '../../matching/catalog.ts';
import {
  activeCatalog,
  addReview,
  businessServices,
  catalogHistory,
  listServices,
  matchHistory,
  saveCatalog,
} from '../../matching/store.ts';
import { CAPABILITIES } from '../../scoring/config.ts';
import { scoreBusinesses } from '../../scoring/store.ts';
import { HttpError, limit, ok, parseBody, parseQuery, sessionOf, type Route } from '../core.ts';
import { listFromQuery } from './discovery.ts';

/*
 * Servizi di Noventra e abbinamento alle aziende (tutte le rotte richiedono una sessione; il catalogo si modifica
 * solo da amministratore). Un abbinamento è un suggerimento da verificare, non una domanda confermata.
 *
 *  GET  /api/services                               catalogo attivo con il numero di aziende per servizio
 *  GET  /api/services/:id                           un servizio
 *  GET  /api/services/:id/businesses                aziende per cui il servizio è proposto (stessi filtri di /api/businesses)
 *  GET  /api/service-catalog                        catalogo completo (regole), versioni, vocabolari per l'editor
 *  POST /api/service-catalog/validate               (admin) verifica senza salvare
 *  PUT  /api/service-catalog                        (admin) nuova versione
 *  GET  /api/businesses/:id/services                lista breve, abbinamenti, revisioni, servizi solo manuali
 *  POST /api/businesses/:id/services/recalculate    ricalcola punteggio e abbinamenti ({ force })
 *  GET  /api/businesses/:id/services/history        esecuzioni precedenti
 *  POST /api/businesses/:id/services/:serviceId/review   { action, note? }: accetta, archivia, da verificare, riapri, nota
 * I ricalcoli in blocco usano POST /api/scoring/jobs (punteggi e abbinamenti insieme).
 */

const UUID = '([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})';
const SERVICE = '([a-z][a-z0-9_]{1,40})';
const catalogBody = z.object({ catalog: z.unknown(), note: z.string().trim().max(300).optional() }).strict();

async function exists(ctx: Parameters<Route['handle']>[0], id: string) {
  const { rows } = await ctx.db.query('SELECT 1 FROM businesses WHERE id = $1', [id]);
  if (!rows.length) throw new JobError(404, 'NOT_FOUND', 'Azienda non trovata.');
}

export const serviceRoutes: Route[] = [
  {
    method: 'GET',
    pattern: /^\/api\/services$/,
    async handle(ctx) {
      return ok(await listServices(ctx.db));
    },
  },
  {
    method: 'GET',
    pattern: new RegExp(`^/api/services/${SERVICE}$`),
    async handle(ctx) {
      const all = await listServices(ctx.db);
      const service = all.services.find((s) => s.id === ctx.match[1]);
      if (!service) throw new JobError(404, 'UNKNOWN_SERVICE', 'Servizio non presente nel catalogo.');
      return ok({ catalogVersion: all.version, service });
    },
  },
  {
    method: 'GET',
    pattern: new RegExp(`^/api/services/${SERVICE}/businesses$`),
    async handle(ctx) {
      const cat = await activeCatalog(ctx.db);
      if (!cat.catalog.services.some((s) => s.id === ctx.match[1]))
        throw new JobError(404, 'UNKNOWN_SERVICE', 'Servizio non presente nel catalogo.');
      return ok(await listFromQuery(ctx, { service: ctx.match[1]! }));
    },
  },
  {
    method: 'GET',
    pattern: /^\/api\/service-catalog$/,
    async handle(ctx) {
      return ok({
        algorithmVersion: MATCHING_ALGORITHM_VERSION,
        active: await activeCatalog(ctx.db),
        defaults: DEFAULT_CATALOG,
        versions: await catalogHistory(ctx.db),
        vocabulary: {
          dimensions: MATCH_DIMENSIONS,
          categories: Object.fromEntries(Object.entries(CATEGORIES).map(([id, c]) => [id, c.label])),
          capabilities: CAPABILITIES,
          findings: Object.fromEntries(Object.entries(FINDINGS).map(([code, d]) => [code, d.title])),
          signals: AUDIT_SIGNALS,
        },
      });
    },
  },
  {
    method: 'POST',
    pattern: /^\/api\/service-catalog\/validate$/,
    access: 'admin',
    async handle(ctx) {
      const v = validateCatalog(parseBody(catalogBody, ctx.body).catalog);
      return ok(v.ok ? { valid: true, errors: {} } : { valid: false, errors: v.errors });
    },
  },
  {
    method: 'PUT',
    pattern: /^\/api\/service-catalog$/,
    access: 'admin',
    async handle(ctx) {
      const session = sessionOf(ctx);
      const body = parseBody(catalogBody, ctx.body);
      const v = validateCatalog(body.catalog);
      if (!v.ok)
        throw new HttpError(400, 'INVALID_CATALOG', 'Il catalogo non è valido: nessuna modifica salvata.', v.errors);
      const version = await saveCatalog(ctx.db, v.catalog, { userId: session.user.id, note: body.note });
      return ok({ version, active: await activeCatalog(ctx.db) });
    },
  },
  {
    method: 'GET',
    pattern: new RegExp(`^/api/businesses/${UUID}/services$`),
    async handle(ctx) {
      return ok(await businessServices(ctx.db, ctx.match[1]!));
    },
  },
  {
    method: 'POST',
    pattern: new RegExp(`^/api/businesses/${UUID}/services/recalculate$`),
    async handle(ctx) {
      const session = sessionOf(ctx);
      const body = parseBody(z.object({ force: z.boolean().optional() }).strict(), ctx.body);
      limit(ctx, `scoring:${session.user.id}`, RULES.scoringByUser);
      const r = await scoreBusinesses(ctx.db, [ctx.match[1]!], {
        trigger: 'manual',
        userId: session.user.id,
        force: body.force,
      });
      if (r.skipped) throw new JobError(404, 'NOT_FOUND', 'Azienda non trovata o unita a un’altra.');
      return ok({ created: r.matchesCreated > 0, ...(await businessServices(ctx.db, ctx.match[1]!)) });
    },
  },
  {
    method: 'GET',
    pattern: new RegExp(`^/api/businesses/${UUID}/services/history$`),
    async handle(ctx) {
      await exists(ctx, ctx.match[1]!);
      const q = parseQuery(
        z.object({
          page: z.coerce.number().int().min(1).max(10_000).default(1),
          pageSize: z.coerce.number().int().min(1).max(100).default(20),
        }),
        ctx.url.searchParams,
      );
      return ok(await matchHistory(ctx.db, ctx.match[1]!, q.page, q.pageSize));
    },
  },
  {
    method: 'POST',
    pattern: new RegExp(`^/api/businesses/${UUID}/services/${SERVICE}/review$`),
    async handle(ctx) {
      const session = sessionOf(ctx);
      const body = parseBody(
        z
          .object({
            action: z.enum(['accepted_for_review', 'dismissed', 'needs_review', 'reopened', 'note']),
            note: z.string().trim().max(1000, 'Al massimo 1000 caratteri.').optional(),
          })
          .strict(),
        ctx.body,
      );
      limit(ctx, `review:${session.user.id}`, RULES.reviewWritesByUser);
      await addReview(ctx.db, {
        businessId: ctx.match[1]!,
        serviceId: ctx.match[2]!,
        action: body.action,
        note: body.note,
        userId: session.user.id,
      });
      return ok(await businessServices(ctx.db, ctx.match[1]!));
    },
  },
];
