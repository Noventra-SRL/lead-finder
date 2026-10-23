import { classifyEmail, matchesBusinessName } from '../discovery/contacts.ts';

/*
 * Email pubblicate sul sito dell'azienda: estrazione dalle pagine già lette dall'audit (stesso sito, robots.txt
 * rispettato, nessun JavaScript eseguito), normalizzazione, validazione e scelta del recapito.
 *
 * Regole (esplicite e modificabili qui):
 *  - si leggono solo gli indirizzi SCRITTI nella pagina: link mailto: e testo visibile (anche «info [at] dominio.it»,
 *    che è comunque scritto dall'azienda). Gli indirizzi protetti contro la raccolta automatica (es. la protezione
 *    email di Cloudflare) non vengono decodificati;
 *  - nessun indirizzo viene mai generato o dedotto dal dominio (niente «info@dominio.it» se non è scritto);
 *  - scartati: segnaposto (example.com, tuodominio…), file (logo@2x.png), indirizzi tecnici (noreply, sentry, wix…);
 *  - si conservano solo gli indirizzi dell'attività: generici (info@, prenotazioni@…) o con il nome dell'attività;
 *    un indirizzo che sembra personale (nome.cognome@) non viene salvato (minimizzazione, come per la scoperta);
 *  - relazione con il sito: stesso dominio, casella gratuita (gmail, libero…), PEC, altro dominio (es. l'agenzia che
 *    ha realizzato il sito: mai scelto come recapito);
 *  - recapito scelto: stesso dominio prima, poi casella gratuita; tra questi l'ordine di CONTACT_PREFERENCE; mai una
 *    PEC né un altro dominio. Nessuna di queste regole rende un indirizzo «verificato».
 */

export type EmailRelation = 'same_domain' | 'free_provider' | 'pec' | 'other_domain';

export interface FoundEmail {
  email: string;
  /** Pagina in cui è scritto. */
  pageUrl: string;
  /** Dove nella pagina: link mailto: o testo. */
  via: 'mailto' | 'text';
  relation: EmailRelation;
}

/** Caselle di posta gratuite: plausibili per piccole attività, ma meno legate al sito di un indirizzo del dominio. */
export const FREE_PROVIDERS = new Set([
  'gmail.com',
  'googlemail.com',
  'libero.it',
  'virgilio.it',
  'alice.it',
  'tim.it',
  'tin.it',
  'tiscali.it',
  'hotmail.com',
  'hotmail.it',
  'outlook.com',
  'outlook.it',
  'live.com',
  'live.it',
  'msn.com',
  'yahoo.com',
  'yahoo.it',
  'icloud.com',
  'me.com',
  'aruba.it',
  'fastwebnet.it',
  'email.it',
  'inwind.it',
  'iol.it',
  'katamail.com',
  'teletu.it',
  'vodafone.it',
]);

/** Posta elettronica certificata: indirizzo legale, non un recapito commerciale. */
const PEC =
  /(^|\.)(pec\.[a-z0-9.-]+|legalmail\.it|arubapec\.it|postacert\.[a-z0-9.-]+|pecveneto\.it|cert\.[a-z0-9.-]+|pec[a-z]*\.it)$/;

/** Preferenza tra più indirizzi dell'attività (parte prima della @). Il primo che corrisponde vince. */
export const CONTACT_PREFERENCE: RegExp[] = [
  /^info\b/,
  /^(contatti|contatto|contact|contacts|informazioni)\b/,
  /^(commerciale|vendite|sales|marketing|preventivi|richieste)\b/,
  /^(prenotazioni|prenota|booking|reservations?|reception|accoglienza)\b/,
  /^(segreteria|ufficio|office|studio|direzione|amministrazione)\b/,
];

// segnaposto dei modelli di sito (dominio esatto) e domini tecnici delle piattaforme (anche i sottodomini)
const PLACEHOLDER_DOMAIN =
  /^(example\.(com|org|net|it)|domain\.(com|it)|dominio\.(it|com)|tuodominio\.it|tuosito\.it|yourdomain\.com|yoursite\.com|test\.(com|it))$/;
const TECHNICAL_DOMAIN =
  /(^|\.)(sentry\.io|wixpress\.com|wix\.com|godaddy\.com|squarespace\.com|jimdo\.com|wordpress\.(com|org)|w3\.org|schema\.org)$/;
const PLACEHOLDER_LOCAL =
  /^(nome|name|tuonome|yourname|your\.?email|email|mail|user|utente|esempio|example|test|xxx+|noreply|no-reply|donotreply|do-not-reply|mailer-daemon|postmaster|webmaster|abuse|privacy-sentry)$/;
const FILE_LIKE = /\.(png|jpe?g|gif|webp|svg|bmp|ico|css|js|mjs|json|xml|pdf|zip|mp4|webm|woff2?|ttf)$/;
const ADDRESS = /^[a-z0-9](?:[a-z0-9._%+-]{0,62}[a-z0-9])?@(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,24}$/;

/** Dominio senza «www.», minuscolo. */
const bare = (host: string) => host.toLowerCase().replace(/^www\./, '');

/** Stesso dominio del sito, anche tra sottodominio e dominio principale (mail.farmacia.it ↔ farmacia.it). */
function sameDomain(emailDomain: string, siteHost: string) {
  const a = bare(emailDomain);
  const b = bare(siteHost);
  return a === b || a.endsWith(`.${b}`) || b.endsWith(`.${a}`);
}

export function relationOf(email: string, siteHost: string): EmailRelation {
  const domain = email.split('@')[1]!;
  if (PEC.test(domain)) return 'pec';
  if (sameDomain(domain, siteHost)) return 'same_domain';
  if (FREE_PROVIDERS.has(domain)) return 'free_provider';
  return 'other_domain';
}

/** Normalizza un indirizzo letto in una pagina; null se non è un indirizzo valido e reale. */
export function normalizeEmail(raw: string): string | null {
  let s = raw.trim();
  try {
    s = decodeURIComponent(s);
  } catch {
    // percentuali non valide: si usa il testo così com'è
  }
  s = s
    .replace(/^mailto:/i, '')
    .split('?')[0]!
    .trim()
    .replace(/^[<("'[]+|[>)"'\].,;:!]+$/g, '')
    .toLowerCase();
  if (s.length > 120 || !ADDRESS.test(s) || s.includes('..')) return null;
  const [local, domain] = s.split('@') as [string, string];
  if (FILE_LIKE.test(s) || /@\d+x\./.test(s)) return null;
  if (PLACEHOLDER_DOMAIN.test(domain) || TECHNICAL_DOMAIN.test(domain) || PLACEHOLDER_LOCAL.test(local)) return null;
  // stringhe tecniche con lunghe sequenze esadecimali (identificatori, non caselle)
  if (/[0-9a-f]{16,}/.test(local)) return null;
  return s;
}

/** Testo visibile: senza script, stili, commenti e tag. */
function visibleText(html: string) {
  return html
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|noscript|template|svg)[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#64;|&#x40;|&commat;/gi, '@')
    .replace(/&#46;|&period;/gi, '.')
    .replace(/&nbsp;|&#160;/gi, ' ')
    .replace(/&amp;/gi, '&');
}

const MAILTO = /href\s*=\s*["']\s*mailto:([^"'?#\s>]+)/gi;
const TEXT_EMAIL = /[a-z0-9][a-z0-9._%+-]{0,63}@[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,24}/gi;
// «info [at] dominio [dot] it», «info (chiocciola) dominio.it»: scritto dall'azienda, solo con le parentesi
const SPELLED =
  /([a-z0-9][a-z0-9._%+-]{0,63})\s*[[(]\s*(?:at|chiocciola)\s*[\])]\s*([a-z0-9-]+(?:\s*(?:[[(]\s*(?:dot|punto)\s*[\])]|\.)\s*[a-z0-9-]+)+)/gi;

/** Indirizzi scritti in una pagina (link mailto: e testo visibile), normalizzati e senza doppioni. */
export function extractEmails(html: string, pageUrl: string, siteHost: string): FoundEmail[] {
  const out = new Map<string, FoundEmail>();
  const add = (raw: string, via: FoundEmail['via']) => {
    const email = normalizeEmail(raw);
    if (email && !out.has(email)) out.set(email, { email, pageUrl, via, relation: relationOf(email, siteHost) });
  };
  for (const m of html.matchAll(MAILTO)) for (const part of m[1]!.split(/[,;]/)) add(part, 'mailto');
  const text = visibleText(html);
  for (const m of text.matchAll(TEXT_EMAIL)) add(m[0], 'text');
  for (const m of text.matchAll(SPELLED))
    add(`${m[1]}@${m[2]!.replace(/\s*[[(]\s*(?:dot|punto)\s*[\])]\s*/gi, '.').replace(/\s+/g, '')}`, 'text');
  return [...out.values()];
}

/** Parole significative del nome dell'attività (per riconoscere una casella con il nome, es. trattoriadapino@). */
/**
 * L'indirizzo è un recapito dell'attività (non di una persona)? Generico (info@…) oppure con il nome dell'attività.
 * Un indirizzo che sembra personale non viene conservato.
 */
export function isBusinessAddress(email: string, businessName: string): boolean {
  if (classifyEmail(email).kind === 'generic') return !/^(noreply|no-reply)/.test(email);
  const local = email.split('@')[0]!.replace(/[^a-z0-9]/g, '');
  return matchesBusinessName(local, businessName);
}

/** Indirizzo da proporre come recapito dell'attività, tra quelli conservati; null se nessuno è adatto. */
export function chooseContact<T extends { email: string; relation: EmailRelation }>(found: T[]): T | null {
  const usable = found.filter((f) => f.relation === 'same_domain' || f.relation === 'free_provider');
  const rank = (f: T) => {
    const local = f.email.split('@')[0]!;
    const pref = CONTACT_PREFERENCE.findIndex((re) => re.test(local));
    return (f.relation === 'same_domain' ? 0 : 100) + (pref === -1 ? CONTACT_PREFERENCE.length : pref);
  };
  return usable.sort((a, b) => rank(a) - rank(b) || a.email.localeCompare(b.email))[0] ?? null;
}
