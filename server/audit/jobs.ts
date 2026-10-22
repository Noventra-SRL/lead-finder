import { audit } from '../audit.ts';
import type { AuditConfig } from '../config.ts';
import type { Db, Queryable } from '../db/client.ts';
import { JobError } from '../discovery/jobs.ts';
import { appendMessages, jobMessage } from '../jobs/messages.ts';
import { configKey, type AuditSettings } from './engine.ts';
import type { FetchPolicy } from './net/safeFetch.ts';

/*
 * Job di audit: un elenco di aziende da analizzare con una configurazione. Stessa macchina a stati dei job di scoperta:
 * pending → running → completed | completed_with_warnings | failed | cancelled; paused (manuale o per interruzione).
 * Un'azienda già in coda con la stessa configurazione non viene accodata di nuovo (vincolo nel database).
 */

export const MAX_ACTIVE_AUDIT_JOBS_PER_USER = 3;

export interface AuditJobRequest {
  businessIds: string[];
  maxPages?: number;
  performance?: boolean;
  /** Ripetere anche se esiste un audit recente con la stessa configurazione. */
  force?: boolean;
}

/** Impostazioni effettive del job, entro i limiti configurati sul server. */
export function settingsFor(req: AuditJobRequest, config: AuditConfig): AuditSettings {
  const maxPages = Math.min(req.maxPages ?? config.defaultPages, config.maxPages);
  return {
    maxPages,
    strategies: config.pagespeedStrategies,
    usePerformance: (req.performance ?? true) && config.pagespeedEnabled,
  };
}

export function policyFor(config: AuditConfig, version: string): FetchPolicy {
  return {
    allowedPorts: config.allowedPorts,
    connectTimeoutMs: config.connectTimeoutMs,
    totalTimeoutMs: config.requestTimeoutMs,
    maxBytes: config.maxResponseBytes,
    maxRedirects: config.maxRedirects,
    userAgent: `NoventraLeadFinder-Audit/${version} (+${config.contact ?? 'https://www.noventra.it'})`,
    testLoopbackPorts: config.testLoopbackPorts.length ? config.testLoopbackPorts : undefined,
  };
}

export async function createAuditJob(
  db: Db,
  req: AuditJobRequest,
  ctx: {
    userId: string;
    config: AuditConfig;
    policy: FetchPolicy;
    /** Verifica creata da una ricerca di lead (Fase 6): collegata alla ricerca, fuori dal limite per utente. */
    huntRunId?: string;
  },
): Promise<{ jobId: string; queued: number; alreadyQueued: number }> {
  const ids = [...new Set(req.businessIds)];
  if (!ids.length) throw new JobError(400, 'NO_BUSINESSES', 'Seleziona almeno un’azienda.');
  if (ids.length > ctx.config.maxBusinessesPerJob)
    throw new JobError(
      400,
      'TOO_MANY_BUSINESSES',
      `Al massimo ${ctx.config.maxBusinessesPerJob} aziende per verifica.`,
    );
  const settings = settingsFor(req, ctx.config);
  const key = configKey(settings, ctx.policy);

  return db.transaction(async (tx) => {
    const { rows: active } = await tx.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM audit_jobs WHERE created_by = $1 AND status IN ('pending', 'running', 'paused')",
      [ctx.userId],
    );
    if (!ctx.huntRunId && active[0]!.n >= MAX_ACTIVE_AUDIT_JOBS_PER_USER)
      throw new JobError(
        429,
        'TOO_MANY_ACTIVE_JOBS',
        `Hai già ${MAX_ACTIVE_AUDIT_JOBS_PER_USER} verifiche attive: attendi che finiscano o annullane una.`,
      );
    const { rows: existing } = await tx.query<{ id: string }>(
      'SELECT id FROM businesses WHERE id = ANY($1) AND merged_into IS NULL',
      [ids],
    );
    const valid = new Set(existing.map((r) => r.id));
    const missing = ids.filter((id) => !valid.has(id));
    if (missing.length)
      throw new JobError(
        404,
        'UNKNOWN_BUSINESS',
        `${missing.length === 1 ? 'Un’azienda selezionata non esiste' : `${missing.length} aziende selezionate non esistono`} o è stata unita a un’altra.`,
      );
    // aziende già in coda con la stessa configurazione (in un altro job attivo)
    const { rows: queued } = await tx.query<{ business_id: string; job_id: string }>(
      "SELECT business_id, job_id FROM audit_job_items WHERE business_id = ANY($1) AND config_key = $2 AND status IN ('pending', 'running')",
      [ids, key],
    );
    const busy = new Set(queued.map((r) => r.business_id));
    const toQueue = ids.filter((id) => !busy.has(id));
    if (!toQueue.length)
      throw new JobError(
        409,
        'DUPLICATE_JOB',
        'Le aziende selezionate sono già in verifica con la stessa configurazione.',
        queued[0]?.job_id,
      );

    const { rows } = await tx.query<{ id: string }>(
      `INSERT INTO audit_jobs (created_by, settings, config_key, force, items_total, messages, hunt_run_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
      [
        ctx.userId,
        JSON.stringify(settings),
        key,
        req.force ?? false,
        toQueue.length,
        JSON.stringify([
          jobMessage(
            'info',
            `Verifica di ${toQueue.length} ${toQueue.length === 1 ? 'azienda' : 'aziende'}: fino a ${settings.maxPages} ${settings.maxPages === 1 ? 'pagina' : 'pagine'} per sito, prestazioni ${settings.usePerformance ? 'incluse' : 'non misurate'}.` +
              (busy.size ? ` ${busy.size} già in verifica altrove, non ripetute.` : ''),
          ),
        ]),
        ctx.huntRunId ?? null,
      ],
    );
    const jobId = rows[0]!.id;
    for (const [seq, businessId] of toQueue.entries())
      await tx.query('INSERT INTO audit_job_items (job_id, seq, business_id, config_key) VALUES ($1, $2, $3, $4)', [
        jobId,
        seq,
        businessId,
        key,
      ]);
    await audit(tx, {
      userId: ctx.userId,
      action: 'audit.job_created',
      entityType: 'audit_job',
      entityId: jobId,
      details: { businesses: toQueue.length, settings, force: req.force ?? false },
    });
    return { jobId, queued: toQueue.length, alreadyQueued: busy.size };
  });
}

async function lockJob(tx: Queryable, id: string) {
  const { rows } = await tx.query<{ status: string }>('SELECT status FROM audit_jobs WHERE id = $1 FOR UPDATE', [id]);
  if (!rows[0]) throw new JobError(404, 'NOT_FOUND', 'Verifica non trovata.');
  return rows[0].status;
}

export async function cancelAuditJob(db: Db, id: string, userId: string) {
  await db.transaction(async (tx) => {
    const status = await lockJob(tx, id);
    if (status === 'running')
      await tx.query('UPDATE audit_jobs SET cancel_requested = true, updated_at = now() WHERE id = $1', [id]);
    else if (status === 'pending' || status === 'paused') {
      // le aziende non verificate escono dalla coda (e possono essere accodate di nuovo)
      await tx.query(
        "UPDATE audit_job_items SET status = 'cancelled', finished_at = now() WHERE job_id = $1 AND status IN ('pending', 'running')",
        [id],
      );
      await tx.query(
        "UPDATE audit_jobs SET status = 'cancelled', finished_at = now(), updated_at = now() WHERE id = $1",
        [id],
      );
      await appendMessages(tx, 'audit_jobs', id, [jobMessage('info', 'Verifica annullata.')]);
    } else throw new JobError(409, 'INVALID_STATE', 'La verifica è già terminata.');
    await audit(tx, { userId, action: 'audit.job_cancelled', entityType: 'audit_job', entityId: id });
  });
}

export async function pauseAuditJob(db: Db, id: string, userId: string) {
  await db.transaction(async (tx) => {
    const status = await lockJob(tx, id);
    if (status === 'running')
      await tx.query('UPDATE audit_jobs SET pause_requested = true, updated_at = now() WHERE id = $1', [id]);
    else if (status === 'pending')
      await tx.query(
        "UPDATE audit_jobs SET status = 'paused', pause_reason = 'manual', updated_at = now() WHERE id = $1",
        [id],
      );
    else throw new JobError(409, 'INVALID_STATE', 'Si può mettere in pausa solo una verifica in coda o in corso.');
    await audit(tx, { userId, action: 'audit.job_paused', entityType: 'audit_job', entityId: id });
  });
}

/** Ripresa: in pausa → in coda; terminata con errori → ripete solo le aziende non riuscite. */
export async function resumeAuditJob(db: Db, id: string, userId: string) {
  await db.transaction(async (tx) => {
    const status = await lockJob(tx, id);
    if (status === 'completed_with_warnings' || status === 'failed') {
      const { rows } = await tx
        .query(
          "UPDATE audit_job_items SET status = 'pending', error = NULL, finished_at = NULL WHERE job_id = $1 AND status = 'failed' RETURNING seq",
          [id],
        )
        .catch((error) => {
          if ((error as { code?: string }).code === '23505')
            throw new JobError(409, 'DUPLICATE_JOB', 'Alcune aziende sono già in verifica in un’altra richiesta.');
          throw error;
        });
      if (!rows.length) throw new JobError(409, 'NOTHING_TO_RESUME', 'Non ci sono verifiche non riuscite da ripetere.');
      await tx.query(
        'UPDATE audit_jobs SET items_failed = items_failed - $2, items_done = items_done - $2 WHERE id = $1',
        [id, rows.length],
      );
    } else if (status !== 'paused')
      throw new JobError(409, 'INVALID_STATE', 'Si può riprendere solo una verifica in pausa o con errori.');
    await tx.query(
      `UPDATE audit_jobs SET status = 'pending', pause_requested = false, cancel_requested = false, pause_reason = NULL, finished_at = NULL, updated_at = now()
        WHERE id = $1`,
      [id],
    );
    await appendMessages(tx, 'audit_jobs', id, [jobMessage('info', 'Verifica ripresa.')]);
    await audit(tx, { userId, action: 'audit.job_resumed', entityType: 'audit_job', entityId: id });
  });
}

/** Verifiche "in corso" il cui processo non dà più segni di vita: in pausa per interruzione, riprendibili. */
export async function recoverInterruptedAudits(db: Db, staleAfterMs: number, workerId: string): Promise<string[]> {
  return db.transaction(async (tx) => {
    const { rows } = await tx.query<{ id: string }>(
      `UPDATE audit_jobs SET status = 'paused', pause_reason = 'interrupted', worker_id = NULL, updated_at = now()
        WHERE status = 'running' AND (worker_id IS DISTINCT FROM $1)
          AND (heartbeat_at IS NULL OR heartbeat_at < now() - make_interval(secs => $2))
        RETURNING id`,
      [workerId, staleAfterMs / 1000],
    );
    for (const { id } of rows) {
      await tx.query("UPDATE audit_job_items SET status = 'pending' WHERE job_id = $1 AND status = 'running'", [id]);
      await appendMessages(tx, 'audit_jobs', id, [
        jobMessage('warning', 'Verifica interrotta (server riavviato o arrestato): puoi riprenderla.'),
      ]);
    }
    return rows.map((r) => r.id);
  });
}
