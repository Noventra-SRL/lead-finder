import { randomUUID } from 'node:crypto';
import { cancelAuditJob, createAuditJob, resumeAuditJob } from '../audit/jobs.ts';
import type { FetchPolicy } from '../audit/net/safeFetch.ts';
import type { AuditConfig, DiscoveryConfig } from '../config.ts';
import type { Db } from '../db/client.ts';
import { cancelJob, createJob, JobError, pauseJob, resumeJob } from '../discovery/jobs.ts';
import { geo } from '../geo/geo.ts';
import { appendMessages, jobMessage } from '../jobs/messages.ts';
import type { Logger } from '../logger.ts';
import { countLinked, emailForecast, type HuntOptions, type PlanArea } from './runs.ts';

/*
 * Coordinatore delle ricerche di lead: a ogni giro fa avanzare ogni ricerca attiva di un passo, in modo idempotente
 * (lo stato è tutto nel database: cursore delle aree, job in corso). Dopo un riavvio riprende da dove era:
 * i job di scoperta e di audit interrotti vengono ripresi, l'area successiva parte dal cursore salvato.
 */

const TERMINAL = new Set(['completed', 'completed_with_warnings', 'failed', 'cancelled']);
/** Oltre questo multiplo dell'obiettivo la scoperta si ferma anche se il punteggio dei candidati non è ancora noto. */
const OVERSAMPLE = 3;
/** Ricerche di email pubbliche: molti siti non pubblicano un indirizzo, il limite di sicurezza è più ampio. */
const OVERSAMPLE_EMAIL = 8;
const AUDIT_BATCH = 100;

interface RunRow {
  id: string;
  status: string;
  target: number;
  sectors: string[];
  /** Fornitore della ricerca: osm (predefinito) o google. */
  provider: string;
  options: HuntOptions;
  plan: PlanArea[];
  cursor: number;
  phase: 'discovery' | 'audit' | 'done';
  current_job_id: string | null;
  current_audit_job_id: string | null;
  pause_requested: boolean;
  cancel_requested: boolean;
  created_by: string | null;
  started_at: Date | null;
}

export interface HuntWorkerDeps {
  log: Logger;
  discovery: {
    config: DiscoveryConfig;
    /** Fornitore predefinito (le ricerche esistenti) e configurazione di ogni fornitore disponibile. */
    providerId: string;
    configured: () => boolean;
    configuredFor?: (providerId: string) => boolean;
    wake: () => void;
  };
  audit: { config: AuditConfig; policy: FetchPolicy; wake: () => void };
  pollMs?: number;
  staleAfterMs?: number;
}

export class HuntWorker {
  readonly id = `${process.pid}-${randomUUID().slice(0, 8)}`;
  private readonly db: Db;
  private readonly deps: HuntWorkerDeps;
  private readonly log: Logger;
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<void> | null = null;
  private stopping = false;

  constructor(db: Db, deps: HuntWorkerDeps) {
    this.db = db;
    this.deps = deps;
    this.log = deps.log.child({ component: 'lead-hunter' });
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
      this.running = this.tick()
        .catch((error) => this.log.error('errore del coordinatore delle ricerche di lead', { error }))
        .finally(() => {
          this.running = null;
          if (!this.stopping) this.schedule(this.deps.pollMs ?? 3000);
        });
    }, ms);
    this.timer.unref();
  }

  /** Un passo per ogni ricerca attiva (o con un annullamento da applicare). */
  async tick(): Promise<void> {
    const { rows } = await this.db.query<{ id: string }>(
      `UPDATE hunt_runs SET worker_id = $1, heartbeat_at = now()
        WHERE (status IN ('pending', 'running') OR (status = 'paused' AND cancel_requested))
          AND (worker_id IS NULL OR worker_id = $1 OR heartbeat_at < now() - make_interval(secs => $2))
        RETURNING id`,
      [this.id, (this.deps.staleAfterMs ?? 60_000) / 1000],
    );
    for (const { id } of rows) {
      if (this.stopping) return;
      try {
        await this.step(id);
      } catch (error) {
        this.log.error('passo della ricerca di lead non riuscito', { runId: id, error });
        await this.message(id, 'error', 'Errore interno del coordinatore: la ricerca riprova al prossimo giro.').catch(
          () => undefined,
        );
      }
    }
  }

  private message(id: string, level: 'info' | 'warning' | 'error', text: string) {
    return appendMessages(this.db, 'hunt_runs', id, [jobMessage(level, text)]);
  }

  private async load(id: string) {
    const { rows } = await this.db.query<RunRow>('SELECT * FROM hunt_runs WHERE id = $1', [id]);
    return rows[0]!;
  }

  private async jobStatus(table: 'discovery_jobs' | 'audit_jobs', id: string) {
    const { rows } = await this.db.query<{ status: string; pause_reason: string | null }>(
      `SELECT status, pause_reason FROM ${table} WHERE id = $1`,
      [id],
    );
    return rows[0] ?? null;
  }

  async step(id: string): Promise<void> {
    let run = await this.load(id);
    const userId = run.created_by;
    if (run.status === 'pending')
      await this.db.query(
        "UPDATE hunt_runs SET status = 'running', started_at = COALESCE(started_at, now()), updated_at = now() WHERE id = $1",
        [id],
      );
    if (!userId) {
      await this.finish(id, 'failed', 'L’utente che ha creato la ricerca non esiste più: ricerca interrotta.');
      return;
    }

    // ---- annullamento e pausa (richiesti dall'utente) ----
    if (run.cancel_requested) {
      if (run.current_job_id) await cancelJob(this.db, run.current_job_id, userId).catch(ignoreState);
      if (run.current_audit_job_id) await cancelAuditJob(this.db, run.current_audit_job_id, userId).catch(ignoreState);
      await this.finish(id, 'cancelled', 'Ricerca annullata: le aziende già raccolte restano nel database.');
      return;
    }
    if (run.pause_requested) {
      if (run.current_job_id) await pauseJob(this.db, run.current_job_id, userId).catch(ignoreState);
      await this.db.query(
        "UPDATE hunt_runs SET status = 'paused', pause_requested = false, pause_reason = 'manual', updated_at = now() WHERE id = $1",
        [id],
      );
      await this.message(id, 'info', 'Ricerca in pausa (le verifiche dei siti già in coda proseguono).');
      return;
    }

    // ---- scoperta: un'area alla volta ----
    if (run.phase === 'discovery') {
      if (run.current_job_id) {
        const job = await this.jobStatus('discovery_jobs', run.current_job_id);
        if (job && !TERMINAL.has(job.status)) {
          if (job.status === 'paused') {
            if (job.pause_reason === 'not_configured' && !this.deps.discovery.configured()) {
              await this.pause(id, 'not_configured', 'Server OpenStreetMap non configurato: ricerca sospesa.');
              return;
            }
            // dopo un riavvio (o una pausa ormai revocata) il job dell'area riparte
            await resumeJob(this.db, run.current_job_id, userId, this.deps.discovery.configured()).catch(ignoreState);
            this.deps.discovery.wake();
          }
        } else {
          await this.adoptAreaResult(run, run.current_job_id, job?.status ?? 'failed');
          run = await this.load(id);
        }
      }
      if (!run.current_job_id && run.phase === 'discovery') await this.nextArea(run, userId);
      run = await this.load(id);
    }

    // ---- audit dei siti trovati: una verifica alla volta ----
    let auditDone = !run.options.audit;
    if (run.options.audit) auditDone = await this.auditStep(run, userId);

    // ---- fine ----
    if (run.phase === 'audit' && !run.current_job_id && auditDone) {
      const qualified = await countLinked(this.db, id, run.options, 'qualified');
      if (qualified >= run.target)
        await this.finish(
          id,
          'completed',
          run.options.publicEmail
            ? `Obiettivo raggiunto: ${qualified} aziende con un’email pubblica (indicata dalla fonte o scritta sul loro sito).`
            : `Obiettivo raggiunto: ${qualified} aziende che soddisfano i criteri.`,
        );
      else
        await this.finish(
          id,
          'completed_with_warnings',
          `Obiettivo non raggiunto: ${qualified} aziende su ${run.target} soddisfano i criteri. Le fonti disponibili per quest'area e questi settori non ne contengono di più (o non ancora verificate).`,
        );
    }
  }

  /** Collega alla ricerca le aziende trovate dal job dell'area appena terminato. */
  private async adoptAreaResult(run: RunRow, jobId: string, status: string) {
    const params: unknown[] = [run.id, jobId, run.sectors, run.started_at ?? new Date()];
    const { rows: linked } = await this.db.query<{ business_id: string }>(
      `INSERT INTO hunt_run_businesses (run_id, business_id, discovery_job_id, is_new)
       SELECT DISTINCT ON (b.id) $1::uuid, b.id, $2::uuid, b.first_seen_at >= $4
         FROM business_sources s JOIN businesses b ON b.id = s.business_id
        WHERE s.last_job_id = $2 AND b.merged_into IS NULL AND b.excluded_at IS NULL AND b.sector = ANY($3)
          ${run.options.excludeKnown ? 'AND b.first_seen_at >= $4' : ''}
       ON CONFLICT (run_id, business_id) DO NOTHING RETURNING business_id`,
      params,
    );
    const { rows } = await this.db.query<{
      area_name: string;
      inserted: number;
      discovered: number;
      failed_requests: number;
    }>('SELECT area_name, inserted, discovered, failed_requests FROM discovery_jobs WHERE id = $1', [jobId]);
    const j = rows[0];
    await this.db.query('UPDATE hunt_runs SET current_job_id = NULL, updated_at = now() WHERE id = $1', [run.id]);
    if (!j) return;
    if (status === 'failed')
      await this.message(
        run.id,
        'warning',
        `${j.area_name}: ricerca non riuscita (${j.failed_requests} richieste fallite). Si passa all'area successiva; le aziende già salvate restano.`,
      );
    else if (j.failed_requests > 0)
      await this.message(
        run.id,
        'warning',
        `${j.area_name}: ${j.discovered} attività trovate, ${linked.length} collegate; ${j.failed_requests} richieste non riuscite (alcuni comuni potrebbero mancare: ripeti la ricerca per completarli).`,
      );
    else
      await this.message(
        run.id,
        'info',
        `${j.area_name}: ${j.discovered} attività trovate, ${j.inserted} nuove, ${linked.length} collegate alla ricerca.`,
      );
  }

  /** Avvia la ricerca dell'area successiva, oppure chiude la scoperta (obiettivo raggiunto o aree finite). */
  private async nextArea(run: RunRow, userId: string) {
    const qualified = await countLinked(this.db, run.id, run.options, 'qualified');
    const candidates = await countLinked(this.db, run.id, run.options, 'candidate');
    const needsAudit = run.options.minScore !== null || run.options.websitePreference === 'website_issues';
    // email pubbliche: quelle già trovate più quelle attese dai siti ancora da controllare (quota misurata)
    const forecast = run.options.publicEmail ? await emailForecast(this.db, run.id, run.options) : null;
    const enough = forecast
      ? qualified >= run.target || forecast.expected >= run.target || candidates >= run.target * OVERSAMPLE_EMAIL
      : qualified >= run.target || (!needsAudit && candidates >= run.target) || candidates >= run.target * OVERSAMPLE;
    if (enough || run.cursor >= run.plan.length) {
      await this.db.query("UPDATE hunt_runs SET phase = 'audit', updated_at = now() WHERE id = $1", [run.id]);
      await this.message(
        run.id,
        'info',
        enough
          ? forecast
            ? `Scoperta conclusa: ${forecast.withEmail} aziende con email pubblica e ${forecast.pending} siti ancora da controllare (circa ${Math.round(forecast.rate * 100)}% dei siti controllati pubblica un indirizzo).`
            : `Scoperta conclusa: ${candidates} aziende candidate raccolte${needsAudit ? ' (il punteggio di alcune dipende ancora dalle verifiche dei siti)' : ''}.`
          : `Tutte le aree cercate: ${candidates} aziende candidate raccolte.`,
      );
      return;
    }
    const area = run.plan[run.cursor]!;
    const remainingAreas = run.plan.length - run.cursor;
    const remaining = Math.max(1, run.target - (forecast ? forecast.expected : needsAudit ? qualified : candidates));
    // quota per area: l'obiettivo restante diviso tra le regioni ancora da visitare (ricerca su tutta Italia: una
    // provincia per regione a turno, quindi il primo giro tocca tutte le regioni), altrimenti tra le province
    // restanti; con un margine per doppioni, aziende escluse o già note. La scoperta si ferma comunque all'obiettivo.
    // Una quota troppo bassa scartava gran parte delle attività già scaricate e moltiplicava le richieste.
    const regionsLeft = new Set(run.plan.slice(run.cursor).map((a) => geo().province(a.code)?.regionCode ?? a.code))
      .size;
    const spread = regionsLeft > 1 ? Math.min(regionsLeft, remainingAreas) : remainingAreas;
    const cfg = this.deps.discovery.config;
    const quota = Math.min(cfg.maxResultsPerJob, Math.max(20, Math.ceil((remaining * 1.1) / spread)));
    // con uno o due settori il limite per comune sale: il capoluogo (cercato per primo) ha molte attività dello
    // stesso tipo (es. farmacie), mentre i piccoli comuni ne hanno una o due; la quota dell'area limita comunque il totale
    const minPerSector = run.sectors.length <= 2 ? 10 : 1;
    const limitPerSector = Math.min(
      20,
      Math.max(minPerSector, Math.ceil(quota / (area.municipalities * run.sectors.length))),
    );
    try {
      const jobId = await createJob(
        this.db,
        {
          area: { type: area.type, code: area.code },
          categories: [],
          sectors: run.sectors,
          limitPerSector,
          maxResults: quota,
          minCompleteness: 0,
          requireWebsite: false,
          requireContact: run.options.publicEmail ?? false,
        },
        {
          userId,
          provider: run.provider ?? this.deps.discovery.providerId,
          providerConfigured:
            this.deps.discovery.configuredFor?.(run.provider ?? this.deps.discovery.providerId) ??
            this.deps.discovery.configured(),
          config: cfg,
          huntRunId: run.id,
        },
      );
      await this.db.query(
        'UPDATE hunt_runs SET current_job_id = $2, cursor = cursor + 1, updated_at = now() WHERE id = $1',
        [run.id, jobId],
      );
      this.deps.discovery.wake();
    } catch (error) {
      if (error instanceof JobError && error.code === 'PROVIDER_NOT_CONFIGURED') {
        await this.pause(
          run.id,
          'not_configured',
          run.provider === 'google'
            ? 'Google Places non configurato (GOOGLE_PLACES_API_KEY): ricerca sospesa.'
            : 'Server OpenStreetMap non configurato: ricerca sospesa.',
        );
        return;
      }
      if (error instanceof JobError && error.code === 'DUPLICATE_JOB' && error.jobId) {
        // una ricerca identica è già in corso (es. avviata a mano): la si adotta invece di ripeterla
        await this.db.query(
          'UPDATE hunt_runs SET current_job_id = $2, cursor = cursor + 1, updated_at = now() WHERE id = $1',
          [run.id, error.jobId],
        );
        return;
      }
      if (error instanceof JobError && error.status === 429) {
        await this.message(run.id, 'warning', 'Coda delle ricerche piena: la prossima area partirà appena possibile.');
        return;
      }
      throw error;
    }
  }

  /** true quando non resta nulla da verificare (nessuna verifica in corso e nessun sito in attesa). */
  private async auditStep(run: RunRow, userId: string): Promise<boolean> {
    if (run.current_audit_job_id) {
      const job = await this.jobStatus('audit_jobs', run.current_audit_job_id);
      if (job && !TERMINAL.has(job.status)) {
        if (job.status === 'paused' && job.pause_reason === 'interrupted') {
          await resumeAuditJob(this.db, run.current_audit_job_id, userId).catch(ignoreState);
          this.deps.audit.wake();
        }
        return false;
      }
      await this.db.query('UPDATE hunt_runs SET current_audit_job_id = NULL, updated_at = now() WHERE id = $1', [
        run.id,
      ]);
    }
    // siti propri non ancora verificati, mai messi in coda da questa ricerca
    const { rows } = await this.db.query<{ id: string }>(
      `SELECT b.id FROM hunt_run_businesses hb JOIN businesses b ON b.id = hb.business_id
         LEFT JOIN business_websites bw ON bw.business_id = b.id LEFT JOIN websites w ON w.id = bw.website_id
        WHERE hb.run_id = $1 AND b.merged_into IS NULL AND b.excluded_at IS NULL
          AND b.website_url IS NOT NULL AND NOT b.website_shared AND w.last_audit_id IS NULL
          AND NOT EXISTS (SELECT 1 FROM audit_job_items i JOIN audit_jobs j ON j.id = i.job_id
                           WHERE j.hunt_run_id = $1 AND i.business_id = b.id)
        ORDER BY (b.email IS NULL) DESC, hb.linked_at, b.id LIMIT $2`,
      [run.id, Math.min(AUDIT_BATCH, this.deps.audit.config.maxBusinessesPerJob)],
    );
    if (!rows.length) return true;
    try {
      const r = await createAuditJob(
        this.db,
        // ricerche di email: solo le pagine del sito (le misure di velocità rallenterebbero i controlli)
        { businessIds: rows.map((x) => x.id), performance: !run.options.publicEmail },
        { userId, config: this.deps.audit.config, policy: this.deps.audit.policy, huntRunId: run.id },
      );
      await this.db.query('UPDATE hunt_runs SET current_audit_job_id = $2, updated_at = now() WHERE id = $1', [
        run.id,
        r.jobId,
      ]);
      this.deps.audit.wake();
    } catch (error) {
      // tutti già in verifica altrove: verranno valutati da quella verifica
      if (error instanceof JobError && error.code === 'DUPLICATE_JOB') return false;
      throw error;
    }
    return false;
  }

  private async pause(id: string, reason: string, text: string) {
    await this.db.query("UPDATE hunt_runs SET status = 'paused', pause_reason = $2, updated_at = now() WHERE id = $1", [
      id,
      reason,
    ]);
    await this.message(id, 'warning', text);
  }

  private async finish(id: string, status: string, text: string) {
    await this.db.query(
      `UPDATE hunt_runs SET status = $2, phase = 'done', cancel_requested = false, pause_requested = false, worker_id = NULL,
              finished_at = now(), updated_at = now() WHERE id = $1`,
      [id, status],
    );
    await this.message(
      id,
      status === 'failed' ? 'error' : status === 'completed_with_warnings' ? 'warning' : 'info',
      text,
    );
    this.log.info('ricerca di lead terminata', { runId: id, status });
  }
}

/** Il job è già terminato o in uno stato che non ammette l'azione: niente da fare. */
function ignoreState(error: unknown) {
  if (error instanceof JobError && (error.status === 409 || error.status === 404)) return;
  throw error;
}
