import type { CommercialPriority, NextFollowUp, StageId } from '../api/client.ts';

type Tone = 'ok' | 'warn' | 'danger' | 'idle';

/** Tono dello stato di una fase: neutro mentre si lavora, verde se vinta, rosso se persa. */
export const STAGE_TONE: Record<StageId, Tone> = {
  da_qualificare: 'idle',
  da_contattare: 'idle',
  primo_contatto: 'idle',
  in_attesa: 'idle',
  interessato: 'warn',
  appuntamento: 'warn',
  preventivo: 'warn',
  negoziazione: 'warn',
  vinto: 'ok',
  perso: 'danger',
  non_contattare: 'idle',
};

/** Nomi delle fasi (gli stessi di /api/crm/meta), per le pagine che non caricano il CRM. */
export const STAGE_LABEL: Record<StageId, string> = {
  da_qualificare: 'Da qualificare',
  da_contattare: 'Da contattare',
  primo_contatto: 'Primo contatto effettuato',
  in_attesa: 'In attesa di risposta',
  interessato: 'Interessato',
  appuntamento: 'Call o appuntamento fissato',
  preventivo: 'Preventivo inviato',
  negoziazione: 'Negoziazione',
  vinto: 'Vinto',
  perso: 'Perso',
  non_contattare: 'Non contattare',
};

export const PRIORITY_LABEL: Record<CommercialPriority, string> = { alta: 'Alta', media: 'Media', bassa: 'Bassa' };

const EURO = new Intl.NumberFormat('it-IT', { style: 'currency', currency: 'EUR', maximumFractionDigits: 2 });
export const formatEuro = (v: number | null) => (v === null ? '—' : EURO.format(v));

const DAY = new Intl.DateTimeFormat('it-IT', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });

/** Scadenza leggibile: "oggi", "domani", altrimenti "mar 21 ott"; con l'ora se indicata. */
export function formatDue(date: string, time: string | null, today: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  const t = new Date(`${today}T00:00:00Z`);
  const days = Math.round((d.getTime() - t.getTime()) / 86_400_000);
  const label = days === 0 ? 'oggi' : days === 1 ? 'domani' : days === -1 ? 'ieri' : DAY.format(d);
  return time ? `${label}, ${time}` : label;
}

/** Testo della prossima azione con lo stato della scadenza (mai solo il colore). */
export function dueText(f: NextFollowUp, today: string): string {
  const when = formatDue(f.dueDate, f.dueTime, today);
  return f.overdue ? `Scaduto: ${when}` : f.dueToday ? `Oggi${f.dueTime ? `, ${f.dueTime}` : ''}` : when;
}

/** Data di oggi (AAAA-MM-GG) nel fuso orario italiano, per i campi data. */
export function todayRome(): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Rome',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date());
  const get = (t: string) => parts.find((p) => p.type === t)!.value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}

/** Data e ora locali per un campo datetime-local (attività appena svolte). */
export function nowLocalInput(): string {
  const d = new Date();
  d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
  return d.toISOString().slice(0, 16);
}
