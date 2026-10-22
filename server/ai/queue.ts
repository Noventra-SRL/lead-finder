import { randomUUID } from 'node:crypto';
import type { AiConfig } from '../config.ts';
import type { Db, Queryable } from '../db/client.ts';
import type { Logger } from '../logger.ts';
import { assessBusiness, type AssessOutcome } from './assess.ts';
import { activeAiConfig } from './config.ts';
import { buildContext, cacheKey } from './context.ts';
import { finishLease, LEASE_MS, PROVIDER_CODES } from './lease.ts';
import { AI_STATE_SQL, type AiState } from './state.ts';

export { AI_STATE_LABEL, AI_STATE_SQL, type AiState } from './state.ts';
import { PROMPT_VERSION } from './prompt.ts';
import type { AiProvider } from './provider.ts';

/*
 * Valutazione commerciale di OGNI azienda (non solo di quelle aperte o selezionate).
 *
 *  1. Impronta: per ogni azienda il server calcola l'impronta delle prove attuali (stessa formula della cache delle
 *     valutazioni: prove, catalogo, configurazione, versione del prompt, modello). Si ricalcola quando cambiano
 *     azienda, sito/audit, servizi abbinati, CRM, configurazione o catalogo, e comunque una volta al giorno.
 *     Nessuna chiamata AI, nessun costo: funziona anche senza fornitore configurato.
 *  2. Stato visibile: Da valutare, In valutazione, Valutata, Valutazione incompleta, Errore di valutazione,
 *     Da aggiornare (le prove sono cambiate dopo la valutazione), Esclusa (non contattare: nessuna chiamata AI).
 *     «Valutata» significa che la valutazione corrente ha la stessa impronta delle prove di oggi.
 *  3. Coda automatica (AutoAssessor): prende le aziende da valutare o da aggiornare, poche alla volta
 *     (AI_CONCURRENCY), con un lease per azienda (mai due valutazioni contemporanee, anche con lotti manuali), un
 *     limite giornaliero, pausa automatica su errori del fornitore e nuovi tentativi limitati sugli errori temporanei.
 *     Dopo un riavvio i lease scadono e il lavoro riprende: la coda è il database, non la memoria.
 */

// ---------------------------------------------------------------- impronte

/** Aziende da ricontrollare: mai controllate, cambiate dopo l'ultimo controllo, o controllate più di 24 ore fa. */
const CANDIDATES = `SELECT b.id FROM businesses b LEFT JOIN ai_business_states ast ON ast.business_id = b.id
  WHERE b.merged_into IS NULL AND (
    ast.checked_at IS NULL
    OR ast.checked_at < b.updated_at
    OR ast.checked_at < (SELECT max(w.last_checked_at) FROM business_websites bw JOIN websites w ON w.id = bw.website_id
                          WHERE bw.business_id = b.id)
    OR ast.checked_at < (SELECT max(m.created_at) FROM service_matches m WHERE m.business_id = b.id AND m.is_current)
    OR ast.checked_at < (SELECT max(o.updated_at) FROM crm_opportunities o WHERE o.business_id = b.id)
    OR ast.checked_at < $1
    OR ast.checked_at < now() - interval '24 hours')
  ORDER BY ast.checked_at NULLS FIRST, b.id LIMIT $2`;

/**
 * Ricalcola l'impronta di un lotto di aziende e aggiorna la coda: impronta cambiata → da valutare (tentativi
 * azzerati); uguale alla valutazione corrente → aggiornata. Restituisce quante aziende ha controllato.
 */
export async function refreshFingerprints(db: Db, model: string, limit = 200): Promise<number> {
  const config = await activeAiConfig(db);
  const { rows: changed } = await db.query<{ at: Date | null }>(
    `SELECT GREATEST((SELECT max(created_at) FROM ai_scoring_configs), (SELECT max(created_at) FROM service_catalog_versions)) AS at`,
  );
  const { rows } = await db.query<{ id: string }>(CANDIDATES, [changed[0]?.at ?? new Date(0), limit]);
  for (const { id } of rows) {
    // lavoro in background: tra un'azienda e l'altra passano prima le richieste in attesa (database nello stesso processo)
    await new Promise((resolve) => setTimeout(resolve, 5));
    const ctx = await buildContext(db, id);
    if (!ctx) continue;
    const key = cacheKey(ctx, { configVersion: config.version, promptVersion: PROMPT_VERSION, model });
    const { rows: cur } = await db.query<{ cache_key: string }>(
      'SELECT cache_key FROM ai_assessments WHERE business_id = $1 AND is_current',
      [id],
    );
    const upToDate = cur[0]?.cache_key === key;
    await db.query(
      `INSERT INTO ai_business_states (business_id, fingerprint, checked_at, queue_status)
       VALUES ($1, $2, now(), CASE WHEN $3 THEN 'done' ELSE 'waiting' END)
       ON CONFLICT (business_id) DO UPDATE SET
         queue_status = CASE
           WHEN ai_business_states.lease_expires_at > now() THEN ai_business_states.queue_status
           WHEN $3 THEN 'done'
           WHEN ai_business_states.fingerprint IS DISTINCT FROM $2 THEN 'waiting'
           WHEN ai_business_states.queue_status = 'done' THEN 'waiting'
           -- «in valutazione» con il lease scaduto: processo interrotto, torna da fare
           WHEN ai_business_states.queue_status = 'running' THEN 'waiting'
           ELSE ai_business_states.queue_status END,
         attempts = CASE WHEN ai_business_states.fingerprint IS DISTINCT FROM $2 OR $3 THEN 0 ELSE ai_business_states.attempts END,
         next_attempt_at = CASE WHEN ai_business_states.fingerprint IS DISTINCT FROM $2 OR $3 THEN NULL
                                ELSE ai_business_states.next_attempt_at END,
         fingerprint = $2, checked_at = now(), updated_at = now()`,
      [id, key, upToDate],
    );
  }
  return rows.length;
}

// ---------------------------------------------------------------- copertura

export interface Coverage {
  total: number;
  counts: Record<AiState, number>;
  /** Aziende che si possono valutare (non escluse). */
  eligible: number;
  /** Valutazione aggiornata (completa o incompleta) sulle valutabili. */
  covered: number;
  coveredShare: number | null;
  /** Impronte non ancora calcolate (controllo in corso). */
  unchecked: number;
  /** Errori senza altri tentativi automatici: serve «Riprova». */
  failedFinal: number;
  auto: {
    enabled: boolean;
    providerConfigured: boolean;
    pausedReason: string | null;
    backoffUntil: string | null;
    dailyLimit: number;
    usedLast24h: number;
  };
  usageLast24h: { assessments: number; costUsd: number | null };
}

export async function coverage(
  db: Queryable,
  opts: { providerConfigured: boolean; dailyLimit: number },
): Promise<Coverage> {
  const { rows } = await db.query<{ state: AiState; n: number }>(
    `SELECT ${AI_STATE_SQL} AS state, count(*)::int AS n
       FROM businesses b LEFT JOIN ai_business_states ast ON ast.business_id = b.id
       LEFT JOIN ai_assessments aa ON aa.business_id = b.id AND aa.is_current
      WHERE b.merged_into IS NULL GROUP BY 1`,
  );
  const counts = { pending: 0, running: 0, assessed: 0, incomplete: 0, failed: 0, outdated: 0, excluded: 0 } as Record<
    AiState,
    number
  >;
  for (const r of rows) counts[r.state] = r.n;
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  const eligible = total - counts.excluded;
  const covered = counts.assessed + counts.incomplete;
  const { rows: extra } = await db.query<{ unchecked: number; failed_final: number }>(
    `SELECT count(*) FILTER (WHERE ast.checked_at IS NULL)::int AS unchecked,
            count(*) FILTER (WHERE ast.queue_status = 'failed' AND ast.next_attempt_at IS NULL)::int AS failed_final
       FROM businesses b LEFT JOIN ai_business_states ast ON ast.business_id = b.id WHERE b.merged_into IS NULL`,
  );
  const control = await autoControl(db);
  const { rows: usage } = await db.query<{ n: number; auto: number; cost: string | null }>(
    `SELECT count(*)::int AS n, count(*) FILTER (WHERE trigger = 'auto')::int AS auto, sum(cost_usd) AS cost
       FROM ai_assessments WHERE created_at > now() - interval '24 hours'`,
  );
  return {
    total,
    counts,
    eligible,
    covered,
    coveredShare: eligible ? covered / eligible : null,
    unchecked: extra[0]!.unchecked,
    failedFinal: extra[0]!.failed_final,
    auto: {
      enabled: control.enabled,
      providerConfigured: opts.providerConfigured,
      pausedReason: control.backoff_until && control.backoff_until > new Date() ? control.paused_reason : null,
      backoffUntil:
        control.backoff_until && control.backoff_until > new Date() ? control.backoff_until.toISOString() : null,
      dailyLimit: opts.dailyLimit,
      usedLast24h: usage[0]!.auto,
    },
    usageLast24h: { assessments: usage[0]!.n, costUsd: usage[0]!.cost === null ? null : Number(usage[0]!.cost) },
  };
}

// ---------------------------------------------------------------- controlli

async function autoControl(db: Queryable) {
  const { rows } = await db.query<{ enabled: boolean; paused_reason: string | null; backoff_until: Date | null }>(
    'SELECT enabled, paused_reason, backoff_until FROM ai_auto_control WHERE id = 1',
  );
  return rows[0] ?? { enabled: true, paused_reason: null, backoff_until: null };
}

export async function setAutoEnabled(db: Queryable, enabled: boolean, userId: string) {
  await db.query(
    `UPDATE ai_auto_control SET enabled = $1, updated_by = $2, updated_at = now(),
            backoff_until = CASE WHEN $1 THEN NULL ELSE backoff_until END,
            paused_reason = CASE WHEN $1 THEN NULL ELSE paused_reason END
      WHERE id = 1`,
    [enabled, userId],
  );
}

/** Errori di nuovo in coda (anche quelli senza altri tentativi automatici). */
export async function retryFailed(db: Queryable): Promise<number> {
  const { rows } = await db.query(
    `UPDATE ai_business_states SET queue_status = 'waiting', attempts = 0, next_attempt_at = NULL, updated_at = now()
      WHERE queue_status = 'failed' RETURNING business_id`,
  );
  return rows.length;
}

/** Ricontrollo di tutte le impronte: le aziende con prove cambiate tornano «Da aggiornare» e in coda. */
export async function recheckAll(db: Queryable): Promise<number> {
  const { rows } = await db.query('UPDATE ai_business_states SET checked_at = NULL RETURNING business_id');
  return rows.length;
}

// ---------------------------------------------------------------- coda automatica

/**
 * Valutazione automatica nel processo del server (AI_AUTO_ASSESS=on): controllo delle impronte (sempre, gratis) e,
 * con il fornitore configurato e la valutazione automatica attiva, valutazione delle aziende in coda.
 */
export class AutoAssessor {
  readonly holder = `auto-${process.pid}-${randomUUID().slice(0, 8)}`;
  private readonly db: Db;
  private readonly provider: AiProvider | null;
  private readonly config: AiConfig;
  private readonly log: Logger;
  private readonly dailyLimit: number;
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<void> | null = null;
  private stopping = false;
  private readonly controller = new AbortController();

  constructor(db: Db, deps: { provider: AiProvider | null; config: AiConfig; log: Logger; dailyLimit: number }) {
    this.db = db;
    this.provider = deps.provider;
    this.config = deps.config;
    this.log = deps.log.child({ component: 'ai-auto' });
    this.dailyLimit = deps.dailyLimit;
  }

  start(pollMs = 5000) {
    this.timer = setInterval(() => this.wake(), pollMs);
    this.timer.unref();
    this.wake();
  }

  wake() {
    if (this.running || this.stopping) return;
    this.running = this.tick()
      .then(() => undefined)
      .catch((error) => this.log.error('valutazione automatica non riuscita', { error }))
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

  /** Un giro: impronte, poi un gruppo di valutazioni. Restituisce quante aziende ha valutato o provato. */
  async tick(): Promise<{ checked: number; processed: number }> {
    const checked = await refreshFingerprints(this.db, this.config.model);
    // senza fornitore o con AI_AUTO_ASSESS=off: solo impronte e stati (gratis), nessuna chiamata al modello
    if (!this.provider || !this.config.autoAssess || this.stopping) return { checked, processed: 0 };
    const control = await autoControl(this.db);
    if (!control.enabled || (control.backoff_until && control.backoff_until > new Date()))
      return { checked, processed: 0 };
    // un lotto manuale in corso usa già la concorrenza consentita
    const { rows: busy } = await this.db.query("SELECT 1 FROM ai_jobs WHERE status = 'running' LIMIT 1");
    if (busy[0]) return { checked, processed: 0 };
    const { rows: used } = await this.db.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM ai_assessments WHERE trigger = 'auto' AND created_at > now() - interval '24 hours'",
    );
    const room = Math.min(this.config.concurrency, this.dailyLimit - used[0]!.n);
    if (room <= 0) return { checked, processed: 0 };
    const ids = await this.claim(room);
    await Promise.all(ids.map((id) => this.assessOne(id)));
    return { checked, processed: ids.length };
  }

  /** Prende fino a `n` aziende in coda: mai valutate prima, poi da aggiornare, poi i nuovi tentativi. */
  private async claim(n: number): Promise<string[]> {
    const { rows } = await this.db.query<{ business_id: string }>(
      `UPDATE ai_business_states SET lease_holder = $1, lease_expires_at = now() + make_interval(secs => $3),
              queue_status = 'running', updated_at = now()
        WHERE business_id IN (
          SELECT ast.business_id FROM ai_business_states ast
            JOIN businesses b ON b.id = ast.business_id
            LEFT JOIN ai_assessments aa ON aa.business_id = b.id AND aa.is_current
           WHERE b.merged_into IS NULL AND b.excluded_at IS NULL AND ast.fingerprint IS NOT NULL
             AND (aa.id IS NULL OR aa.cache_key <> ast.fingerprint)
             AND (ast.queue_status = 'waiting'
                  -- interrotta da un processo fermato (il lease è scaduto, controllato sotto)
                  OR ast.queue_status = 'running'
                  OR (ast.queue_status = 'failed' AND ast.next_attempt_at IS NOT NULL AND ast.next_attempt_at <= now()))
             AND (ast.lease_expires_at IS NULL OR ast.lease_expires_at < now())
             -- sito in verifica: si attende l'audit per non pagare due valutazioni
             AND NOT EXISTS (SELECT 1 FROM audit_job_items ai WHERE ai.business_id = b.id AND ai.status IN ('pending', 'running'))
           ORDER BY (aa.id IS NULL) DESC, ast.attempts, b.first_seen_at DESC, b.id
           LIMIT $2 FOR UPDATE OF ast SKIP LOCKED)
        RETURNING business_id`,
      [this.holder, n, LEASE_MS / 1000],
    );
    return rows.map((r) => r.business_id);
  }

  private async assessOne(businessId: string) {
    let outcome: AssessOutcome;
    try {
      outcome = await assessBusiness(this.db, this.provider, this.config, businessId, {
        trigger: 'auto',
        userId: null,
        leaseHolder: this.holder,
        signal: this.controller.signal,
      });
    } catch (error) {
      this.log.warn('valutazione automatica di un’azienda non riuscita', { error, businessId });
      await finishLease(this.db, businessId, this.holder, {
        kind: 'failed',
        code: 'unknown',
        message: error instanceof Error ? error.message.slice(0, 300) : 'Errore imprevisto.',
      });
      return;
    }
    if (outcome.status === 'failed' && (PROVIDER_CODES.has(outcome.code) || outcome.code === 'rate_limited')) {
      // problema del fornitore: la coda si ferma per un po' e l'azienda torna in attesa (nessun errore a suo carico)
      const minutes = outcome.code === 'rate_limited' ? 2 : 15;
      await this.db.query(
        `UPDATE ai_auto_control SET backoff_until = now() + make_interval(mins => $1), paused_reason = $2, updated_at = now()
          WHERE id = 1`,
        [minutes, `${outcome.message} Nuovo tentativo tra ${minutes} minuti.`],
      );
      await this.db.query(
        `UPDATE ai_business_states SET queue_status = 'waiting', attempts = GREATEST(attempts - 1, 0), next_attempt_at = NULL,
              last_error_code = $2, last_error = $3, updated_at = now()
          WHERE business_id = $1`,
        [businessId, outcome.code, outcome.message.slice(0, 500)],
      );
      this.log.warn('valutazione automatica in pausa per un errore del fornitore', { code: outcome.code, minutes });
    }
  }
}
