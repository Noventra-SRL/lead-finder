import { describe, expect, it } from 'vitest';
import type { Clock } from '../../discovery/osm/overpass.ts';
import { PageSpeedProvider, parsePageSpeed, type PageSpeedConfig } from './pagespeed.ts';

/* PageSpeed Insights con risposte simulate (forma della risposta reale v5). Nessuna richiesta a Google. */

const KEY = 'chiave-segreta-di-prova';

function psiBody(over: { score?: number | null; field?: boolean; origin?: boolean; runtimeError?: string } = {}) {
  const exp = {
    id: 'https://farmacia.example.it/',
    overall_category: 'AVERAGE',
    metrics: {
      LARGEST_CONTENTFUL_PAINT_MS: { percentile: 3100, category: 'AVERAGE' },
      CUMULATIVE_LAYOUT_SHIFT_SCORE: { percentile: 12, category: 'AVERAGE' },
      INTERACTION_TO_NEXT_PAINT: { percentile: 280, category: 'AVERAGE' },
      FIRST_CONTENTFUL_PAINT_MS: { percentile: 1900, category: 'AVERAGE' },
    },
  };
  return {
    lighthouseResult: {
      lighthouseVersion: '12.2.1',
      ...(over.runtimeError ? { runtimeError: { code: over.runtimeError, message: 'x' } } : {}),
      categories: { performance: { score: over.score === undefined ? 0.47 : over.score } },
      audits: {
        'largest-contentful-paint': { numericValue: 5321.4 },
        'cumulative-layout-shift': { numericValue: 0.031 },
        'first-contentful-paint': { numericValue: 2210 },
        'speed-index': { numericValue: 6100 },
        // total-blocking-time assente: deve risultare null, non zero
      },
    },
    ...(over.field ? { loadingExperience: exp } : {}),
    ...(over.origin
      ? { loadingExperience: { id: 'x', metrics: {}, origin_fallback: true }, originLoadingExperience: exp }
      : {}),
  };
}

const config = (over: Partial<PageSpeedConfig> = {}): PageSpeedConfig => ({
  apiKey: KEY,
  enabled: true,
  endpoint: 'https://pagespeed.example.test/runPagespeed',
  timeoutMs: 500,
  maxRetries: 2,
  minIntervalMs: 0,
  cacheTtlMs: 3_600_000,
  ...over,
});

function fakeClock(): Clock {
  let t = 1_000_000;
  return { now: () => t, sleep: async (ms) => void (t += ms) };
}

function fetchSequence(replies: (() => Response | Promise<Response>)[]) {
  const urls: string[] = [];
  const impl = (async (input: string | URL | Request) => {
    urls.push(String(input));
    const next = replies.shift();
    if (!next) throw new Error('nessuna risposta prevista');
    return next();
  }) as typeof fetch;
  return { impl, urls };
}
const json = (status: number, body: unknown) => () =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const s = () => new AbortController().signal;

describe('lettura della risposta', () => {
  it('laboratorio e dati reali separati; metriche assenti = null', () => {
    const r = parsePageSpeed(psiBody({ field: true }));
    expect(r.lab).toEqual({
      performanceScore: 47,
      lcpMs: 5321.4,
      cls: 0.031,
      fcpMs: 2210,
      speedIndexMs: 6100,
      tbtMs: null,
    });
    expect(r.field).toEqual({
      scope: 'url',
      overall: 'AVERAGE',
      lcpMs: 3100,
      cls: 0.12,
      inpMs: 280,
      fcpMs: 1900,
      ttfbMs: null,
    });
    expect(parsePageSpeed(psiBody()).field).toBeNull();
    expect(parsePageSpeed(psiBody({ origin: true })).field?.scope).toBe('origin');
    expect(parsePageSpeed(psiBody({ score: null })).lab.performanceScore).toBeNull();
  });
});

describe('fornitore PageSpeed Insights', () => {
  it('senza chiave: non configurato, nessuna richiesta', async () => {
    const f = fetchSequence([]);
    const p = new PageSpeedProvider(config({ apiKey: null }), { fetch: f.impl });
    expect(p.configured).toBe(false);
    expect(await p.analyze('https://x.it/', 'mobile', s())).toMatchObject({ status: 'error', errorKind: 'rejected' });
    expect(f.urls).toEqual([]);
  });

  it('successo: metriche, strategia e data; la chiave non compare nel risultato', async () => {
    const f = fetchSequence([json(200, psiBody({ field: true }))]);
    const p = new PageSpeedProvider(config(), { fetch: f.impl, clock: fakeClock() });
    const r = await p.analyze('https://farmacia.example.it/', 'mobile', s());
    expect(r).toMatchObject({
      status: 'ok',
      strategy: 'mobile',
      lighthouseVersion: '12.2.1',
      lab: { performanceScore: 47 },
      fromCache: false,
    });
    expect(f.urls[0]).toContain('strategy=mobile');
    expect(f.urls[0]).toContain('category=performance');
    expect(JSON.stringify(r)).not.toContain(KEY);
  });

  it('quota esaurita (429): errore "quota" e nessuna nuova richiesta per un’ora', async () => {
    const f = fetchSequence([json(429, { error: { code: 429, message: 'Quota exceeded' } })]);
    const p = new PageSpeedProvider(config(), { fetch: f.impl, clock: fakeClock() });
    expect(await p.analyze('https://a.it/', 'mobile', s())).toMatchObject({ status: 'error', errorKind: 'quota' });
    expect(await p.analyze('https://b.it/', 'mobile', s())).toMatchObject({ status: 'error', errorKind: 'quota' });
    expect(f.urls).toHaveLength(1);
  });

  it('errori temporanei: nuovi tentativi limitati, poi "unavailable"', async () => {
    const f = fetchSequence([json(500, {}), json(503, {}), json(500, {})]);
    const p = new PageSpeedProvider(config({ maxRetries: 2 }), { fetch: f.impl, clock: fakeClock() });
    expect(await p.analyze('https://a.it/', 'desktop', s())).toMatchObject({
      status: 'error',
      errorKind: 'unavailable',
      strategy: 'desktop',
    });
    expect(f.urls).toHaveLength(3);
  });

  it('nuovo tentativo riuscito dopo un errore temporaneo', async () => {
    const f = fetchSequence([json(502, {}), json(200, psiBody())]);
    const p = new PageSpeedProvider(config(), { fetch: f.impl, clock: fakeClock() });
    expect((await p.analyze('https://a.it/', 'mobile', s())).status).toBe('ok');
  });

  it('timeout', async () => {
    // server che non risponde mai: solo il segnale di timeout chiude la richiesta
    const silent = ((_u: string, init?: RequestInit) =>
      new Promise<Response>((_, reject) =>
        init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))),
      )) as typeof fetch;
    const p = new PageSpeedProvider(config({ maxRetries: 0, timeoutMs: 100 }), { fetch: silent, clock: fakeClock() });
    expect(await p.analyze('https://a.it/', 'mobile', s())).toMatchObject({ status: 'error', errorKind: 'timeout' });
  });

  it('risposta malformata o pagina non analizzabile: errore esplicito, nessuna metrica inventata', async () => {
    const bad = new PageSpeedProvider(config(), {
      fetch: fetchSequence([json(200, { lighthouseResult: { audits: 'x' } })]).impl,
      clock: fakeClock(),
    });
    expect(await bad.analyze('https://a.it/', 'mobile', s())).toMatchObject({
      status: 'error',
      errorKind: 'invalid_response',
    });
    const notJson = new PageSpeedProvider(config(), {
      fetch: fetchSequence([() => new Response('<html>', { status: 200 })]).impl,
      clock: fakeClock(),
    });
    expect(await notJson.analyze('https://a.it/', 'mobile', s())).toMatchObject({
      status: 'error',
      errorKind: 'invalid_response',
    });
    const target = new PageSpeedProvider(config(), {
      fetch: fetchSequence([
        json(400, {
          error: {
            message:
              'Lighthouse returned error: FAILED_DOCUMENT_REQUEST. Lighthouse was unable to reliably load the page',
          },
        }),
      ]).impl,
      clock: fakeClock(),
    });
    expect(await target.analyze('https://a.it/', 'mobile', s())).toMatchObject({
      status: 'error',
      errorKind: 'target_failed',
    });
    const runtime = new PageSpeedProvider(config(), {
      fetch: fetchSequence([json(200, psiBody({ runtimeError: 'NO_FCP' }))]).impl,
      clock: fakeClock(),
    });
    expect(await runtime.analyze('https://a.it/', 'mobile', s())).toMatchObject({
      status: 'error',
      errorKind: 'target_failed',
    });
    const key = new PageSpeedProvider(config(), {
      fetch: fetchSequence([json(403, { error: { message: 'API key not valid' } })]).impl,
      clock: fakeClock(),
    });
    const r = await key.analyze('https://a.it/', 'mobile', s());
    expect(r).toMatchObject({ status: 'error', errorKind: 'rejected' });
    expect(JSON.stringify(r)).not.toContain(KEY);
  });

  it('cache: la stessa misura non viene ripetuta', async () => {
    const store = new Map<string, { value: never; fetchedAt: Date }>();
    const cache = {
      get: async (k: string) => store.get(k) ?? null,
      set: async (k: string, _p: string, value: never, fetchedAt: Date) => void store.set(k, { value, fetchedAt }),
    };
    const f = fetchSequence([json(200, psiBody())]);
    const p = new PageSpeedProvider(config(), { fetch: f.impl, clock: fakeClock(), cache });
    await p.analyze('https://a.it/', 'mobile', s());
    expect(await p.analyze('https://a.it/', 'mobile', s())).toMatchObject({ status: 'ok', fromCache: true });
    expect(f.urls).toHaveLength(1);
  });
});
