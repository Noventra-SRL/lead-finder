/*
 * Controlli sul testo prima dell'invio (da Harvey, gate.py, adattati al modello ufficiale di Noventra): solo codice,
 * nessuna chiamata all'AI. I blocchi sono errori oggettivi (segnaposto rimasti, codice HTML in un'email in solo
 * testo); il resto sono avvisi che la persona valuta nella conferma.
 */

const SUBJECT_MAX = 90;
const BODY_MAX_WORDS = 450;

/** Segnaposto non sostituiti: {nome}, {{azienda}}, [NOME], <AZIENDA>, %nome%. */
const PLACEHOLDER = /\{\{?\s*[\w.]+\s*\}?\}|\[(?:[A-ZÀ-Ù_ ]{3,}|nome|azienda|citt[àa])\]|<[A-Z_]{3,}>|%[a-z_]{3,}%/i;
const HTML = /<\/?(p|br|div|span|a|b|i|strong|em|table|img|ul|li|html|body)\b[^>]*>/i;

/** Frasi tipiche dello spam (filtri antispam e lettori), senza toccare la «consulenza gratuita» del modello. */
const SPAM_PHRASES = [
  /\bgratis\b/i,
  /\b100\s?%/,
  /offerta (imperdibile|limitata|esclusiva)/i,
  /ultim[aie] (occasione|giorni|posti)/i,
  /\bclicca qui\b/i,
  /\bguadagn[aio]\b/i,
  /senza (alcun )?rischio/i,
  /\burgente\b/i,
  /\bsolo per oggi\b/i,
  /€{2,}|\${2,}/,
  /!{2,}/,
];

export function contentChecks(subject: string, body: string): { blockers: string[]; warnings: string[] } {
  const blockers: string[] = [];
  const warnings: string[] = [];
  const text = `${subject}\n${body}`;
  if (PLACEHOLDER.test(text)) blockers.push('Il testo contiene un segnaposto non sostituito (es. {nome} o [AZIENDA]).');
  if (HTML.test(body))
    blockers.push('Il testo contiene codice HTML: l’email parte in solo testo e lo mostrerebbe così.');
  if (subject.trim().length > SUBJECT_MAX)
    warnings.push(`Oggetto lungo (${subject.trim().length} caratteri): oltre ${SUBJECT_MAX} viene spesso troncato.`);
  const letters = subject.replace(/[^A-Za-zÀ-ù]/g, '');
  if (letters.length >= 8 && letters === letters.toUpperCase()) warnings.push('Oggetto tutto in maiuscolo.');
  const words = body.trim().split(/\s+/).filter(Boolean).length;
  if (words > BODY_MAX_WORDS) warnings.push(`Testo lungo (${words} parole): le email brevi ricevono più risposte.`);
  const spam = SPAM_PHRASES.map((re) => re.exec(text)?.[0]).filter((m): m is string => Boolean(m));
  if (spam.length)
    warnings.push(`Espressioni che i filtri antispam penalizzano: ${spam.map((s) => `«${s}»`).join(', ')}.`);
  const external = new Set(
    [...body.matchAll(/https?:\/\/([^/\s]+)/gi)]
      .map((m) => m[1]!.toLowerCase().replace(/^www\./, ''))
      .filter((h) => h !== 'noventra.it'),
  );
  if (external.size) warnings.push(`Link esterni nel testo (${[...external].join(', ')}): ne basta nessuno.`);
  return { blockers, warnings };
}
