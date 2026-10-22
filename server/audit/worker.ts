import { randomUUID } from 'node:crypto';
import type { AuditConfig } from '../config.ts';
import type { Db } from '../db/client.ts';
import type { CategoryId } from '../discovery/categories.ts';
import { appendMessages, jobMessage } from '../jobs/messages.ts';
import type { Logger } from '../logger.ts';
import { HostScheduler, runAudit, type AuditSettings } from './engine.ts';
import { recoverInterruptedAudits } from './jobs.ts';
import { FetchError, type FetchPolicy } from './net/safeFetch.ts';
import type { PerformanceProvider } from './performance/pagespeed.ts';
import { linkWebsite, recentAudit, saveAudit, saveFailedAudit } from './store.ts';

/*
 * Esecuzione dei job di audit nel processo dell'API (stessa architettura del worker della scoperta):
 * un job alla volta, preso con FOR UPDATE SKIP LOCKED e segnalato con un battito; all'interno del job fino a
 * AUDIT_CONCURRENCY aziende in parallelo, mai due volte lo stesso sito contemporaneamente.
 * Per ogni azienda: collegamento al sito → (audit recente? si riusa) → audit → salvataggio in una transazione.
 * Un errore interno su un'azienda non ferma il job: l'azienda risulta "non riuscita" e si può ripetere.
 */

interface JobRow {
  id: string;
  settings: AuditSettings;
  config_key: string;
  force: boolean;
}

interface ItemRow {
  seq: number;
  business_id: string;
}

export interface AuditWorkerOptions {
  log: Logger;
  config: AuditConfig;
  policy: FetchPolicy;
  performance: PerformanceProvider | null;
  pollMs?: number;
  heartbeatMs?: number;
  staleAfterMs?: number;
  /** Attese tra i tentativi dell'audit (sostituibile nei test). */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  /** Chiamata dopo ogni azienda elaborata (es. ricalcolo del punteggio delle aziende con quel sito). */
  onItemDone?: (businessId: string) => Promise<void>;
}

export class AuditWorker {
  readonly id = `${process.pid}-${randomUUID().slice(0, 8)}`;
  private readonly db: Db;
  private readonly options: AuditWorkerOptions;
  private readonly log: Logger;
  private readonly hosts = new HostScheduler();
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<void> | null = null;
  private readonly controllers = new Set<AbortController>();
  private stopping = false;

  constructor(db: Db, options: AuditWorkerOptions) {
    this.db = db;
    this.options = options;
    this.log = options.log.child({ component: 'audit' });
  }

  async start() {
    const recovered = await recoverInterruptedAudits(this.db, 0, this.id);
    if (recovered.length) this.log.warn('verifiche interrotte messe in pausa', { jobs: recovered });
    this.schedule(0);
  }

  wake() {
    if (!this.stopping && !this.running) this.schedule(0);
  }

  async stop() {
    this.stopping = true;
    if (this.timer) clearTimeout(this.timer);
    for (const c of this.controllers) c.abort();
    await this.running;
  }

  private schedule(ms: number) {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      this.running = this.loop().finally(() => {
        this.running = null;
        if (!this.stopping) this.schedule(this.options.pollMs ?? 2000);
      });
    }, ms);
    this.timer.unref();
  }

  private async loop() {
    try {
      while (!this.stopping && (await this.runOnce()));
    } catch (error) {
      this.log.error('errore del ciclo di audit', { error });
    }
  }

  /** Esegue al massimo un job; false se non ce n'erano. */
  async runOnce(): Promise<boolean> {
    await recoverInterruptedAudits(this.db, this.options.staleAfterMs ?? 60_000, this.id);
    const { rows } = await this.db.query<JobRow>(
      `UPDATE audit_jobs SET status = 'running', worker_id = $1, heartbeat_at = now(), started_at = COALESCE(started_at, now()), updated_at = now()
        WHERE id = (SELECT id FROM audit_jobs WHERE status = 'pending' ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED)
        RETURNING id, settings, config_key, force`,
      [this.id],
    );
    if (!rows[0]) return false;
    await this.runJob(rows[0]);
    return true;
  }

  private async runJob(job: JobRow) {
    const log = this.log.child({ jobId: job.id });
    log.info('verifica avviata');
    const controller = new AbortController();
    this.controllers.add(controller);
    let flags = { cancel: false, pause: false };
    const beat = setInterval(() => {
      this.db
        .query<{ cancel_requested: boolean; pause_requested: boolean }>(
          'UPDATE audit_jobs SET heartbeat_at = now() WHERE id = $1 AND worker_id = $2 RETURNING cancel_requested, pause_requested',
          [job.id, this.id],
        )
        .then(({ rows }) => {
          if (rows[0]?.cancel_requested || rows[0]?.pause_requested) {
            flags = { cancel: rows[0].cancel_requested, pause: rows[0].pause_requested };
            controller.abort();
          }
        })
        .catch((error) => log.warn('battito non registrato', { error }));
    }, this.options.heartbeatMs ?? 5000);
    beat.unref();

    const inFlightSites = new Map<string, Promise<void>>();
    try {
      const workers = Array.from({ length: this.options.config.concurrency }, async () => {
        for (;;) {
          if (controller.signal.aborted || this.stopping) return;
          // un'azienda alla volta presa dalla coda del job (in transazione: nessun doppione tra i lavoratori)
          const { rows } = await this.db.query<ItemRow>(
            `UPDATE audit_job_items SET status = 'running', attempts = attempts + 1, started_at = now()
              WHERE (job_id, seq) = (SELECT job_id, seq FROM audit_job_items WHERE job_id = $1 AND status = 'pending' ORDER BY seq LIMIT 1 FOR UPDATE SKIP LOCKED)
              RETURNING seq, business_id`,
            [job.id],
          );
          const item = rows[0];
          if (!item) return;
          await this.processItem(job, item, controller.signal, inFlightSites, log);
          // prove nuove (o confermate): aggiorna i punteggi; un errore qui non ferma la verifica
          if (this.options.onItemDone)
            await this.options
              .onItemDone(item.business_id)
              .catch((error) =>
                log.warn('punteggio non aggiornato dopo l’audit', { businessId: item.business_id, error }),
              );
        }
      });
      await Promise.all(workers);
      await this.finish(job.id, flags, log);
    } finally {
      clearInterval(beat);
      this.controllers.delete(controller);
    }
  }

  private async processItem(
    job: JobRow,
    item: ItemRow,
    signal: AbortSignal,
    inFlight: Map<string, Promise<void>>,
    log: Logger,
  ) {
    const { rows } = await this.db.query<{ name: string; category: CategoryId; website_url: string | null }>(
      'SELECT name, category, website_url FROM businesses WHERE id = $1',
      [item.business_id],
    );
    const business = rows[0];
    const done = async (
      status: 'done' | 'skipped' | 'failed',
      outcome: string,
      auditId: string | null,
      error: string | null = null,
    ) => {
      await this.db.transaction(async (tx) => {
        await tx.query(
          'UPDATE audit_job_items SET status = $3, outcome = $4, audit_id = $5, error = $6, finished_at = now() WHERE job_id = $1 AND seq = $2',
          [job.id, item.seq, status, outcome, auditId, error],
        );
        await tx.query(
          `UPDATE audit_jobs SET items_done = items_done + 1, items_failed = items_failed + $2, items_skipped = items_skipped + $3,
                  heartbeat_at = now(), updated_at = now() WHERE id = $1`,
          [job.id, status === 'failed' ? 1 : 0, status === 'skipped' ? 1 : 0],
        );
      });
    };
    if (!business) return done('skipped', 'Azienda non più presente.', null);

    const link = await this.db.transaction((tx) => linkWebsite(tx, item.business_id, business.website_url));
    if (link.kind === 'none') return done('done', link.status, null);

    // lo stesso sito non viene analizzato due volte in parallelo: si attende l'altro audit e poi lo si riusa
    // (controllo e prenotazione senza await in mezzo: nessun altro lavoratore può inserirsi)
    while (inFlight.has(link.websiteId)) await inFlight.get(link.websiteId);
    let release!: () => void;
    inFlight.set(link.websiteId, new Promise<void>((r) => (release = r)));
    const startedAt = new Date();
    try {
      // un audit forzato riusa comunque quello appena fatto da un'altra azienda dello stesso job
      const recent = job.force
        ? await this.auditOfThisJob(job.id, link.websiteId)
        : await recentAudit(this.db, link.websiteId, job.config_key, this.options.config.reauditHours);
      if (recent) return await done('skipped', 'recent', recent);
      const outcome = await runAudit(
        link.url,
        business.category,
        job.settings,
        {
          policy: this.options.policy,
          hostIntervalMs: this.options.config.hostIntervalMs,
          performance: this.options.performance,
          hosts: this.hosts,
          log,
          sleep: this.options.sleep,
        },
        signal,
      );
      const auditId = await this.db.transaction((tx) =>
        saveAudit(tx, {
          websiteId: link.websiteId,
          businessId: item.business_id,
          jobId: job.id,
          settings: job.settings,
          configKey: job.config_key,
          outcome,
        }),
      );
      await done('done', outcome.websiteStatus, auditId);
    } catch (error) {
      if (error instanceof FetchError && error.kind === 'aborted') {
        // interruzione (annullamento, pausa, arresto): l'azienda torna in coda
        await this.db.query("UPDATE audit_job_items SET status = 'pending' WHERE job_id = $1 AND seq = $2", [
          job.id,
          item.seq,
        ]);
        return;
      }
      const message = (error as Error)?.message ?? String(error);
      log.error('audit non riuscito', { businessId: item.business_id, error });
      const auditId = await this.db
        .transaction((tx) =>
          saveFailedAudit(tx, {
            websiteId: link.websiteId,
            businessId: item.business_id,
            jobId: job.id,
            settings: job.settings,
            configKey: job.config_key,
            url: link.url,
            error: message,
            startedAt,
          }),
        )
        .catch(() => null);
      await done('failed', 'audit_failed', auditId, 'Errore interno durante l’audit: riprova più tardi.');
    } finally {
      inFlight.delete(link.websiteId);
      release();
    }
  }

  private async auditOfThisJob(jobId: string, websiteId: string): Promise<string | null> {
    const { rows } = await this.db.query<{ id: string }>(
      "SELECT id FROM website_audits WHERE job_id = $1 AND website_id = $2 AND run_status <> 'failed' ORDER BY finished_at DESC LIMIT 1",
      [jobId, websiteId],
    );
    return rows[0]?.id ?? null;
  }

  private async finish(jobId: string, flags: { cancel: boolean; pause: boolean }, log: Logger) {
    await this.db.transaction(async (tx) => {
      if (flags.cancel) {
        await tx.query(
          "UPDATE audit_job_items SET status = 'cancelled', finished_at = now() WHERE job_id = $1 AND status IN ('pending', 'running')",
          [jobId],
        );
        await tx.query(
          "UPDATE audit_jobs SET status = 'cancelled', cancel_requested = false, worker_id = NULL, finished_at = now(), updated_at = now() WHERE id = $1",
          [jobId],
        );
        await appendMessages(tx, 'audit_jobs', jobId, [
          jobMessage('info', 'Verifica annullata: gli audit già completati restano disponibili.'),
        ]);
        return;
      }
      if (flags.pause || this.stopping) {
        const reason = flags.pause ? 'manual' : 'interrupted';
        await tx.query("UPDATE audit_job_items SET status = 'pending' WHERE job_id = $1 AND status = 'running'", [
          jobId,
        ]);
        await tx.query(
          "UPDATE audit_jobs SET status = 'paused', pause_requested = false, pause_reason = $2, worker_id = NULL, updated_at = now() WHERE id = $1",
          [jobId, reason],
        );
        await appendMessages(tx, 'audit_jobs', jobId, [
          jobMessage(
            reason === 'manual' ? 'info' : 'warning',
            reason === 'manual'
              ? 'Verifica in pausa.'
              : 'Verifica interrotta per l’arresto del server: puoi riprenderla.',
          ),
        ]);
        return;
      }
      const { rows } = await tx.query<{ failed: number; total: number }>(
        "SELECT count(*) FILTER (WHERE status = 'failed')::int AS failed, count(*)::int AS total FROM audit_job_items WHERE job_id = $1",
        [jobId],
      );
      const r = rows[0]!;
      const status = r.failed === 0 ? 'completed' : r.failed === r.total ? 'failed' : 'completed_with_warnings';
      if (r.failed)
        await appendMessages(tx, 'audit_jobs', jobId, [
          jobMessage(
            'error',
            `${r.failed} ${r.failed === 1 ? 'verifica non riuscita' : 'verifiche non riuscite'} per un errore interno: puoi ripeterle.`,
          ),
        ]);
      await tx.query(
        'UPDATE audit_jobs SET status = $2, worker_id = NULL, finished_at = now(), updated_at = now() WHERE id = $1',
        [jobId, status],
      );
      log.info('verifica terminata', { status });
    });
  }
}
