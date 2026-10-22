import { parse } from 'parse5';

/*
 * Estrazione di misure oggettive da una pagina HTML (nessun JavaScript eseguito, nessuna risorsa scaricata).
 * Il risultato descrive ciò che c'è nel codice ricevuto: un elemento assente qui può essere aggiunto dal JavaScript
 * del sito, per questo le conclusioni (findings) tengono conto della quantità di testo e degli script.
 * Recapiti personali: di telefono ed email si contano solo i link (tel:, mailto:), i valori non vengono conservati.
 */

interface Node {
  nodeName: string;
  tagName?: string;
  attrs?: { name: string; value: string }[];
  childNodes?: Node[];
  content?: Node;
  value?: string;
}

export interface LinkInfo {
  href: string;
  text: string;
  internal: boolean;
  nofollow: boolean;
}

export interface PageMeasurements {
  title: string | null;
  metaDescription: string | null;
  metaRobots: string | null;
  viewport: string | null;
  lang: string | null;
  canonical: string | null;
  generator: string | null;
  h1: string[];
  h2Count: number;
  h2Sample: string[];
  links: LinkInfo[];
  linkCounts: { internal: number; external: number; nofollow: number };
  images: {
    total: number;
    missingAlt: number;
    emptyAlt: number;
    withoutDimensions: number;
    lazy: number;
    withSrcset: number;
  };
  openGraph: Record<string, string>;
  structuredData: { jsonLdBlocks: number; jsonLdInvalid: number; types: string[]; microdataTypes: string[] };
  forms: { count: number; actions: string[]; insecureActions: string[]; withEmailField: number; withPassword: number };
  scripts: { external: number; inline: number; srcHosts: string[] };
  stylesheets: number;
  inlineCss: { styleBlocks: number; mediaQueries: number; fixedWidthsPx: number[] };
  insecureResources: { active: string[]; passive: string[] };
  iframes: string[];
  legacy: { frameset: boolean; flashObjects: number; layoutTables: number; fontTags: number; marquee: boolean };
  text: { words: number; chars: number };
  contacts: { telLinks: number; mailtoLinks: number; whatsappLinks: number };
  socialDomains: string[];
  copyrightYear: number | null;
  /** Testo minuscolo per i rilevamenti (non viene salvato). */
  searchableText: string;
}

const SOCIAL =
  /(^|\.)(facebook\.com|instagram\.com|linkedin\.com|tiktok\.com|youtube\.com|twitter\.com|x\.com|pinterest\.com|threads\.net)$/i;

const attr = (n: Node, name: string) => n.attrs?.find((a) => a.name === name)?.value ?? null;
const clip = (s: string, max: number) => s.replace(/\s+/g, ' ').trim().slice(0, max);

function textOf(n: Node, out: string[] = []): string[] {
  if (n.nodeName === '#text') out.push(n.value ?? '');
  else if (!['script', 'style', 'noscript', 'template', 'svg'].includes(n.nodeName))
    for (const c of n.childNodes ?? []) textOf(c, out);
  return out;
}

function resolveUrl(href: string, base: URL): URL | null {
  try {
    return new URL(href, base);
  } catch {
    return null;
  }
}

export function extract(html: string, pageUrl: string, isInternal: (u: URL) => boolean): PageMeasurements {
  const doc = parse(html) as unknown as Node;
  const base = new URL(pageUrl);
  // <base href> cambia la risoluzione dei link relativi
  const m: PageMeasurements = {
    title: null,
    metaDescription: null,
    metaRobots: null,
    viewport: null,
    lang: null,
    canonical: null,
    generator: null,
    h1: [],
    h2Count: 0,
    h2Sample: [],
    links: [],
    linkCounts: { internal: 0, external: 0, nofollow: 0 },
    images: { total: 0, missingAlt: 0, emptyAlt: 0, withoutDimensions: 0, lazy: 0, withSrcset: 0 },
    openGraph: {},
    structuredData: { jsonLdBlocks: 0, jsonLdInvalid: 0, types: [], microdataTypes: [] },
    forms: { count: 0, actions: [], insecureActions: [], withEmailField: 0, withPassword: 0 },
    scripts: { external: 0, inline: 0, srcHosts: [] },
    stylesheets: 0,
    inlineCss: { styleBlocks: 0, mediaQueries: 0, fixedWidthsPx: [] },
    insecureResources: { active: [], passive: [] },
    iframes: [],
    legacy: { frameset: false, flashObjects: 0, layoutTables: 0, fontTags: 0, marquee: false },
    text: { words: 0, chars: 0 },
    contacts: { telLinks: 0, mailtoLinks: 0, whatsappLinks: 0 },
    socialDomains: [],
    copyrightYear: null,
    searchableText: '',
  };
  let baseUrl = base;
  const types = new Set<string>();
  const micro = new Set<string>();
  const scriptHosts = new Set<string>();
  const social = new Set<string>();
  const https = base.protocol === 'https:';

  const insecure = (raw: string | null, active: boolean) => {
    if (!https || !raw) return;
    const u = resolveUrl(raw, baseUrl);
    if (u?.protocol === 'http:') (active ? m.insecureResources.active : m.insecureResources.passive).push(u.toString());
  };
  const collectTypes = (v: unknown, depth = 0) => {
    if (depth > 6 || !v || typeof v !== 'object') return;
    if (Array.isArray(v)) return v.forEach((x) => collectTypes(x, depth + 1));
    const o = v as Record<string, unknown>;
    const t = o['@type'];
    if (typeof t === 'string') types.add(t);
    if (Array.isArray(t)) t.forEach((x) => typeof x === 'string' && types.add(x));
    for (const k of ['@graph', 'mainEntity', 'publisher', 'author', 'location', 'brand', 'provider'])
      collectTypes(o[k], depth + 1);
  };

  const stack: { node: Node; tableDepth: number }[] = [{ node: doc, tableDepth: 0 }];
  while (stack.length) {
    const { node: n, tableDepth } = stack.pop()!;
    const tag = n.tagName;
    let childTableDepth = tableDepth;
    if (tag) {
      const itemtype = attr(n, 'itemtype');
      if (itemtype) for (const t of itemtype.split(/\s+/)) micro.add(t.replace(/^https?:\/\/schema\.org\//i, ''));
      switch (tag) {
        case 'html':
          m.lang = attr(n, 'lang') ?? attr(n, 'xml:lang');
          break;
        case 'base': {
          const b = resolveUrl(attr(n, 'href') ?? '', base);
          if (b) baseUrl = b;
          break;
        }
        case 'title':
          if (m.title === null) m.title = clip(textOf(n).join(''), 300);
          break;
        case 'meta': {
          const name = (attr(n, 'name') ?? '').toLowerCase();
          const prop = (attr(n, 'property') ?? '').toLowerCase();
          const content = attr(n, 'content');
          if (content === null) break;
          if (name === 'description' && m.metaDescription === null) m.metaDescription = clip(content, 500);
          else if (name === 'robots' || name === 'googlebot')
            m.metaRobots = clip([m.metaRobots, content].filter(Boolean).join(', '), 200);
          else if (name === 'viewport') m.viewport = clip(content, 200);
          else if (name === 'generator') m.generator = clip(content, 100);
          else if (prop.startsWith('og:') && Object.keys(m.openGraph).length < 20)
            m.openGraph[prop] = clip(content, 300);
          break;
        }
        case 'link': {
          const rel = (attr(n, 'rel') ?? '').toLowerCase().split(/\s+/);
          const href = attr(n, 'href');
          if (rel.includes('canonical') && href && m.canonical === null)
            m.canonical = resolveUrl(href, baseUrl)?.toString() ?? href;
          if (rel.includes('stylesheet')) {
            m.stylesheets++;
            insecure(href, true);
          }
          break;
        }
        case 'h1':
          if (m.h1.length < 10) m.h1.push(clip(textOf(n).join(' '), 200));
          break;
        case 'h2':
          m.h2Count++;
          if (m.h2Sample.length < 10) m.h2Sample.push(clip(textOf(n).join(' '), 150));
          break;
        case 'a': {
          const href = attr(n, 'href');
          if (!href) break;
          const lower = href.trim().toLowerCase();
          if (lower.startsWith('tel:')) m.contacts.telLinks++;
          else if (lower.startsWith('mailto:')) m.contacts.mailtoLinks++;
          else if (/wa\.me\/|api\.whatsapp\.com/.test(lower)) m.contacts.whatsappLinks++;
          const u = resolveUrl(href, baseUrl);
          if (!u || (u.protocol !== 'http:' && u.protocol !== 'https:')) break;
          u.hash = '';
          const internal = isInternal(u);
          const nofollow = (attr(n, 'rel') ?? '').toLowerCase().includes('nofollow');
          if (internal) m.linkCounts.internal++;
          else m.linkCounts.external++;
          if (nofollow) m.linkCounts.nofollow++;
          if (!internal && SOCIAL.test(u.hostname)) social.add(u.hostname.replace(/^(www|m)\./, ''));
          if (m.links.length < 400)
            m.links.push({
              href: u.toString(),
              text: clip(textOf(n).join(' ') || attr(n, 'title') || attr(n, 'aria-label') || '', 120),
              internal,
              nofollow,
            });
          break;
        }
        case 'img': {
          m.images.total++;
          const alt = attr(n, 'alt');
          if (alt === null) m.images.missingAlt++;
          else if (!alt.trim()) m.images.emptyAlt++;
          if (!attr(n, 'width') || !attr(n, 'height')) m.images.withoutDimensions++;
          if ((attr(n, 'loading') ?? '').toLowerCase() === 'lazy') m.images.lazy++;
          if (attr(n, 'srcset')) m.images.withSrcset++;
          insecure(attr(n, 'src'), false);
          break;
        }
        case 'script': {
          const src = attr(n, 'src');
          if (src) {
            m.scripts.external++;
            const u = resolveUrl(src, baseUrl);
            if (u && scriptHosts.size < 40) scriptHosts.add(u.hostname);
            insecure(src, true);
          } else {
            m.scripts.inline++;
            if ((attr(n, 'type') ?? '').toLowerCase() === 'application/ld+json') {
              m.structuredData.jsonLdBlocks++;
              const raw = textOf({ nodeName: 'x', childNodes: n.childNodes }).join('');
              try {
                collectTypes(JSON.parse(raw));
              } catch {
                m.structuredData.jsonLdInvalid++;
              }
            }
          }
          break;
        }
        case 'style': {
          m.inlineCss.styleBlocks++;
          const css = textOf({ nodeName: 'x', childNodes: n.childNodes }).join('');
          m.inlineCss.mediaQueries += (css.match(/@media/gi) ?? []).length;
          for (const w of css.matchAll(/(?:^|[;{\s])(?:min-)?width\s*:\s*(\d{3,5})px/gi))
            if (Number(w[1]) >= 900) m.inlineCss.fixedWidthsPx.push(Number(w[1]));
          break;
        }
        case 'form': {
          m.forms.count++;
          const action = attr(n, 'action');
          if (action) {
            const u = resolveUrl(action, baseUrl);
            if (u && m.forms.actions.length < 20) m.forms.actions.push(u.toString());
            if (u?.protocol === 'http:') m.forms.insecureActions.push(u.toString());
          }
          break;
        }
        case 'input': {
          const type = (attr(n, 'type') ?? '').toLowerCase();
          if (type === 'email') m.forms.withEmailField++;
          if (type === 'password') m.forms.withPassword++;
          break;
        }
        case 'iframe':
          if (m.iframes.length < 20) {
            const u = resolveUrl(attr(n, 'src') ?? '', baseUrl);
            if (u) m.iframes.push(u.toString());
          }
          insecure(attr(n, 'src'), true);
          break;
        case 'frameset':
        case 'frame':
          m.legacy.frameset = true;
          break;
        case 'object':
        case 'embed': {
          const data = `${attr(n, 'data') ?? ''} ${attr(n, 'src') ?? ''} ${attr(n, 'type') ?? ''}`.toLowerCase();
          if (data.includes('.swf') || data.includes('shockwave') || data.includes('x-shockwave-flash'))
            m.legacy.flashObjects++;
          break;
        }
        case 'table':
          childTableDepth = tableDepth + 1;
          // tabelle annidate o larghe a pixel fissi: impaginazione a tabelle tipica dei siti datati
          if (childTableDepth >= 2 || Number(attr(n, 'width') ?? 0) >= 760) m.legacy.layoutTables++;
          break;
        case 'font':
          m.legacy.fontTags++;
          break;
        case 'marquee':
          m.legacy.marquee = true;
          break;
      }
      const style = attr(n, 'style');
      if (style)
        for (const w of style.matchAll(/(?:^|;)\s*(?:min-)?width\s*:\s*(\d{3,5})px/gi))
          if (Number(w[1]) >= 900) m.inlineCss.fixedWidthsPx.push(Number(w[1]));
      const widthAttr = Number(attr(n, 'width') ?? 0);
      if (widthAttr >= 900 && tag !== 'img' && tag !== 'iframe' && tag !== 'video')
        m.inlineCss.fixedWidthsPx.push(widthAttr);
    }
    if (n.nodeName === 'script' || n.nodeName === 'style') continue;
    const children = n.nodeName === 'template' ? (n.content?.childNodes ?? []) : (n.childNodes ?? []);
    for (let i = children.length - 1; i >= 0; i--) stack.push({ node: children[i]!, tableDepth: childTableDepth });
  }

  const body = textOf(doc).join(' ').replace(/\s+/g, ' ').trim();
  m.text = { chars: body.length, words: body ? body.split(' ').length : 0 };
  const year = /(?:©|&copy;|copyright)\s*(?:\d{4}\s*[-–]\s*)?(\d{4})/i.exec(body)?.[1];
  m.copyrightYear = year ? Number(year) : null;
  m.structuredData.types = [...types].slice(0, 30);
  m.structuredData.microdataTypes = [...micro].slice(0, 30);
  m.scripts.srcHosts = [...scriptHosts];
  m.socialDomains = [...social].slice(0, 10);
  m.inlineCss.fixedWidthsPx = [...new Set(m.inlineCss.fixedWidthsPx)].slice(0, 20);
  m.insecureResources.active = [...new Set(m.insecureResources.active)].slice(0, 20);
  m.insecureResources.passive = [...new Set(m.insecureResources.passive)].slice(0, 20);
  // testo per i rilevamenti: contenuto, testi e indirizzi dei link, sorgenti degli script (non salvato)
  m.searchableText = [
    body,
    ...m.links.map((l) => `${l.text} ${l.href}`),
    ...m.iframes,
    ...m.forms.actions,
    ...m.scripts.srcHosts,
    m.generator ?? '',
  ]
    .join(' \n ')
    .toLowerCase()
    .slice(0, 200_000);
  return m;
}

/** Copia delle misure da salvare: senza il testo dei rilevamenti e con al massimo 100 link. */
export function storableMeasurements(m: PageMeasurements) {
  const { searchableText: _omit, links, ...rest } = m;
  return { ...rest, links: links.slice(0, 100) };
}
