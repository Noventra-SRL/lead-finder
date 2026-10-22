/*
 * Normalizzazione dei siti web indicati dalle fonti. Nessuna deduzione: se la fonte non indica un sito,
 * il sito è sconosciuto. Si normalizza solo il formato (schema mancante, spazi, più valori separati da ";").
 */

/** Domini di piattaforme condivise: un indirizzo qui non identifica una singola attività. */
const SHARED_DOMAINS = [
  'facebook.com',
  'fb.com',
  'fb.me',
  'instagram.com',
  'tiktok.com',
  'linkedin.com',
  'twitter.com',
  'x.com',
  'youtube.com',
  'linktr.ee',
  'beacons.ai',
  'business.site',
  'google.com',
  'goo.gl',
  'g.page',
  'maps.app.goo.gl',
  'wixsite.com',
  'wix.com',
  'jimdofree.com',
  'jimdo.com',
  'blogspot.com',
  'wordpress.com',
  'altervista.org',
  'weebly.com',
  'webnode.it',
  'webnode.com',
  'site123.me',
  'tripadvisor.it',
  'tripadvisor.com',
  'booking.com',
  'airbnb.it',
  'airbnb.com',
  'thefork.it',
  'paginegialle.it',
  'paginebianche.it',
  'yelp.it',
  'yelp.com',
  'justeat.it',
  'deliveroo.it',
  'glovoapp.com',
  'miodottore.it',
  'subito.it',
  'amazon.it',
  'ebay.it',
  'wa.me',
  'whatsapp.com',
  't.me',
];

export interface NormalizedWebsite {
  url: string;
  domain: string;
  shared: boolean;
}

export function isSharedDomain(domain: string): boolean {
  return SHARED_DOMAINS.some((d) => domain === d || domain.endsWith(`.${d}`));
}

/** URL assoluto http(s) e dominio; null se il valore non è un indirizzo web plausibile. */
export function normalizeWebsite(raw: string | undefined | null): NormalizedWebsite | null {
  if (!raw) return null;
  // più valori: si usa il primo; spazi interni non sono ammessi in un URL
  let value = raw.split(/[;\s]+/).find((p) => p.length > 0) ?? '';
  if (!value || value.length > 500) return null;
  if (!/^[a-z][a-z0-9+.-]*:/i.test(value)) value = `http://${value.replace(/^\/+/, '')}`;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (url.username || url.password) return null;
  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  // serve un nome di dominio con almeno un punto; niente indirizzi IP o nomi locali
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(host) || /^\d+(\.\d+){3}$/.test(host)) return null;
  url.hash = '';
  const domain = host.replace(/^www\d?\./, '');
  return { url: url.toString(), domain, shared: isSharedDomain(domain) };
}
