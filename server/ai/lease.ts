import type { Queryable } from '../db/client.ts';

/*
 * Lease per azienda: una sola valutazione alla volta per azienda (coda automatica, lotti, valutazioni singole), anche
 * con più processi. Il lease scade da solo dopo un'interruzione; l'esito aggiorna lo stato della coda.
 */

/** Nuovi tentativi automatici dopo un errore temporaneo: dopo il terzo si riprova solo a mano. */
export const MAX_AUTO_ATTEMPTS = 3;
const RETRY_DELAYS_MS = [5 * 60_000, 30 * 60_000, 2 * 3_600_000];
export const LEASE_MS = 10 * 60_000;
/** Errori che non dipendono dalla singola azienda: pausa della coda invece di segnare errori su tutte. */
export const PROVIDER_CODES = new Set(['auth', 'bad_request', 'not_configured']);
const TRANSIENT_CODES = new Set(['rate_limited', 'timeout', 'unavailable', 'truncated', 'invalid_output', 'unknown']);

// ---------------------------------------------------------------- lease

/** Prende il lease dell'azienda (nessuno lo ha, o è scaduto). false = in valutazione altrove. */
export async function acquireLease(db: Queryable, businessId: string, holder: string, ttlMs = LEASE_MS) {
  const { rows } = await db.query(
    `INSERT INTO ai_business_states (business_id, lease_holder, lease_expires_at, queue_status)
     VALUES ($1, $2, now() + make_interval(secs => $3), 'running')
     ON CONFLICT (business_id) DO UPDATE SET lease_holder = $2, lease_expires_at = now() + make_interval(secs => $3),
            queue_status = 'running', updated_at = now()
      WHERE ai_business_states.lease_expires_at IS NULL OR ai_business_states.lease_expires_at < now()
         OR ai_business_states.lease_holder = $2
     RETURNING business_id`,
    [businessId, holder, ttlMs / 1000],
  );
  return rows.length > 0;
}

/** Esito registrato e lease rilasciato (solo da chi lo possiede). */
export async function finishLease(
  db: Queryable,
  businessId: string,
  holder: string,
  outcome:
    { kind: 'done'; fingerprint: string } | { kind: 'failed'; code: string; message: string } | { kind: 'requeue' },
) {
  if (outcome.kind === 'done')
    await db.query(
      `UPDATE ai_business_states SET fingerprint = $3, checked_at = now(), queue_status = 'done', attempts = 0,
              next_attempt_at = NULL, last_error = NULL, last_error_code = NULL, lease_holder = NULL, lease_expires_at = NULL,
              updated_at = now()
        WHERE business_id = $1 AND lease_holder = $2`,
      [businessId, holder, outcome.fingerprint],
    );
  else if (outcome.kind === 'failed') {
    const transient = TRANSIENT_CODES.has(outcome.code);
    await db.query(
      `UPDATE ai_business_states SET queue_status = 'failed', attempts = attempts + 1,
              next_attempt_at = CASE WHEN $3 AND attempts + 1 < $4
                                     THEN now() + make_interval(secs => ($5::int[])[attempts + 1] / 1000) END,
              last_error_code = $6, last_error = $7, lease_holder = NULL, lease_expires_at = NULL, updated_at = now()
        WHERE business_id = $1 AND lease_holder = $2`,
      [businessId, holder, transient, MAX_AUTO_ATTEMPTS, RETRY_DELAYS_MS, outcome.code, outcome.message.slice(0, 500)],
    );
  } else
    await db.query(
      `UPDATE ai_business_states SET queue_status = 'waiting', lease_holder = NULL, lease_expires_at = NULL, updated_at = now()
        WHERE business_id = $1 AND lease_holder = $2`,
      [businessId, holder],
    );
}
