import { z } from 'zod';
import { RULES } from '../../auth/rateLimit.ts';
import { listFollowUps, listOpportunities } from '../../crm/store.ts';
import { listBusinesses } from '../../discovery/businesses.ts';
import { listNotifications, markRead, syncIfStale } from '../../workflow/reminders.ts';
import { commercialReport, PERIODS } from '../../workflow/reports.ts';
import {
  canonicalQuery,
  createSavedFilter,
  deleteSavedFilter,
  listSavedFilters,
  renameSavedFilter,
  type SavedFilterScope,
} from '../../workflow/savedFilters.ts';
import type { Queryable } from '../../db/client.ts';
import { created, HttpError, limit, ok, parseBody, parseQuery, sessionOf, type Context, type Route } from '../core.ts';
import { crmFiltersFrom, crmListSchema, followUpFilters, followUpListSchema } from './crm.ts';
import { filtersFromQuery, listSchema } from './discovery.ts';

/*
 * Flusso commerciale (Fase 8). Tutte le rotte richiedono una sessione; promemoria e filtri salvati sono personali.
 *
 *  GET  /api/notifications?unread=1           promemoria dei follow-up (aggiornati al più una volta al minuto)
 *  POST /api/notifications/:id/read           segna come letto
 *  POST /api/notifications/read-all           segna tutti come letti
 *  GET  /api/saved-filters?scope=&counts=1    filtri salvati, con il numero di risultati di oggi e la validità
 *  POST /api/saved-filters                    nuovo filtro {scope, name, query}
 *  PATCH /api/saved-filters/:id               rinomina {name}
 *  DELETE /api/saved-filters/:id              elimina
 *  GET  /api/reports?period=                  report commerciali (solo conteggi, nessuna AI)
 */

const UUID = '([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})';
const SCOPES = ['businesses', 'opportunities', 'followups'] as const;
/** Limite per utente: i conteggi dei filtri restano poche query per richiesta. */
const MAX_FILTERS_PER_SCOPE = 30;

const SCHEMAS = { businesses: listSchema, opportunities: crmListSchema, followups: followUpListSchema } as const;

/**
 * Criteri ancora validi? Parametri sconosciuti (un filtro rimosso) o valori non più ammessi (un settore eliminato)
 * rendono il filtro non valido: si mostra il motivo invece di aprire un elenco diverso da quello salvato.
 */
export function validateCriteria(
  scope: SavedFilterScope,
  query: string,
): { valid: true } | { valid: false; reason: string } {
  const params = new URLSearchParams(query);
  const schema = SCHEMAS[scope];
  const known = new Set(Object.keys(schema.shape));
  const unknown = [...params.keys()].filter((k) => !known.has(k));
  if (unknown.length)
    return { valid: false, reason: `Criteri non più disponibili: ${[...new Set(unknown)].join(', ')}.` };
  const result = schema.safeParse(Object.fromEntries(params));
  if (!result.success) {
    const fields = [...new Set(result.error.issues.map((i) => String(i.path[0] ?? '')))].filter(Boolean);
    return { valid: false, reason: `Valori non più validi: ${fields.join(', ') || 'criteri'}.` };
  }
  return { valid: true };
}

async function countFor(db: Queryable, scope: SavedFilterScope, query: string, userId: string): Promise<number> {
  const params = new URLSearchParams(query);
  params.set('page', '1');
  params.set('pageSize', '1');
  if (scope === 'businesses') return (await listBusinesses(db, filtersFromQuery(params))).total;
  if (scope === 'opportunities') return (await listOpportunities(db, crmFiltersFrom(params, userId))).total;
  const f = followUpFilters(parseQuery(followUpListSchema, params), userId);
  return (await listFollowUps(db, f, { page: 1, pageSize: 1 })).total;
}

const createSchema = z
  .object({
    scope: z.enum(SCOPES),
    name: z.string().trim().min(1, 'Dai un nome al filtro.').max(80, 'Usa al massimo 80 caratteri.'),
    query: z.string().max(2000, 'Troppi criteri.'),
  })
  .strict();
const renameSchema = z
  .object({ name: z.string().trim().min(1, 'Dai un nome al filtro.').max(80, 'Usa al massimo 80 caratteri.') })
  .strict();

const writes = (ctx: Context) => {
  const session = sessionOf(ctx);
  limit(ctx, `crm:${session.user.id}`, RULES.crmWritesByUser);
  return session;
};

export const workflowRoutes: Route[] = [
  {
    method: 'GET',
    pattern: /^\/api\/notifications$/,
    async handle(ctx) {
      const session = sessionOf(ctx);
      const q = parseQuery(
        z.object({
          unread: z.enum(['0', '1']).default('0'),
          limit: z.coerce.number().int().min(1).max(100).default(30),
        }),
        ctx.url.searchParams,
      );
      await syncIfStale(ctx.db);
      return ok(await listNotifications(ctx.db, session.user.id, { unreadOnly: q.unread === '1', limit: q.limit }));
    },
  },
  {
    method: 'POST',
    pattern: /^\/api\/notifications\/read-all$/,
    async handle(ctx) {
      const session = sessionOf(ctx);
      return ok({ marked: await markRead(ctx.db, session.user.id, 'all') });
    },
  },
  {
    method: 'POST',
    pattern: new RegExp(`^/api/notifications/${UUID}/read$`),
    async handle(ctx) {
      const session = sessionOf(ctx);
      await markRead(ctx.db, session.user.id, ctx.match[1]!);
      return ok({ marked: 1 });
    },
  },
  {
    method: 'GET',
    pattern: /^\/api\/saved-filters$/,
    async handle(ctx) {
      const session = sessionOf(ctx);
      const q = parseQuery(
        z.object({ scope: z.enum(SCOPES).optional(), counts: z.enum(['0', '1']).default('1') }),
        ctx.url.searchParams,
      );
      const filters = await listSavedFilters(ctx.db, session.user.id, q.scope);
      const items = [];
      for (const f of filters) {
        const check = validateCriteria(f.scope, f.query);
        const count =
          check.valid && q.counts === '1' ? await countFor(ctx.db, f.scope, f.query, session.user.id) : null;
        items.push({ ...f, valid: check.valid, invalidReason: check.valid ? null : check.reason, count });
      }
      return ok({ items, maxPerScope: MAX_FILTERS_PER_SCOPE });
    },
  },
  {
    method: 'POST',
    pattern: /^\/api\/saved-filters$/,
    async handle(ctx) {
      const session = writes(ctx);
      const body = parseBody(createSchema, ctx.body);
      const query = canonicalQuery(body.query);
      const check = validateCriteria(body.scope, query);
      if (!check.valid) throw new HttpError(400, 'INVALID_FILTER', check.reason);
      const existing = await listSavedFilters(ctx.db, session.user.id, body.scope);
      if (existing.length >= MAX_FILTERS_PER_SCOPE)
        throw new HttpError(
          409,
          'TOO_MANY_FILTERS',
          `Puoi salvare al massimo ${MAX_FILTERS_PER_SCOPE} filtri per elenco.`,
        );
      return created(await createSavedFilter(ctx.db, session.user.id, { ...body, query }));
    },
  },
  {
    method: 'PATCH',
    pattern: new RegExp(`^/api/saved-filters/${UUID}$`),
    async handle(ctx) {
      const session = writes(ctx);
      const body = parseBody(renameSchema, ctx.body);
      return ok(await renameSavedFilter(ctx.db, session.user.id, ctx.match[1]!, body.name));
    },
  },
  {
    method: 'DELETE',
    pattern: new RegExp(`^/api/saved-filters/${UUID}$`),
    async handle(ctx) {
      const session = writes(ctx);
      await deleteSavedFilter(ctx.db, session.user.id, ctx.match[1]!);
      return ok({ deleted: true });
    },
  },
  {
    method: 'GET',
    pattern: /^\/api\/reports$/,
    async handle(ctx) {
      sessionOf(ctx);
      const q = parseQuery(z.object({ period: z.enum(PERIODS).default('30d') }), ctx.url.searchParams);
      return ok(await commercialReport(ctx.db, q.period));
    },
  },
];
