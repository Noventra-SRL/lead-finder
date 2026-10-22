import type { AiConfig } from '../config.ts';
import type { Db } from '../db/client.ts';
import type { Logger } from '../logger.ts';
import { assessBusiness, type AssessOutcome } from './assess.ts';
import type { AiProvider } from './provider.ts';

/*
 * Servizi AI condivisi con le rotte. La valutazione di una singola azienda dura da qualche secondo a un minuto:
 * parte in background (la richiesta HTTP risponde subito) e l'interfaccia legge lo stato finché non termina.
 * Una sola valutazione per azienda alla volta; il numero di valutazioni singole contemporanee è limitato.
 */

export interface AiServices {
  provider: AiProvider | null;
  config: AiConfig;
  workerActive: boolean;
  wake(): void;
  /** Aziende con una valutazione singola in corso in questo processo. */
  running: Set<string>;
  /** Avvia una valutazione singola; false se già in corso o se il limite di contemporaneità è raggiunto. */
  start(businessId: string, opts: { userId: string; force: boolean }): 'started' | 'already_running' | 'busy';
  /** Ultimo esito per azienda (per mostrare un errore appena avvenuto). */
  lastOutcome: Map<string, AssessOutcome | { status: 'error'; message: string }>;
  /** Attende le valutazioni in corso (arresto ordinato, test). */
  idle(): Promise<void>;
}

const MAX_SINGLE = 4;

export function createAiServices(
  db: Db,
  deps: { provider: AiProvider | null; config: AiConfig; log: Logger; workerActive?: boolean; wake?: () => void },
): AiServices {
  const running = new Set<string>();
  const pending = new Set<Promise<unknown>>();
  const lastOutcome: AiServices['lastOutcome'] = new Map();
  return {
    provider: deps.provider,
    config: deps.config,
    workerActive: deps.workerActive ?? false,
    wake: deps.wake ?? (() => undefined),
    running,
    lastOutcome,
    start(businessId, opts) {
      if (running.has(businessId)) return 'already_running';
      if (running.size >= MAX_SINGLE) return 'busy';
      running.add(businessId);
      lastOutcome.delete(businessId);
      const p = assessBusiness(db, deps.provider, deps.config, businessId, {
        trigger: 'manual',
        userId: opts.userId,
        force: opts.force,
      })
        .then((r) => lastOutcome.set(businessId, r))
        .catch((error) => {
          deps.log.warn('valutazione AI non riuscita', { error, businessId });
          lastOutcome.set(businessId, { status: 'error', message: 'Valutazione non riuscita per un errore interno.' });
        })
        .finally(() => {
          running.delete(businessId);
          pending.delete(p);
        });
      pending.add(p);
      return 'started';
    },
    async idle() {
      await Promise.all([...pending]);
    },
  };
}
