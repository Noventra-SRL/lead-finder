import { randomUUID } from 'node:crypto';
import { audit } from '../audit.ts';
import type { AiConfig } from '../config.ts';
import type { Db, Queryable } from '../db/client.ts';
import { JobError } from '../discovery/jobs.ts';
import { appendMessages, jobMessage } from '../jobs/messages.ts';
import type { Logger } from '../logger.ts';
import { assessBusiness } from './assess.ts';
import type { AiProvider } from './provider.ts';

/*
 * Valutazioni AI in blocco: avviate solo da una persona su un elenco esplicito (al massimo 500 aziende), mai
 * sull'intero database. Un elemento per azienda: dopo un riavvio si riprende dagli elementi non completati.
 * Concorrenza limitata (AI_CONCURRENCY), pausa e annullamento tra un gruppo e l'altro, costi sommati dai token reali.
 */

export const MAX_JOB_SIZE = 500;
const ACTIVE = ['pending', 'running', 'paused'];

export async function createAiJob(
  db: Db,
  input: { businessIds: string[]; force: boolean; estimatedCostUsd: number | null },
  userId: string,
): Promise<string> {
  const ids = [...new Set(input.businessIds)];
  if (ids.length === 0 || ids.length > MAX_JOB_SIZE)
    throw new JobError(400, 'INVALID_SIZE', `Seleziona da 1 a ${MAX_JOB_SIZE} aziende.`);
  return db.transaction(async (tx) => {
    const { rows: active } = await tx.query<{ id: string }>('SELECT id FROM ai_jobs WHERE status = ANY($1) LIMIT 1', [
      ACTIVE,
    ]);
    if (active[0])
      throw new JobError(
        409,
        'AI_JOB_ACTIVE',
        'Una valutazione in blocco è già in corso: attendi o annullala.',
        active[0].id,
      );
    const { rows: known } = await tx.query<{ id: string }>('SELECT id FROM businesses WHERE id = ANY($1)', [ids]);
    const existing = new Set(known.map((r) => r.id));
    const valid = ids.filter((id) => existing.has(id));
    if (!valid.length) throw new JobError(404, 'NOT_FOUND', 'Nessuna delle aziende indicate esiste.');
    const { rows } = await tx.query<{ id: string }>(
      `INSERT INTO ai_jobs (created_by, force, total, estimated_cost_usd, messages) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [
        userId,
        input.force,
        valid.length,
        input.estimatedCostUsd,
        JSON.stringify([
          jobMessage(
            'info',
            `Valutazione di ${valid.length} aziende${input.force ? ' (anche quelle già valutate)' : ''}${
              ids.length > valid.length ? `; ${ids.length - valid.length} non trovate` : ''
            }.`,
          ),
        ]),
      ],
    );
    const id = rows[0]!.id;
    for (const [seq, businessId] of valid.entries())
      await tx.query('INSERT INTO ai_job_items (job_id, seq, business_id) VALUES ($1, $2, $3)', [id, seq, businessId]);
    await audit(tx, {
      userId,
      action: 'ai.job_created',
      entityType: 'ai_job',
      entityId: id,
      details: { total: valid.length, force: input.force },
    });
    return id;
  });
}

export async function controlAiJob(db: Db, id: string, action: 'pause' | 'resume' | 'cancel', userId: string) {
  await db.transaction(async (tx) => {
    const { rows } = await tx.query<{ status: string }>('SELECT status FROM ai_jobs WHERE id = $1 FOR UPDATE', [id]);
    const status = rows[0]?.status;
    if (!status) throw new JobError(404, 'NOT_FOUND', 'Valutazione in blocco non trovata.');
    if (!ACTIVE.includes(status)) throw new JobError(409, 'INVALID_STATE', 'La valutazione in blocco è già terminata.');
    if (action === 'pause') {
      if (status === 'paused') throw new JobError(409, 'INVALID_STATE', 'Già in pausa.');
      await tx.query(
        "UPDATE ai_jobs SET pause_requested = true, status = CASE WHEN status = 'pending' THEN 'paused' ELSE status END, pause_reason = 'manual', updated_at = now() WHERE id = $1",
        [id],
      );
    } else if (action === 'resume') {
      if (status !== 'paused') throw new JobError(409, 'INVALID_STATE', 'Non è in pausa.');
      await tx.query(
        "UPDATE ai_jobs SET status = 'pending', pause_requested = false, pause_reason = NULL, updated_at = now() WHERE id = $1",
        [id],
      );
    } else {
      await tx.query(
        `UPDATE ai_jobs SET cancel_requested = true,
                status = CASE WHEN status IN ('pending', 'paused') THEN 'cancelled' ELSE status END,
                finished_at = CASE WHEN status IN ('pending', 'paused') THEN now() ELSE finished_at END, updated_at = now() WHERE id = $1`,
        [id],
      );
    }
    await appendMessages(tx, 'ai_jobs', id, [
      jobMessage(
        'info',
        action === 'pause' ? 'Pausa richiesta.' : action === 'resume' ? 'Ripresa.' : 'Annullamento richiesto.',
      ),
    ]);
    await audit(tx, {
      userId,
      action: action === 'pause' ? 'ai.job_paused' : action === 'resume' ? 'ai.job_resumed' : 'ai.job_cancelled',
      entityType: 'ai_job',
      entityId: id,
    });
  });
}

const COUNTS = `(SELECT json_build_object(
   'pending', count(*) FILTER (WHERE i.status IN ('pending', 'running')),
   'assessed', count(*) FILTER (WHERE i.status = 'assessed'),
   'cached', count(*) FILTER (WHERE i.status = 'cached'),
   'skipped', count(*) FILTER (WHERE i.status = 'skipped'),
   'failed', count(*) FILTER (WHERE i.status = 'failed')) FROM ai_job_items i WHERE i.job_id = j.id) AS counts,
 (SELECT json_build_object('inputTokens', sum(a.input_tokens), 'outputTokens', sum(a.output_tokens), 'costUsd', sum(a.cost_usd))
    FROM ai_job_items i JOIN ai_assessments a ON a.id = i.assessment_id WHERE i.job_id = j.id AND i.status <> 'cached') AS usage`;

interface JobRow {
  id: string;
  status: string;
  force: boolean;
  total: number;
  estimated_cost_usd: string | null;
  messages: { at: string; level: string; message: string }[];
  pause_requested: boolean;
  cancel_requested: boolean;
  pause_reason: string | null;
  created_by_name: string | null;
  created_at: Date;
  started_at: Date | null;
  finished_at: Date | null;
  counts: Record<'pending' | 'assessed' | 'cached' | 'skipped' | 'failed', number>;
  usage: { inputTokens: number | null; outputTokens: number | null; costUsd: string | number | null };
}

const jobOut = (j: JobRow) => ({
  id: j.id,
  status: j.status,
  force: j.force,
  total: j.total,
  estimatedCostUsd: j.estimated_cost_usd === null ? null : Number(j.estimated_cost_usd),
  messages: j.messages,
  pauseRequested: j.pause_requested,
  cancelRequested: j.cancel_requested,
  pauseReason: j.pause_reason,
  createdBy: j.created_by_name,
  createdAt: new Date(j.created_at).toISOString(),
  startedAt: j.started_at ? new Date(j.started_at).toISOString() : null,
  finishedAt: j.finished_at ? new Date(j.finished_at).toISOString() : null,
  counts: j.counts,
  usage: {
    inputTokens: j.usage.inputTokens === null ? null : Number(j.usage.inputTokens),
    outputTokens: j.usage.outputTokens === null ? null : Number(j.usage.outputTokens),
    costUsd: j.usage.costUsd === null ? null : Number(j.usage.costUsd),
  },
});

const JOB_SELECT = `SELECT j.*, u.display_name AS created_by_name, ${COUNTS} FROM ai_jobs j LEFT JOIN users u ON u.id = j.created_by`;

export async function listAiJobs(db: Queryable, page: number, pageSize: number) {
  const { rows: total } = await db.query<{ n: number }>('SELECT count(*)::int AS n FROM ai_jobs');
  const { rows } = await db.query<JobRow>(`${JOB_SELECT} ORDER BY j.created_at DESC LIMIT $1 OFFSET $2`, [
    pageSize,
    (page - 1) * pageSize,
  ]);
  return { items: rows.map(jobOut), total: total[0]!.n, page, pageSize };
}

export async function getAiJob(db: Queryable, id: string) {
  const { rows } = await db.query<JobRow>(`${JOB_SELECT} WHERE j.id = $1`, [id]);
  if (!rows[0]) throw new JobError(404, 'NOT_FOUND', 'Valutazione in blocco non trovata.');
  const { rows: items } = await db.query<{
    seq: number;
    business_id: string;
    name: string;
    status: string;
    error: string | null;
    score: number | null;
  }>(
    `SELECT i.seq, i.business_id, b.name, i.status, i.error, a.final_score AS score FROM ai_job_items i
       JOIN businesses b ON b.id = i.business_id LEFT JOIN ai_assessments a ON a.id = i.assessment_id
      WHERE i.job_id = $1 ORDER BY i.seq LIMIT 500`,
    [id],
  );
  return {
    job: jobOut(rows[0]),
    items: items.map((i) => ({
      seq: i.seq,
      businessId: i.business_id,
      name: i.name,
      status: i.status,
      error: i.error,
      score: i.score,
    })),
  };
}

/** Esecutore delle valutazioni in blocco in questo processo (AI_WORKER=on). */
export class AiWorker {
  readonly id = `${process.pid}-${randomUUID().slice(0, 8)}`;
  private readonly db: Db;
  private readonly provider: AiProvider | null;
  private readonly config: AiConfig;
  private readonly log: Logger;
  private readonly staleAfterMs: number;
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<void> | null = null;
  private stopping = false;
  private controller = new AbortController();

  constructor(db: Db, deps: { provider: AiProvider | null; config: AiConfig; log: Logger; staleAfterMs?: number }) {
    this.db = db;
    this.provider = deps.provider;
    this.config = deps.config;
    this.log = deps.log.child({ component: 'ai-worker' });
    this.staleAfterMs = deps.staleAfterMs ?? 120_000;
  }

  start(pollMs = 3000) {
    this.timer = setInterval(() => this.wake(), pollMs);
    this.wake();
  }

  wake() {
    if (this.running || this.stopping) return;
    this.running = this.tick()
      .then(() => undefined)
      .catch((error) => this.log.error('valutazione in blocco non riuscita', { error }))
      .finally(() => {
        this.running = null;
      });
  }

  async stop() {
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
    this.controller.abort();
    await this.running;
  }

  /** Riprende i lavori rimasti "in corso" da un processo fermato, poi esegue il primo in coda fino alla fine. */
  async tick(): Promise<boolean> {
    await this.db.query(
      `UPDATE ai_jobs SET status = 'pending', worker_id = NULL
        WHERE status = 'running' AND (heartbeat_at IS NULL OR heartbeat_at < now() - make_interval(secs => $1))`,
      [this.staleAfterMs / 1000],
    );
    const job = await this.db.transaction(async (tx) => {
      const { rows } = await tx.query<{ id: string; force: boolean; created_by: string | null }>(
        "SELECT id, force, created_by FROM ai_jobs WHERE status = 'pending' ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED",
      );
      if (!rows[0]) return null;
      await tx.query(
        "UPDATE ai_jobs SET status = 'running', worker_id = $2, heartbeat_at = now(), started_at = COALESCE(started_at, now()), updated_at = now() WHERE id = $1",
        [rows[0].id, this.id],
      );
      // elementi rimasti "in corso" da un'interruzione: tornano da fare
      await tx.query("UPDATE ai_job_items SET status = 'pending' WHERE job_id = $1 AND status = 'running'", [
        rows[0].id,
      ]);
      return rows[0];
    });
    if (!job) return false;
    await this.run(job);
    return true;
  }

  private async run(job: { id: string; force: boolean; created_by: string | null }) {
    if (!this.provider) {
      await this.db.query(
        "UPDATE ai_jobs SET status = 'paused', pause_reason = 'not_configured', worker_id = NULL, updated_at = now() WHERE id = $1",
        [job.id],
      );
      await appendMessages(this.db, 'ai_jobs', job.id, [
        jobMessage(
          'error',
          'Valutazione AI non configurata (AI_API_KEY): il lavoro resta in pausa finché non viene configurata.',
        ),
      ]);
      return;
    }
    for (;;) {
      const { rows: state } = await this.db.query<{ pause_requested: boolean; cancel_requested: boolean }>(
        'UPDATE ai_jobs SET heartbeat_at = now() WHERE id = $1 RETURNING pause_requested, cancel_requested',
        [job.id],
      );
      if (state[0]?.cancel_requested)
        return this.finish(job.id, 'cancelled', 'Annullata: gli elementi non ancora valutati restano da fare.');
      if (state[0]?.pause_requested || this.stopping) {
        await this.db.query(
          `UPDATE ai_jobs SET status = 'paused', pause_requested = false, pause_reason = $2, worker_id = NULL, updated_at = now() WHERE id = $1`,
          [job.id, this.stopping ? 'interrupted' : 'manual'],
        );
        if (!this.stopping) await appendMessages(this.db, 'ai_jobs', job.id, [jobMessage('info', 'In pausa.')]);
        return;
      }
      const { rows: items } = await this.db.query<{ seq: number; business_id: string }>(
        "UPDATE ai_job_items SET status = 'running', attempts = attempts + 1 WHERE (job_id, seq) IN (SELECT job_id, seq FROM ai_job_items WHERE job_id = $1 AND status = 'pending' ORDER BY seq LIMIT $2) RETURNING seq, business_id",
        [job.id, this.config.concurrency],
      );
      if (!items.length) break;
      await Promise.all(
        items.map(async (item) => {
          let status = 'failed';
          let assessmentId: string | null = null;
          let error: string | null = null;
          try {
            const r = await assessBusiness(this.db, this.provider, this.config, item.business_id, {
              trigger: 'batch',
              userId: job.created_by,
              force: job.force,
              signal: this.controller.signal,
            });
            if (r.status === 'skipped') {
              status = 'skipped';
              error =
                r.reason === 'merged'
                  ? 'Azienda unita a un’altra'
                  : r.reason === 'busy'
                    ? 'Già in valutazione (automatica o di un altro lotto): il risultato arriverà da lì'
                    : 'Azienda non trovata';
            } else {
              status = r.status === 'failed' ? 'failed' : r.status;
              assessmentId = r.assessmentId;
              if (r.status === 'failed') error = r.message;
            }
          } catch (e) {
            error = e instanceof Error ? e.message.slice(0, 300) : 'Errore imprevisto';
            this.log.warn('valutazione di un’azienda non riuscita', { error: e, businessId: item.business_id });
          }
          await this.db.query(
            'UPDATE ai_job_items SET status = $3, assessment_id = $4, error = $5, finished_at = now() WHERE job_id = $1 AND seq = $2',
            [job.id, item.seq, status, assessmentId, error],
          );
        }),
      );
    }
    const { rows: c } = await this.db.query<{ failed: number; done: number }>(
      "SELECT count(*) FILTER (WHERE status = 'failed')::int AS failed, count(*) FILTER (WHERE status IN ('assessed', 'cached'))::int AS done FROM ai_job_items WHERE job_id = $1",
      [job.id],
    );
    const { failed, done } = c[0]!;
    await this.finish(
      job.id,
      failed && !done ? 'failed' : failed ? 'completed_with_warnings' : 'completed',
      `Completata: ${done} valutate o riusate, ${failed} non riuscite.`,
    );
  }

  private async finish(id: string, status: string, message: string) {
    await this.db.transaction(async (tx) => {
      await tx.query(
        'UPDATE ai_jobs SET status = $2, finished_at = now(), worker_id = NULL, cancel_requested = false, pause_requested = false, updated_at = now() WHERE id = $1',
        [id, status],
      );
      await appendMessages(tx, 'ai_jobs', id, [
        jobMessage(status === 'failed' ? 'error' : status === 'completed' ? 'info' : 'warning', message),
      ]);
    });
  }
}
