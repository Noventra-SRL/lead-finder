import { z } from 'zod';
import { RULES } from '../../auth/rateLimit.ts';
import {
  ACTIVITY_TYPE_IDS,
  MANUAL_ACTIVITY_TYPES,
  PRIORITY_IDS,
  STAGE_IDS,
  OPEN_STAGES,
  type PriorityId,
  type StageId,
} from '../../crm/model.ts';
import {
  addActivity,
  addFollowUp,
  addFollowUpForBusiness,
  board,
  bulkCreate,
  cancelFollowUp,
  changeStage,
  completeFollowUp,
  createOpportunity,
  CRM_SORTS,
  crmMeta,
  dashboard,
  getOpportunity,
  listFollowUps,
  listOpportunities,
  updateActivity,
  updateFollowUp,
  updateOpportunity,
  type CrmFilters,
  type FollowUpFilters,
  type CrmSort,
} from '../../crm/store.ts';
import { isCategoryId } from '../../discovery/categories.ts';
import { created, HttpError, limit, ok, parseBody, parseQuery, sessionOf, type Context, type Route } from '../core.ts';
import {
  ACTIVITY_COLUMNS,
  BUSINESS_COLUMNS,
  exportActivities,
  exportFollowUps,
  exportOpportunities,
  FOLLOWUP_COLUMNS,
  OPPORTUNITY_COLUMNS,
} from '../../exports/datasets.ts';
import { describeColumns, EXPORT_LIMIT } from '../../exports/format.ts';
import { checkFields, exportParams, fileReply } from '../../exports/http.ts';
import { markRemindersStale } from '../../workflow/reminders.ts';
import { csv, listSchema } from './discovery.ts';

/*
 * CRM commerciale (Fase 7). Tutte le rotte richiedono una sessione: il CRM è uno strumento interno usato da
 * amministratori e commerciali. Le attività si modificano solo da chi le ha registrate (o da un amministratore).
 *
 *  GET  /api/crm/meta                          fasi, priorità, tipi di attività, responsabili, servizi del catalogo
 *  GET  /api/crm/dashboard                     numeri della pipeline (definizioni in docs/crm.md)
 *  GET  /api/crm/opportunities                 elenco filtrato e paginato
 *  GET  /api/crm/board                         Kanban: per fase il totale e le prime opportunità
 *  POST /api/crm/opportunities                 nuova opportunità per un'azienda esistente
 *  POST /api/crm/opportunities/bulk            aggiunta delle aziende selezionate (aggiunte, saltate, non riuscite)
 *  GET  /api/crm/opportunities/:id             scheda: opportunità, azienda, attività, follow-up
 *  PATCH /api/crm/opportunities/:id            campi commerciali
 *  POST /api/crm/opportunities/:id/stage       cambio di fase (registrato nella cronologia)
 *  POST /api/crm/opportunities/:id/activities  nuova attività
 *  PATCH /api/crm/activities/:id               modifica di un'attività
 *  POST /api/crm/opportunities/:id/followups   nuovo follow-up
 *  GET  /api/crm/followups?view=today|overdue|upcoming|completed
 *  PATCH /api/crm/followups/:id                modifica di un follow-up in attesa
 *  POST /api/crm/followups/:id/complete | /cancel
 */

const UUID = '([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})';
const DATE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;

const date = z
  .string()
  .regex(DATE, 'Data non valida (AAAA-MM-GG).')
  .refine(
    (s) =>
      !Number.isNaN(new Date(`${s}T00:00:00Z`).getTime()) && new Date(`${s}T00:00:00Z`).toISOString().startsWith(s),
    'Data non valida.',
  );
const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Ora non valida (HH:MM).');
const euro = z
  .number('Inserisci un importo in euro.')
  .min(0, 'L’importo non può essere negativo.')
  .max(1_000_000_000, 'Importo troppo alto.')
  .refine((v) => Math.round(v * 100) === Number((v * 100).toFixed(6)), 'Al massimo due decimali.');
const notes = (n: number) => z.string().trim().max(n, `Usa al massimo ${n} caratteri.`);
const summary = z.string().trim().min(1, 'Campo obbligatorio.').max(300, 'Usa al massimo 300 caratteri.');
const services = z.array(z.string().regex(/^[a-z][a-z0-9_]{1,40}$/, 'Servizio non valido.')).max(20);

/** Data e ora di un'attività: non nel futuro (tolleranza di 5 minuti) né più vecchia di 10 anni. */
const occurredAt = z.iso
  .datetime({ offset: true, message: 'Data e ora non valide.' })
  .transform((s) => new Date(s))
  .refine(
    (d) => d.getTime() <= Date.now() + 5 * 60_000,
    'Un’attività registrata non può essere nel futuro: usa un follow-up.',
  )
  .refine((d) => d.getTime() >= Date.now() - 10 * 365 * 86_400_000, 'Data troppo lontana nel passato.');

const createSchema = z
  .object({
    businessId: z.uuid('Azienda non valida.'),
    stage: z.enum(OPEN_STAGES as [StageId, ...StageId[]]).default('da_qualificare'),
    priority: z.enum(PRIORITY_IDS).default('media'),
    ownerId: z.uuid().nullable().optional(),
    estimatedValue: euro.nullable().optional(),
    services: services.optional(),
    notes: notes(5000).optional(),
  })
  .strict();

const patchSchema = z
  .object({
    priority: z.enum(PRIORITY_IDS).optional(),
    ownerId: z.uuid().nullable().optional(),
    estimatedValue: euro.nullable().optional(),
    services: services.optional(),
    notes: notes(5000).nullable().optional(),
  })
  .strict();

export const crmListSchema = listSchema.omit({ sort: true, dir: true }).extend({
  stage: csv(STAGE_IDS),
  crmPriority: csv(PRIORITY_IDS),
  owner: z.union([z.uuid(), z.enum(['none', 'me'])]).optional(),
  followUp: z.enum(['overdue', 'today', 'upcoming', 'none']).optional(),
  state: z.enum(['open', 'closed', 'all']).default('open'),
  // nel CRM le aziende escluse (non contattare) restano visibili
  excluded: z.enum(['hide', 'only', 'include']).default('include'),
  sort: z.enum(Object.keys(CRM_SORTS) as [CrmSort, ...CrmSort[]]).default('activity'),
  dir: z.enum(['asc', 'desc']).default('desc'),
});

/** Filtri dei follow-up dalla query string (elenco, esportazione, filtri salvati). */
export const followUpListSchema = z.object({
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
  // vista precedente (Fase 7), ancora accettata
  view: z.enum(['today', 'overdue', 'upcoming', 'completed', 'cancelled', 'all']).optional(),
  status: z.enum(['pending', 'completed', 'cancelled', 'all']).optional(),
  due: z.enum(['overdue', 'today', 'soon', 'later', 'upcoming']).optional(),
  priority: csv(PRIORITY_IDS),
  stage: csv(STAGE_IDS),
  owner: z.union([z.uuid(), z.literal('me')]).optional(),
  business: z.uuid().optional(),
});

export function followUpFilters(q: z.infer<typeof followUpListSchema>, userId: string): FollowUpFilters {
  const fromView: FollowUpFilters =
    q.view === 'completed' || q.view === 'cancelled'
      ? { status: q.view }
      : q.view === 'all'
        ? { status: 'all' }
        : q.view
          ? { status: 'pending', due: q.view }
          : {};
  return {
    ...fromView,
    ...(q.status ? { status: q.status } : {}),
    ...(q.due ? { due: q.due } : {}),
    priorities: q.priority,
    stages: q.stage,
    owner: q.owner === 'me' ? userId : q.owner,
    businessId: q.business,
  };
}

function crmFilters(ctx: Context): CrmFilters {
  return crmFiltersFrom(ctx.url.searchParams, sessionOf(ctx).user.id);
}

export function crmFiltersFrom(params: URLSearchParams, userId: string): CrmFilters {
  const q = parseQuery(crmListSchema, params);
  const session = { user: { id: userId } };
  return {
    business: {
      ...q,
      sectors: q.sector,
      categories: q.category.filter(isCategoryId),
      review: q.review === '1',
    },
    stages: q.stage,
    priorities: q.crmPriority as PriorityId[],
    owner: q.owner === 'me' ? session.user.id : q.owner,
    followUp: q.followUp,
    state: q.state,
    sort: q.sort,
    dir: q.dir,
    page: q.page,
    pageSize: q.pageSize,
  };
}

const writes = (ctx: Context) => {
  const session = sessionOf(ctx);
  limit(ctx, `crm:${session.user.id}`, RULES.crmWritesByUser);
  // i promemoria dipendono da follow-up e fasi: alla prossima lettura si riallineano subito
  markRemindersStale();
  return session;
};

/** Opzioni di esportazione (formato, colonne, nome) separate dai filtri dell'elenco. */
function exportRequest<T extends z.ZodRawShape>(ctx: Context, extra: T, catalog: { id: string }[]) {
  const session = sessionOf(ctx);
  limit(ctx, `export:${session.user.id}`, RULES.exportsByUser);
  const base = parseQuery(z.object(exportParams), ctx.url.searchParams);
  const q = { ...parseQuery(z.object(extra), ctx.url.searchParams), ...base };
  const bad = checkFields(base.fields, catalog);
  if (bad) throw new HttpError(400, 'VALIDATION_ERROR', bad, { fields: bad });
  const rest = new URLSearchParams(ctx.url.searchParams);
  for (const k of ['format', 'fields', 'name', ...Object.keys(extra)]) rest.delete(k);
  return { session, q, rest };
}

export const crmRoutes: Route[] = [
  {
    method: 'GET',
    pattern: /^\/api\/exports\/columns$/,
    async handle() {
      // catalogo delle colonne di ogni elenco esportabile (per la scelta delle colonne nell'interfaccia)
      return ok({
        businesses: describeColumns(BUSINESS_COLUMNS),
        opportunities: describeColumns(OPPORTUNITY_COLUMNS),
        followups: describeColumns(FOLLOWUP_COLUMNS),
        activities: describeColumns(ACTIVITY_COLUMNS),
        limit: EXPORT_LIMIT,
      });
    },
  },
  {
    method: 'GET',
    pattern: /^\/api\/crm\/opportunities\/export$/,
    async handle(ctx) {
      const { session, q, rest } = exportRequest(
        ctx,
        { groupByStage: z.enum(['0', '1']).default('0') },
        OPPORTUNITY_COLUMNS,
      );
      const f = crmFiltersFrom(rest, session.user.id);
      return fileReply(
        await exportOpportunities(ctx.db, f, {
          format: q.format,
          fields: q.fields,
          name: q.name,
          groupByStage: q.groupByStage === '1',
          userId: session.user.id,
        }),
      );
    },
  },
  {
    method: 'GET',
    pattern: /^\/api\/crm\/followups\/export$/,
    async handle(ctx) {
      const { session, q, rest } = exportRequest(ctx, {}, FOLLOWUP_COLUMNS);
      const f = followUpFilters(parseQuery(followUpListSchema, rest), session.user.id);
      return fileReply(
        await exportFollowUps(ctx.db, f, { format: q.format, fields: q.fields, name: q.name, userId: session.user.id }),
      );
    },
  },
  {
    method: 'GET',
    pattern: /^\/api\/crm\/activities\/export$/,
    async handle(ctx) {
      const { session, q } = exportRequest(
        ctx,
        {
          from: date.optional(),
          to: date.optional(),
          type: csv(ACTIVITY_TYPE_IDS),
          business: z.uuid().optional(),
        },
        ACTIVITY_COLUMNS,
      );
      return fileReply(
        await exportActivities(
          ctx.db,
          { from: q.from, to: q.to, types: q.type, businessId: q.business },
          { format: q.format, fields: q.fields, name: q.name, userId: session.user.id },
        ),
      );
    },
  },
  {
    method: 'POST',
    pattern: new RegExp(`^/api/businesses/${UUID}/followups$`),
    async handle(ctx) {
      const session = writes(ctx);
      const body = parseBody(
        z
          .object({
            description: summary,
            dueDate: date,
            dueTime: time.nullable().optional(),
            notes: notes(2000).optional(),
            priority: z.enum(PRIORITY_IDS).optional(),
            createOpportunity: z.boolean().default(false),
          })
          .strict(),
        ctx.body,
      );
      const { createOpportunity: create, ...input } = body;
      const r = await addFollowUpForBusiness(
        ctx.db,
        ctx.match[1]!,
        input,
        { createOpportunity: create },
        session.user.id,
      );
      return created(r);
    },
  },
  {
    method: 'GET',
    pattern: /^\/api\/crm\/meta$/,
    async handle(ctx) {
      return ok(await crmMeta(ctx.db));
    },
  },
  {
    method: 'GET',
    pattern: /^\/api\/crm\/dashboard$/,
    async handle(ctx) {
      return ok(await dashboard(ctx.db));
    },
  },
  {
    method: 'GET',
    pattern: /^\/api\/crm\/opportunities$/,
    async handle(ctx) {
      return ok(await listOpportunities(ctx.db, crmFilters(ctx)));
    },
  },
  {
    method: 'GET',
    pattern: /^\/api\/crm\/board$/,
    async handle(ctx) {
      const perStage = parseQuery(
        z.object({ perStage: z.coerce.number().int().min(1).max(50).default(20) }),
        new URLSearchParams({ perStage: ctx.url.searchParams.get('perStage') ?? '20' }),
      ).perStage;
      const f = crmFilters(ctx);
      return ok(await board(ctx.db, f, perStage));
    },
  },
  {
    method: 'POST',
    pattern: /^\/api\/crm\/opportunities$/,
    async handle(ctx) {
      const session = writes(ctx);
      const body = parseBody(createSchema, ctx.body);
      const id = await createOpportunity(ctx.db, body, session.user.id);
      return created(await getOpportunity(ctx.db, id));
    },
  },
  {
    method: 'POST',
    pattern: /^\/api\/crm\/opportunities\/bulk$/,
    async handle(ctx) {
      const session = sessionOf(ctx);
      const body = parseBody(
        z
          .object({
            businessIds: z
              .array(z.uuid('Identificativo non valido.'))
              .min(1, 'Seleziona almeno un’azienda.')
              .max(500, 'Al massimo 500 aziende per volta.'),
          })
          .strict(),
        ctx.body,
      );
      limit(ctx, `crm-bulk:${session.user.id}`, RULES.crmBulkByUser);
      return ok(await bulkCreate(ctx.db, body.businessIds, session.user.id));
    },
  },
  {
    method: 'GET',
    pattern: new RegExp(`^/api/crm/opportunities/${UUID}$`),
    async handle(ctx) {
      return ok(await getOpportunity(ctx.db, ctx.match[1]!));
    },
  },
  {
    method: 'PATCH',
    pattern: new RegExp(`^/api/crm/opportunities/${UUID}$`),
    async handle(ctx) {
      const session = writes(ctx);
      const body = parseBody(patchSchema, ctx.body);
      await updateOpportunity(ctx.db, ctx.match[1]!, body, session.user.id);
      return ok(await getOpportunity(ctx.db, ctx.match[1]!));
    },
  },
  {
    method: 'POST',
    pattern: new RegExp(`^/api/crm/opportunities/${UUID}/stage$`),
    async handle(ctx) {
      const session = writes(ctx);
      const body = parseBody(
        z
          .object({
            stage: z.enum(STAGE_IDS),
            lostReason: notes(500).optional(),
            note: notes(1000).optional(),
          })
          .strict(),
        ctx.body,
      );
      const r = await changeStage(ctx.db, ctx.match[1]!, body, session.user.id);
      return ok({ ...r, ...(await getOpportunity(ctx.db, ctx.match[1]!)) });
    },
  },
  {
    method: 'POST',
    pattern: new RegExp(`^/api/crm/opportunities/${UUID}/activities$`),
    async handle(ctx) {
      const session = writes(ctx);
      const body = parseBody(
        z
          .object({
            type: z.enum(MANUAL_ACTIVITY_TYPES),
            occurredAt,
            summary,
            notes: notes(5000).optional(),
          })
          .strict(),
        ctx.body,
      );
      await addActivity(ctx.db, ctx.match[1]!, body, session.user.id);
      return created(await getOpportunity(ctx.db, ctx.match[1]!));
    },
  },
  {
    method: 'PATCH',
    pattern: new RegExp(`^/api/crm/activities/${UUID}$`),
    async handle(ctx) {
      const session = writes(ctx);
      const body = parseBody(
        z
          .object({
            type: z.enum(MANUAL_ACTIVITY_TYPES).optional(),
            occurredAt: occurredAt.optional(),
            summary: summary.optional(),
            notes: notes(5000).nullable().optional(),
          })
          .strict(),
        ctx.body,
      );
      await updateActivity(ctx.db, ctx.match[1]!, body, { id: session.user.id, role: session.user.role });
      return ok({ updated: true });
    },
  },
  {
    method: 'POST',
    pattern: new RegExp(`^/api/crm/opportunities/${UUID}/followups$`),
    async handle(ctx) {
      const session = writes(ctx);
      const body = parseBody(
        z
          .object({
            description: summary,
            dueDate: date,
            dueTime: time.nullable().optional(),
            notes: notes(2000).optional(),
            priority: z.enum(PRIORITY_IDS).optional(),
          })
          .strict(),
        ctx.body,
      );
      await addFollowUp(ctx.db, ctx.match[1]!, body, session.user.id);
      return created(await getOpportunity(ctx.db, ctx.match[1]!));
    },
  },
  {
    method: 'GET',
    pattern: /^\/api\/crm\/followups$/,
    async handle(ctx) {
      const session = sessionOf(ctx);
      const q = parseQuery(followUpListSchema, ctx.url.searchParams);
      return ok(
        await listFollowUps(ctx.db, followUpFilters(q, session.user.id), { page: q.page, pageSize: q.pageSize }),
      );
    },
  },
  {
    method: 'PATCH',
    pattern: new RegExp(`^/api/crm/followups/${UUID}$`),
    async handle(ctx) {
      writes(ctx);
      const body = parseBody(
        z
          .object({
            description: summary.optional(),
            dueDate: date.optional(),
            dueTime: time.nullable().optional(),
            notes: notes(2000).nullable().optional(),
            priority: z.enum(PRIORITY_IDS).optional(),
          })
          .strict(),
        ctx.body,
      );
      await updateFollowUp(ctx.db, ctx.match[1]!, body);
      return ok({ updated: true });
    },
  },
  {
    method: 'POST',
    pattern: new RegExp(`^/api/crm/followups/${UUID}/complete$`),
    async handle(ctx) {
      const session = writes(ctx);
      const body = parseBody(z.object({ note: notes(2000).optional() }).strict(), ctx.body);
      await completeFollowUp(ctx.db, ctx.match[1]!, body.note || null, session.user.id);
      return ok({ completed: true });
    },
  },
  {
    method: 'POST',
    pattern: new RegExp(`^/api/crm/followups/${UUID}/cancel$`),
    async handle(ctx) {
      writes(ctx);
      await cancelFollowUp(ctx.db, ctx.match[1]!);
      return ok({ cancelled: true });
    },
  },
];
