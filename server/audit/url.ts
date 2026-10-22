import { isSharedDomain } from '../discovery/website.ts';

/*
 * Indirizzo da analizzare per un'azienda. Si usa solo il sito indicato dalla fonte: un profilo social o una scheda in
 * una directory NON sono considerati il sito ufficiale (stato "not_found", con il motivo).
 * La chiave del sito (host senza "www." + percorso) riconosce lo stesso sito scritto in modi diversi
 * (http/https, con o senza www, barra finale): lo stesso sito viene analizzato una volta sola.
 */

export type WebsiteTarget =
  | { kind: 'ok'; url: string; siteKey: string; host: string }
  | { kind: 'none'; reason: string }
  | { kind: 'invalid'; reason: string };

export const bareHost = (host: string) =>
  host
    .toLowerCase()
    .replace(/\.$/, '')
    .replace(/^www\d?\./, '');

export function siteKeyOf(url: URL): string {
  const path = url.pathname.replace(/\/+$/, '').toLowerCase();
  // porta solo se non predefinita (fuori dai test le porte ammesse sono 80 e 443)
  return `${bareHost(url.hostname)}${url.port ? `:${url.port}` : ''}${path}`;
}

export function websiteTarget(raw: string | null | undefined): WebsiteTarget {
  if (!raw?.trim()) return { kind: 'none', reason: 'La fonte non indica un sito web.' };
  let url: URL;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:/i.test(raw.trim()) ? raw.trim() : `http://${raw.trim()}`);
  } catch {
    return { kind: 'invalid', reason: 'L’indirizzo del sito non è un URL valido.' };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:')
    return { kind: 'invalid', reason: `Protocollo non supportato (${url.protocol}).` };
  if (url.username || url.password) return { kind: 'invalid', reason: 'L’indirizzo contiene credenziali.' };
  if (!/^[a-z0-9.-]+$/i.test(url.hostname) || !url.hostname.includes('.'))
    return { kind: 'invalid', reason: 'Nome di dominio non valido.' };
  if (isSharedDomain(bareHost(url.hostname)))
    return {
      kind: 'none',
      reason: `Indicato solo un indirizzo su una piattaforma condivisa (${bareHost(url.hostname)}), non un sito proprio.`,
    };
  url.hash = '';
  return { kind: 'ok', url: url.toString(), siteKey: siteKeyOf(url), host: url.hostname.toLowerCase() };
}

/** Stesso sito: stesso host a meno del "www." iniziale (i sottodomini diversi sono considerati esterni). */
export const sameSite = (a: URL, b: URL) => bareHost(a.hostname) === bareHost(b.hostname);
