import { createServer, type AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { silentLogger } from '../logger.ts';
import type { FindingCode } from './findings.ts';
import { HostScheduler, runAudit, type AuditSettings } from './engine.ts';
import { goodPharmacyHome, poorRestaurantHome, startFakeSite, type FakeSite } from './fakeSite.ts';
import type { FetchPolicy } from './net/safeFetch.ts';
import type { PerformanceOutcome, PerformanceProvider } from './performance/pagespeed.ts';
import { isAllowed, parseRobots } from './robots.ts';
import { websiteTarget } from './url.ts';

/* Audit completo contro siti finti locali (DATI DI TEST, pagine "di Prova"). Nessuna richiesta verso Internet. */

let sites: FakeSite[] = [];
afterEach(async () => {
  await Promise.all(sites.map((s) => s.close()));
  sites = [];
});
async function site(routes: Parameters<typeof startFakeSite>[0]) {
  const s = await startFakeSite(routes);
  sites.push(s);
  return s;
}

const policy = (ports: number[], over: Partial<FetchPolicy> = {}): FetchPolicy => ({
  allowedPorts: [80, 443],
  connectTimeoutMs: 1500,
  totalTimeoutMs: 3000,
  maxBytes: 500_000,
  maxRedirects: 5,
  userAgent: 'NoventraLeadFinder-Audit/test',
  testLoopbackPorts: ports,
  ...over,
});
const settings = (over: Partial<AuditSettings> = {}): AuditSettings => ({
  maxPages: 3,
  strategies: ['mobile'],
  usePerformance: false,
  ...over,
});
const deps = (
  ports: number[],
  over: { performance?: PerformanceProvider | null; policy?: Partial<FetchPolicy> } = {},
) => ({
  policy: policy(ports, over.policy),
  hostIntervalMs: 0,
  performance: over.performance ?? null,
  hosts: new HostScheduler(),
  log: silentLogger,
  sleep: async () => undefined,
});
const codes = (list: { code: FindingCode }[]) => list.map((f) => f.code);
const signal = () => new AbortController().signal;

describe('indirizzo del sito', () => {
  it('normalizza, riconosce i profili social e gli URL non validi', () => {
    expect(websiteTarget('www.Farmacia.it')).toMatchObject({
      kind: 'ok',
      url: 'http://www.farmacia.it/',
      siteKey: 'farmacia.it',
    });
    expect(websiteTarget('https://farmacia.it/home/')).toMatchObject({ siteKey: 'farmacia.it/home' });
    expect(websiteTarget('https://www.facebook.com/farmacia')).toMatchObject({ kind: 'none' });
    expect(websiteTarget(null)).toMatchObject({ kind: 'none' });
    for (const bad of ['ftp://x.it', 'http://u:p@x.it', 'http://localhost', 'http://in valido.it'])
      expect(websiteTarget(bad).kind, bad).toBe('invalid');
  });
});

describe('robots.txt (RFC 9309)', () => {
  it('gruppo specifico prima di "*", regola più lunga, Allow a parità, caratteri jolly', () => {
    const r = parseRobots(
      'User-agent: *\nDisallow: /\n\nUser-agent: NoventraLeadFinder\nDisallow: /privato\nAllow: /privato/pubblico\nDisallow: /*.pdf$\nCrawl-delay: 4\nSitemap: /sitemap.xml',
      'https://esempio.it',
    );
    expect(r.group).toBe('specific');
    expect(isAllowed(r, '/')).toBe(true);
    expect(isAllowed(r, '/privato/x')).toBe(false);
    expect(isAllowed(r, '/privato/pubblico/x')).toBe(true);
    expect(isAllowed(r, '/doc.pdf')).toBe(false);
    expect(r.crawlDelaySeconds).toBe(4);
    expect(r.sitemaps).toEqual(['https://esempio.it/sitemap.xml']);
    // un nome che contiene solo una parte del nostro non vale
    expect(parseRobots('User-agent: lead\nDisallow: /', 'https://x.it').group).toBe('none');
  });
});

describe('audit di siti finti', () => {
  it('sito curato: tre pagine esaminate, pochi rilievi, nessun rilievo di contenuto', async () => {
    const s = await site({
      '/robots.txt': {
        headers: { 'Content-Type': 'text/plain' },
        body: 'User-agent: *\nDisallow: /area-riservata\nSitemap: /sitemap.xml',
      },
      '/': { body: goodPharmacyHome() },
      '/servizi': {
        body: '<html lang="it"><head><title>Servizi della Farmacia di Prova</title><meta name="viewport" content="width=device-width"></head><body><h1>Servizi</h1></body></html>',
      },
      '/contatti': {
        body: '<html lang="it"><head><title>Contatti della Farmacia di Prova</title><meta name="viewport" content="width=device-width"></head><body><h1>Contatti</h1><form><input type="email"></form></body></html>',
      },
      '/sitemap.xml': {
        headers: { 'Content-Type': 'application/xml' },
        body: '<?xml version="1.0"?><urlset><url><loc>/</loc></url><url><loc>/servizi</loc></url></urlset>',
      },
    });
    const out = await runAudit(s.url, 'farmacie', settings(), deps([s.port]), signal());
    expect(out.websiteStatus).toBe('valid');
    expect(out.pages.map((p) => new URL(p.finalUrl).pathname)).toEqual(['/', '/contatti', '/servizi']);
    expect(out.summary.sitemap).toBe(true);
    expect(out.summary.robots).toBe('parsed');
    const found = codes(out.findings);
    for (const absent of [
      'MOBILE_NO_VIEWPORT',
      'SEO_MISSING_TITLE',
      'SEO_NO_STRUCTURED_DATA',
      'CONTENT_NO_CONTACT',
      'CONTENT_NO_PRIVACY_LINK',
      'CONTENT_NO_COOKIE_INDICATOR',
      'IND_NO_OPENING_HOURS',
      'IND_NO_ONLINE_BOOKING',
    ])
      expect(found, absent).not.toContain(absent);
    expect(out.summary.signals).toMatchObject({
      phoneLink: true,
      privacy: true,
      cookie: true,
      openingHours: true,
      booking: true,
      address: true,
    });
    // il server di prova parla solo HTTP: HTTPS risulta non disponibile (dato reale della prova)
    expect(found.some((c) => c === 'SEC_NO_HTTPS' || c === 'SEC_TLS_ERROR')).toBe(true);
    // robots.txt letto prima di qualsiasi pagina
    expect(s.hits[0]).toBe('/robots.txt');
    expect(out.limitations).toContain('Prestazioni non misurate: PageSpeed Insights non è configurato.');
    // nessun numero di telefono nelle misure salvate
    expect(JSON.stringify(out.summary)).not.toContain('0600000000');
  });

  it('sito datato: rilievi su titolo, mobile, contenuti e settore, con evidenze', async () => {
    const s = await site({ '/robots.txt': { status: 404 }, '/': { body: poorRestaurantHome() } });
    const out = await runAudit(s.url, 'ristorazione', settings(), deps([s.port]), signal());
    const byCode = Object.fromEntries(out.findings.map((f) => [f.code, f]));
    expect(byCode.MOBILE_NO_VIEWPORT).toMatchObject({ severity: 'high', observation: 'missing', category: 'mobile' });
    expect(byCode.SEO_TITLE_LENGTH?.evidence).toMatchObject({ titolo: 'Benvenuti', caratteri: 9 });
    expect(byCode.SEO_MISSING_META_DESCRIPTION).toMatchObject({ actionable: true, service: 'seo' });
    expect(byCode.SEO_MISSING_H1).toBeTruthy();
    expect(byCode.SEO_IMAGES_MISSING_ALT?.evidence).toMatchObject({ senzaAlt: 3, immagini: 3 });
    expect(byCode.MOBILE_LEGACY_LAYOUT?.evidence).toMatchObject({
      tecniche: expect.arrayContaining(['tabelle di impaginazione']),
    });
    expect(byCode.MOBILE_FIXED_WIDTH).toBeTruthy();
    expect(byCode.CONTENT_NO_CONTACT).toBeTruthy();
    expect(byCode.IND_RESTAURANT_NO_MENU).toMatchObject({ category: 'industry', severity: 'medium' });
    // un robots.txt assente (404) non è un errore e non blocca
    expect(out.summary.robots).toBe('missing');
    // ogni rilievo ha i campi richiesti
    for (const f of out.findings)
      expect(Object.keys(f).sort()).toEqual([
        'actionable',
        'category',
        'code',
        'confidence',
        'evidence',
        'explanation',
        'observation',
        'page',
        'remediation',
        'service',
        'severity',
        'title',
      ]);
    // nessun doppione per codice e pagina
    expect(new Set(out.findings.map((f) => `${f.code}|${f.page}`)).size).toBe(out.findings.length);
  });

  it('robots.txt che vieta tutto: nessuna pagina richiesta, stato "blocked"', async () => {
    const s = await site({
      '/robots.txt': { headers: { 'Content-Type': 'text/plain' }, body: 'User-agent: *\nDisallow: /' },
      '/': { body: goodPharmacyHome() },
    });
    const out = await runAudit(s.url, 'farmacie', settings(), deps([s.port]), signal());
    expect(out.websiteStatus).toBe('blocked');
    expect(s.hits).toEqual(['/robots.txt']);
    expect(out.limitations[0]).toContain('robots.txt vieta');
  });

  it('robots.txt con errore del server (5xx): per prudenza nessuna pagina', async () => {
    const s = await site({ '/robots.txt': { status: 500 }, '/': { body: goodPharmacyHome() } });
    const out = await runAudit(s.url, 'farmacie', settings(), deps([s.port]), signal());
    expect(out.websiteStatus).toBe('blocked');
    expect(s.hits).toEqual(['/robots.txt']);
  });

  it('accesso negato (403): stato "blocked", nessun tentativo di aggirarlo', async () => {
    const s = await site({ '/robots.txt': { status: 404 }, '/': { status: 403, body: '<h1>Forbidden</h1>' } });
    const out = await runAudit(s.url, 'farmacie', settings(), deps([s.port]), signal());
    expect(out.websiteStatus).toBe('blocked');
    expect(codes(out.findings)).toContain('AVAIL_BLOCKED');
    expect(s.hits.filter((h) => h !== '/robots.txt')).toEqual(['/']);
  });

  it('sito irraggiungibile: stato "unreachable" dopo un nuovo tentativo, mai "inesistente"', async () => {
    // la porta resta occupata da un server che chiude ogni connessione: nessun altro processo può prenderla
    const refuse = createServer((socket) => socket.resetAndDestroy());
    await new Promise<void>((resolve) => refuse.listen(0, '127.0.0.1', resolve));
    const { port } = refuse.address() as AddressInfo;
    try {
      const out = await runAudit(`http://127.0.0.1:${port}/`, 'farmacie', settings(), deps([port]), signal());
      expect(out.websiteStatus).toBe('unreachable');
      expect(out.summary.statusReason).toMatch(/connection/);
      expect(codes(out.findings)).toContain('AVAIL_UNREACHABLE');
    } finally {
      await new Promise((resolve) => refuse.close(resolve));
    }
  });

  it('sito lento: stato "timeout"', async () => {
    const s = await site({ '/robots.txt': { status: 404 }, '/': { body: '<p>tardi</p>', delayMs: 2000 } });
    const out = await runAudit(
      s.url,
      'farmacie',
      settings(),
      deps([s.port], { policy: { totalTimeoutMs: 500 } }),
      signal(),
    );
    expect(out.websiteStatus).toBe('timeout');
    expect(codes(out.findings)).toContain('AVAIL_TIMEOUT');
  });

  it('limite di pagine, robots.txt sulle pagine interne e link interni rotti', async () => {
    const home = `<html lang="it"><head><title>Studio di Prova — consulenza</title><meta name="viewport" content="width=device-width"></head><body>
      <a href="/contatti">Contatti</a><a href="/servizi">Servizi</a><a href="/prodotti">Prodotti</a><a href="/chi-siamo">Chi siamo</a></body></html>`;
    const s = await site({
      '/robots.txt': { headers: { 'Content-Type': 'text/plain' }, body: 'User-agent: *\nDisallow: /contatti' },
      '/': { body: home },
      // /servizi non esiste (404)
      '/prodotti': { body: '<html><head><title>Prodotti</title></head><body><h1>Prodotti</h1></body></html>' },
    });
    const out = await runAudit(s.url, 'studi_professionali', settings({ maxPages: 3 }), deps([s.port]), signal());
    expect(s.hits).not.toContain('/contatti');
    expect(out.pages).toHaveLength(3);
    expect(out.limitations.some((l) => l.includes('vietate da robots.txt'))).toBe(true);
    const broken = out.findings.find((f) => f.code === 'SEO_BROKEN_INTERNAL_LINKS');
    expect(broken?.evidence).toMatchObject({ pagine: [expect.stringContaining('404')] });
  });

  it('il sito chiede di rallentare (429): nessuna richiesta successiva', async () => {
    const home =
      '<html><head><title>Negozio di Prova</title></head><body><a href="/contatti">Contatti</a><a href="/prodotti">Prodotti</a></body></html>';
    const s = await site({
      '/robots.txt': { status: 404 },
      '/': { body: home },
      '/contatti': { status: 429 },
      '/prodotti': { body: '<p>x</p>' },
    });
    const out = await runAudit(s.url, 'negozi', settings(), deps([s.port]), signal());
    expect(s.hits).not.toContain('/prodotti');
    expect(out.runStatus).toBe('partial');
    expect(out.limitations.some((l) => l.includes('HTTP 429'))).toBe(true);
  });

  it('regole di settore: solo per le categorie pertinenti', async () => {
    const hotelHome = `<html lang="it"><head><title>Hotel di Prova sul lago</title><meta name="viewport" content="width=device-width"></head><body>
      <h1>Hotel di Prova</h1><a href="https://www.booking.com/hotel/it/prova.html">Prenota su Booking</a><p>Le nostre camere</p></body></html>`;
    const s = await site({ '/robots.txt': { status: 404 }, '/': { body: hotelHome } });
    const hotel = await runAudit(s.url, 'hotel', settings({ maxPages: 1 }), deps([s.port]), signal());
    const direct = hotel.findings.find((f) => f.code === 'IND_HOTEL_NO_DIRECT_BOOKING');
    // "Prenota su Booking" è un link a un portale: conta come prenotazione rilevata, quindi niente rilievo
    expect(direct).toBeUndefined();
    const factory = await runAudit(s.url, 'industria', settings({ maxPages: 1 }), deps([s.port]), signal());
    expect(codes(factory.findings).filter((c) => c.startsWith('IND_'))).toEqual([]);
  });

  it('viewport: larghezza fissa solo se dichiarata o senza alcuna indicazione di adattamento', async () => {
    const viewportCodes = async (content: string) => {
      const s = await site({
        '/robots.txt': { status: 404 },
        '/': {
          body: `<html lang="it"><head><title>Pagina di Prova</title><meta name="viewport" content="${content}"></head><body><h1>Prova</h1></body></html>`,
        },
      });
      const out = await runAudit(s.url, 'industria', settings({ maxPages: 1 }), deps([s.port]), signal());
      return codes(out.findings).filter((c) => c.startsWith('MOBILE_VIEWPORT') || c === 'MOBILE_ZOOM_DISABLED');
    };
    // forma vista su un sito reale: initial-scale senza width=device-width si adatta comunque allo schermo
    expect(await viewportCodes('initial-scale=1, minimum-scale=1, maximum-scale=5, viewport-fit=cover')).toEqual([]);
    expect(await viewportCodes('width=980')).toEqual(['MOBILE_VIEWPORT_FIXED']);
    expect(await viewportCodes('user-scalable=yes')).toEqual(['MOBILE_VIEWPORT_FIXED']);
    expect(await viewportCodes('width=device-width, maximum-scale=1')).toEqual(['MOBILE_ZOOM_DISABLED']);
  });

  it('prestazioni: rilievi dai dati del fornitore, limitazione se non configurato', async () => {
    const s = await site({ '/robots.txt': { status: 404 }, '/': { body: goodPharmacyHome() } });
    const fake: PerformanceProvider = {
      id: 'finto',
      configured: true,
      analyze: async (url, strategy): Promise<PerformanceOutcome> => ({
        status: 'ok',
        provider: 'pagespeed',
        strategy,
        url,
        analyzedAt: new Date().toISOString(),
        lighthouseVersion: '12',
        lab: { performanceScore: 41, lcpMs: 5200, cls: 0.02, fcpMs: 2100, speedIndexMs: 6000, tbtMs: 900 },
        field: null,
        fromCache: false,
      }),
    };
    const out = await runAudit(
      s.url,
      'farmacie',
      settings({ maxPages: 1, usePerformance: true }),
      deps([s.port], { performance: fake }),
      signal(),
    );
    const byCode = Object.fromEntries(out.findings.map((f) => [f.code, f]));
    expect(byCode.PERF_LOW_SCORE).toMatchObject({ severity: 'high', evidence: { punteggio: 41, strategia: 'mobile' } });
    expect(byCode.PERF_LCP_SLOW).toMatchObject({ severity: 'high', evidence: { lcpMs: 5200, dati: 'laboratorio' } });
    expect(byCode.PERF_CLS_HIGH).toBeUndefined();
    expect(out.summary.performance.mobile).toMatchObject({ status: 'ok', score: 41 });

    const none = await runAudit(
      s.url,
      'farmacie',
      settings({ maxPages: 1, usePerformance: true }),
      deps([s.port], { performance: null }),
      signal(),
    );
    expect(none.limitations).toContain('Prestazioni non misurate: PageSpeed Insights non è configurato.');
    expect(codes(none.findings).filter((c) => c.startsWith('PERF_'))).toEqual([]);
  });

  it('un sito che risolve verso un indirizzo privato non viene contattato', async () => {
    const out = await runAudit(
      'http://intranet-di-prova.example.com/',
      'farmacie',
      settings(),
      { ...deps([]), policy: policy([], { resolve: async () => [{ address: '10.0.0.7', family: 4 }] }) },
      signal(),
    );
    expect(out.websiteStatus).toBe('blocked');
    expect(out.limitations).toContain(
      'Il sito porta a una destinazione non pubblica: per sicurezza non è stato contattato.',
    );
  });
});
