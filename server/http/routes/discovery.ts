import { editBusiness, OPERATING_STATUSES } from '../../discovery/edit.ts';
import { z } from 'zod';
import { CONTACTABILITY } from '../../enrichment/contactability.ts';
import { BUSINESS_CATEGORIES, BUSINESS_CATEGORY_IDS } from '../../categories/catalog.ts';
import { categoryCounts, statusCounts } from '../../categories/counts.ts';
import { setManualCategory } from '../../categories/store.ts';
import { CONTACT_STATUSES } from '../../crm/contactStatus.ts';
import { RULES } from '../../auth/rateLimit.ts';
import {
  discoveryStats,
  getBusiness,
  listBusinesses,
  listCandidates,
  markDistinct,
  mergeCandidate,
  MATCH_FILTER_STATUSES,
  setExclusion,
  revokeDoNotContact,
  EXCLUSION_CODES,
  AI_STATE_FILTERS,
  SORTS,
  type BusinessFilters,
  type SortKey,
} from '../../discovery/businesses.ts';
import { SECTOR_IDS } from '../../discovery/sectors.ts';
import { BUSINESS_COLUMNS, exportBusinesses } from '../../exports/datasets.ts';
import { checkFields, exportParams, fileReply } from '../../exports/http.ts';
import { CATEGORIES, CATEGORY_IDS, isCategoryId } from '../../discovery/categories.ts';
import {
  cancelJob,
  createJob,
  JobError,
  pauseJob,
  resumeJob,
  type JobMessage,
  type JobStatus,
} from '../../discovery/jobs.ts';
import { COMPLETENESS_MAX } from '../../discovery/types.ts';
import { geo } from '../../geo/geo.ts';
import {
  created,
  HttpError,
  limit,
  msg,
  ok,
  parseBody,
  parseQuery,
  sessionOf,
  type Context,
  type Route,
} from '../core.ts';

/*
 * Scoperta di aziende, geografia e anagrafica (tutte le rotte richiedono una sessione valida).
 *
 *  GET  /api/geo/regions                          regioni
 *  GET  /api/geo/regions/:code/provinces          province / città metropolitane di una regione
 *  GET  /api/geo/provinces/:code/municipalities   comuni di una provincia
 *  GET  /api/geo/search?q=                        ricerca di aree per nome
 *  GET  /api/discovery/meta                       fornitore, categorie con copertura, limiti
 *  GET  /api/discovery/stats                      statistiche reali per la dashboard
 *  POST /api/discovery/jobs                       avvia una ricerca
 *  GET  /api/discovery/jobs                       elenco delle ricerche
 *  GET  /api/discovery/jobs/:id                   dettaglio con avanzamento, unità e messaggi
 *  POST /api/discovery/jobs/:id/{cancel|pause|resume}
 *  GET  /api/businesses                           elenco con filtri, ordinamento e paginazione
 *  GET  /api/businesses/:id                       scheda con provenienza, possibili duplicati e cronologia
 *  GET  /api/duplicates?status=pending|resolved   possibili duplicati
 *  POST /api/duplicates/:id/merge                 unisci (indica quale azienda resta)
 *  POST /api/duplicates/:id/distinct              segna come attività distinte
 */

const UUID = '([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})';
const iso = (d: Date | string | null) => (d ? new Date(d).toISOString() : null);

export const geoRoutes: Route[] = [
  {
    method: 'GET',
    pattern: /^\/api\/geo\/regions$/,
    async handle() {
      return ok({ regions: geo().regions, source: geo().meta });
    },
  },
  {
    method: 'GET',
    pattern: /^\/api\/geo\/regions\/(\d{2})\/provinces$/,
    async handle(ctx) {
      if (!geo().region(ctx.match[1]!)) throw new JobError(404, 'NOT_FOUND', 'Regione non trovata.');
      return ok({ provinces: geo().provincesOf(ctx.match[1]!) });
    },
  },
  {
    method: 'GET',
    pattern: /^\/api\/geo\/provinces\/(\d{3})\/municipalities$/,
    async handle(ctx) {
      if (!geo().province(ctx.match[1]!)) throw new JobError(404, 'NOT_FOUND', 'Provincia non trovata.');
      return ok({
        municipalities: geo()
          .municipalitiesOf(ctx.match[1]!)
          .map(({ code, name, altName }) => ({ code, name, altName })),
      });
    },
  },
  {
    method: 'GET',
    pattern: /^\/api\/geo\/search$/,
    async handle(ctx) {
      const { q } = parseQuery(
        z.object({ q: z.string().trim().min(2, 'Scrivi almeno 2 caratteri.').max(80) }),
        ctx.url.searchParams,
      );
      return ok({ areas: geo().search(q, 20) });
    },
  },
];

/* ---------- ricerche ---------- */

const jobSchema = z
  .object({
    area: z.object({
      type: z.enum(['italy', 'region', 'province', 'municipality'], { error: 'Scegli un’area.' }),
      code: z.string().regex(/^(IT|\d{2}|\d{3}|\d{6})$/, 'Codice area non valido.'),
    }),
    radiusKm: z.number().min(0.5, 'Raggio minimo 0,5 km.').max(30, 'Raggio massimo 30 km.').optional(),
    categories: z
      .array(z.string().refine(isCategoryId, 'Categoria sconosciuta.'))
      .min(1, 'Scegli almeno una categoria.')
      .max(CATEGORY_IDS.length)
      .refine((c) => new Set(c).size === c.length, 'Categorie ripetute.'),
    maxResults: z.number({ error: msg.required }).int().min(1, 'Almeno 1 risultato.'),
    minCompleteness: z.number().int().min(0).max(COMPLETENESS_MAX).default(0),
    requireWebsite: z.boolean().default(false),
  })
  .strict();

interface JobRow {
  id: string;
  status: JobStatus;
  provider: string;
  area_type: string;
  area_code: string;
  area_name: string;
  radius_km: string | number | null;
  categories: string[];
  max_results: number;
  min_completeness: number;
  require_website: boolean;
  units_total: number;
  units_done: number;
  discovered: number;
  inserted: number;
  updated: number;
  unchanged: number;
  merged: number;
  duplicates_skipped: number;
  flagged_for_review: number;
  skipped_incomplete: number;
  requests_sent: number;
  failed_requests: number;
  limit_reached: boolean;
  messages: JobMessage[];
  cancel_requested: boolean;
  pause_requested: boolean;
  pause_reason: string | null;
  heartbeat_at: Date | null;
  created_at: Date;
  started_at: Date | null;
  finished_at: Date | null;
  created_by_name: string | null;
}

function jobDto(j: JobRow) {
  return {
    id: j.id,
    status: j.status,
    provider: j.provider,
    area: {
      type: j.area_type,
      code: j.area_code,
      name: j.area_name,
      context: geo().area(j.area_type as never, j.area_code)?.context ?? null,
    },
    radiusKm: j.radius_km === null ? null : Number(j.radius_km),
    categories: j.categories.map((id) => ({ id, label: CATEGORIES[id as keyof typeof CATEGORIES]?.label ?? id })),
    maxResults: j.max_results,
    minCompleteness: j.min_completeness,
    requireWebsite: j.require_website,
    progress: { unitsTotal: j.units_total, unitsDone: j.units_done },
    counts: {
      discovered: j.discovered,
      inserted: j.inserted,
      updated: j.updated,
      unchanged: j.unchanged,
      merged: j.merged,
      duplicatesSkipped: j.duplicates_skipped,
      flaggedForReview: j.flagged_for_review,
      skippedIncomplete: j.skipped_incomplete,
      requestsSent: j.requests_sent,
      failedRequests: j.failed_requests,
    },
    limitReached: j.limit_reached,
    messages: j.messages,
    cancelRequested: j.cancel_requested,
    pauseRequested: j.pause_requested,
    pauseReason: j.pause_reason,
    heartbeatAt: iso(j.heartbeat_at),
    createdAt: iso(j.created_at),
    startedAt: iso(j.started_at),
    finishedAt: iso(j.finished_at),
    createdBy: j.created_by_name,
  };
}

const JOB_SELECT = `SELECT j.*, u.display_name AS created_by_name FROM discovery_jobs j LEFT JOIN users u ON u.id = j.created_by`;

async function loadJob(ctx: Parameters<Route['handle']>[0], id: string) {
  const { rows } = await ctx.db.query<JobRow>(`${JOB_SELECT} WHERE j.id = $1`, [id]);
  if (!rows[0]) throw new JobError(404, 'NOT_FOUND', 'Ricerca non trovata.');
  return rows[0];
}

export const pageQuery = {
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
};

export const discoveryRoutes: Route[] = [
  {
    method: 'GET',
    pattern: /^\/api\/discovery\/meta$/,
    async handle(ctx) {
      const { provider, config, workerActive } = ctx.state.discovery;
      const info = provider.info();
      return ok({
        provider: info,
        workerActive,
        categories: info.categories.map((c) => ({
          ...c,
          label: CATEGORIES[c.id].label,
          description: CATEGORIES[c.id].description,
        })),
        limits: {
          maxResultsPerJob: config.maxResultsPerJob,
          maxUnitsPerJob: config.maxUnitsPerJob,
          municipalitiesPerRequest: config.municipalitiesPerRequest,
          minIntervalSeconds: config.minIntervalMs / 1000,
          completenessMax: COMPLETENESS_MAX,
        },
        geoSource: geo().meta,
      });
    },
  },
  {
    method: 'GET',
    pattern: /^\/api\/discovery\/stats$/,
    async handle(ctx) {
      return ok(await discoveryStats(ctx.db));
    },
  },
  {
    method: 'POST',
    pattern: /^\/api\/discovery\/jobs$/,
    async handle(ctx) {
      const session = sessionOf(ctx);
      const body = parseBody(jobSchema, ctx.body);
      limit(ctx, `discovery:${session.user.id}`, RULES.discoveryJobsByUser);
      const { provider, config, wake } = ctx.state.discovery;
      const info = provider.info();
      const id = await createJob(
        ctx.db,
        { ...body, categories: body.categories.filter(isCategoryId) },
        { userId: session.user.id, provider: info.id, providerConfigured: info.configured, config },
      );
      wake();
      return created({ job: jobDto(await loadJob(ctx, id)) });
    },
  },
  {
    method: 'GET',
    pattern: /^\/api\/discovery\/jobs$/,
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
      const { rows: total } = await ctx.db.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM discovery_jobs j ${cond}`,
      );
      const { rows } = await ctx.db.query<JobRow>(
        `${JOB_SELECT} ${cond} ORDER BY j.created_at DESC, j.id LIMIT $1 OFFSET $2`,
        [q.pageSize, (q.page - 1) * q.pageSize],
      );
      return ok({ items: rows.map(jobDto), total: total[0]!.n, page: q.page, pageSize: q.pageSize });
    },
  },
  {
    method: 'GET',
    pattern: new RegExp(`^/api/discovery/jobs/${UUID}$`),
    async handle(ctx) {
      const job = await loadJob(ctx, ctx.match[1]!);
      const { rows: units } = await ctx.db.query<{
        seq: number;
        municipality_codes: string[];
        status: string;
        attempts: number;
        records_found: number;
        missing_municipalities: string[];
        from_cache: boolean;
        source_data_at: Date | null;
        error: string | null;
        finished_at: Date | null;
      }>(
        `SELECT seq, municipality_codes, status, attempts, records_found, missing_municipalities, from_cache, source_data_at, error, finished_at
           FROM discovery_job_units WHERE job_id = $1 ORDER BY seq LIMIT 2000`,
        [job.id],
      );
      return ok({
        job: jobDto(job),
        units: units.map((u) => ({
          seq: u.seq,
          status: u.status,
          municipalities: u.municipality_codes.map((c) => ({ code: c, name: geo().municipality(c)?.name ?? c })),
          attempts: u.attempts,
          recordsFound: u.records_found,
          missing: u.missing_municipalities,
          fromCache: u.from_cache,
          sourceDataAt: iso(u.source_data_at),
          error: u.error,
          finishedAt: iso(u.finished_at),
        })),
      });
    },
  },
  ...(['cancel', 'pause', 'resume'] as const).map((action): Route => ({
    method: 'POST',
    pattern: new RegExp(`^/api/discovery/jobs/${UUID}/${action}$`),
    async handle(ctx) {
      const session = sessionOf(ctx);
      const id = ctx.match[1]!;
      const { provider, wake } = ctx.state.discovery;
      if (action === 'cancel') await cancelJob(ctx.db, id, session.user.id);
      if (action === 'pause') await pauseJob(ctx.db, id, session.user.id);
      if (action === 'resume') {
        limit(ctx, `discovery:${session.user.id}`, RULES.discoveryJobsByUser);
        await resumeJob(ctx.db, id, session.user.id, provider.info().configured);
        wake();
      }
      return ok({ job: jobDto(await loadJob(ctx, id)) });
    },
  })),
];

/* ---------- anagrafica ---------- */

export const listSchema = z.object({
  ...pageQuery,
  q: z.string().trim().max(100).optional(),
  region: z
    .string()
    .regex(/^\d{2}$/)
    .optional(),
  province: z
    .string()
    .regex(/^\d{3}$/)
    .optional(),
  municipality: z
    .string()
    .regex(/^\d{6}$/)
    .optional(),
  category: z
    .string()
    .optional()
    .transform((v) => (v ? v.split(',') : []))
    .refine((v) => v.every(isCategoryId), 'Categoria sconosciuta.'),
  website: z.enum(['any', 'yes', 'own', 'no']).default('any'),
  audit: z.enum(['audited', 'unaudited', 'failed', 'unavailable', 'no_website', 'problems']).optional(),
  priority: csv(['A', 'B', 'C', 'low', 'needs_review', 'insufficient_data', 'not_suitable', 'unscored'] as const),
  minScore: z.coerce.number().int().min(0).max(100).default(0),
  confidence: csv(['high', 'medium', 'low'] as const),
  service: z
    .string()
    .regex(/^[a-z][a-z0-9_]{1,40}$/, 'Servizio non valido.')
    .optional(),
  minMatch: z.coerce.number().int().min(0).max(100).default(0),
  matchStatus: csv(MATCH_FILTER_STATUSES),
  // Lead Hunter (Fase 6)
  hunt: z.uuid().optional(),
  sector: csv(SECTOR_IDS as [string, ...string[]]),
  excluded: z.enum(['hide', 'only', 'include']).optional(),
  // divieto di contatto: 1 = solo le aziende con il divieto, 0 = solo quelle senza
  doNotContact: z.enum(['0', '1']).optional(),
  contact: z.enum(['phone', 'any']).optional(),
  maxPerSector: z.coerce.number().int().min(1).max(1000).optional(),
  maxPerRegion: z.coerce.number().int().min(1).max(1000).optional(),
  // CRM (Fase 7): aziende senza opportunità aperta, con un'opportunità aperta, con almeno un'opportunità
  crm: z.enum(['none', 'open', 'any']).optional(),
  contactStatus: csv(CONTACT_STATUSES),
  email: z.enum(['yes', 'no']).optional(),
  // categoria commerciale di «Trova aziende» ('pending' = non ancora classificate) e categorie da verificare
  businessCategory: z.enum([...BUSINESS_CATEGORY_IDS, 'pending'], { error: 'Categoria sconosciuta.' }).optional(),
  categoryReview: z.enum(['0', '1']).default('0'),
  // contattabilità via email (uno o più stati separati da virgola)
  contactability: csv(CONTACTABILITY),
  // valutazione commerciale (AI, altrimenti riserva a regole): intervallo di punteggio (es. una fascia), stato, componenti
  minCommercial: z.coerce.number().int().min(0).max(100).optional(),
  maxCommercial: z.coerce.number().int().min(0).max(100).optional(),
  aiStatus: z.enum(['assessed', 'not_assessed', 'needs_review', 'failed', 'excluded', ...AI_STATE_FILTERS]).optional(),
  aiConfidence: csv(['high', 'medium', 'low'] as const),
  minAcquisition: z.coerce.number().int().min(0).max(100).optional(),
  minServiceFit: z.coerce.number().int().min(0).max(100).optional(),
  minCompleteness: z.coerce.number().int().min(0).max(COMPLETENESS_MAX).default(0),
  review: z.enum(['0', '1']).default('0'),
  job: z.uuid().optional(),
  sort: z.enum(Object.keys(SORTS) as [SortKey, ...SortKey[]]).default('verified'),
  dir: z.enum(['asc', 'desc']).default('desc'),
});

/** Filtri dell'elenco dalla query string (stessi per elenco ed esportazione). */
export function filtersFromQuery(
  params: URLSearchParams,
  fixed: { service?: string; ids?: string[] } = {},
): BusinessFilters {
  const q = parseQuery(listSchema, params);
  return {
    ...q,
    ...fixed,
    sectors: q.sector,
    categories: q.category.filter(isCategoryId),
    review: q.review === '1',
    categoryReview: q.categoryReview === '1',
    doNotContact: q.doNotContact === undefined ? undefined : q.doNotContact === '1',
  };
}

/** Elenco delle aziende con i filtri della query (usato anche per le aziende abbinate a un servizio). */
export async function listFromQuery(ctx: Context, fixed: { service?: string } = {}) {
  return listBusinesses(ctx.db, filtersFromQuery(ctx.url.searchParams, fixed));
}

/** Elenco di valori ammessi separati da virgola (vuoto = nessun filtro). */
export function csv<T extends string>(values: readonly [T, ...T[]]) {
  return z
    .string()
    .optional()
    .transform((v) => (v ? v.split(',') : []))
    .refine((v) => v.every((x) => (values as readonly string[]).includes(x)), 'Valore non ammesso.')
    .transform((v) => v as T[]);
}

/** File CSV con il numero di righe e l'eventuale troncamento negli header (letti dall'interfaccia). */
const businessExportSchema = z.object(exportParams);
const exportOptions = (q: z.infer<typeof businessExportSchema>) => {
  const bad = checkFields(q.fields, BUSINESS_COLUMNS);
  if (bad) throw new HttpError(400, 'VALIDATION_ERROR', bad, { fields: bad });
  return { format: q.format, fields: q.fields, name: q.name };
};

export const businessRoutes: Route[] = [
  {
    // esportazione CSV con i filtri dell'elenco (GET) o di una selezione di aziende (POST { ids })
    method: 'GET',
    pattern: /^\/api\/businesses\/export$/,
    async handle(ctx) {
      const session = sessionOf(ctx);
      limit(ctx, `export:${session.user.id}`, RULES.exportsByUser);
      // le opzioni di esportazione non sono filtri dell'elenco
      const params = new URLSearchParams(ctx.url.searchParams);
      const options = exportOptions(parseQuery(businessExportSchema, params));
      for (const k of ['format', 'fields', 'name']) params.delete(k);
      const f = filtersFromQuery(params);
      return fileReply(await exportBusinesses(ctx.db, f, { ...options, userId: session.user.id }));
    },
  },
  {
    method: 'POST',
    pattern: /^\/api\/businesses\/export$/,
    async handle(ctx) {
      const session = sessionOf(ctx);
      const body = parseBody(
        z
          .object({
            ids: z
              .array(z.uuid('Identificativo non valido.'))
              .min(1, 'Seleziona almeno un’azienda.')
              .max(1000, 'Al massimo 1.000 aziende selezionate: per elenchi più grandi esporta con i filtri.'),
            format: exportParams.format,
            fields: z.array(z.string().max(40)).max(60).optional(),
            name: exportParams.name,
          })
          .strict(),
        ctx.body,
      );
      limit(ctx, `export:${session.user.id}`, RULES.exportsByUser);
      const bad = checkFields(body.fields, BUSINESS_COLUMNS);
      if (bad) throw new HttpError(400, 'VALIDATION_ERROR', bad, { fields: bad });
      const params = new URLSearchParams({ excluded: 'include', pageSize: '100' });
      const f = filtersFromQuery(params, { ids: [...new Set(body.ids)] });
      return fileReply(
        await exportBusinesses(ctx.db, f, {
          format: body.format,
          fields: body.fields,
          name: body.name ?? 'aziende_selezionate',
          userId: session.user.id,
        }),
      );
    },
  },
  {
    method: 'POST',
    pattern: new RegExp(`^/api/businesses/${UUID}/exclusion$`),
    async handle(ctx) {
      const session = sessionOf(ctx);
      const body = parseBody(
        z
          .object({
            excluded: z.boolean(),
            // motivo obbligatorio per escludere; «reason» (testo) resta accettato come nota
            code: z.enum(EXCLUSION_CODES, { error: 'Scegli un motivo valido.' }).optional(),
            note: z.string().trim().max(300).optional(),
            reason: z.string().trim().max(300).optional(),
            scope: z.enum(['tutti', 'email', 'telefono']).optional(),
          })
          .strict()
          .refine((b) => !b.excluded || b.code || b.reason, { message: 'Scegli il motivo.', path: ['code'] }),
        ctx.body,
      );
      limit(ctx, `review:${session.user.id}`, RULES.reviewWritesByUser);
      await setExclusion(
        ctx.db,
        ctx.match[1]!,
        { excluded: body.excluded, code: body.code, note: body.note ?? body.reason ?? null, scope: body.scope },
        session.user.id,
      );
      return ok({ business: await getBusiness(ctx.db, ctx.match[1]!) });
    },
  },
  {
    // revoca del divieto di contatto: solo amministratori, con un motivo (es. consenso scritto ricevuto)
    method: 'POST',
    pattern: new RegExp(`^/api/businesses/${UUID}/do-not-contact/revoke$`),
    access: 'admin',
    async handle(ctx) {
      const session = sessionOf(ctx);
      const body = parseBody(
        z.object({ note: z.string().trim().min(5, 'Scrivi il motivo della revoca.').max(300) }).strict(),
        ctx.body,
      );
      limit(ctx, `review:${session.user.id}`, RULES.reviewWritesByUser);
      await revokeDoNotContact(ctx.db, ctx.match[1]!, body.note, session.user.id);
      return ok({ business: await getBusiness(ctx.db, ctx.match[1]!) });
    },
  },
  {
    // città presenti nel database (comuni ISTAT con almeno un'azienda attiva), per il selettore della dashboard
    method: 'GET',
    pattern: /^\/api\/businesses\/cities$/,
    async handle(ctx) {
      const { rows } = await ctx.db.query<{ code: string; name: string; province_code: string; n: number }>(
        `SELECT municipality_code AS code, min(municipality_name) AS name, min(province_code) AS province_code,
                count(*)::int AS n
           FROM businesses WHERE merged_into IS NULL AND excluded_at IS NULL AND municipality_code IS NOT NULL
          GROUP BY municipality_code ORDER BY n DESC, name LIMIT 300`,
      );
      return ok({
        items: rows
          .map((r) => ({
            code: r.code,
            name: r.name,
            province: geo().province(r.province_code)?.sigla ?? null,
            count: r.n,
          }))
          .sort((a, b) => a.name.localeCompare(b.name, 'it')),
      });
    },
  },
  {
    // categorie commerciali con i conteggi reali, calcolati con gli stessi filtri dell'elenco
    method: 'GET',
    pattern: /^\/api\/businesses\/categories$/,
    async handle(ctx) {
      const filters = filtersFromQuery(ctx.url.searchParams);
      const counts = await categoryCounts(ctx.db, filters);
      const byId = new Map(counts.categories.map((c) => [c.id, c.counts]));
      return ok({
        all: counts.all,
        pending: counts.pending,
        // stessi filtri: aziende escluse dalla prospezione e con divieto di contatto (conteggi separati)
        status: await statusCounts(ctx.db, { ...filters, excluded: undefined }),
        categories: BUSINESS_CATEGORIES.map((c) => ({
          id: c.id,
          label: c.label,
          description: c.description,
          empty: c.empty,
          discover: c.discover,
          sectors: c.sectors,
          counts: byId.get(c.id)!,
        })),
      });
    },
  },
  {
    // «Modifica» della scheda: solo i campi inviati; svuotare un campo richiede `clear`; `updatedAt` evita sovrascritture
    method: 'PATCH',
    pattern: new RegExp(`^/api/businesses/${UUID}$`),
    async handle(ctx) {
      const session = sessionOf(ctx);
      const str = (max: number) => z.string().max(max, `Al massimo ${max} caratteri.`).nullable().optional();
      const body = parseBody(
        z
          .object({
            updatedAt: z.iso.datetime({ offset: true, error: 'Versione della scheda mancante: ricarica la pagina.' }),
            name: z.string().max(200, 'Al massimo 200 caratteri.').optional(),
            category: z.enum(BUSINESS_CATEGORY_IDS, { error: 'Categoria sconosciuta.' }).nullable().optional(),
            operatingStatus: z.enum(OPERATING_STATUSES, { error: 'Stato sconosciuto.' }).nullable().optional(),
            email: str(254),
            phone: str(40),
            fax: str(40),
            website: str(500),
            street: str(200),
            housenumber: str(20),
            postcode: str(10),
            city: str(120),
            municipalityCode: z
              .string()
              .regex(/^\d{6}$/, 'Comune non valido.')
              .nullable()
              .optional(),
            contactName: str(120),
            contactRole: str(80),
            notes: str(5000),
            clear: z.array(z.string().max(40)).max(20).optional(),
          })
          .strict(),
        ctx.body,
      );
      limit(ctx, `review:${session.user.id}`, RULES.reviewWritesByUser);
      const r = await editBusiness(ctx.db, ctx.match[1]!, body, session.user.id);
      return ok({ changed: r.changed, business: await getBusiness(ctx.db, ctx.match[1]!) });
    },
  },
  {
    // categoria scelta da una persona, oppure ritorno alla classificazione automatica (category: null)
    method: 'PUT',
    pattern: new RegExp(`^/api/businesses/${UUID}/category$`),
    async handle(ctx) {
      const session = sessionOf(ctx);
      const body = parseBody(
        z.object({ category: z.enum(BUSINESS_CATEGORY_IDS, { error: 'Categoria sconosciuta.' }).nullable() }).strict(),
        ctx.body,
      );
      limit(ctx, `review:${session.user.id}`, RULES.reviewWritesByUser);
      if (!(await setManualCategory(ctx.db, ctx.match[1]!, body.category, session.user.id)))
        throw new HttpError(404, 'NOT_FOUND', 'Azienda non trovata.');
      return ok({ business: await getBusiness(ctx.db, ctx.match[1]!) });
    },
  },
  {
    method: 'GET',
    pattern: /^\/api\/businesses$/,
    async handle(ctx) {
      return ok(await listFromQuery(ctx));
    },
  },
  {
    method: 'GET',
    pattern: new RegExp(`^/api/businesses/${UUID}$`),
    async handle(ctx) {
      return ok({ business: await getBusiness(ctx.db, ctx.match[1]!) });
    },
  },
  {
    method: 'GET',
    pattern: /^\/api\/duplicates$/,
    async handle(ctx) {
      const q = parseQuery(
        z.object({ ...pageQuery, status: z.enum(['pending', 'resolved']).default('pending') }),
        ctx.url.searchParams,
      );
      return ok(await listCandidates(ctx.db, q.status, q.page, q.pageSize));
    },
  },
  {
    method: 'POST',
    pattern: new RegExp(`^/api/duplicates/${UUID}/merge$`),
    async handle(ctx) {
      const session = sessionOf(ctx);
      limit(ctx, `review:${session.user.id}`, RULES.reviewWritesByUser);
      const body = parseBody(z.object({ keep: z.uuid('Scegli quale azienda mantenere.') }).strict(), ctx.body);
      return ok(await mergeCandidate(ctx.db, ctx.match[1]!, body.keep, session.user.id));
    },
  },
  {
    method: 'POST',
    pattern: new RegExp(`^/api/duplicates/${UUID}/distinct$`),
    async handle(ctx) {
      const session = sessionOf(ctx);
      limit(ctx, `review:${session.user.id}`, RULES.reviewWritesByUser);
      await markDistinct(ctx.db, ctx.match[1]!, session.user.id);
      return ok({ ok: true });
    },
  },
];
