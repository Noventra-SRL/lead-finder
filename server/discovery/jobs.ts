import { createHash } from 'node:crypto';
import { audit } from '../audit.ts';
import type { DiscoveryConfig } from '../config.ts';
import type { Db, Queryable } from '../db/client.ts';
import { geo, type AreaType } from '../geo/geo.ts';
import { appendMessages, jobMessage, type JobMessage } from '../jobs/messages.ts';
import { inPriorityOrder, type CategoryId } from './categories.ts';
import { sectorsInOrder } from './sectors.ts';

/*
 * Job di ricerca: creazione con pianificazione in unità (gruppi di comuni), limiti, stato e transizioni.
 *
 * Stati: pending → running → completed | completed_with_warnings | failed | cancelled
 *                          ↘ paused (manuale o per interruzione del server) → pending (ripresa)
 * L'avanzamento è salvato per unità: dopo un'interruzione si riparte dalla prima unità non completata.
 */

export type JobStatus =
  'pending' | 'running' | 'paused' | 'completed' | 'completed_with_warnings' | 'failed' | 'cancelled';
export const ACTIVE_STATUSES: JobStatus[] = ['pending', 'running', 'paused'];

export const MAX_ACTIVE_JOBS_PER_USER = 3;
export const MAX_ACTIVE_JOBS_TOTAL = 10;

export class JobError extends Error {
  readonly status: number;
  readonly code: string;
  readonly jobId?: string;
  /** Altri dati sicuri da restituire con l'errore (es. l'id dell'opportunità già aperta). */
  readonly data?: Record<string, unknown>;
  constructor(status: number, code: string, message: string, jobId?: string, data?: Record<string, unknown>) {
    super(message);
    this.status = status;
    this.code = code;
    this.jobId = jobId;
    this.data = data;
  }
}

export interface JobRequest {
  area: { type: AreaType; code: string };
  radiusKm?: number;
  categories: CategoryId[];
  maxResults: number;
  minCompleteness: number;
  requireWebsite: boolean;
  /** Solo attività con un sito proprio o un'email indicata dalla fonte (ricerche di aziende con email pubblica). */
  requireContact?: boolean;
  /** Ricerca per settori (Fase 6): le categorie derivano dai settori. */
  sectors?: string[];
  /** Limite per settore e per comune nelle ricerche per settori. */
  limitPerSector?: number;
}

export type { JobMessage };

/** Richieste più piccole nelle ricerche per settori: ogni comune porta decine di blocchi nella query. */
export const SECTOR_MUNICIPALITIES_PER_REQUEST = 5;
/** Ricerche di uno o due settori: una query leggera per comune, si possono chiedere più comuni per richiesta. */
export const FEW_SECTORS_MUNICIPALITIES_PER_REQUEST = 20;

/** Capoluoghi con un nome diverso da quello della provincia. */
const CAPITALS: Record<string, string> = {
  "Valle d'Aosta/Vallée d'Aoste": 'Aosta',
  'Bolzano/Bozen': 'Bolzano',
  'Verbano-Cusio-Ossola': 'Verbania',
  'Sud Sardegna': 'Carbonia',
  'Reggio Calabria': 'Reggio di Calabria',
};

/** Il comune capoluogo, riconosciuto dal nome della provincia ("Pesaro e Urbino" → Pesaro, "Forlì-Cesena" → Forlì). */
const isCapital = (municipality: string, province: string) =>
  CAPITALS[province] !== undefined
    ? municipality === CAPITALS[province]
    : municipality === province || province.startsWith(`${municipality} `) || province.startsWith(`${municipality}-`);

/**
 * Unità di lavoro: comuni della stessa provincia, al massimo `perRequest` per richiesta.
 * Con `capitalFirst` il capoluogo apre la provincia: una ricerca con un limite di risultati (Lead Hunter) lo
 * raggiunge spesso con la prima richiesta, e le unità rimaste vengono saltate.
 */
export function planUnits(type: AreaType, code: string, perRequest: number, capitalFirst = false): string[][] {
  const municipalities = geo().municipalitiesIn(type, code);
  const byProvince = new Map<string, typeof municipalities>();
  for (const m of municipalities) {
    const list = byProvince.get(m.provinceCode) ?? [];
    list.push(m);
    byProvince.set(m.provinceCode, list);
  }
  const units: string[][] = [];
  for (const [provinceCode, list] of byProvince) {
    const province = geo().province(provinceCode)?.name ?? '';
    const ordered = capitalFirst
      ? [...list.filter((m) => isCapital(m.name, province)), ...list.filter((m) => !isCapital(m.name, province))]
      : list;
    const codes = ordered.map((m) => m.code);
    for (let i = 0; i < codes.length; i += perRequest) units.push(codes.slice(i, i + perRequest));
  }
  return units;
}

export function requestKey(provider: string, r: JobRequest): string {
  const canonical = JSON.stringify({
    provider,
    area: [r.area.type, r.area.code],
    radiusKm: r.radiusKm ?? null,
    categories: [...r.categories].sort(),
    maxResults: r.maxResults,
    minCompleteness: r.minCompleteness,
    requireWebsite: r.requireWebsite,
    requireContact: r.requireContact ?? false,
    sectors: [...(r.sectors ?? [])].sort(),
    limitPerSector: r.limitPerSector ?? null,
  });
  return createHash('sha256').update(canonical).digest('hex');
}

const message = jobMessage;

/** Aggiunge messaggi al job tenendo solo i più recenti. */
export const addMessages = (tx: Queryable, jobId: string, messages: JobMessage[]) =>
  appendMessages(tx, 'discovery_jobs', jobId, messages);

export async function createJob(
  db: Db,
  input: JobRequest,
  ctx: {
    userId: string;
    provider: string;
    providerConfigured: boolean;
    config: DiscoveryConfig;
    /** Job creato da una ricerca di lead (Fase 6): collegato alla ricerca, fuori dal limite per utente. */
    huntRunId?: string;
  },
): Promise<string> {
  if (!ctx.providerConfigured)
    throw new JobError(
      503,
      'PROVIDER_NOT_CONFIGURED',
      'La ricerca non è disponibile: nessun server OpenStreetMap configurato. Un amministratore deve impostare DISCOVERY_OVERPASS_URL.',
    );
  const area = geo().area(input.area.type, input.area.code);
  if (!area) throw new JobError(400, 'UNKNOWN_AREA', 'Area geografica sconosciuta.');
  if (input.radiusKm !== undefined && input.area.type !== 'municipality')
    throw new JobError(400, 'RADIUS_NEEDS_MUNICIPALITY', 'Il raggio si può usare solo partendo da un comune.');
  if (input.maxResults > ctx.config.maxResultsPerJob)
    throw new JobError(
      400,
      'TOO_MANY_RESULTS',
      `Il massimo consentito è ${ctx.config.maxResultsPerJob} risultati per ricerca.`,
    );

  const units =
    input.radiusKm !== undefined
      ? [[input.area.code]]
      : input.sectors?.length
        ? planUnits(
            input.area.type,
            input.area.code,
            Math.min(
              ctx.config.municipalitiesPerRequest,
              input.sectors.length <= 2 ? FEW_SECTORS_MUNICIPALITIES_PER_REQUEST : SECTOR_MUNICIPALITIES_PER_REQUEST,
            ),
            true,
          )
        : planUnits(input.area.type, input.area.code, ctx.config.municipalitiesPerRequest);
  if (units.length > ctx.config.maxUnitsPerJob) {
    throw new JobError(
      400,
      'AREA_TOO_LARGE',
      `L’area richiede ${units.length} richieste al server, oltre il limite di ${ctx.config.maxUnitsPerJob} per ricerca. ` +
        'Scegli una regione o una provincia, oppure fai aumentare il limite DISCOVERY_MAX_UNITS_PER_JOB.',
    );
  }
  const sectors = input.sectors?.length ? sectorsInOrder(input.sectors) : [];
  if (input.sectors?.length && sectors.length !== new Set(input.sectors).size)
    throw new JobError(400, 'UNKNOWN_SECTOR', 'Settore non presente nel catalogo.');
  const categories = sectors.length
    ? inPriorityOrder([...new Set(sectors.map((x) => x.category))])
    : inPriorityOrder(input.categories);
  if (!categories.length) throw new JobError(400, 'NO_CATEGORIES', 'Scegli almeno una categoria o un settore.');
  const key = requestKey(ctx.provider, { ...input, categories });

  return db.transaction(async (tx) => {
    // limiti contro la creazione abusiva di job (contati dentro la transazione)
    const active = await tx.query<{ mine: number; total: number }>(
      `SELECT count(*) FILTER (WHERE created_by = $1)::int AS mine, count(*)::int AS total
         FROM discovery_jobs WHERE status = ANY($2)`,
      [ctx.userId, ACTIVE_STATUSES],
    );
    const identical = await tx.query<{ id: string }>(
      'SELECT id FROM discovery_jobs WHERE request_key = $1 AND status = ANY($2)',
      [key, ACTIVE_STATUSES],
    );
    if (identical.rows[0])
      throw new JobError(
        409,
        'DUPLICATE_JOB',
        'Una ricerca identica è già in corso o in pausa: riprendi quella.',
        identical.rows[0].id,
      );
    if (!ctx.huntRunId && active.rows[0]!.mine >= MAX_ACTIVE_JOBS_PER_USER)
      throw new JobError(
        429,
        'TOO_MANY_ACTIVE_JOBS',
        `Hai già ${MAX_ACTIVE_JOBS_PER_USER} ricerche attive: attendi che finiscano o annullane una.`,
      );
    if (active.rows[0]!.total >= MAX_ACTIVE_JOBS_TOTAL)
      throw new JobError(429, 'QUEUE_FULL', 'Troppe ricerche in coda: riprova quando alcune saranno terminate.');

    const { rows } = await tx.query<{ id: string }>(
      `INSERT INTO discovery_jobs (created_by, provider, area_type, area_code, area_name, radius_km, categories, max_results,
                                   min_completeness, require_website, request_key, units_total, messages, sectors, limit_per_sector,
                                   hunt_run_id, require_contact)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17) RETURNING id`,
      [
        ctx.userId,
        ctx.provider,
        area.type,
        area.code,
        area.name,
        input.radiusKm ?? null,
        categories,
        input.maxResults,
        input.minCompleteness,
        input.requireWebsite,
        key,
        units.length,
        JSON.stringify([
          message(
            'info',
            `Ricerca pianificata in ${units.length} ${units.length === 1 ? 'richiesta' : 'richieste'} al server.`,
          ),
        ]),
        sectors.map((x) => x.id),
        sectors.length ? (input.limitPerSector ?? 1) : null,
        ctx.huntRunId ?? null,
        input.requireContact ?? false,
      ],
    );
    const id = rows[0]!.id;
    for (let i = 0; i < units.length; i++)
      await tx.query('INSERT INTO discovery_job_units (job_id, seq, municipality_codes) VALUES ($1, $2, $3)', [
        id,
        i,
        units[i],
      ]);
    await audit(tx, {
      userId: ctx.userId,
      action: 'discovery.job_created',
      entityType: 'discovery_job',
      entityId: id,
      details: { area: [area.type, area.code], categories, maxResults: input.maxResults, units: units.length },
    });
    return id;
  });
}

async function lockJob(tx: Queryable, id: string) {
  const { rows } = await tx.query<{ id: string; status: JobStatus }>(
    'SELECT id, status FROM discovery_jobs WHERE id = $1 FOR UPDATE',
    [id],
  );
  if (!rows[0]) throw new JobError(404, 'NOT_FOUND', 'Ricerca non trovata.');
  return rows[0];
}

export async function cancelJob(db: Db, id: string, userId: string): Promise<void> {
  await db.transaction(async (tx) => {
    const job = await lockJob(tx, id);
    if (job.status === 'running') {
      // il processo che la esegue si ferma alla prossima verifica (pochi secondi) e interrompe la richiesta in corso
      await tx.query('UPDATE discovery_jobs SET cancel_requested = true, updated_at = now() WHERE id = $1', [id]);
    } else if (job.status === 'pending' || job.status === 'paused') {
      await tx.query(
        "UPDATE discovery_jobs SET status = 'cancelled', finished_at = now(), updated_at = now() WHERE id = $1",
        [id],
      );
      await addMessages(tx, id, [message('info', 'Ricerca annullata.')]);
    } else throw new JobError(409, 'INVALID_STATE', 'La ricerca è già terminata.');
    await audit(tx, { userId, action: 'discovery.job_cancelled', entityType: 'discovery_job', entityId: id });
  });
}

export async function pauseJob(db: Db, id: string, userId: string): Promise<void> {
  await db.transaction(async (tx) => {
    const job = await lockJob(tx, id);
    if (job.status === 'running')
      await tx.query('UPDATE discovery_jobs SET pause_requested = true, updated_at = now() WHERE id = $1', [id]);
    else if (job.status === 'pending')
      await tx.query(
        "UPDATE discovery_jobs SET status = 'paused', pause_reason = 'manual', updated_at = now() WHERE id = $1",
        [id],
      );
    else throw new JobError(409, 'INVALID_STATE', 'Si può mettere in pausa solo una ricerca in coda o in corso.');
    await audit(tx, { userId, action: 'discovery.job_paused', entityType: 'discovery_job', entityId: id });
  });
}

/** Ripresa: una ricerca in pausa riparte; una terminata con errori ripete solo le unità non riuscite. */
export async function resumeJob(db: Db, id: string, userId: string, providerConfigured: boolean): Promise<void> {
  if (!providerConfigured)
    throw new JobError(
      503,
      'PROVIDER_NOT_CONFIGURED',
      'Nessun server OpenStreetMap configurato: impossibile riprendere.',
    );
  await db.transaction(async (tx) => {
    const job = await lockJob(tx, id);
    if (job.status === 'completed_with_warnings' || job.status === 'failed') {
      const { rows } = await tx.query(
        "UPDATE discovery_job_units SET status = 'pending', error = NULL WHERE job_id = $1 AND status = 'failed' RETURNING seq",
        [id],
      );
      if (!rows.length) throw new JobError(409, 'NOTHING_TO_RESUME', 'Non ci sono parti non riuscite da ripetere.');
    } else if (job.status !== 'paused')
      throw new JobError(409, 'INVALID_STATE', 'Si può riprendere solo una ricerca in pausa o con errori.');
    const { rows: units } = await tx.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM discovery_job_units WHERE job_id = $1 AND status = 'done'",
      [id],
    );
    try {
      await tx.query(
        `UPDATE discovery_jobs SET status = 'pending', pause_requested = false, cancel_requested = false, pause_reason = NULL,
                finished_at = NULL, units_done = $2, updated_at = now() WHERE id = $1`,
        [id, units[0]!.n],
      );
    } catch (error) {
      if ((error as { code?: string }).code === '23505')
        throw new JobError(409, 'DUPLICATE_JOB', 'Una ricerca identica è già attiva.');
      throw error;
    }
    await addMessages(tx, id, [message('info', 'Ricerca ripresa.')]);
    await audit(tx, { userId, action: 'discovery.job_resumed', entityType: 'discovery_job', entityId: id });
  });
}

/**
 * Ricerche "in corso" il cui processo non dà più segni di vita (server riavviato o terminato): passano in pausa
 * per interruzione, pronte per essere riprese. La parte in corso torna da eseguire.
 */
export async function recoverInterrupted(db: Db, staleAfterMs: number, workerId: string): Promise<string[]> {
  return db.transaction(async (tx) => {
    const { rows } = await tx.query<{ id: string }>(
      `UPDATE discovery_jobs SET status = 'paused', pause_reason = 'interrupted', worker_id = NULL, updated_at = now()
        WHERE status = 'running' AND (worker_id IS DISTINCT FROM $1)
          AND (heartbeat_at IS NULL OR heartbeat_at < now() - make_interval(secs => $2))
        RETURNING id`,
      [workerId, staleAfterMs / 1000],
    );
    for (const { id } of rows) {
      await tx.query("UPDATE discovery_job_units SET status = 'pending' WHERE job_id = $1 AND status = 'running'", [
        id,
      ]);
      await addMessages(tx, id, [
        message(
          'warning',
          'Ricerca interrotta (server riavviato o arrestato): puoi riprenderla da dove si era fermata.',
        ),
      ]);
    }
    return rows.map((r) => r.id);
  });
}

export { jobMessage };
