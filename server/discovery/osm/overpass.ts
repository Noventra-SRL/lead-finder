import { createHash } from 'node:crypto';
import type { ResultCache } from '../cache.ts';
import { CATEGORIES, type CategoryId } from '../categories.ts';
import { sectorsInOrder } from '../sectors.ts';
import {
  ProviderError,
  type DiscoveryProvider,
  type DiscoveryUnitSpec,
  type ProviderInfo,
  type RetryInfo,
  type UnitResult,
} from '../types.ts';
import { OSM_PROVIDER, parseOverpassResponse } from './normalize.ts';
import { buildUnitQuery } from './query.ts';
import { OSM_CATEGORIES } from './tags.ts';

/*
 * Fornitore OpenStreetMap tramite un endpoint Overpass API configurato (DISCOVERY_OVERPASS_URL).
 *
 * Regole d'uso rispettate (https://dev.overpass-api.de/overpass-doc/en/preface/commons.html):
 *  - una richiesta alla volta per processo e un intervallo minimo tra l'inizio di due richieste;
 *  - timeout e memoria massima dichiarati nella query;
 *  - 429 (limite di frequenza) e 502/503/504 (server occupato): nuovi tentativi limitati con attesa crescente,
 *    rispettando Retry-After; poi l'errore arriva al job, che lo mostra e permette di riprendere più tardi;
 *  - User-Agent identificabile con un recapito;
 *  - risultati in cache: la stessa ricerca entro la validità non viene ripetuta.
 * Le istanze pubbliche non garantiscono capacità per uso continuativo o commerciale: per un uso regolare
 * va configurata un'istanza propria o un servizio dedicato.
 */

export interface OverpassConfig {
  /** Endpoint completo, es. https://overpass-api.de/api/interpreter; null = fornitore non configurato. */
  endpoint: string | null;
  userAgent: string;
  minIntervalMs: number;
  timeoutSeconds: number;
  maxsizeBytes: number;
  maxRetries: number;
  maxResponseBytes: number;
  cacheTtlMs: number;
}

export interface Clock {
  now(): number;
  sleep(ms: number, signal: AbortSignal): Promise<void>;
}

export const realClock: Clock = {
  now: () => Date.now(),
  sleep: (ms, signal) =>
    new Promise((resolve, reject) => {
      if (signal.aborted) return reject(abortError());
      const timer = setTimeout(() => {
        signal.removeEventListener('abort', onAbort);
        resolve();
      }, ms);
      const onAbort = () => {
        clearTimeout(timer);
        reject(abortError());
      };
      signal.addEventListener('abort', onAbort, { once: true });
    }),
};

const abortError = () => new ProviderError('aborted', 'Ricerca interrotta.');

const ATTRIBUTION = {
  text: '© OpenStreetMap contributors',
  url: 'https://www.openstreetmap.org/copyright',
  license: 'ODbL 1.0',
  licenseUrl: 'https://opendatacommons.org/licenses/odbl/1-0/',
};

export const OVERPASS_SETUP_HINT =
  'Nessun server OpenStreetMap configurato. Imposta DISCOVERY_OVERPASS_URL nel file .env (es. un’istanza Overpass ' +
  'propria, oppure https://overpass-api.de/api/interpreter per un uso occasionale) e riavvia l’API.';

/** Serializza le richieste e garantisce un intervallo minimo tra l'inizio di due richieste consecutive. */
class RequestGate {
  private tail: Promise<void> = Promise.resolve();
  private lastStart = 0;
  private readonly clock: Clock;
  private readonly minIntervalMs: number;

  constructor(clock: Clock, minIntervalMs: number) {
    this.clock = clock;
    this.minIntervalMs = minIntervalMs;
  }

  run<T>(signal: AbortSignal, fn: () => Promise<T>): Promise<T> {
    const result = this.tail.then(async () => {
      const wait = this.lastStart + this.minIntervalMs - this.clock.now();
      if (wait > 0) await this.clock.sleep(wait, signal);
      if (signal.aborted) throw abortError();
      this.lastStart = this.clock.now();
      return fn();
    });
    // la coda prosegue anche se una richiesta fallisce
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

export class OverpassProvider implements DiscoveryProvider {
  private readonly config: OverpassConfig;
  private readonly cache: ResultCache | null;
  private readonly clock: Clock;
  private readonly fetchImpl: typeof fetch;
  private readonly gate: RequestGate;
  /** Richieste HTTP inviate da questo processo (per i contatori d'uso e i test). */
  requestsSent = 0;

  constructor(config: OverpassConfig, deps: { cache?: ResultCache | null; clock?: Clock; fetch?: typeof fetch } = {}) {
    this.config = config;
    this.cache = deps.cache ?? null;
    this.clock = deps.clock ?? realClock;
    this.fetchImpl = deps.fetch ?? fetch;
    this.gate = new RequestGate(this.clock, config.minIntervalMs);
  }

  info(): ProviderInfo {
    const configured = this.config.endpoint !== null;
    return {
      id: OSM_PROVIDER,
      label: 'OpenStreetMap (Overpass API)',
      configured,
      ...(configured ? { endpointHost: new URL(this.config.endpoint!).host } : { setupHint: OVERPASS_SETUP_HINT }),
      attribution: ATTRIBUTION,
      supportsRadius: true,
      categories: (Object.keys(CATEGORIES) as CategoryId[]).map((id) => ({
        id,
        coverage: OSM_CATEGORIES[id].coverage,
        ...(OSM_CATEGORIES[id].note ? { note: OSM_CATEGORIES[id].note } : {}),
      })),
    };
  }

  async fetchUnit(
    unit: DiscoveryUnitSpec,
    categories: CategoryId[],
    limitPerArea: number,
    signal: AbortSignal,
    onRetry?: (info: RetryInfo) => void,
    options: { sectors?: string[] } = {},
  ): Promise<UnitResult> {
    if (!this.config.endpoint) throw new ProviderError('not_configured', OVERPASS_SETUP_HINT);
    const sectors = options.sectors?.length ? sectorsInOrder(options.sectors) : undefined;
    const query = buildUnitQuery(
      unit,
      categories,
      limitPerArea,
      { timeoutSeconds: this.config.timeoutSeconds, maxsizeBytes: this.config.maxsizeBytes },
      sectors,
    );
    // il formato dei record in cache cambia con i campi normalizzati (Fase 6: settore e recapiti): mai riusare il vecchio
    const key = `${OSM_PROVIDER}:${createHash('sha256')
      .update(`record-v2\n${categories.join(',')}\n${(options.sectors ?? []).join(',')}\n${query}`)
      .digest('hex')}`;
    const cached = await this.cache?.get(key);
    if (cached) return { ...cached.value, fromCache: true, fetchedAt: cached.fetchedAt, requests: 0 };

    let requests = 0;
    for (let attempt = 0; ; attempt++) {
      try {
        requests++;
        const fetchedAt = new Date(this.clock.now());
        const body = await this.gate.run(signal, () => this.post(query, signal));
        const parsed = parseOverpassResponse(body, categories, options.sectors);
        await this.cache?.set(key, OSM_PROVIDER, parsed, fetchedAt, this.config.cacheTtlMs);
        return { ...parsed, fromCache: false, fetchedAt, requests };
      } catch (error) {
        if (!(error instanceof ProviderError)) throw error;
        const transient = error.kind === 'rate_limited' || error.kind === 'unavailable';
        if (!transient || !error.retryable || attempt >= this.config.maxRetries || signal.aborted) {
          error.attempts = requests;
          throw error;
        }
        // attesa crescente: 15 s, 30 s, 60 s… (massimo 2 minuti), o quella indicata dal server se maggiore
        const waitMs = Math.max(Math.min(15_000 * 2 ** attempt, 120_000), error.retryAfterMs ?? 0);
        onRetry?.({ attempt: attempt + 1, maxAttempts: this.config.maxRetries + 1, waitMs, reason: error.message });
        await this.clock.sleep(waitMs, signal);
      }
    }
  }

  private async post(query: string, signal: AbortSignal): Promise<unknown> {
    this.requestsSent++;
    // il server interrompe la query dopo timeoutSeconds; qui si attende un margine in più per il trasferimento
    const timeout = AbortSignal.timeout((this.config.timeoutSeconds + 30) * 1000);
    let res: Response;
    try {
      res = await this.fetchImpl(this.config.endpoint!, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded; charset=utf-8',
          Accept: 'application/json',
          'User-Agent': this.config.userAgent,
        },
        body: new URLSearchParams({ data: query }).toString(),
        signal: AbortSignal.any([signal, timeout]),
        redirect: 'error',
      });
    } catch (error) {
      if (signal.aborted) throw abortError();
      if (timeout.aborted)
        throw new ProviderError('unavailable', 'Il server OpenStreetMap non ha risposto in tempo.', {
          retryable: true,
        });
      throw new ProviderError('unavailable', `Server OpenStreetMap non raggiungibile (${(error as Error).message}).`, {
        retryable: true,
      });
    }

    if (res.status === 429) {
      await res.body?.cancel();
      const retryAfter = Number(res.headers.get('retry-after'));
      throw new ProviderError('rate_limited', 'Limite di richieste del server OpenStreetMap raggiunto.', {
        retryable: true,
        retryAfterMs: Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter, 600) * 1000 : undefined,
      });
    }
    if (res.status === 502 || res.status === 503 || res.status === 504) {
      await res.body?.cancel();
      throw new ProviderError('unavailable', `Server OpenStreetMap occupato o sovraccarico (HTTP ${res.status}).`, {
        retryable: true,
      });
    }
    if (res.status === 400) {
      await res.body?.cancel();
      throw new ProviderError('invalid_response', 'Il server OpenStreetMap ha rifiutato la richiesta (HTTP 400).');
    }
    if (!res.ok) {
      await res.body?.cancel();
      throw new ProviderError('unavailable', `Risposta inattesa dal server OpenStreetMap (HTTP ${res.status}).`, {
        retryable: res.status >= 500,
      });
    }
    if (!/json/i.test(res.headers.get('content-type') ?? '')) {
      await res.body?.cancel();
      throw new ProviderError('invalid_response', 'Il server OpenStreetMap non ha risposto in formato JSON.');
    }

    // lettura con limite di dimensione: una risposta enorme non deve esaurire la memoria del processo
    const reader = res.body!.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > this.config.maxResponseBytes) {
          await reader.cancel();
          throw new ProviderError('too_large', 'Risposta di OpenStreetMap troppo grande: verrà divisa in parti.');
        }
        chunks.push(value);
      }
    } catch (error) {
      if (error instanceof ProviderError) throw error;
      if (signal.aborted) throw abortError();
      throw new ProviderError('unavailable', 'Trasferimento dei dati da OpenStreetMap interrotto.', {
        retryable: true,
      });
    }
    try {
      return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
      throw new ProviderError('invalid_response', 'Risposta di OpenStreetMap non leggibile.');
    }
  }
}

export function overpassUserAgent(version: string, contact: string | null) {
  return `NoventraLeadFinder/${version} (+${contact ?? 'https://www.noventra.it'})`;
}
