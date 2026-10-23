import { z } from 'zod';
import { BUSINESS_CATEGORY_IDS } from '../../categories/catalog.ts';
import { resumeAuditJob } from '../../audit/jobs.ts';
import { RULES } from '../../auth/rateLimit.ts';
import { JobError } from '../../discovery/jobs.ts';
import { SECTOR_GROUPS, SECTOR_IDS } from '../../discovery/sectors.ts';
import { controlHuntRun, createHuntRun, getHuntRun, listHuntRuns, sectorCatalog } from '../../hunter/runs.ts';
import { created, limit, ok, parseBody, parseQuery, sessionOf, type Context, type Route } from '../core.ts';

/*
 * Lead Hunter (Fase 6). Tutte le rotte richiedono una sessione.
 *
 *  GET  /api/hunter/meta                     settori (con copertura), gruppi, valori predefiniti, stato del fornitore
 *  POST /api/hunter/runs                     avvia una ricerca di lead (una sola attiva alla volta)
 *  GET  /api/hunter/runs                     ricerche (paginato) con avanzamento
 *  GET  /api/hunter/runs/:id                 stato, avanzamento, distribuzione per settore e regione, migliori opportunità
 *  POST /api/hunter/runs/:id/{pause|resume|cancel}
 *  POST /api/hunter/runs/:id/retry-audits    ripete le verifiche dei siti non riuscite
 * I lead si consultano ed esportano con GET /api/businesses?hunt=:id e /api/businesses/export (stessi filtri).
 */

const UUID = '([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})';

const runSchema = z
  .object({
    target: z.number().int().min(1, 'Almeno 1 azienda.').max(10_000, 'Al massimo 10.000 aziende per ricerca.'),
    area: z
      .object({ type: z.enum(['italy', 'region', 'province', 'municipality']), code: z.string().min(2).max(6) })
      .strict(),
    sectors: z
      .array(z.string())
      .max(SECTOR_IDS.length)
      .refine((v) => v.every((x) => SECTOR_IDS.includes(x)), 'Settore non presente nel catalogo.')
      .default([]),
    // ricerca per categoria di «Trova aziende»: i settori vengono dalla categoria (non si indicano)
    category: z.enum(BUSINESS_CATEGORY_IDS, { error: 'Categoria sconosciuta.' }).nullable().default(null),
    // fonte della ricerca: OpenStreetMap (predefinita) o Google Maps (Places API)
    provider: z.enum(['osm', 'google'], { error: 'Fonte sconosciuta.' }).default('osm'),
    options: z
      .object({
        minScore: z.number().int().min(0).max(100).nullable().default(null),
        websitePreference: z.enum(['any', 'no_website', 'website_issues']).default('any'),
        excludeKnown: z.boolean().default(false),
        audit: z.boolean().default(true),
        // obiettivo = aziende con un'email pubblica (dalla fonte o dal sito): servono le verifiche dei siti
        publicEmail: z.boolean().default(false),
      })
      .strict()
      .default({ minScore: null, websitePreference: 'any', excludeKnown: false, audit: true, publicEmail: false }),
  })
  .strict()
  .refine((b) => !b.options.publicEmail || b.options.audit, {
    message: 'Per trovare le email pubblicate sui siti serve la verifica automatica dei siti.',
    path: ['options', 'audit'],
  })
  .refine((b) => !b.options.publicEmail || b.options.websitePreference !== 'no_website', {
    message: 'Le aziende senza sito hanno raramente un’email pubblica: scegli «tutte» o «con problemi del sito».',
    path: ['options', 'websitePreference'],
  })
  .refine((b) => b.category !== null || b.sectors.length > 0, {
    message: 'Scegli almeno un settore.',
    path: ['sectors'],
  });

/** Fonti della ricerca di lead: OpenStreetMap e le fonti aggiuntive (es. Google Places). */
const providersOf = (ctx: Context) => [ctx.state.discovery.provider, ...(ctx.state.discovery.extraProviders ?? [])];

export const hunterRoutes: Route[] = [
  {
    method: 'GET',
    pattern: /^\/api\/hunter\/meta$/,
    async handle(ctx) {
      return ok({
        sectors: sectorCatalog(),
        groups: SECTOR_GROUPS,
        defaults: {
          target: 1000,
          area: { type: 'italy', code: 'IT' },
          options: { minScore: null, websitePreference: 'any', excludeKnown: false, audit: true, publicEmail: false },
        },
        limits: { maxTarget: 10_000 },
        provider: {
          configured: ctx.state.discovery.provider.info().configured,
          label: ctx.state.discovery.provider.info().label,
        },
        // fonti disponibili per la ricerca: stato della configurazione, mai le chiavi
        providers: providersOf(ctx).map((p) => {
          const i = p.info();
          return { id: i.id, label: i.label, configured: i.configured, setupHint: i.setupHint ?? null };
        }),
        workerActive: ctx.state.hunter.workerActive,
      });
    },
  },
  {
    method: 'POST',
    pattern: /^\/api\/hunter\/runs$/,
    async handle(ctx) {
      const session = sessionOf(ctx);
      const body = parseBody(runSchema, ctx.body);
      limit(ctx, `hunt:${session.user.id}`, RULES.huntsByUser);
      const id = await createHuntRun(ctx.db, body, {
        userId: session.user.id,
        providerConfigured:
          providersOf(ctx)
            .find((p) => p.info().id === body.provider)
            ?.info().configured ?? false,
      });
      ctx.state.hunter.wake();
      return created(await getHuntRun(ctx.db, id));
    },
  },
  {
    method: 'GET',
    pattern: /^\/api\/hunter\/runs$/,
    async handle(ctx) {
      const q = parseQuery(
        z.object({
          page: z.coerce.number().int().min(1).max(1000).default(1),
          pageSize: z.coerce.number().int().min(1).max(50).default(10),
        }),
        ctx.url.searchParams,
      );
      return ok(await listHuntRuns(ctx.db, q.page, q.pageSize));
    },
  },
  {
    method: 'GET',
    pattern: new RegExp(`^/api/hunter/runs/${UUID}$`),
    async handle(ctx) {
      return ok(await getHuntRun(ctx.db, ctx.match[1]!));
    },
  },
  ...(['pause', 'resume', 'cancel'] as const).map((action): Route => ({
    method: 'POST',
    pattern: new RegExp(`^/api/hunter/runs/${UUID}/${action}$`),
    async handle(ctx) {
      const session = sessionOf(ctx);
      limit(ctx, `hunt:${session.user.id}`, RULES.huntsByUser);
      await controlHuntRun(ctx.db, ctx.match[1]!, action, session.user.id);
      ctx.state.hunter.wake();
      return ok(await getHuntRun(ctx.db, ctx.match[1]!));
    },
  })),
  {
    method: 'POST',
    pattern: new RegExp(`^/api/hunter/runs/${UUID}/retry-audits$`),
    async handle(ctx) {
      const session = sessionOf(ctx);
      limit(ctx, `hunt:${session.user.id}`, RULES.huntsByUser);
      const id = ctx.match[1]!;
      await getHuntRun(ctx.db, id);
      const { rows } = await ctx.db.query<{ id: string }>(
        "SELECT id FROM audit_jobs WHERE hunt_run_id = $1 AND status IN ('completed_with_warnings', 'failed') ORDER BY created_at",
        [id],
      );
      let resumed = 0;
      for (const j of rows) {
        try {
          await resumeAuditJob(ctx.db, j.id, session.user.id);
          resumed++;
        } catch (error) {
          // nessuna azienda non riuscita da ripetere in quella verifica, o già in coda altrove
          if (!(error instanceof JobError && error.status === 409)) throw error;
        }
      }
      ctx.state.audit.wake();
      return ok({ resumed, ...(await getHuntRun(ctx.db, id)) });
    },
  },
];
