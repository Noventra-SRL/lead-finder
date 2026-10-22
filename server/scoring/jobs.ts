import { randomUUID } from 'node:crypto';
import { audit } from '../audit.ts';
import type { Db, Queryable } from '../db/client.ts';
import { JobError } from '../discovery/jobs.ts';
import type { Logger } from '../logger.ts';
import { SCORING_BATCH_SIZE, scoreBusinesses } from './store.ts';

/*
 * Ricalcoli in blocco: righe di scoring_jobs elaborate in background dallo stesso processo dell'API, a lotti
 * ordinati per id dell'azienda. Il cursore (ultimo id elaborato) è salvato a ogni lotto: un job interrotto da un
 * riavvio riprende da lì. Le aziende con dati invariati non generano istantanee nuove (salvo "force").
 */

export type ScoringScope =
  { kind: 'all' } | { kind: 'businesses'; ids: string[] } | { kind: 'discovery_job'; jobId: string };

export const MAX_SCOPE_IDS = 5000;

function scopeWhere(scope: ScoringScope, params: unknown[]): string {
  if (scope.kind === 'businesses') {
    params.push(scope.ids);
    return `b.id = ANY($${params.length})`;
  }
  if (scope.kind === 'discovery_job') {
    params.push(scope.jobId);
    return `EXISTS (SELECT 1 FROM business_sources s WHERE s.business_id = b.id AND s.last_job_id = $${params.length})`;
  }
  return 'true';
}

export async function createScoringJob(
  db: Db,
  req: { scope: ScoringScope; force?: boolean; trigger: 'manual' | 'discovery' | 'bulk' },
  userId: string | null,
): Promise<string> {
  if (req.scope.kind === 'businesses' && (req.scope.ids.length === 0 || req.scope.ids.length > MAX_SCOPE_IDS))
    throw new JobError(400, 'INVALID_SCOPE', `Indica da 1 a ${MAX_SCOPE_IDS} aziende.`);
  return db.transaction(async (tx) => {
    if (req.scope.kind === 'all') {
      const { rows } = await tx.query<{ id: string }>(
        "SELECT id FROM scoring_jobs WHERE status IN ('pending', 'running') AND scope->>'kind' = 'all' LIMIT 1",
      );
      if (rows[0])
        throw new JobError(409, 'DUPLICATE_JOB', 'Un ricalcolo di tutti i punteggi è già in corso.', rows[0].id);
    }
    const params: unknown[] = [];
    const where = scopeWhere(req.scope, params);
    const { rows: total } = await tx.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM businesses b WHERE b.merged_into IS NULL AND ${where}`,
      params,
    );
    const { rows } = await tx.query<{ id: string }>(
      'INSERT INTO scoring_jobs (created_by, scope, force, trigger, total) VALUES ($1, $2, $3, $4, $5) RETURNING id',
      [userId, JSON.stringify(req.scope), req.force ?? false, req.trigger, total[0]!.n],
    );
    if (userId)
      await audit(tx, {
        userId,
        action: 'scoring.job_created',
        entityType: 'scoring_job',
        entityId: rows[0]!.id,
        details: { scope: req.scope.kind, businesses: total[0]!.n, force: req.force ?? false },
      });
    return rows[0]!.id;
  });
}

export async function cancelScoringJob(db: Db, id: string, userId: string) {
  await db.transaction(async (tx) => {
    const { rows } = await tx.query<{ status: string }>('SELECT status FROM scoring_jobs WHERE id = $1 FOR UPDATE', [
      id,
    ]);
    if (!rows[0]) throw new JobError(404, 'NOT_FOUND', 'Ricalcolo non trovato.');
    if (rows[0].status === 'pending')
      await tx.query("UPDATE scoring_jobs SET status = 'cancelled', finished_at = now() WHERE id = $1", [id]);
    else if (rows[0].status === 'running')
      await tx.query('UPDATE scoring_jobs SET cancel_requested = true WHERE id = $1', [id]);
    else throw new JobError(409, 'INVALID_STATE', 'Il ricalcolo è già terminato.');
    await audit(tx, { userId, action: 'scoring.job_cancelled', entityType: 'scoring_job', entityId: id });
  });
}

interface JobRow {
  id: string;
  status: string;
  scope: ScoringScope;
  force: boolean;
  trigger: 'manual' | 'discovery' | 'bulk';
  cursor: string | null;
  total: number;
  processed: number;
  created_count: number;
  unchanged_count: number;
  matches_created: number;
  error: string | null;
  cancel_requested: boolean;
  created_at: Date;
  started_at: Date | null;
  finished_at: Date | null;
  created_by_name?: string | null;
}

const iso = (d: Date | null) => (d ? new Date(d).toISOString() : null);

export const scoringJobDto = (j: JobRow) => ({
  id: j.id,
  status: j.status,
  scope: j.scope.kind,
  force: j.force,
  trigger: j.trigger,
  progress: {
    total: j.total,
    processed: j.processed,
    created: j.created_count,
    unchanged: j.unchanged_count,
    matchesCreated: j.matches_created,
  },
  error: j.error,
  cancelRequested: j.cancel_requested,
  createdAt: iso(j.created_at),
  startedAt: iso(j.started_at),
  finishedAt: iso(j.finished_at),
  createdBy: j.created_by_name ?? null,
});

const JOB_SELECT =
  'SELECT j.*, u.display_name AS created_by_name FROM scoring_jobs j LEFT JOIN users u ON u.id = j.created_by';

export async function getScoringJob(db: Queryable, id: string) {
  const { rows } = await db.query<JobRow>(`${JOB_SELECT} WHERE j.id = $1`, [id]);
  if (!rows[0]) throw new JobError(404, 'NOT_FOUND', 'Ricalcolo non trovato.');
  return scoringJobDto(rows[0]);
}

export async function listScoringJobs(db: Queryable, limit = 10) {
  const { rows } = await db.query<JobRow>(`${JOB_SELECT} ORDER BY j.created_at DESC, j.id LIMIT $1`, [limit]);
  return rows.map(scoringJobDto);
}

export class ScoringWorker {
  readonly id = `${process.pid}-${randomUUID().slice(0, 8)}`;
  private readonly db: Db;
  private readonly log: Logger;
  private readonly pollMs: number;
  private readonly staleAfterMs: number;
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<void> | null = null;
  private stopping = false;

  constructor(db: Db, opts: { log: Logger; pollMs?: number; staleAfterMs?: number }) {
    this.db = db;
    this.log = opts.log.child({ component: 'scoring' });
    this.pollMs = opts.pollMs ?? 3000;
    this.staleAfterMs = opts.staleAfterMs ?? 60_000;
  }

  start() {
    this.schedule(0);
  }

  wake() {
    if (!this.stopping && !this.running) this.schedule(0);
  }

  async stop() {
    this.stopping = true;
    if (this.timer) clearTimeout(this.timer);
    await this.running;
  }

  private schedule(ms: number) {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      this.running = this.loop().finally(() => {
        this.running = null;
        if (!this.stopping) this.schedule(this.pollMs);
      });
    }, ms);
    this.timer.unref();
  }

  private async loop() {
    try {
      while (!this.stopping && (await this.runOnce()));
    } catch (error) {
      this.log.error('errore del ciclo dei punteggi', { error });
    }
  }

  /** Esegue al massimo un job; false se non ce n'erano. */
  async runOnce(): Promise<boolean> {
    // job "in corso" di un processo che non dà più segni di vita: torna in coda e riprende dal cursore salvato
    await this.db.query(
      `UPDATE scoring_jobs SET status = 'pending', worker_id = NULL
        WHERE status = 'running' AND worker_id IS DISTINCT FROM $1
          AND (heartbeat_at IS NULL OR heartbeat_at < now() - make_interval(secs => $2))`,
      [this.id, this.staleAfterMs / 1000],
    );
    const { rows } = await this.db.query<JobRow>(
      `UPDATE scoring_jobs SET status = 'running', worker_id = $1, heartbeat_at = now(), started_at = COALESCE(started_at, now())
        WHERE id = (SELECT id FROM scoring_jobs WHERE status = 'pending' ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED)
        RETURNING *`,
      [this.id],
    );
    const job = rows[0];
    if (!job) return false;
    try {
      await this.runJob(job);
    } catch (error) {
      this.log.error('ricalcolo dei punteggi non riuscito', { jobId: job.id, error });
      await this.db.query(
        "UPDATE scoring_jobs SET status = 'failed', error = $2, worker_id = NULL, finished_at = now() WHERE id = $1",
        [job.id, 'Errore interno durante il calcolo: riprova.'],
      );
    }
    return true;
  }

  private async runJob(job: JobRow) {
    let cursor = job.cursor;
    for (;;) {
      const { rows: flags } = await this.db.query<{ cancel_requested: boolean }>(
        'SELECT cancel_requested FROM scoring_jobs WHERE id = $1',
        [job.id],
      );
      if (flags[0]?.cancel_requested) {
        await this.db.query(
          "UPDATE scoring_jobs SET status = 'cancelled', worker_id = NULL, finished_at = now() WHERE id = $1",
          [job.id],
        );
        return;
      }
      if (this.stopping) {
        // arresto del server: il job torna in coda e riparte dal cursore
        await this.db.query("UPDATE scoring_jobs SET status = 'pending', worker_id = NULL WHERE id = $1", [job.id]);
        return;
      }
      const params: unknown[] = [];
      const where = scopeWhere(job.scope, params);
      params.push(cursor, SCORING_BATCH_SIZE);
      const { rows } = await this.db.query<{ id: string }>(
        `SELECT b.id FROM businesses b WHERE b.merged_into IS NULL AND ${where}
            AND ($${params.length - 1}::uuid IS NULL OR b.id > $${params.length - 1}::uuid)
          ORDER BY b.id LIMIT $${params.length}`,
        params,
      );
      if (!rows.length) {
        await this.db.query(
          "UPDATE scoring_jobs SET status = 'completed', worker_id = NULL, finished_at = now() WHERE id = $1",
          [job.id],
        );
        this.log.info('ricalcolo dei punteggi terminato', { jobId: job.id });
        return;
      }
      const ids = rows.map((r) => r.id);
      const r = await scoreBusinesses(this.db, ids, {
        trigger: job.trigger === 'discovery' ? 'discovery' : 'bulk',
        force: job.force,
      });
      cursor = ids.at(-1)!;
      await this.db.query(
        `UPDATE scoring_jobs SET cursor = $2, processed = processed + $3, created_count = created_count + $4,
                unchanged_count = unchanged_count + $5, matches_created = matches_created + $6, heartbeat_at = now() WHERE id = $1`,
        [job.id, cursor, ids.length, r.created, r.unchanged, r.matchesCreated],
      );
    }
  }
}
