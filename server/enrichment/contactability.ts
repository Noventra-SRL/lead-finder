/*
 * Contattabilità via email di un'azienda: una sola definizione in SQL (alias del FROM dell'elenco: b = businesses,
 * bw = business_websites, w = websites, aa = valutazione AI corrente). Separata dal punteggio commerciale, che non
 * cambia.
 *
 *  verificata             recapito confermato con una verifica affidabile (nessuna verifica automatica oggi)
 *  pubblicata             recapito scritto su una pagina del sito dell'azienda
 *  da_verificare          un indirizzo plausibile senza quella prova: indicato dalla fonte della scoperta, oppure sul sito
 *                         ma non adatto come recapito (PEC, altro dominio)
 *  da_arricchire          sito proprio non ancora controllato per le email
 *  nessuna_email          pagine del sito controllate, nessun indirizzo dell'attività
 *  sito_non_accessibile   sito irraggiungibile, bloccato, indirizzo non valido o controllo non riuscito
 *  senza_sito             nessun sito proprio indicato (o solo una pagina social / di una piattaforma)
 */

export const CONTACTABILITY = [
  'verificata',
  'pubblicata',
  'da_verificare',
  'da_arricchire',
  'nessuna_email',
  'sito_non_accessibile',
  'senza_sito',
] as const;
export type Contactability = (typeof CONTACTABILITY)[number];

export const CONTACTABILITY_LABEL: Record<Contactability, string> = {
  verificata: 'Email verificata',
  pubblicata: 'Email pubblicata sul sito',
  da_verificare: 'Email da verificare',
  da_arricchire: 'Sito da controllare',
  nessuna_email: 'Nessuna email trovata',
  sito_non_accessibile: 'Sito non accessibile',
  senza_sito: 'Senza sito web',
};

const USABLE = `(b.email IS NOT NULL AND b.email_kind IS DISTINCT FROM 'personal')`;
const NO_OWN_SITE = `(bw.status = 'not_found' OR (bw.business_id IS NULL AND (NOT b.has_website OR b.website_shared)))`;
const SITE_DOWN = `(bw.status = 'invalid_url' OR w.status IN ('unreachable', 'timeout', 'blocked', 'invalid_url', 'audit_failed'))`;
const OTHER_ADDRESSES = `EXISTS (SELECT 1 FROM website_emails we WHERE we.website_id = w.id)`;

export const CONTACTABILITY_SQL = `CASE
  WHEN ${USABLE} AND b.email_status = 'verificata' THEN 'verificata'
  WHEN ${USABLE} AND b.email_status = 'pubblicata' THEN 'pubblicata'
  WHEN ${USABLE} THEN 'da_verificare'
  WHEN ${NO_OWN_SITE} THEN 'senza_sito'
  WHEN ${SITE_DOWN} THEN 'sito_non_accessibile'
  WHEN w.emails_checked_at IS NULL THEN 'da_arricchire'
  WHEN ${OTHER_ADDRESSES} THEN 'da_verificare'
  ELSE 'nessuna_email' END`;

/**
 * Priorità di contatto (ordinamento «Priorità: aziende con email disponibile»), dal più facile e promettente:
 *  0  email disponibile e punteggio commerciale alto (≥ 60)
 *  1  email disponibile, valutazione commerciale AI ancora da fare
 *  2  email disponibile, punteggio più basso
 *  3  sito proprio senza email trovata (ancora da controllare o da riprovare)
 *  4  senza sito o sito non accessibile
 * A parità, punteggio commerciale decrescente. Il punteggio resta quello del modello esistente.
 */
export function prioritySql(commercialScore: string) {
  return `CASE
    WHEN ${USABLE} AND (${commercialScore}) >= 60 THEN 0
    WHEN ${USABLE} AND aa.id IS NULL THEN 1
    WHEN ${USABLE} THEN 2
    WHEN NOT ${NO_OWN_SITE} AND NOT ${SITE_DOWN} THEN 3
    ELSE 4 END`;
}
