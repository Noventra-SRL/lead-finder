import { fold } from '../geo/geo.ts';

/*
 * Recapiti pubblici di un'attività, dai tag della fonte (OpenStreetMap: phone, contact:phone, email, contact:email…).
 * Minimizzazione dei dati: si conserva il telefono indicato per l'attività e l'email SOLO se è un indirizzo generico
 * (info@, prenotazioni@, segreteria@…). Un indirizzo che sembra personale (nome.cognome@) non viene salvato:
 * si registra soltanto che la fonte ne indica uno. Nessun recapito viene mai dedotto o generato.
 * Un recapito pubblico non è un consenso al marketing: vedi docs/lead-hunter.md.
 */

const GENERIC_LOCAL =
  /^(info|informazioni|contatti|contatto|contact|contacts|hello|ciao|segreteria|amministrazione|admin|ufficio|uffici|office|prenotazioni|prenota|booking|reservations?|reception|ricevimento|hotel|ristorante|farmacia|ordini|orders?|vendite|sales|commerciale|marketing|support|supporto|assistenza|servizioclienti|customercare|customerservice|clienti|mail|email|posta|studio|shop|negozio|staff|direzione|accoglienza|eventi|events|noreply|preventivi|richieste|amministrativo|fatturazione)([._-]?[a-z0-9]{0,12})?$/;

const EMAIL = /^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/;

/** Primo valore di un tag che può contenerne più di uno separati da ";". */
const first = (...values: (string | undefined)[]) =>
  values
    .filter((v): v is string => Boolean(v?.trim()))
    .flatMap((v) => v.split(';'))
    .map((v) => v.trim())
    .find(Boolean) ?? null;

export function normalizePhone(raw: string | null): string | null {
  if (!raw) return null;
  const cleaned = raw
    .replace(/[^\d+ ()./-]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  const digits = cleaned.replace(/\D/g, '');
  // meno di 6 cifre non è un numero di telefono plausibile; oltre 15 non è un numero E.164
  if (digits.length < 6 || digits.length > 15) return null;
  return cleaned.slice(0, 30);
}

/** Parole significative del nome dell'attività (per riconoscere un indirizzo come «trattoriamario@…»). */
export function nameTokens(name: string) {
  const STOP = new Set(['della', 'delle', 'dello', 'degli', 'dalla', 'dott', 'dottssa', 'studio', 'prova']);
  return fold(name)
    .split(' ')
    .filter((w) => w.length >= 4 && !STOP.has(w));
}

/**
 * La parte locale contiene il nome dell'attività: almeno due parole significative del nome (una sola se il nome ne ha
 * una). «pizzeriadamario» per «Pizzeria da Mario» sì; «mario.rossi» no: sembra l'indirizzo di una persona.
 */
export function matchesBusinessName(local: string, businessName: string): boolean {
  const tokens = nameTokens(businessName);
  if (!tokens.length) return false;
  const compact = local.toLowerCase().replace(/[^a-z0-9]/g, '');
  return tokens.filter((t) => compact.includes(t)).length >= Math.min(2, tokens.length);
}

/**
 * Indirizzo generico (info@…) oppure con il nome dell'attività nella parte locale (es. «pizzeriadamario@gmail.com»):
 * un recapito dell'attività. Gli altri sembrano personali e non vengono conservati.
 */
export function classifyEmail(
  raw: string | null,
  businessName?: string,
): { email: string | null; kind: 'generic' | 'personal' | null } {
  if (!raw) return { email: null, kind: null };
  const email = raw
    .trim()
    .toLowerCase()
    .replace(/^mailto:/, '');
  if (!EMAIL.test(email) || email.length > 120) return { email: null, kind: null };
  const local = email.split('@')[0]!;
  if (GENERIC_LOCAL.test(local)) return { email, kind: 'generic' };
  const compact = local.replace(/[^a-z0-9]/g, '');
  if (businessName && matchesBusinessName(compact, businessName)) return { email, kind: 'generic' };
  return { email: null, kind: 'personal' };
}

/** Tutti i valori di uno o più tag (separati da ";"), senza doppioni. */
const all = (...values: (string | undefined)[]) => [
  ...new Set(
    values
      .filter((v): v is string => Boolean(v?.trim()))
      .flatMap((v) => v.split(';'))
      .map((v) => v.trim())
      .filter(Boolean),
  ),
];

export function contactsFromTags(tags: Record<string, string>) {
  const phone = normalizePhone(first(tags.phone, tags['contact:phone'], tags.mobile, tags['contact:mobile']));
  const { email, kind } = classifyEmail(first(tags.email, tags['contact:email']), tags.name);
  // altri numeri indicati dalla fonte (es. "06 1234; 333 5678") e fax: solo se scritti, mai dedotti
  const phonesExtra = all(tags.phone, tags['contact:phone'], tags.mobile, tags['contact:mobile'])
    .map((p) => normalizePhone(p))
    .filter((p): p is string => p !== null && p !== phone)
    .slice(0, 5);
  const fax = normalizePhone(first(tags.fax, tags['contact:fax']));
  return { phone, email, emailKind: kind, fax, phonesExtra };
}
