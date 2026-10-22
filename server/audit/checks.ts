import type { CategoryId } from '../discovery/categories.ts';
import { dedupeFindings, finding, type Confidence, type Finding, type FindingCode } from './findings.ts';
import type { PageMeasurements } from './html.ts';
import type { TlsInfo } from './net/safeFetch.ts';
import type { PerformanceOutcome } from './performance/pagespeed.ts';
import type { Robots } from './robots.ts';
import type { Signals } from './signals.ts';
import { bareHost } from './url.ts';

/*
 * Regole: dalle misure oggettive ai rilievi. Principi:
 *  - un elemento mancante in una pagina è un rilievo su quella pagina, non un giudizio sul sito;
 *  - se il contenuto sembra generato da JavaScript (che non eseguiamo), i rilievi sui contenuti hanno confidenza bassa;
 *  - dati strutturati: si valuta solo la presenza di tipi che descrivono l'attività (LocalBusiness, Organization…);
 *  - indicatori di settore: solo per le categorie a cui si applicano; sono opportunità, non requisiti.
 */

export interface InspectedPage {
  role: 'home' | 'extra';
  requestedUrl: string;
  finalUrl: string;
  status: number | null;
  contentType: string | null;
  bytes: number;
  truncated: boolean;
  ttfbMs: number | null;
  totalMs: number | null;
  redirects: { url: string; status: number; location: string }[];
  headers: Record<string, string>;
  tls: TlsInfo | null;
  measurements: PageMeasurements | null;
  html: string | null;
  error: { kind: string; code?: string; message: string } | null;
}

export interface HttpsCheck {
  /** HTTPS risponde con un certificato valido; null = non verificato. */
  available: boolean | null;
  tlsErrorCode: string | null;
  certDaysToExpiry: number | null;
  /** http:// reindirizza a https://; null = non verificato. */
  httpRedirectsToHttps: boolean | null;
}

export interface SitemapCheck {
  found: boolean;
  url: string | null;
  source: 'robots' | 'default' | null;
  urlCount: number | null;
}

export type WebsiteStatus =
  | 'not_checked'
  | 'not_found'
  | 'valid'
  | 'redirected'
  | 'unreachable'
  | 'timeout'
  | 'blocked'
  | 'invalid_url'
  | 'audit_failed';

export interface AuditContext {
  originalUrl: string;
  websiteStatus: WebsiteStatus;
  /** Motivo tecnico per gli stati non validi (es. ENOTFOUND, HTTP 404). */
  statusReason: string | null;
  home: InspectedPage | null;
  pages: InspectedPage[];
  robots: Robots | null;
  sitemap: SitemapCheck | null;
  https: HttpsCheck;
  signals: Signals | null;
  performance: PerformanceOutcome[];
  category: CategoryId;
  limitations: string[];
}

const BUSINESS_TYPES =
  /^(LocalBusiness|Organization|Corporation|Store|Pharmacy|Hospital|MedicalBusiness|MedicalClinic|Dentist|Physician|Restaurant|FoodEstablishment|CafeOrCoffeeShop|BarOrPub|Bakery|Hotel|LodgingBusiness|BedAndBreakfast|Motel|Hostel|Resort|ExerciseGym|HealthClub|SportsActivityLocation|BeautySalon|DaySpa|HairSalon|AutoRepair|ProfessionalService|LegalService|Attorney|Notary|AccountingService|FinancialService|InsuranceAgency|RealEstateAgent|HomeAndConstructionBusiness|Electrician|Plumber|ClothingStore|HealthAndBeautyBusiness|ShoppingCenter|OnlineStore|OnlineBusiness|.*Store|.*Shop)$/;

const LOCAL_CATEGORIES: CategoryId[] = [
  'farmacie',
  'parafarmacie',
  'hotel',
  'extralberghiero',
  'ristorazione',
  'studi_sanitari',
  'palestre_benessere',
  'artigiani_servizi',
  'negozi',
];

/** Indicatori di settore per categoria: opportunità da verificare, mai requisiti. */
export const INDUSTRY_RULES: Record<CategoryId, FindingCode[]> = {
  farmacie: ['IND_NO_OPENING_HOURS', 'IND_NO_ONLINE_BOOKING', 'IND_NO_CATALOG'],
  parafarmacie: ['IND_NO_OPENING_HOURS', 'IND_NO_CATALOG', 'IND_NO_ECOMMERCE'],
  hotel: ['IND_HOTEL_NO_DIRECT_BOOKING', 'IND_HOTEL_NO_ROOMS'],
  extralberghiero: ['IND_HOTEL_NO_DIRECT_BOOKING', 'IND_HOTEL_NO_ROOMS'],
  ristorazione: ['IND_RESTAURANT_NO_MENU', 'IND_RESTAURANT_NO_RESERVATION', 'IND_NO_OPENING_HOURS'],
  studi_sanitari: ['IND_NO_APPOINTMENT', 'IND_NO_OPENING_HOURS'],
  studi_professionali: ['IND_NO_APPOINTMENT'],
  palestre_benessere: ['IND_GYM_NO_SCHEDULE', 'IND_NO_ONLINE_BOOKING', 'IND_NO_OPENING_HOURS'],
  artigiani_servizi: ['IND_NO_APPOINTMENT', 'IND_NO_OPENING_HOURS'],
  industria: [],
  aziende_uffici: [],
  negozi: ['IND_NO_OPENING_HOURS', 'IND_NO_CATALOG', 'IND_NO_ECOMMERCE'],
};

/** Pagina con contenuto probabilmente generato da JavaScript (poco testo, molti script). */
export const jsRendered = (m: PageMeasurements) => m.text.words < 60 && m.scripts.external + m.scripts.inline >= 3;

function availability(ctx: AuditContext, out: Finding[]) {
  const reason = ctx.statusReason ? { motivo: ctx.statusReason } : {};
  if (ctx.websiteStatus === 'unreachable' && !ctx.home?.status) out.push(finding('AVAIL_UNREACHABLE', reason));
  if (ctx.websiteStatus === 'timeout') out.push(finding('AVAIL_TIMEOUT', reason));
  if (ctx.websiteStatus === 'blocked') out.push(finding('AVAIL_BLOCKED', reason));
  const home = ctx.home;
  if (!home?.status) return;
  if (home.status >= 400 && ctx.websiteStatus !== 'blocked')
    out.push(finding('AVAIL_HTTP_ERROR', { statoHttp: home.status }, { page: home.finalUrl }));
  if (home.status < 300 && home.contentType && !/html/i.test(home.contentType))
    out.push(finding('AVAIL_NOT_HTML', { tipoContenuto: home.contentType }, { page: home.finalUrl }));
  if (home.redirects.length > 2)
    out.push(
      finding(
        'AVAIL_REDIRECT_CHAIN',
        { redirect: home.redirects.map((r) => `${r.status} ${r.url} → ${r.location}`) },
        { page: home.requestedUrl },
      ),
    );
  if (ctx.websiteStatus === 'redirected')
    out.push(finding('AVAIL_REDIRECT_OTHER_DOMAIN', { da: ctx.originalUrl, a: home.finalUrl }));
  if (home.ttfbMs !== null && home.ttfbMs > 1500)
    out.push(
      finding(
        'AVAIL_SLOW_RESPONSE',
        { tempoPrimoByteMs: home.ttfbMs, nota: 'misura singola' },
        { page: home.finalUrl, confidence: 'low' },
      ),
    );
}

function security(ctx: AuditContext, out: Finding[]) {
  const h = ctx.https;
  if (h.tlsErrorCode) out.push(finding('SEC_TLS_ERROR', { codice: h.tlsErrorCode }));
  else if (h.available === false) out.push(finding('SEC_NO_HTTPS', {}));
  if (h.available && h.certDaysToExpiry !== null && h.certDaysToExpiry < 21 && h.certDaysToExpiry >= 0)
    out.push(finding('SEC_CERT_EXPIRING', { giorniAllaScadenza: h.certDaysToExpiry }));
  if (h.available && h.httpRedirectsToHttps === false) out.push(finding('SEC_HTTP_NOT_REDIRECTED', {}));
  for (const p of ctx.pages) {
    const m = p.measurements;
    if (!m) continue;
    const { active, passive } = m.insecureResources;
    if (active.length || passive.length)
      out.push(
        finding(
          'SEC_MIXED_CONTENT',
          { attive: active.slice(0, 5), passive: passive.slice(0, 5) },
          { page: p.finalUrl, severity: active.length ? 'medium' : 'low' },
        ),
      );
    if (m.forms.insecureActions.length)
      out.push(finding('SEC_INSECURE_FORM', { azioni: m.forms.insecureActions.slice(0, 3) }, { page: p.finalUrl }));
  }
  const home = ctx.home;
  if (home?.status && home.status < 400 && home.finalUrl.startsWith('https:')) {
    const hd = home.headers;
    const missing = [
      !hd['strict-transport-security'] && 'Strict-Transport-Security',
      !hd['x-content-type-options'] && 'X-Content-Type-Options',
      !hd['x-frame-options'] &&
        !/frame-ancestors/i.test(hd['content-security-policy'] ?? '') &&
        'X-Frame-Options / frame-ancestors',
    ].filter(Boolean);
    if (missing.length) out.push(finding('SEC_HEADERS_MISSING', { assenti: missing }, { page: home.finalUrl }));
  }
}

function seo(ctx: AuditContext, out: Finding[]) {
  const home = ctx.home;
  if (
    ctx.robots?.source === 'parsed' &&
    ctx.robots.rules.some((r) => !r.allow && r.pattern === '/') &&
    !ctx.robots.rules.some((r) => r.allow && r.pattern.length > 1)
  )
    out.push(finding('SEO_ROBOTS_DISALLOW_ALL', { gruppo: ctx.robots.group }));
  if (home?.measurements && home.status && home.status < 400) {
    if (ctx.sitemap && !ctx.sitemap.found)
      out.push(finding('SEO_NO_SITEMAP', { cercata: ctx.sitemap.url }, { confidence: 'medium' }));
    const types = new Set(
      ctx.pages.flatMap((p) => [
        ...(p.measurements?.structuredData.types ?? []),
        ...(p.measurements?.structuredData.microdataTypes ?? []),
      ]),
    );
    const business = [...types].filter((t) => BUSINESS_TYPES.test(t));
    if (!business.length)
      out.push(
        finding(
          'SEO_NO_STRUCTURED_DATA',
          { tipiTrovati: [...types].slice(0, 10) },
          { confidence: jsRendered(home.measurements) ? 'low' : 'high' },
        ),
      );
    if (!Object.keys(home.measurements.openGraph).length)
      out.push(finding('SEO_NO_OPEN_GRAPH', {}, { page: home.finalUrl }));
    const words = home.measurements.text.words;
    if (words < 150 && !jsRendered(home.measurements))
      out.push(finding('SEO_THIN_CONTENT', { parole: words }, { page: home.finalUrl, confidence: 'medium' }));
  }
  for (const p of ctx.pages) {
    const m = p.measurements;
    if (!m || !p.status || p.status >= 400) continue;
    const page = p.finalUrl;
    const conf: Confidence = jsRendered(m) ? 'low' : 'high';
    if (!m.title) out.push(finding('SEO_MISSING_TITLE', {}, { page, confidence: conf }));
    else if (m.title.length < 15 || m.title.length > 65)
      out.push(finding('SEO_TITLE_LENGTH', { titolo: m.title, caratteri: m.title.length }, { page }));
    if (!m.metaDescription) out.push(finding('SEO_MISSING_META_DESCRIPTION', {}, { page, confidence: conf }));
    else if (m.metaDescription.length < 50 || m.metaDescription.length > 170)
      out.push(finding('SEO_META_DESCRIPTION_LENGTH', { caratteri: m.metaDescription.length }, { page }));
    if (!m.h1.length) out.push(finding('SEO_MISSING_H1', {}, { page, confidence: conf }));
    else if (m.h1.length > 1) out.push(finding('SEO_MULTIPLE_H1', { h1: m.h1.slice(0, 5) }, { page }));
    const robotsHeader = p.headers['x-robots-tag'] ?? '';
    if (/noindex/i.test(m.metaRobots ?? '') || /noindex/i.test(robotsHeader))
      out.push(finding('SEO_NOINDEX', { metaRobots: m.metaRobots, xRobotsTag: robotsHeader || null }, { page }));
    if (p.role === 'home') {
      if (!m.canonical) out.push(finding('SEO_CANONICAL_MISSING', {}, { page }));
      else {
        try {
          if (bareHost(new URL(m.canonical).hostname) !== bareHost(new URL(page).hostname))
            out.push(finding('SEO_CANONICAL_OTHER_HOST', { canonico: m.canonical }, { page }));
        } catch {
          // canonico non valido: già evidente dal valore registrato nelle misure
        }
      }
      if (!m.lang) out.push(finding('SEO_MISSING_LANG', {}, { page }));
    }
    const noAlt = m.images.missingAlt;
    if (m.images.total >= 3 && noAlt / m.images.total >= 0.3)
      out.push(
        finding(
          'SEO_IMAGES_MISSING_ALT',
          { senzaAlt: noAlt, immagini: m.images.total },
          { page, severity: noAlt / m.images.total >= 0.7 ? 'medium' : 'low' },
        ),
      );
    if (m.structuredData.jsonLdInvalid)
      out.push(finding('SEO_INVALID_JSON_LD', { blocchiNonValidi: m.structuredData.jsonLdInvalid }, { page }));
  }
  // link interni verso pagine esaminate che rispondono con un errore
  const failed = ctx.pages.filter((p) => p.role === 'extra' && p.status !== null && p.status >= 400);
  if (failed.length)
    out.push(finding('SEO_BROKEN_INTERNAL_LINKS', { pagine: failed.map((p) => `${p.status} ${p.requestedUrl}`) }));
}

function mobile(ctx: AuditContext, out: Finding[]) {
  for (const p of ctx.pages) {
    const m = p.measurements;
    if (!m || !p.status || p.status >= 400) continue;
    const page = p.finalUrl;
    if (p.role === 'home' || !m.viewport) {
      if (!m.viewport) out.push(finding('MOBILE_NO_VIEWPORT', {}, { page }));
      else {
        const vp = m.viewport.toLowerCase().replace(/\s/g, '');
        // larghezza fissa: "width=980", oppure nessuna indicazione di adattamento (initial-scale da solo basta ai browser)
        if (/(^|,)width=\d/.test(vp) || (!vp.includes('width=device-width') && !vp.includes('initial-scale=')))
          out.push(finding('MOBILE_VIEWPORT_FIXED', { viewport: m.viewport }, { page }));
        if (vp.includes('user-scalable=no') || vp.includes('user-scalable=0') || /maximum-scale=1(\.0)?(,|$)/.test(vp))
          out.push(finding('MOBILE_ZOOM_DISABLED', { viewport: m.viewport }, { page }));
      }
    }
    if (m.inlineCss.fixedWidthsPx.length && m.inlineCss.mediaQueries === 0)
      out.push(
        finding(
          'MOBILE_FIXED_WIDTH',
          { larghezzePx: m.inlineCss.fixedWidthsPx.slice(0, 5) },
          { page, confidence: 'medium' },
        ),
      );
    const legacy = m.legacy;
    const signs = [
      legacy.frameset && 'frame',
      legacy.flashObjects && 'Flash',
      legacy.layoutTables >= 2 && 'tabelle di impaginazione',
      legacy.fontTags >= 5 && 'tag <font>',
      legacy.marquee && '<marquee>',
    ].filter(Boolean);
    if (signs.length)
      out.push(
        finding(
          'MOBILE_LEGACY_LAYOUT',
          { tecniche: signs },
          { page, severity: legacy.frameset || legacy.flashObjects ? 'high' : 'medium' },
        ),
      );
    if (p.role === 'home' && m.images.total >= 5 && m.images.withoutDimensions / m.images.total >= 0.5)
      out.push(
        finding(
          'MOBILE_IMAGES_NO_DIMENSIONS',
          { senzaDimensioni: m.images.withoutDimensions, immagini: m.images.total },
          { page },
        ),
      );
  }
}

function performance(ctx: AuditContext, out: Finding[]) {
  for (const r of ctx.performance) {
    if (r.status !== 'ok') continue;
    const tag = { strategia: r.strategy, fonte: 'PageSpeed Insights' };
    const s = r.lab.performanceScore;
    if (s !== null && s < 90)
      out.push(
        finding('PERF_LOW_SCORE', { ...tag, punteggio: s }, { page: r.url, severity: s < 50 ? 'high' : 'medium' }),
      );
    // preferenza ai dati reali degli utenti, se presenti; altrimenti laboratorio
    const lcp = r.field?.lcpMs ?? r.lab.lcpMs;
    const lcpSource =
      r.field?.lcpMs !== null && r.field?.lcpMs !== undefined
        ? `dati reali (${r.field.scope === 'url' ? 'pagina' : 'intero sito'})`
        : 'laboratorio';
    if (lcp !== null && lcp > 2500)
      out.push(
        finding(
          'PERF_LCP_SLOW',
          { ...tag, lcpMs: Math.round(lcp), dati: lcpSource },
          { page: r.url, severity: lcp > 4000 ? 'high' : 'medium' },
        ),
      );
    const cls = r.field?.cls ?? r.lab.cls;
    if (cls !== null && cls > 0.1)
      out.push(
        finding(
          'PERF_CLS_HIGH',
          { ...tag, cls: Number(cls.toFixed(3)) },
          { page: r.url, severity: cls > 0.25 ? 'high' : 'medium' },
        ),
      );
    const inp = r.field?.inpMs ?? null;
    if (inp !== null && inp > 200)
      out.push(
        finding(
          'PERF_INP_SLOW',
          { ...tag, inpMs: inp, dati: `dati reali (${r.field!.scope === 'url' ? 'pagina' : 'intero sito'})` },
          { page: r.url, severity: inp > 500 ? 'high' : 'medium' },
        ),
      );
  }
}

function content(ctx: AuditContext, out: Finding[]) {
  const s = ctx.signals;
  const home = ctx.home;
  if (!s || !home?.measurements || !home.status || home.status >= 400) return;
  const js = ctx.pages.some((p) => p.measurements && jsRendered(p.measurements));
  const conf: Confidence = js ? 'low' : 'medium';
  if (js)
    out.push(
      finding(
        'CONTENT_JS_RENDERED',
        {
          parole: home.measurements.text.words,
          script: home.measurements.scripts.external + home.measurements.scripts.inline,
        },
        { page: home.finalUrl },
      ),
    );
  if (!s.phoneLink.detected && !s.emailLink.detected && !s.contactForm.detected && !s.contactPage.detected)
    out.push(finding('CONTENT_NO_CONTACT', {}, { confidence: conf }));
  if (LOCAL_CATEGORIES.includes(ctx.category) && !s.address.detected)
    out.push(finding('CONTENT_NO_ADDRESS', {}, { confidence: 'low' }));
  if (!s.callToAction.detected) out.push(finding('CONTENT_NO_CTA', {}, { confidence: conf }));
  if (
    !s.servicesSection.detected &&
    ['studi_professionali', 'aziende_uffici', 'industria', 'artigiani_servizi', 'studi_sanitari'].includes(ctx.category)
  )
    out.push(finding('CONTENT_NO_SERVICES', {}, { confidence: conf }));
  if (!s.privacy.detected) out.push(finding('CONTENT_NO_PRIVACY_LINK', {}, { confidence: conf }));
  if (!s.cookie.detected) out.push(finding('CONTENT_NO_COOKIE_INDICATOR', {}, { confidence: 'low' }));
  if (!s.social.detected) out.push(finding('CONTENT_NO_SOCIAL', {}, { confidence: conf }));
  if (s.platforms.length) out.push(finding('CONTENT_PLATFORM', { piattaforme: s.platforms }, { confidence: 'medium' }));
}

function industry(ctx: AuditContext, out: Finding[]) {
  const s = ctx.signals;
  if (!s || !ctx.home?.measurements || !ctx.home.status || ctx.home.status >= 400) return;
  const conf: Confidence = ctx.pages.some((p) => p.measurements && jsRendered(p.measurements)) ? 'low' : 'medium';
  const absent: Partial<Record<FindingCode, boolean>> = {
    IND_NO_OPENING_HOURS: !s.openingHours.detected,
    IND_NO_ONLINE_BOOKING: !s.booking.detected && !s.appointment.detected,
    IND_HOTEL_NO_DIRECT_BOOKING: !s.booking.detected,
    IND_HOTEL_NO_ROOMS: !s.rooms.detected,
    IND_RESTAURANT_NO_MENU: !s.menu.detected,
    IND_RESTAURANT_NO_RESERVATION: !s.booking.detected && !s.ordering.detected,
    IND_NO_CATALOG: !s.catalog.detected && !s.ecommerce.detected,
    IND_NO_ECOMMERCE:
      !s.ecommerce.detected &&
      !s.platforms.some((p) => ['Shopify', 'WooCommerce', 'Magento', 'PrestaShop'].includes(p)),
    IND_NO_APPOINTMENT: !s.appointment.detected && !s.booking.detected && !s.contactForm.detected,
    IND_GYM_NO_SCHEDULE: !s.schedule.detected,
  };
  for (const code of INDUSTRY_RULES[ctx.category] ?? []) {
    if (!absent[code]) continue;
    const evidence: Record<string, unknown> = {
      categoria: ctx.category,
      pagineEsaminate: ctx.pages.filter((p) => p.measurements).length,
    };
    if (code === 'IND_HOTEL_NO_DIRECT_BOOKING' && s.otaLinks.detected) evidence.portaliTerzi = s.otaLinks.evidence;
    out.push(finding(code, evidence, { confidence: conf }));
  }
}

export function evaluate(ctx: AuditContext): Finding[] {
  const out: Finding[] = [];
  availability(ctx, out);
  security(ctx, out);
  seo(ctx, out);
  mobile(ctx, out);
  performance(ctx, out);
  content(ctx, out);
  industry(ctx, out);
  return dedupeFindings(out);
}

/** Riepilogo strutturato (letto dalla Fase 4): misure e conteggi, nessun punteggio finale. */
export function summarize(ctx: AuditContext, findings: Finding[]) {
  const count = <K extends string>(key: (f: Finding) => K) =>
    findings.reduce<Record<string, number>>((acc, f) => ((acc[key(f)] = (acc[key(f)] ?? 0) + 1), acc), {});
  const perf = (strategy: 'mobile' | 'desktop') => {
    const r = ctx.performance.find((x) => x.strategy === strategy);
    if (!r) return null;
    return r.status === 'ok'
      ? {
          status: 'ok',
          score: r.lab.performanceScore,
          lcpMs: r.field?.lcpMs ?? r.lab.lcpMs,
          cls: r.field?.cls ?? r.lab.cls,
          inpMs: r.field?.inpMs ?? null,
          analyzedAt: r.analyzedAt,
        }
      : { status: 'error', errorKind: r.errorKind };
  };
  const home = ctx.home;
  const signals = ctx.signals
    ? Object.fromEntries(
        Object.entries(ctx.signals)
          .filter(([k]) => k !== 'platforms')
          .map(([k, v]) => [k, (v as { detected: boolean }).detected]),
      )
    : null;
  return {
    websiteStatus: ctx.websiteStatus,
    statusReason: ctx.statusReason,
    finalUrl: home?.finalUrl ?? null,
    homepage: home
      ? {
          status: home.status,
          ttfbMs: home.ttfbMs,
          bytes: home.bytes,
          words: home.measurements?.text.words ?? null,
          jsRendered: home.measurements ? jsRendered(home.measurements) : null,
        }
      : null,
    https: ctx.https,
    pagesInspected: ctx.pages.filter((p) => p.measurements).length,
    robots: ctx.robots?.source ?? null,
    sitemap: ctx.sitemap?.found ?? null,
    hasViewport: home?.measurements ? Boolean(home.measurements.viewport) : null,
    platforms: ctx.signals?.platforms ?? [],
    signals,
    findings: {
      total: findings.length,
      actionable: findings.filter((f) => f.actionable).length,
      bySeverity: count((f) => f.severity),
      byCategory: count((f) => f.category),
      services: count((f) => f.service ?? 'nessuno'),
    },
    performance: { mobile: perf('mobile'), desktop: perf('desktop') },
    limitations: ctx.limitations,
  };
}

export type AuditSummary = ReturnType<typeof summarize>;
