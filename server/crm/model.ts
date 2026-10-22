/*
 * Modello del CRM (Fase 7): fasi della pipeline, priorità, tipi di attività, regole di passaggio.
 * Un'unica definizione usata da database (vincoli in 0007_crm.sql), API e interfaccia (tramite /api/crm/meta).
 *
 * Regole:
 *  - al massimo un'opportunità APERTA per azienda; le chiuse (vinto, perso, non contattare) restano come storico;
 *  - tra le fasi aperte ci si sposta liberamente (nessun ordine imposto: una trattativa reale può saltare passaggi);
 *  - "perso" richiede un motivo; chiudere annulla i follow-up in attesa (registrato nella cronologia);
 *  - riaprire un'opportunità chiusa è possibile solo se l'azienda non ne ha un'altra aperta, e da "non contattare"
 *    solo dopo aver reincluso l'azienda (l'esclusione è una decisione esplicita, non si annulla di nascosto);
 *  - "non contattare" esclude anche l'azienda dalla prospezione (Fase 6);
 *  - nessun lavoro automatico (scoperta, audit, punteggio) cambia fase, priorità, valore, note o attività.
 */

export const STAGES = [
  { id: 'da_qualificare', label: 'Da qualificare', closed: false },
  { id: 'da_contattare', label: 'Da contattare', closed: false },
  { id: 'primo_contatto', label: 'Primo contatto effettuato', closed: false },
  { id: 'in_attesa', label: 'In attesa di risposta', closed: false },
  { id: 'interessato', label: 'Interessato', closed: false },
  { id: 'appuntamento', label: 'Call o appuntamento fissato', closed: false },
  { id: 'preventivo', label: 'Preventivo inviato', closed: false },
  { id: 'negoziazione', label: 'Negoziazione', closed: false },
  { id: 'vinto', label: 'Vinto', closed: true },
  { id: 'perso', label: 'Perso', closed: true },
  { id: 'non_contattare', label: 'Non contattare', closed: true },
] as const;

export type StageId = (typeof STAGES)[number]['id'];
export const STAGE_IDS = STAGES.map((s) => s.id) as [StageId, ...StageId[]];
export const CLOSED_STAGES: StageId[] = STAGES.filter((s) => s.closed).map((s) => s.id);
export const OPEN_STAGES: StageId[] = STAGES.filter((s) => !s.closed).map((s) => s.id);
export const isClosed = (s: string) => (CLOSED_STAGES as string[]).includes(s);
export const stageLabel = (s: string) => STAGES.find((x) => x.id === s)?.label ?? s;
/** Condizione SQL "opportunità chiusa" (stessa lista dell'indice parziale della migrazione). */
export const CLOSED_SQL = `('vinto', 'perso', 'non_contattare')`;

export const PRIORITIES = [
  { id: 'alta', label: 'Alta' },
  { id: 'media', label: 'Media' },
  { id: 'bassa', label: 'Bassa' },
] as const;
export type PriorityId = (typeof PRIORITIES)[number]['id'];
export const PRIORITY_IDS = PRIORITIES.map((p) => p.id) as [PriorityId, ...PriorityId[]];

export const ACTIVITY_TYPES = [
  { id: 'call', label: 'Telefonata', manual: true },
  { id: 'contact_attempt', label: 'Tentativo di contatto', manual: true },
  { id: 'conversation', label: 'Conversazione', manual: true },
  { id: 'meeting', label: 'Incontro', manual: true },
  { id: 'follow_up', label: 'Follow-up', manual: true },
  { id: 'proposal', label: 'Proposta o preventivo', manual: true },
  { id: 'note', label: 'Nota', manual: true },
  { id: 'stage_change', label: 'Cambio di fase', manual: false },
  // registrata dal sistema solo quando il server di posta accetta un'email commerciale (Fase 9)
  { id: 'email_sent', label: 'Email commerciale inviata', manual: false },
  // registrata dal sistema quando la lettura della casella trova una risposta a un'email commerciale
  { id: 'email_reply', label: 'Risposta ricevuta', manual: false },
] as const;
export type ActivityType = (typeof ACTIVITY_TYPES)[number]['id'];
/** Tipi che una persona può registrare e modificare (il cambio di fase è registrato dal sistema). */
export const MANUAL_ACTIVITY_TYPES = ACTIVITY_TYPES.filter((t) => t.manual).map((t) => t.id) as [
  ActivityType,
  ...ActivityType[],
];
export const activityLabel = (t: string) => ACTIVITY_TYPES.find((x) => x.id === t)?.label ?? t;

export const FOLLOWUP_STATUSES = ['pending', 'completed', 'cancelled'] as const;
export type FollowupStatus = (typeof FOLLOWUP_STATUSES)[number];

/** Fuso orario di riferimento per "oggi", "scaduto" e le scadenze (stesso dell'interfaccia). */
export const TIME_ZONE = 'Europe/Rome';

/** Data di oggi (AAAA-MM-GG) nel fuso orario italiano. */
export function todayInRome(now = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)!.value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}

/** Euro (con al massimo due decimali) ↔ centesimi interi: nessun arrotondamento in virgola mobile nel database. */
export const toCents = (euro: number) => Math.round(euro * 100);
export const toEuro = (cents: number | string | null) => (cents === null ? null : Number(cents) / 100);

export const ACTIVITY_TYPE_IDS = ACTIVITY_TYPES.map((t) => t.id) as [ActivityType, ...ActivityType[]];
