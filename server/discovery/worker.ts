import { randomUUID } from 'node:crypto';
import type { Db } from '../db/client.ts';
import { geo } from '../geo/geo.ts';
import type { Logger } from '../logger.ts';
import type { CategoryId } from './categories.ts';
import { addMessages, jobMessage, recoverInterrupted, type JobMessage, type JobStatus } from './jobs.ts';
import { saveRecord, type SaveContext } from './store.ts';
import { ProviderError, type DiscoveryProvider, type UnitResult } from './types.ts';

/*
 * Esecuzione dei job di ricerca nel processo dell'API, uno alla volta (il fornitore accetta comunque una
 * richiesta alla volta). Più istanze dell'API possono convivere su PostgreSQL: un job viene preso con
 * FOR UPDATE SKIP LOCKED e il processo che lo esegue lo segnala con un "battito" periodico.
 *
 * Per ogni unità: richiesta al fornitore → in un'unica transazione salvataggio dei record, stato dell'unità e
 * contatori del job. Un'interruzione in qualunque momento lascia il database coerente: l'unità non completata
 * torna da eseguire, quelle completate restano salvate.
 */

interface JobRow {
  id: string;
  status: JobStatus;
  provider: string;
  area_type: string;
  radius_km: string | number | null;
  categories: CategoryId[];
  max_results: number;
  min_completeness: number;
  require_website: boolean;
  require_contact: boolean;
  sectors: string[];
  limit_per_sector: number | null;
  inserted: number;
  updated: number;
  unchanged: number;
  merged: number;
}

interface UnitRow {
  seq: number;
  municipality_codes: string[];
  attempts: number;
}

export interface WorkerOptions {
  log: Logger;
  pollMs?: number;
  heartbeatMs?: number;
  /** Dopo quanto un job "in corso" senza battito è considerato interrotto. */
  staleAfterMs?: number;
  /** Oltre quanti giorni i dati della fonte sono segnalati come vecchi. */
  staleDataDays?: number;
  /** Chiamata a ricerca terminata (non in pausa), es. per ricalcolare i punteggi delle aziende viste. */
  onFinished?: (jobId: string) => Promise<void>;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const itDate = new Intl.DateTimeFormat('it-IT', {
  day: 'numeric',
  month: 'long',
  year: 'numeric',
  timeZone: 'Europe/Rome',
});

const saved = (j: Pick<JobRow, 'inserted' | 'updated' | 'unchanged' | 'merged'>) =>
  j.inserted + j.updated + j.unchanged + j.merged;

export class DiscoveryWorker {
  readonly id = `${process.pid}-${randomUUID().slice(0, 8)}`;
  private readonly db: Db;
  private readonly providers: Map<string, DiscoveryProvider>;
  private readonly log: Logger;
  private readonly pollMs: number;
  private readonly heartbeatMs: number;
  private readonly staleAfterMs: number;
  private readonly staleDataDays: number;
  private readonly onFinished?: (jobId: string) => Promise<void>;
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<void> | null = null;
  private current: AbortController | null = null;
  private stopping = false;

  constructor(db: Db, provider: DiscoveryProvider | DiscoveryProvider[], options: WorkerOptions) {
    this.db = db;
    this.providers = new Map((Array.isArray(provider) ? provider : [provider]).map((p) => [p.info().id, p]));
    this.log = options.log.child({ component: 'scoperta' });
    this.pollMs = options.pollMs ?? 2000;
    this.heartbeatMs = options.heartbeatMs ?? 5000;
    this.staleAfterMs = options.staleAfterMs ?? 60_000;
    this.staleDataDays = options.staleDataDays ?? 7;
    this.onFinished = options.onFinished;
  }

  async start() {
    const recovered = await recoverInterrupted(this.db, 0, this.id);
    if (recovered.length) this.log.warn('ricerche interrotte messe in pausa', { jobs: recovered });
    this.schedule(0);
  }

  /** Controlla subito se ci sono ricerche da eseguire (dopo una creazione o una ripresa). */
  wake() {
    if (!this.stopping && !this.running) this.schedule(0);
  }

  /** Arresto ordinato: interrompe la richiesta in corso; il job passa in pausa ed è riprendibile. */
  async stop() {
    this.stopping = true;
    if (this.timer) clearTimeout(this.timer);
    this.current?.abort();
    await this.running;
  }

  /** Esegue al massimo un job; restituisce false se non ce n'erano (usato anche dai test). */
  async runOnce(): Promise<boolean> {
    await recoverInterrupted(this.db, this.staleAfterMs, this.id);
    const { rows } = await this.db.query<JobRow>(
      `UPDATE discovery_jobs SET status = 'running', worker_id = $1, heartbeat_at = now(),
              started_at = COALESCE(started_at, now()), updated_at = now()
        WHERE id = (SELECT id FROM discovery_jobs WHERE status = 'pending' ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED)
        RETURNING id, status, provider, area_type, radius_km, categories, max_results, min_completeness, require_website,
                  require_contact, sectors, limit_per_sector, inserted, updated, unchanged, merged`,
      [this.id],
    );
    if (!rows[0]) return false;
    await this.runJob(rows[0]);
    return true;
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
      // un errore del database non deve fermare il processo: si riprova al prossimo giro
      this.log.error('errore del ciclo di ricerca', { error });
    }
  }

  private async runJob(job: JobRow) {
    const log = this.log.child({ jobId: job.id });
    log.info('ricerca avviata');
    const controller = new AbortController();
    this.current = controller;
    let flags: { cancel: boolean; pause: boolean; reason?: string } = { cancel: false, pause: false };

    // battito e lettura delle richieste di annullamento/pausa mentre una richiesta è in corso
    const beat = setInterval(() => {
      this.db
        .query<{ cancel_requested: boolean; pause_requested: boolean }>(
          'UPDATE discovery_jobs SET heartbeat_at = now() WHERE id = $1 AND worker_id = $2 RETURNING cancel_requested, pause_requested',
          [job.id, this.id],
        )
        .then(({ rows }) => {
          if (rows[0]?.cancel_requested || rows[0]?.pause_requested) {
            flags = { cancel: rows[0].cancel_requested, pause: rows[0].pause_requested };
            controller.abort();
          }
        })
        .catch((error) => log.warn('battito non registrato', { error }));
    }, this.heartbeatMs);
    beat.unref();

    try {
      const seen = new Set<string>();
      const warnedStamps = new Set<string>();
      const counts = { ...job };
      for (;;) {
        const state = await this.db.query<{ cancel_requested: boolean; pause_requested: boolean }>(
          'SELECT cancel_requested, pause_requested FROM discovery_jobs WHERE id = $1',
          [job.id],
        );
        if (state.rows[0]?.cancel_requested) flags.cancel = true;
        if (state.rows[0]?.pause_requested) flags.pause = true;
        if (flags.cancel || flags.pause || this.stopping) break;

        if (saved(counts) >= job.max_results) {
          await this.db.transaction(async (tx) => {
            await tx.query(
              "UPDATE discovery_job_units SET status = 'skipped' WHERE job_id = $1 AND status = 'pending'",
              [job.id],
            );
            await tx.query('UPDATE discovery_jobs SET limit_reached = true WHERE id = $1', [job.id]);
            await addMessages(tx, job.id, [
              jobMessage('info', `Raggiunto il limite di ${job.max_results} risultati: la ricerca si ferma qui.`),
            ]);
          });
          break;
        }

        const { rows } = await this.db.query<UnitRow>(
          "SELECT seq, municipality_codes, attempts FROM discovery_job_units WHERE job_id = $1 AND status = 'pending' ORDER BY seq LIMIT 1",
          [job.id],
        );
        const unit = rows[0];
        if (!unit) break;
        await this.db.query(
          "UPDATE discovery_job_units SET status = 'running', attempts = attempts + 1, started_at = now() WHERE job_id = $1 AND seq = $2",
          [job.id, unit.seq],
        );

        let result: UnitResult;
        try {
          const provider = this.providers.get(job.provider);
          if (!provider) throw new ProviderError('not_configured', `Fornitore «${job.provider}» non disponibile.`);
          result = await provider.fetchUnit(
            {
              municipalities: unit.municipality_codes.map((c) => geo().municipality(c)!),
              ...(job.radius_km !== null ? { radiusKm: Number(job.radius_km) } : {}),
            },
            job.categories,
            // per settori: limite per settore e per comune (nessun settore prevale); altrimenti i risultati mancanti
            job.sectors.length
              ? Math.min(job.limit_per_sector ?? 1, Math.max(1, job.max_results - saved(counts)))
              : Math.max(1, job.max_results - saved(counts)),
            controller.signal,
            (info) => {
              // nuovi tentativi visibili all'utente: altrimenti una ricerca "in corso" sembra bloccata
              const text = `${info.reason} Nuovo tentativo tra ${Math.round(info.waitMs / 1000)} s (${info.attempt + 1} di ${info.maxAttempts}).`;
              log.warn('richiesta al fornitore non riuscita, nuovo tentativo', {
                attempt: info.attempt,
                waitMs: info.waitMs,
                reason: info.reason,
              });
              addMessages(this.db, job.id, [jobMessage('warning', text)]).catch((error) =>
                log.warn('messaggio di nuovo tentativo non registrato', { error }),
              );
            },
            job.sectors.length || job.require_contact
              ? { sectors: job.sectors, requireContact: job.require_contact }
              : undefined,
          );
        } catch (error) {
          if (!(error instanceof ProviderError)) throw error;
          await this.unitFailed(job.id, unit, error);
          if (error.kind === 'aborted') break;
          if (error.kind === 'not_configured') {
            flags = { ...flags, pause: true, reason: 'not_configured' };
            break;
          }
          continue;
        }

        const tally = await this.db.transaction(async (tx) => {
          const t = {
            inserted: 0,
            updated: 0,
            unchanged: 0,
            merged: 0,
            duplicates_skipped: 0,
            skipped_incomplete: 0,
            flagged: 0,
            saved: 0,
          };
          const ctx: SaveContext = {
            jobId: job.id,
            fetchedAt: result.fetchedAt,
            sourceDataAt: result.sourceTimestamp ? new Date(result.sourceTimestamp) : null,
            minCompleteness: job.min_completeness,
            requireWebsite: job.require_website,
            requireContact: job.require_contact,
            seen,
          };
          const remaining = job.max_results - saved(counts);
          for (const record of result.records) {
            if (t.saved >= remaining) break;
            const r = await saveRecord(tx, record, ctx);
            t.flagged += r.flaggedForReview;
            if (r.outcome === 'duplicate_skipped') t.duplicates_skipped++;
            else if (r.outcome === 'skipped_incomplete') t.skipped_incomplete++;
            else {
              t[r.outcome]++;
              t.saved++;
            }
          }
          const missing = unit.municipality_codes.filter((c) => !result.foundMunicipalities.includes(c));
          await tx.query(
            `UPDATE discovery_job_units SET status = 'done', records_found = $3, missing_municipalities = $4, from_cache = $5,
                    source_data_at = $6, error = NULL, finished_at = now() WHERE job_id = $1 AND seq = $2`,
            [job.id, unit.seq, result.records.length, missing, result.fromCache, result.sourceTimestamp],
          );
          await tx.query(
            `UPDATE discovery_jobs SET units_done = units_done + 1, discovered = discovered + $2, inserted = inserted + $3,
                    updated = updated + $4, unchanged = unchanged + $5, merged = merged + $6, duplicates_skipped = duplicates_skipped + $7,
                    skipped_incomplete = skipped_incomplete + $8, flagged_for_review = flagged_for_review + $9,
                    requests_sent = requests_sent + $10, failed_requests = failed_requests + $11,
                    heartbeat_at = now(), updated_at = now()
              WHERE id = $1`,
            [
              job.id,
              result.records.length,
              t.inserted,
              t.updated,
              t.unchanged,
              t.merged,
              t.duplicates_skipped,
              t.skipped_incomplete,
              t.flagged,
              result.requests,
              // tentativi falliti prima della risposta buona (es. un 502 seguito da un successo)
              Math.max(0, result.requests - 1),
            ],
          );
          const notes: JobMessage[] = [];
          if (missing.length) {
            const names = missing.map((c) => `${geo().municipality(c)?.name ?? c} (${c})`).join(', ');
            notes.push(
              jobMessage(
                'warning',
                `${missing.length === 1 ? 'Comune non trovato' : `${missing.length} comuni non trovati`} su OpenStreetMap con il codice ISTAT: ${names}. Per ${missing.length === 1 ? 'questo comune' : 'questi comuni'} non ci sono risultati.`,
              ),
            );
          }
          // dati vecchi: un avviso per ogni copia diversa dei dati (i server pubblici possono averne più d'una)
          if (result.sourceTimestamp && !warnedStamps.has(result.sourceTimestamp)) {
            const age = Math.floor((Date.now() - Date.parse(result.sourceTimestamp)) / DAY_MS);
            if (age > this.staleDataDays) {
              warnedStamps.add(result.sourceTimestamp);
              notes.push(
                jobMessage(
                  'warning',
                  `Il server OpenStreetMap usa dati aggiornati al ${itDate.format(new Date(result.sourceTimestamp))} (${age} giorni fa): attività aperte, chiuse o modificate dopo quella data non sono incluse.`,
                ),
              );
            }
          }
          await addMessages(tx, job.id, notes);
          return t;
        });
        counts.inserted += tally.inserted;
        counts.updated += tally.updated;
        counts.unchanged += tally.unchanged;
        counts.merged += tally.merged;
      }

      await this.finish(job.id, flags, log);
      // ricerca terminata (anche annullata: le aziende salvate restano): avvisa chi deve aggiornare i punteggi
      if (!flags.pause && !this.stopping && this.onFinished)
        await this.onFinished(job.id).catch((error) => log.warn('aggiornamento dei punteggi non avviato', { error }));
    } finally {
      clearInterval(beat);
      this.current = null;
    }
  }

  /** Errore di un'unità: interruzione, divisione in due parti più piccole, oppure unità non riuscita. */
  private async unitFailed(jobId: string, unit: UnitRow, error: ProviderError) {
    await this.db.transaction(async (tx) => {
      if (error.kind === 'aborted' || error.kind === 'not_configured') {
        await tx.query("UPDATE discovery_job_units SET status = 'pending' WHERE job_id = $1 AND seq = $2", [
          jobId,
          unit.seq,
        ]);
        if (error.kind === 'not_configured') await addMessages(tx, jobId, [jobMessage('error', error.message)]);
        return;
      }
      const failedRequests = error.attempts;
      if ((error.kind === 'too_large' || error.kind === 'timeout') && unit.municipality_codes.length > 1) {
        const half = Math.ceil(unit.municipality_codes.length / 2);
        const { rows } = await tx.query<{ next: number }>(
          'SELECT max(seq) + 1 AS next FROM discovery_job_units WHERE job_id = $1',
          [jobId],
        );
        const next = rows[0]!.next;
        await tx.query(
          "UPDATE discovery_job_units SET status = 'split', error = $3, finished_at = now() WHERE job_id = $1 AND seq = $2",
          [jobId, unit.seq, error.message],
        );
        await tx.query(
          'INSERT INTO discovery_job_units (job_id, seq, municipality_codes) VALUES ($1, $2, $3), ($1, $4, $5)',
          [jobId, next, unit.municipality_codes.slice(0, half), next + 1, unit.municipality_codes.slice(half)],
        );
        // l'unità divisa conta come fatta: le due nuove si aggiungono al totale
        await tx.query(
          'UPDATE discovery_jobs SET units_total = units_total + 2, units_done = units_done + 1, failed_requests = failed_requests + $2, requests_sent = requests_sent + $2 WHERE id = $1',
          [jobId, failedRequests],
        );
        await addMessages(tx, jobId, [
          jobMessage(
            'info',
            `Richiesta troppo ampia per il server: divisa in due parti (${unit.municipality_codes.length} comuni).`,
          ),
        ]);
        return;
      }
      const names = unit.municipality_codes.slice(0, 3).map((c) => geo().municipality(c)?.name ?? c);
      const where = `${names.join(', ')}${unit.municipality_codes.length > 3 ? ` e altri ${unit.municipality_codes.length - 3}` : ''}`;
      await tx.query(
        "UPDATE discovery_job_units SET status = 'failed', error = $3, finished_at = now() WHERE job_id = $1 AND seq = $2",
        [jobId, unit.seq, error.message],
      );
      await tx.query(
        'UPDATE discovery_jobs SET units_done = units_done + 1, failed_requests = failed_requests + $2, requests_sent = requests_sent + $2 WHERE id = $1',
        [jobId, failedRequests],
      );
      await addMessages(tx, jobId, [jobMessage('error', `${where}: ${error.message}`)]);
    });
  }

  private async finish(jobId: string, flags: { cancel: boolean; pause: boolean; reason?: string }, log: Logger) {
    await this.db.transaction(async (tx) => {
      if (flags.cancel) {
        await tx.query(
          "UPDATE discovery_jobs SET status = 'cancelled', cancel_requested = false, worker_id = NULL, finished_at = now(), updated_at = now() WHERE id = $1",
          [jobId],
        );
        await addMessages(tx, jobId, [
          jobMessage('info', 'Ricerca annullata: i risultati già salvati restano disponibili.'),
        ]);
        log.info('ricerca annullata');
        return;
      }
      if (flags.pause || this.stopping) {
        const reason = flags.pause ? (flags.reason ?? 'manual') : 'interrupted';
        await tx.query(
          "UPDATE discovery_jobs SET status = 'paused', pause_requested = false, pause_reason = $2, worker_id = NULL, updated_at = now() WHERE id = $1",
          [jobId, reason],
        );
        await addMessages(tx, jobId, [
          jobMessage(
            reason === 'manual' ? 'info' : 'warning',
            reason === 'manual'
              ? 'Ricerca in pausa.'
              : reason === 'not_configured'
                ? 'Ricerca sospesa: configura il server OpenStreetMap e riprendila.'
                : 'Ricerca interrotta per l’arresto del server: puoi riprenderla.',
          ),
        ]);
        log.info('ricerca in pausa', { reason });
        return;
      }
      const { rows } = await tx.query<{ failed: number; done: number; missing: number; stale: number }>(
        `SELECT count(*) FILTER (WHERE status = 'failed')::int AS failed,
                count(*) FILTER (WHERE status = 'done')::int AS done,
                count(*) FILTER (WHERE cardinality(missing_municipalities) > 0)::int AS missing,
                count(*) FILTER (WHERE source_data_at < now() - make_interval(days => $2))::int AS stale
           FROM discovery_job_units WHERE job_id = $1`,
        [jobId, this.staleDataDays],
      );
      const u = rows[0]!;
      // dati della fonte vecchi: la ricerca è riuscita ma va letta con cautela (avviso nei messaggi)
      const status: JobStatus =
        u.failed > 0 && u.done === 0
          ? 'failed'
          : u.failed > 0 || u.missing > 0 || u.stale > 0
            ? 'completed_with_warnings'
            : 'completed';
      await tx.query(
        'UPDATE discovery_jobs SET status = $2, worker_id = NULL, finished_at = now(), updated_at = now() WHERE id = $1',
        [jobId, status],
      );
      log.info('ricerca terminata', { status });
    });
  }
}
