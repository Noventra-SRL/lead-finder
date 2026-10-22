import type { PageMeasurements } from './html.ts';

/*
 * Indicatori di contenuto e di attività, rilevati nel codice delle pagine esaminate (testo, link, form, script).
 * Sono "rilevato / non rilevato nelle pagine esaminate", mai "assente dal sito": una funzione può esistere in una
 * pagina non esaminata o essere caricata da JavaScript. Le evidenze sono parole o indirizzi trovati, mai recapiti.
 */

export interface Signal {
  detected: boolean;
  /** Cosa è stato trovato (termine, dominio o pagina), per l'evidenza. */
  evidence: string[];
}

export interface Signals {
  contactPage: Signal;
  phoneLink: Signal;
  emailLink: Signal;
  contactForm: Signal;
  address: Signal;
  openingHours: Signal;
  privacy: Signal;
  cookie: Signal;
  callToAction: Signal;
  servicesSection: Signal;
  booking: Signal;
  appointment: Signal;
  ordering: Signal;
  menu: Signal;
  ecommerce: Signal;
  rooms: Signal;
  schedule: Signal;
  catalog: Signal;
  otaLinks: Signal;
  social: Signal;
  platforms: string[];
  /** Strumenti di terze parti riconosciuti dal codice (analytics, pixel pubblicitari, CRM, chat, prenotazioni). */
  tools: Tool[];
  /** Agenzia citata nei crediti del sito («realizzato da», «powered by»), solo con formula esplicita. */
  agency: { name: string; href: string } | null;
  /** Pagina o link «lavora con noi»: l'azienda cerca personale. */
  hiring: Signal;
}

export type ToolCategory = 'analytics' | 'advertising' | 'marketing' | 'chat' | 'booking' | 'payments';
export interface Tool {
  name: string;
  category: ToolCategory;
}

interface Page {
  url: string;
  m: PageMeasurements;
  html: string;
}

const BOOKING_ENGINES = [
  'simplebooking',
  'verticalbooking',
  'vertical-booking',
  'octorate',
  'bookingexpert',
  'cloudbeds',
  'synxis',
  'hotelrunner',
  'beddy',
  'wubook',
  'ericsoft',
  'kross',
  'slope.it',
  'blastness',
  'bookassist',
  'siteminder',
  'thefork',
  'quandoo',
  'opentable',
  'covermanager',
  'resmio',
  'plateform',
];
const CMP_HOSTS = [
  'iubenda',
  'cookiebot',
  'onetrust',
  'cookieyes',
  'complianz',
  'usercentrics',
  'didomi',
  'quantcast',
  'cookie-script',
  'termly',
  'osano',
  'cookiefirst',
  'consentmanager',
];
const OTA = ['booking.com', 'expedia.', 'airbnb.', 'hotels.com', 'agoda.', 'trivago.'];

function find(pages: Page[], patterns: RegExp[], where: (p: Page) => string = (p) => p.m.searchableText): Signal {
  const evidence = new Set<string>();
  for (const p of pages) {
    const text = where(p);
    for (const re of patterns) {
      const hit = re.exec(text);
      if (hit) evidence.add(hit[0].trim().slice(0, 60));
    }
  }
  return { detected: evidence.size > 0, evidence: [...evidence].slice(0, 5) };
}

const linksText = (p: Page) =>
  p.m.links
    .map((l) => `${l.text} ${l.href}`)
    .join('\n')
    .toLowerCase();
const merge = (...signals: Signal[]): Signal => {
  const evidence = [...new Set(signals.flatMap((s) => s.evidence))].slice(0, 5);
  return { detected: signals.some((s) => s.detected), evidence };
};

/*
 * Impronte di strumenti di terze parti (da Harvey, tech_detect.py, con aggiunte italiane): host di script distintivi,
 * mai parole generiche, per tenere bassi i falsi positivi.
 */
const TOOL_FINGERPRINTS: [string, ToolCategory, RegExp][] = [
  ['Google Analytics', 'analytics', /googletagmanager\.com\/gtag\/js|google-analytics\.com\/(analytics|ga)\.js/],
  ['Google Tag Manager', 'analytics', /googletagmanager\.com\/gtm\.js/],
  ['Matomo', 'analytics', /matomo\.(js|php)|piwik\.(js|php)/],
  ['Hotjar', 'analytics', /static\.hotjar\.com/],
  ['Microsoft Clarity', 'analytics', /clarity\.ms\/tag/],
  ['Plausible', 'analytics', /plausible\.io\/js/],
  ['Meta Pixel', 'advertising', /connect\.facebook\.net\/[^"']*fbevents\.js/],
  ['Google Ads', 'advertising', /googleadservices\.com\/pagead\/conversion|gtag\(['"]config['"],\s*['"]AW-/],
  ['LinkedIn Insight', 'advertising', /snap\.licdn\.com\/li\.lms-analytics/],
  ['TikTok Pixel', 'advertising', /analytics\.tiktok\.com/],
  ['HubSpot', 'marketing', /js\.hs-scripts\.com|js\.hsforms\.net/],
  ['Mailchimp', 'marketing', /chimpstatic\.com|list-manage\.com\/subscribe/],
  ['Klaviyo', 'marketing', /static\.klaviyo\.com/],
  ['ActiveCampaign', 'marketing', /trackcmp\.net/],
  ['Brevo', 'marketing', /sibforms\.com|sendinblue\.com|brevo\.com\/js/],
  ['MailUp', 'marketing', /mailup\.(com|it)\/(js|frontend)/],
  ['Intercom', 'chat', /widget\.intercom\.io|js\.intercomcdn\.com/],
  ['Tidio', 'chat', /code\.tidio\.co/],
  ['Crisp', 'chat', /client\.crisp\.chat/],
  ['Zendesk', 'chat', /static\.zdassets\.com/],
  ['LiveChat', 'chat', /cdn\.livechatinc\.com/],
  ['Tawk.to', 'chat', /embed\.tawk\.to/],
  ['Calendly', 'booking', /assets\.calendly\.com|calendly\.com\/[\w-]+\//],
  ['Stripe', 'payments', /js\.stripe\.com/],
  ['PayPal', 'payments', /paypal\.com\/sdk\/js|paypalobjects\.com/],
];

export function detectTools(html: string): Tool[] {
  const h = html.slice(0, 600_000);
  return TOOL_FINGERPRINTS.filter(([, , re]) => re.test(h)).map(([name, category]) => ({ name, category }));
}

/*
 * Agenzia nei crediti (da Harvey, detect_agency): solo un link esterno preceduto da una formula esplicita
 * («realizzato da», «powered by», …). Un link nudo nel footer non basta: un'agenzia sbagliata citata in un'email è
 * peggio di nessuna.
 */
const CREDIT =
  /\b(realizzat[oa]|sviluppat[oa]|progettat[oa]|creat[oa]|design|sito|web\s*design|grafica|powered|designed|developed|made|built)\s+(da|by|con)\s*:?\s*$/i;
const NOT_AGENCY =
  /facebook|instagram|linkedin|twitter|x\.com|youtube|tiktok|google|apple\.com|wordpress\.org|wix\.com|shopify|iubenda|cookiebot|w3\.org|schema\.org|jquery|whatsapp|tripadvisor|booking\.com/;

export function detectAgency(html: string, siteHost: string): { name: string; href: string } | null {
  const footer = /<footer\b[\s\S]*?<\/footer>/i.exec(html)?.[0] ?? html.slice(-15_000);
  const own = siteHost.replace(/^www\./, '').toLowerCase();
  for (const link of footer.matchAll(/<a\b[^>]*href=["'](https?:\/\/[^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    const href = link[1]!;
    let host: string;
    try {
      host = new URL(href).hostname.replace(/^www\./, '').toLowerCase();
    } catch {
      continue;
    }
    if (!host || host === own || host.endsWith(`.${own}`) || own.endsWith(`.${host}`) || NOT_AGENCY.test(host))
      continue;
    const name = link[2]!
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (!name || name.length > 60) continue;
    const before = footer
      .slice(Math.max(0, link.index! - 160), link.index)
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/\s+/g, ' ');
    if (CREDIT.test(before)) return { name, href: `https://${host}/` };
  }
  return null;
}

/** Piattaforme e CMS riconoscibili dal codice (solo indizi). */
export function detectPlatforms(html: string, m: PageMeasurements): string[] {
  const h = html.slice(0, 600_000).toLowerCase();
  const gen = (m.generator ?? '').toLowerCase();
  const found = new Set<string>();
  if (h.includes('cdn.shopify.com') || h.includes('myshopify.com')) found.add('Shopify');
  if (h.includes('woocommerce')) found.add('WooCommerce');
  if (/mage\/|magento_|mage-cache|static\/version\d+\/frontend/.test(h)) found.add('Magento');
  if (h.includes('prestashop')) found.add('PrestaShop');
  if (h.includes('wixstatic.com') || h.includes('static.parastorage.com') || gen.includes('wix')) found.add('Wix');
  if (h.includes('squarespace')) found.add('Squarespace');
  if (h.includes('/wp-content/') || h.includes('/wp-includes/') || gen.includes('wordpress')) found.add('WordPress');
  if (gen.includes('joomla') || h.includes('/media/jui/') || h.includes('/components/com_')) found.add('Joomla');
  if (gen.includes('drupal') || h.includes('drupal-settings-json') || h.includes('/sites/default/files/'))
    found.add('Drupal');
  if (h.includes('webflow')) found.add('Webflow');
  if (h.includes('jimdo')) found.add('Jimdo');
  if (h.includes('godaddy') && h.includes('website builder')) found.add('GoDaddy Website Builder');
  return [...found];
}

export function detectSignals(pages: Page[]): Signals {
  const allLinks = (p: Page) => linksText(p);
  return {
    contactPage: find(pages, [/\bcontatt[io]\b|\bcontact(s|o)?\b|dove[\s-]siamo|come[\s-]raggiungerci/], allLinks),
    phoneLink: {
      detected: pages.some((p) => p.m.contacts.telLinks > 0),
      evidence: pages.some((p) => p.m.contacts.telLinks > 0) ? ['link tel:'] : [],
    },
    emailLink: {
      detected: pages.some((p) => p.m.contacts.mailtoLinks > 0),
      evidence: pages.some((p) => p.m.contacts.mailtoLinks > 0) ? ['link mailto:'] : [],
    },
    contactForm: {
      detected: pages.some((p) => p.m.forms.count > 0 && p.m.forms.withEmailField > 0),
      evidence: pages
        .filter((p) => p.m.forms.count > 0 && p.m.forms.withEmailField > 0)
        .map((p) => p.url)
        .slice(0, 3),
    },
    address: merge(
      find(pages, [
        /\b(via|viale|piazza|piazzale|corso|largo|vicolo|strada|contrada|località|loc\.)\s+[a-zà-ù'.\s]{2,40}?,?\s*\d{1,4}\b/,
      ]),
      {
        detected: pages.some((p) => p.m.structuredData.types.includes('PostalAddress')),
        evidence: pages.some((p) => p.m.structuredData.types.includes('PostalAddress'))
          ? ['PostalAddress (dati strutturati)']
          : [],
      },
    ),
    openingHours: find(pages, [
      /\borar[io]\b[^\n]{0,80}?\b\d{1,2}[:.]\d{2}\b/,
      /\b(lun|mar|mer|gio|ven|sab|dom)[a-zì]*\.?\s*[-–/a-zì.\s]{0,20}\d{1,2}[:.]\d{2}/,
      /openinghours|opening hours|orari di apertura/,
    ]),
    privacy: find(pages, [/privacy|informativa sul trattamento|trattamento dei dati/], allLinks),
    cookie: merge(
      find(pages, [/cookie policy|informativa (sui |sull'uso dei )?cookie|\bcookie\b/], allLinks),
      find(
        pages,
        [new RegExp(CMP_HOSTS.join('|'))],
        (p) => p.m.scripts.srcHosts.join(' ').toLowerCase() + ' ' + p.html.slice(0, 300_000).toLowerCase(),
      ),
    ),
    callToAction: find(
      pages,
      [
        /\b(contattaci|chiamaci|chiama ora|scrivici|richiedi|preventivo|prenota|acquista|ordina|iscriviti|scopri di più|vieni a trovarci|book now|contact us)\b/,
      ],
      allLinks,
    ),
    servicesSection: find(
      pages,
      [/\bservizi\b|\bprodotti\b|cosa facciamo|\bcatalogo\b|\bsoluzioni\b|\bservices\b|\bproducts\b|\bspecialità\b/],
      allLinks,
    ),
    booking: merge(
      find(
        pages,
        [
          /\bprenota(\s+(ora|adesso|online|un tavolo|la tua camera|il tuo soggiorno))?\b|\bprenotazion[ei]\b|\bbook now\b|\breserv(e|ation)\b|verifica disponibilità/,
        ],
        allLinks,
      ),
      find(pages, [new RegExp(BOOKING_ENGINES.join('|').replace(/\./g, '\\.'))]),
    ),
    appointment: find(pages, [
      /appuntament[oi]|prenota (una )?(visita|consulenza)|calendly|miodottore|docplanner|prenotazioni online|setmore|acuityscheduling/,
    ]),
    ordering: find(pages, [
      /ordina (online|ora|adesso)|asporto|consegna a domicilio|delivery|justeat|deliveroo|glovo|ubereats|uber eats/,
    ]),
    menu: find(
      pages,
      [
        /\bmen[uù]\b[^#\n]{0,40}(pdf|piatti|pranzo|cena|degustazione)|i nostri piatti|carta dei vini|il nostro men[uù]|\/men[uù]\b/,
      ],
      allLinks,
    ),
    ecommerce: find(pages, [
      /carrello|aggiungi al carrello|add to cart|checkout|\/cart\b|negozio online|shop online|acquista online|\/shop\b|\/negozio\b/,
    ]),
    rooms: find(pages, [/\bcamer[ae]\b|\bsuite\b|\brooms?\b|\balloggi\b|\bappartament[io]\b/]),
    schedule: find(pages, [
      /\bcorsi\b|calendario (delle )?lezioni|palinsesto|orario (dei corsi|delle lezioni)|\babbonament[io]\b/,
    ]),
    catalog: find(pages, [/\bprodotti\b|\bcatalogo\b|parafarmac|cosmesi|dermocosmesi|integratori|\bshop\b/]),
    otaLinks: find(pages, [new RegExp(OTA.map((d) => d.replace(/\./g, '\\.')).join('|'))], (p) =>
      p.m.links
        .filter((l) => !l.internal)
        .map((l) => l.href)
        .join(' ')
        .toLowerCase(),
    ),
    social: {
      detected: pages.some((p) => p.m.socialDomains.length > 0),
      evidence: [...new Set(pages.flatMap((p) => p.m.socialDomains))].slice(0, 5),
    },
    platforms: [...new Set(pages.flatMap((p) => detectPlatforms(p.html, p.m)))],
    tools: [...new Map(pages.flatMap((p) => detectTools(p.html)).map((t) => [t.name, t])).values()],
    agency: pages[0] ? detectAgency(pages[0].html, new URL(pages[0].url).hostname) : null,
    hiring: find(
      pages,
      [
        /lavora con noi|unisciti al (nostro )?team|posizioni aperte|offerte di lavoro|candidatur[ae] spontane[ae]|\bcareers?\b|we.?re hiring/,
      ],
      allLinks,
    ),
  };
}
