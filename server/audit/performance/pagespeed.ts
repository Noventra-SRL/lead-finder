import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { ResultCache } from '../../discovery/cache.ts';
import { realClock, type Clock } from '../../discovery/osm/overpass.ts';

/*
 * Prestazioni tramite Google PageSpeed Insights (API v5), integrazione FACOLTATIVA.
 *  - attiva solo con PAGESPEED_API_KEY (e AUDIT_PAGESPEED diverso da "off"); senza, l'audit HTML funziona comunque;
 *  - la chiave resta nel server: non compare nelle risposte dell'API, nei messaggi né nel registro;
 *  - dati di laboratorio (Lighthouse) e dati reali degli utenti (CrUX) restano separati; una metrica non restituita
 *    è null, mai zero;
 *  - timeout, nuovi tentativi con attesa crescente sugli errori temporanei, cache, intervallo minimo tra richieste;
 *  - quota esaurita (429): le richieste si sospendono per un'ora, l'audit prosegue senza prestazioni.
 */

export type Strategy = 'mobile' | 'desktop';

export interface LabMetrics {
  performanceScore: number | null;
  lcpMs: number | null;
  cls: number | null;
  fcpMs: number | null;
  speedIndexMs: number | null;
  tbtMs: number | null;
}

export interface FieldMetrics {
  /** 'url' = dati della pagina; 'origin' = dati dell'intero sito (quando la pagina non ne ha abbastanza). */
  scope: 'url' | 'origin';
  overall: string | null;
  lcpMs: number | null;
  cls: number | null;
  inpMs: number | null;
  fcpMs: number | null;
  ttfbMs: number | null;
}

export type PerformanceOutcome =
  | {
      status: 'ok';
      provider: 'pagespeed';
      strategy: Strategy;
      url: string;
      analyzedAt: string;
      lighthouseVersion: string | null;
      lab: LabMetrics;
      field: FieldMetrics | null;
      fromCache: boolean;
    }
  | {
      status: 'error';
      provider: 'pagespeed';
      strategy: Strategy;
      url: string;
      analyzedAt: string;
      errorKind: 'quota' | 'timeout' | 'unavailable' | 'target_failed' | 'invalid_response' | 'rejected';
      message: string;
    };

export interface PerformanceProvider {
  readonly id: string;
  readonly configured: boolean;
  analyze(url: string, strategy: Strategy, signal: AbortSignal): Promise<PerformanceOutcome>;
}

export interface PageSpeedConfig {
  apiKey: string | null;
  enabled: boolean;
  endpoint: string;
  timeoutMs: number;
  maxRetries: number;
  minIntervalMs: number;
  cacheTtlMs: number;
}

const num = z.number().finite();
const audit = z.object({ numericValue: num.optional() }).passthrough().optional();
const metric = z.object({ percentile: num.optional(), category: z.string().optional() }).passthrough().optional();
const experience = z
  .object({
    id: z.string().optional(),
    overall_category: z.string().optional(),
    origin_fallback: z.boolean().optional(),
    metrics: z
      .object({
        LARGEST_CONTENTFUL_PAINT_MS: metric,
        CUMULATIVE_LAYOUT_SHIFT_SCORE: metric,
        INTERACTION_TO_NEXT_PAINT: metric,
        FIRST_CONTENTFUL_PAINT_MS: metric,
        EXPERIMENTAL_TIME_TO_FIRST_BYTE: metric,
      })
      .passthrough()
      .optional(),
  })
  .passthrough()
  .optional();
const responseSchema = z.object({
  lighthouseResult: z.object({
    lighthouseVersion: z.string().optional(),
    runtimeError: z.object({ code: z.string().optional(), message: z.string().optional() }).passthrough().optional(),
    categories: z
      .object({ performance: z.object({ score: num.nullable().optional() }).passthrough().optional() })
      .passthrough(),
    audits: z.record(z.string(), audit),
  }),
  loadingExperience: experience,
  originLoadingExperience: experience,
  analysisUTCTimestamp: z.string().optional(),
});

const v = (x: { numericValue?: number } | undefined) => (x?.numericValue === undefined ? null : x.numericValue);
const p = (x: { percentile?: number } | undefined) => (x?.percentile === undefined ? null : x.percentile);

export function parsePageSpeed(body: unknown): {
  lab: LabMetrics;
  field: FieldMetrics | null;
  lighthouseVersion: string | null;
  runtimeError: string | null;
} {
  const r = responseSchema.parse(body);
  const a = r.lighthouseResult.audits;
  const score = r.lighthouseResult.categories.performance?.score;
  const lab: LabMetrics = {
    performanceScore: score === null || score === undefined ? null : Math.round(score * 100),
    lcpMs: v(a['largest-contentful-paint']),
    cls: v(a['cumulative-layout-shift']),
    fcpMs: v(a['first-contentful-paint']),
    speedIndexMs: v(a['speed-index']),
    tbtMs: v(a['total-blocking-time']),
  };
  // dati reali: quelli della pagina; se mancano, quelli dell'intero sito (dichiarato in "scope")
  const page = r.loadingExperience;
  const usePage = page?.metrics && !page.origin_fallback && Object.keys(page.metrics).length > 0;
  const exp = usePage ? page : r.originLoadingExperience?.metrics ? r.originLoadingExperience : null;
  let field: FieldMetrics | null = null;
  if (exp?.metrics) {
    const m = exp.metrics;
    const clsRaw = p(m.CUMULATIVE_LAYOUT_SHIFT_SCORE);
    field = {
      scope: usePage ? 'url' : 'origin',
      overall: exp.overall_category ?? null,
      lcpMs: p(m.LARGEST_CONTENTFUL_PAINT_MS),
      // CrUX esprime il CLS moltiplicato per 100
      cls: clsRaw === null ? null : clsRaw / 100,
      inpMs: p(m.INTERACTION_TO_NEXT_PAINT),
      fcpMs: p(m.FIRST_CONTENTFUL_PAINT_MS),
      ttfbMs: p(m.EXPERIMENTAL_TIME_TO_FIRST_BYTE),
    };
  }
  return {
    lab,
    field,
    lighthouseVersion: r.lighthouseResult.lighthouseVersion ?? null,
    runtimeError:
      r.lighthouseResult.runtimeError?.code && r.lighthouseResult.runtimeError.code !== 'NO_ERROR'
        ? r.lighthouseResult.runtimeError.code
        : null,
  };
}

class TransientError extends Error {}

export class PageSpeedProvider implements PerformanceProvider {
  readonly id = 'pagespeed';
  private readonly config: PageSpeedConfig;
  private readonly cache: ResultCache | null;
  private readonly clock: Clock;
  private readonly fetchImpl: typeof fetch;
  private lastStart = 0;
  private queue: Promise<void> = Promise.resolve();
  private quotaUntil = 0;
  /** Richieste HTTP inviate (per i test e i contatori d'uso). */
  requestsSent = 0;

  constructor(config: PageSpeedConfig, deps: { cache?: ResultCache | null; clock?: Clock; fetch?: typeof fetch } = {}) {
    this.config = config;
    this.cache = deps.cache ?? null;
    this.clock = deps.clock ?? realClock;
    this.fetchImpl = deps.fetch ?? fetch;
  }

  get configured() {
    return this.config.enabled && Boolean(this.config.apiKey);
  }

  async analyze(url: string, strategy: Strategy, signal: AbortSignal): Promise<PerformanceOutcome> {
    const now = () => new Date(this.clock.now()).toISOString();
    const fail = (
      errorKind: Extract<PerformanceOutcome, { status: 'error' }>['errorKind'],
      message: string,
    ): PerformanceOutcome => ({
      status: 'error',
      provider: 'pagespeed',
      strategy,
      url,
      analyzedAt: now(),
      errorKind,
      message,
    });
    if (!this.configured) return fail('rejected', 'PageSpeed Insights non configurato.');
    if (this.clock.now() < this.quotaUntil)
      return fail('quota', 'Quota di PageSpeed Insights esaurita: misura rimandata.');

    const key = `pagespeed:${createHash('sha256').update(`${strategy}\n${url}`).digest('hex')}`;
    const cached = await this.cache?.get(key);
    if (cached)
      return { ...(cached.value as unknown as Extract<PerformanceOutcome, { status: 'ok' }>), fromCache: true };

    for (let attempt = 0; ; attempt++) {
      try {
        const body = await this.serialized(signal, () => this.request(url, strategy, signal));
        let parsed: ReturnType<typeof parsePageSpeed>;
        try {
          parsed = parsePageSpeed(body);
        } catch {
          return fail('invalid_response', 'Risposta di PageSpeed Insights in un formato inatteso.');
        }
        if (parsed.runtimeError)
          return fail(
            'target_failed',
            `PageSpeed Insights non è riuscito ad analizzare la pagina (${parsed.runtimeError}).`,
          );
        const outcome: Extract<PerformanceOutcome, { status: 'ok' }> = {
          status: 'ok',
          provider: 'pagespeed',
          strategy,
          url,
          analyzedAt: now(),
          lighthouseVersion: parsed.lighthouseVersion,
          lab: parsed.lab,
          field: parsed.field,
          fromCache: false,
        };
        await this.cache?.set(key, 'pagespeed', outcome as never, new Date(this.clock.now()), this.config.cacheTtlMs);
        return outcome;
      } catch (error) {
        if (signal.aborted) return fail('timeout', 'Misura interrotta.');
        if (error instanceof QuotaError) {
          this.quotaUntil = this.clock.now() + 3_600_000;
          return fail('quota', 'Quota di PageSpeed Insights esaurita (HTTP 429): le misure riprenderanno più tardi.');
        }
        if (error instanceof TargetError) return fail('target_failed', error.message);
        if (error instanceof RejectedError) return fail('rejected', error.message);
        if (attempt >= this.config.maxRetries) {
          return error instanceof TimeoutError
            ? fail('timeout', 'PageSpeed Insights non ha risposto in tempo.')
            : fail('unavailable', 'PageSpeed Insights non disponibile al momento.');
        }
        await this.clock.sleep(Math.min(5_000 * 2 ** attempt, 60_000), signal).catch(() => undefined);
      }
    }
  }

  private serialized<T>(signal: AbortSignal, fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(async () => {
      const wait = this.lastStart + this.config.minIntervalMs - this.clock.now();
      if (wait > 0) await this.clock.sleep(wait, signal);
      this.lastStart = this.clock.now();
      return fn();
    });
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async request(url: string, strategy: Strategy, signal: AbortSignal): Promise<unknown> {
    const query = new URLSearchParams({
      url,
      strategy,
      category: 'performance',
      locale: 'it',
      key: this.config.apiKey!,
    });
    this.requestsSent++;
    let res: Response;
    const timeout = AbortSignal.timeout(this.config.timeoutMs);
    try {
      res = await this.fetchImpl(`${this.config.endpoint}?${query}`, {
        signal: AbortSignal.any([signal, timeout]),
        headers: { Accept: 'application/json' },
      });
    } catch {
      // nessun dettaglio dell'errore: l'URL della richiesta contiene la chiave
      if (timeout.aborted) throw new TimeoutError();
      throw new TransientError();
    }
    const text = await res.text().catch(() => '');
    if (res.status === 429) throw new QuotaError();
    if (res.status >= 500) throw new TransientError();
    if (res.status === 400) {
      const message = /"message"\s*:\s*"([^"]{0,300})/.exec(text)?.[1] ?? '';
      if (
        /FAILED_DOCUMENT_REQUEST|ERRORED_DOCUMENT_REQUEST|DNS_FAILURE|NOT_HTML|NO_FCP|DOCUMENT_REQUEST/i.test(message)
      )
        throw new TargetError(
          `PageSpeed Insights non è riuscito a caricare la pagina (${message.match(/[A-Z_]{6,}/)?.[0] ?? 'errore della pagina'}).`,
        );
      throw new RejectedError('PageSpeed Insights ha rifiutato la richiesta (HTTP 400).');
    }
    if (res.status === 403 || res.status === 401)
      throw new RejectedError('Chiave di PageSpeed Insights non valida o non autorizzata.');
    if (!res.ok) throw new TransientError();
    try {
      return JSON.parse(text);
    } catch {
      return null;
    }
  }
}

class QuotaError extends Error {}
class TimeoutError extends Error {}
class TargetError extends Error {}
class RejectedError extends Error {}
