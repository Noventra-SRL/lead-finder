import { createHash } from 'node:crypto';
import type { CategoryId } from '../discovery/categories.ts';
import type { Logger } from '../logger.ts';
import {
  evaluate,
  summarize,
  type AuditContext,
  type HttpsCheck,
  type InspectedPage,
  type SitemapCheck,
  type WebsiteStatus,
} from './checks.ts';
import type { Finding } from './findings.ts';
import { extract } from './html.ts';
import { FetchError, safeFetch, type FetchPolicy, type FetchResult } from './net/safeFetch.ts';
import type { PerformanceOutcome, PerformanceProvider, Strategy } from './performance/pagespeed.ts';
import { isAllowed, parseRobots, robotsMissing, robotsUnavailable, type Robots } from './robots.ts';
import { detectSignals } from './signals.ts';
import { bareHost, sameSite } from './url.ts';

/*
 * Audit di un sito: poche richieste, in sequenza, rispettose.
 *  1. robots.txt dell'origine (RFC 9309); se vieta la pagina principale, ci si ferma;
 *  2. pagina principale, con un secondo tentativo e le varianti comuni (https/http, con o senza www) prima di
 *     concludere che il sito non è raggiungibile;
 *  3. verifica HTTPS (certificato valido; http:// reindirizza a https://);
 *  4. sitemap (indicata in robots.txt o /sitemap.xml), senza scaricarne le pagine;
 *  5. fino a maxPages − 1 pagine interne pertinenti (contatti, servizi…), nello stesso sito e consentite da robots.txt;
 *  6. prestazioni con il fornitore facoltativo;
 *  7. rilievi e riepilogo.
 * Tra due richieste allo stesso host passa almeno hostIntervalMs (o il Crawl-delay del sito, fino a 10 s);
 * un 429 o 503 ferma le richieste successive al sito.
 */

export const AUDIT_VERSION = 1;

export interface AuditSettings {
  maxPages: number;
  strategies: Strategy[];
  usePerformance: boolean;
}

export interface EngineDeps {
  policy: FetchPolicy;
  hostIntervalMs: number;
  performance: PerformanceProvider | null;
  hosts: HostScheduler;
  log: Logger;
  /** Attesa tra i tentativi (sostituibile nei test). */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

export interface AuditOutcome {
  runStatus: 'completed' | 'partial';
  websiteStatus: WebsiteStatus;
  originalUrl: string;
  finalUrl: string | null;
  pages: InspectedPage[];
  findings: Finding[];
  performance: PerformanceOutcome[];
  limitations: string[];
  summary: ReturnType<typeof summarize>;
  startedAt: Date;
  finishedAt: Date;
}

/** Impronta della configurazione: due audit con la stessa impronta sono confrontabili. */
export function configKey(
  settings: AuditSettings,
  policy: Pick<FetchPolicy, 'maxBytes' | 'totalTimeoutMs' | 'maxRedirects'>,
): string {
  const canonical = JSON.stringify({
    v: AUDIT_VERSION,
    maxPages: settings.maxPages,
    strategies: settings.usePerformance ? [...settings.strategies].sort() : [],
    maxBytes: policy.maxBytes,
    timeout: policy.totalTimeoutMs,
    redirects: policy.maxRedirects,
  });
  return createHash('sha256').update(canonical).digest('hex').slice(0, 16);
}

/** Intervallo minimo tra richieste allo stesso host, condiviso tra audit contemporanei. */
export class HostScheduler {
  private readonly next = new Map<string, number>();
  async wait(
    host: string,
    intervalMs: number,
    signal: AbortSignal,
    sleep: (ms: number, s: AbortSignal) => Promise<void>,
  ) {
    const key = bareHost(host);
    const now = Date.now();
    const at = Math.max(now, this.next.get(key) ?? 0);
    this.next.set(key, at + intervalMs);
    if (this.next.size > 5000) for (const [k, t] of this.next) if (t < now) this.next.delete(k);
    if (at > now) await sleep(at - now, signal);
  }
}

const defaultSleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal.aborted) return reject(new FetchError('aborted', 'Audit interrotto.'));
    const t = setTimeout(resolve, ms);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(t);
        reject(new FetchError('aborted', 'Audit interrotto.'));
      },
      { once: true },
    );
  });

const NON_PAGE =
  /\.(pdf|jpe?g|png|gif|webp|svg|zip|rar|7z|docx?|xlsx?|pptx?|mp4|mp3|avi|mov|ics|xml|json|txt|exe|dmg|apk)$/i;
const PRIORITY: [RegExp, number][] = [
  [/contatt|contact|dove[-_ ]siamo|come[-_ ]raggiungerci/, 10],
  [/servizi|services|prodotti|products|catalogo|shop|negozio/, 8],
  [/men[uù]|camere|rooms|prenot|booking|orari|corsi/, 8],
  [/chi[-_ ]siamo|about|azienda|la[-_ ]farmacia|storia/, 4],
];

function pageFromResult(r: FetchResult, role: InspectedPage['role'], isInternal: (u: URL) => boolean): InspectedPage {
  const isHtml = r.body !== null && /html/i.test(r.contentType ?? '');
  return {
    role,
    requestedUrl: r.requestedUrl,
    finalUrl: r.finalUrl,
    status: r.status,
    contentType: r.contentType,
    bytes: r.bytes,
    truncated: r.truncated,
    ttfbMs: r.ttfbMs,
    totalMs: r.totalMs,
    redirects: r.redirects,
    headers: r.headers,
    tls: r.tls,
    measurements: isHtml && r.status < 400 ? extract(r.body!, r.finalUrl, isInternal) : null,
    html: isHtml ? r.body : null,
    error: null,
  };
}

function failedPage(url: string, role: InspectedPage['role'], e: FetchError): InspectedPage {
  return {
    role,
    requestedUrl: url,
    finalUrl: url,
    status: null,
    contentType: null,
    bytes: 0,
    truncated: false,
    ttfbMs: null,
    totalMs: null,
    redirects: e.redirects,
    headers: {},
    tls: null,
    measurements: null,
    html: null,
    error: { kind: e.kind, code: e.code, message: e.message },
  };
}

/** Accesso negato o limitato dal sito: non va aggirato. */
const accessDenied = (r: FetchResult) =>
  r.status === 401 ||
  r.status === 403 ||
  r.status === 429 ||
  (r.status === 503 && (r.headers['cf-mitigated'] === 'challenge' || /cloudflare/i.test(r.headers.server ?? ''))) ||
  r.headers['cf-mitigated'] === 'challenge';

export async function runAudit(
  originalUrl: string,
  category: CategoryId,
  settings: AuditSettings,
  deps: EngineDeps,
  signal: AbortSignal,
): Promise<AuditOutcome> {
  const startedAt = new Date();
  const sleep = deps.sleep ?? defaultSleep;
  const limitations: string[] = [];
  const robotsCache = new Map<string, Robots>();
  let crawlDelayMs = deps.hostIntervalMs;
  let rateLimited = false;
  const pages: InspectedPage[] = [];

  const request = async (url: string, accept: 'html' | 'text' | 'xml') => {
    await deps.hosts.wait(new URL(url).hostname, crawlDelayMs, signal, sleep);
    return safeFetch(url, deps.policy, { accept, signal });
  };

  const robotsFor = async (origin: URL): Promise<Robots> => {
    const key = origin.origin;
    const known = robotsCache.get(key);
    if (known) return known;
    let robots: Robots;
    try {
      const r = await request(`${key}/robots.txt`, 'text');
      if (r.status >= 200 && r.status < 300) robots = parseRobots(r.body ?? '', key);
      else if (r.status >= 400 && r.status < 500) robots = robotsMissing();
      else robots = robotsUnavailable();
    } catch (e) {
      const err = e as FetchError;
      // errori di rete: è il sito a non essere raggiungibile (lo decide chi chiama); niente in cache
      if (['aborted', 'dns', 'connection', 'timeout', 'tls', 'blocked', 'invalid_url'].includes(err.kind)) throw err;
      // risposta non valida o troppi redirect: per l'RFC 9309 robots.txt è indefinito, quindi tutto vietato
      robots = robotsUnavailable();
    }
    if (robots.crawlDelaySeconds !== null)
      crawlDelayMs = Math.max(deps.hostIntervalMs, Math.min(robots.crawlDelaySeconds, 10) * 1000);
    robotsCache.set(key, robots);
    return robots;
  };

  // ---- 1-2. robots.txt e pagina principale, con varianti e un nuovo tentativo ----
  const start = new URL(originalUrl);
  const variants = [start.toString()];
  const flip = new URL(start);
  flip.protocol = start.protocol === 'https:' ? 'http:' : 'https:';
  variants.push(flip.toString());
  const www = new URL(start);
  www.hostname = start.hostname.startsWith('www.') ? start.hostname.slice(4) : `www.${start.hostname}`;
  variants.push(www.toString());

  let home: InspectedPage | null = null;
  // errore dell'indirizzo indicato: è quello che descrive lo stato del sito, le varianti sono solo tentativi in più
  let firstError: FetchError | null = null;
  let tlsErrorCode: string | null = null;
  let websiteStatus: WebsiteStatus = 'unreachable';
  let statusReason: string | null = null;
  let robots: Robots | null = null;
  const isInternal = (u: URL) => sameSite(u, new URL(home?.finalUrl ?? originalUrl));

  outer: for (const [i, candidate] of variants.entries()) {
    const url = new URL(candidate);
    // il primo indirizzo si riprova una volta prima di passare alle varianti
    for (let attempt = 0; attempt < (i === 0 ? 2 : 1); attempt++) {
      try {
        robots = await robotsFor(url);
        if (!isAllowed(robots, `${url.pathname}${url.search}`)) {
          websiteStatus = 'blocked';
          statusReason =
            robots.source === 'unavailable'
              ? 'robots.txt non leggibile (errore del server): per prudenza nessuna pagina esaminata'
              : 'robots.txt vieta l’accesso alla pagina principale';
          limitations.push(statusReason);
          break outer;
        }
        const r = await request(candidate, 'html');
        home = pageFromResult(r, 'home', (u) => sameSite(u, new URL(r.finalUrl)));
        if (i > 0)
          limitations.push(
            `L’indirizzo indicato (${originalUrl}) non ha risposto; è stata usata la variante ${candidate}.`,
          );
        break outer;
      } catch (e) {
        const err = e as FetchError;
        if (err.kind === 'aborted') throw err;
        if (i === 0) firstError = err;
        if (err.kind === 'tls' && new URL(candidate).hostname === start.hostname) tlsErrorCode = err.code ?? 'TLS';
        // errori non temporanei: inutile riprovare lo stesso indirizzo
        if (['blocked', 'invalid_url', 'too_many_redirects', 'tls', 'http_protocol'].includes(err.kind)) break;
        if (attempt === 0 && i === 0) await sleep(3000, signal);
      }
    }
  }

  if (home) pages.push(home);
  else if (websiteStatus !== 'blocked' && firstError) {
    const lastError = firstError;
    websiteStatus =
      lastError.kind === 'timeout'
        ? 'timeout'
        : lastError.kind === 'blocked'
          ? 'blocked'
          : lastError.kind === 'invalid_url'
            ? 'invalid_url'
            : 'unreachable';
    statusReason = lastError.code ? `${lastError.kind}: ${lastError.code}` : `${lastError.kind}: ${lastError.message}`;
    if (lastError.kind === 'blocked')
      limitations.push('Il sito porta a una destinazione non pubblica: per sicurezza non è stato contattato.');
    pages.push(failedPage(originalUrl, 'home', lastError));
  }

  let https: HttpsCheck = { available: null, tlsErrorCode, certDaysToExpiry: null, httpRedirectsToHttps: null };
  let sitemap: SitemapCheck | null = null;

  if (home?.status) {
    const final = new URL(home.finalUrl);
    if (accessDenied({ status: home.status, headers: home.headers } as FetchResult)) {
      websiteStatus = 'blocked';
      statusReason = `HTTP ${home.status}${home.headers['cf-mitigated'] ? ' (protezione anti-bot)' : ''}`;
      limitations.push(
        'Il sito ha negato o limitato l’accesso automatico: l’audit non lo aggira e si ferma alla pagina principale.',
      );
      rateLimited = true;
    } else if (home.status >= 400) {
      websiteStatus = 'unreachable';
      statusReason = `HTTP ${home.status}`;
    } else {
      websiteStatus = bareHost(final.hostname) !== bareHost(start.hostname) ? 'redirected' : 'valid';
    }
    if (home.truncated)
      limitations.push(
        `La pagina principale supera il limite di ${Math.round(deps.policy.maxBytes / 1024)} KB: analizzata solo in parte.`,
      );
    // robots.txt del sito finale (può essere un altro dominio dopo i redirect); se non leggibile, nessuna altra pagina
    robots = await robotsFor(final).catch((e: FetchError) => {
      if (e.kind === 'aborted') throw e;
      return robotsUnavailable();
    });

    // ---- 3. HTTPS ----
    if (!rateLimited) {
      if (final.protocol === 'https:') {
        https = { available: true, tlsErrorCode: null, certDaysToExpiry: null, httpRedirectsToHttps: null };
        try {
          const plain = new URL(final);
          plain.protocol = 'http:';
          plain.pathname = '/';
          plain.search = '';
          const r = await request(plain.toString(), 'html');
          https.httpRedirectsToHttps = r.finalUrl.startsWith('https:');
        } catch (e) {
          if ((e as FetchError).kind === 'aborted') throw e;
          // http:// non raggiungibile (es. porta 80 chiusa): nessun contenuto in chiaro, quindi nessun problema
          https.httpRedirectsToHttps =
            (e as FetchError).kind === 'connection' || (e as FetchError).kind === 'timeout' ? true : null;
        }
      } else {
        try {
          const secure = new URL(final);
          secure.protocol = 'https:';
          const r = await request(secure.toString(), 'html');
          https = {
            available: r.status < 500,
            tlsErrorCode: null,
            certDaysToExpiry: null,
            httpRedirectsToHttps: false,
          };
        } catch (e) {
          const err = e as FetchError;
          if (err.kind === 'aborted') throw err;
          https = {
            available: false,
            tlsErrorCode: err.kind === 'tls' ? (err.code ?? 'TLS') : tlsErrorCode,
            certDaysToExpiry: null,
            httpRedirectsToHttps: false,
          };
        }
      }
    }
    // ---- 4. sitemap ----
    if (!rateLimited && home.measurements) {
      const fromRobots = robots.sitemaps.find((s) => {
        try {
          return sameSite(new URL(s), final);
        } catch {
          return false;
        }
      });
      const candidate = fromRobots ?? `${final.origin}/sitemap.xml`;
      sitemap = { found: false, url: candidate, source: fromRobots ? 'robots' : 'default', urlCount: null };
      if (isAllowed(robots, new URL(candidate).pathname)) {
        try {
          const r = await request(candidate, 'xml');
          if (r.status < 300 && r.body && /<(urlset|sitemapindex)[\s>]/i.test(r.body)) {
            sitemap = { ...sitemap, found: true, urlCount: (r.body.match(/<loc>/gi) ?? []).length };
          } else if (r.status === 429 || r.status === 503) rateLimited = true;
        } catch (e) {
          if ((e as FetchError).kind === 'aborted') throw e;
          sitemap = { ...sitemap, found: false };
        }
      } else limitations.push('robots.txt vieta la lettura della sitemap.');
    }

    // ---- 5. pagine interne ----
    if (home.measurements && settings.maxPages > 1 && !rateLimited) {
      const seen = new Set([home.finalUrl.replace(/\/$/, ''), home.requestedUrl.replace(/\/$/, '')]);
      const candidates = home.measurements.links
        .filter((l) => l.internal && !l.nofollow)
        .map((l) => ({ url: new URL(l.href), text: l.text.toLowerCase() }))
        .filter(
          ({ url }) =>
            (url.protocol === 'https:' || url.protocol === 'http:') &&
            sameSite(url, final) &&
            !NON_PAGE.test(url.pathname),
        )
        .map(({ url, text }) => {
          const key = `${url.pathname} ${text}`.toLowerCase();
          const score = PRIORITY.reduce((s, [re, w]) => (re.test(key) ? Math.max(s, w) : s), 0);
          return { url: url.toString(), score };
        })
        .filter((c) => c.score > 0)
        .sort((a, b) => b.score - a.score);
      let blockedByRobots = 0;
      for (const c of candidates) {
        if (pages.length >= settings.maxPages) break;
        const key = c.url.replace(/\/$/, '');
        if (seen.has(key)) continue;
        seen.add(key);
        const u = new URL(c.url);
        if (!isAllowed(robots, `${u.pathname}${u.search}`)) {
          blockedByRobots++;
          continue;
        }
        try {
          const r = await request(c.url, 'html');
          if (r.status === 429 || r.status === 503) {
            rateLimited = true;
            limitations.push(
              `Il sito ha chiesto di rallentare (HTTP ${r.status}): le pagine successive non sono state richieste.`,
            );
            break;
          }
          pages.push(pageFromResult(r, 'extra', isInternal));
        } catch (e) {
          const err = e as FetchError;
          if (err.kind === 'aborted') throw err;
          pages.push(failedPage(c.url, 'extra', err));
        }
      }
      if (blockedByRobots)
        limitations.push(
          `${blockedByRobots} ${blockedByRobots === 1 ? 'pagina non esaminata' : 'pagine non esaminate'} perché vietate da robots.txt.`,
        );
      if (!candidates.length)
        limitations.push('Nessuna pagina interna pertinente collegata dalla pagina principale: esaminata solo quella.');
    }
  }

  // giorni alla scadenza del certificato, dalla connessione HTTPS della pagina principale
  if (home?.tls && https.available) https.certDaysToExpiry = home.tls.daysToExpiry;

  // ---- 6. prestazioni ----
  const performance: PerformanceOutcome[] = [];
  if (
    settings.usePerformance &&
    home?.measurements &&
    home.status &&
    home.status < 400 &&
    websiteStatus !== 'blocked'
  ) {
    if (!deps.performance?.configured)
      limitations.push('Prestazioni non misurate: PageSpeed Insights non è configurato.');
    else
      for (const strategy of settings.strategies) {
        const r = await deps.performance.analyze(home.finalUrl, strategy, signal);
        performance.push(r);
        if (r.status === 'error') limitations.push(`Prestazioni (${strategy}) non disponibili: ${r.message}`);
      }
  } else if (!settings.usePerformance)
    limitations.push(
      deps.performance?.configured
        ? 'Prestazioni escluse da questa verifica.'
        : 'Prestazioni non misurate: PageSpeed Insights non è configurato.',
    );

  // ---- 7. rilievi ----
  const inspected = pages.filter((p) => p.measurements && p.html);
  const signals = inspected.length
    ? detectSignals(inspected.map((p) => ({ url: p.finalUrl, m: p.measurements!, html: p.html! })))
    : null;
  if (
    pages.some(
      (p) =>
        p.measurements &&
        p.html &&
        p.measurements.text.words < 60 &&
        p.measurements.scripts.external + p.measurements.scripts.inline >= 3,
    )
  )
    limitations.push(
      'Contenuti in parte generati da JavaScript, che l’audit non esegue: i rilievi sui contenuti hanno confidenza bassa.',
    );
  limitations.push('Indicatori mobile statici: nessun test visivo in un browser.');
  const ctx: AuditContext = {
    originalUrl,
    websiteStatus,
    statusReason,
    home,
    pages,
    robots,
    sitemap,
    https,
    signals,
    performance,
    category,
    limitations,
  };
  const findings = evaluate(ctx);
  const partial =
    rateLimited ||
    pages.some((p) => p.truncated) ||
    performance.some((p) => p.status === 'error') ||
    websiteStatus === 'blocked';
  deps.log.debug('audit completato', {
    url: originalUrl,
    websiteStatus,
    pagine: pages.length,
    rilievi: findings.length,
  });
  return {
    runStatus: partial ? 'partial' : 'completed',
    websiteStatus,
    originalUrl,
    finalUrl: home?.finalUrl ?? null,
    pages,
    findings,
    performance,
    limitations,
    summary: summarize(ctx, findings),
    startedAt,
    finishedAt: new Date(),
  };
}
