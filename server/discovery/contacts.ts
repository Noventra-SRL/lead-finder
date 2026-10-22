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

export function classifyEmail(raw: string | null): { email: string | null; kind: 'generic' | 'personal' | null } {
  if (!raw) return { email: null, kind: null };
  const email = raw
    .trim()
    .toLowerCase()
    .replace(/^mailto:/, '');
  if (!EMAIL.test(email) || email.length > 120) return { email: null, kind: null };
  const local = email.split('@')[0]!;
  return GENERIC_LOCAL.test(local) ? { email, kind: 'generic' } : { email: null, kind: 'personal' };
}

export function contactsFromTags(tags: Record<string, string>) {
  const phone = normalizePhone(first(tags.phone, tags['contact:phone'], tags.mobile, tags['contact:mobile']));
  const { email, kind } = classifyEmail(first(tags.email, tags['contact:email']));
  return { phone, email, emailKind: kind };
}
