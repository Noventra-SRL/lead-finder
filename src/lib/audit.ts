import type { AuditJob, FindingCategory, Severity, WebsiteStatus } from '../api/client.ts';
import { JOB_STATUS } from './discovery.ts';

/* Etichette italiane e toni per l'audit dei siti. */

type Tone = 'ok' | 'warn' | 'danger' | 'idle';

/** Stato del sito: "non verificato", "irraggiungibile", "parziale" e "riuscito" restano sempre distinguibili. */
export const WEBSITE_STATUS: Record<WebsiteStatus, { label: string; tone: Tone }> = {
  not_checked: { label: 'Non verificato', tone: 'idle' },
  not_found: { label: 'Nessun sito proprio', tone: 'idle' },
  valid: { label: 'Raggiungibile', tone: 'ok' },
  redirected: { label: 'Raggiungibile (reindirizzato)', tone: 'ok' },
  unreachable: { label: 'Irraggiungibile', tone: 'danger' },
  timeout: { label: 'Non risponde in tempo', tone: 'danger' },
  blocked: { label: 'Accesso negato al controllo', tone: 'warn' },
  invalid_url: { label: 'Indirizzo non valido', tone: 'danger' },
  audit_failed: { label: 'Verifica non riuscita', tone: 'warn' },
};

export const RUN_STATUS: Record<'completed' | 'partial' | 'failed', { label: string; tone: Tone }> = {
  completed: { label: 'Audit completo', tone: 'ok' },
  partial: { label: 'Audit parziale', tone: 'warn' },
  failed: { label: 'Audit non riuscito', tone: 'danger' },
};

export const SEVERITY: Record<Severity, { label: string; tone: Tone }> = {
  high: { label: 'Alta', tone: 'danger' },
  medium: { label: 'Media', tone: 'warn' },
  low: { label: 'Bassa', tone: 'idle' },
  info: { label: 'Informativa', tone: 'idle' },
};
export const SEVERITIES: Severity[] = ['high', 'medium', 'low', 'info'];

export const CATEGORY: Record<FindingCategory, string> = {
  availability: 'Disponibilità',
  security: 'Sicurezza (indicatori)',
  seo: 'SEO tecnica',
  mobile: 'Mobile (indicatori statici)',
  performance: 'Prestazioni',
  content: 'Contenuti e contatti',
  industry: 'Opportunità di settore',
};
export const CATEGORIES = Object.keys(CATEGORY) as FindingCategory[];

export const CONFIDENCE: Record<string, string> = { high: 'alta', medium: 'media', low: 'bassa' };

export const ITEM_STATUS: Record<string, { label: string; tone: Tone }> = {
  pending: { label: 'In coda', tone: 'idle' },
  running: { label: 'In corso', tone: 'warn' },
  done: { label: 'Verificata', tone: 'ok' },
  skipped: { label: 'Audit recente riusato', tone: 'idle' },
  failed: { label: 'Non riuscita', tone: 'danger' },
  cancelled: { label: 'Annullata', tone: 'idle' },
};

export const SIGNAL_LABEL: Record<string, string> = {
  contactPage: 'Pagina contatti',
  phoneLink: 'Telefono cliccabile',
  emailLink: 'Email cliccabile',
  contactForm: 'Modulo di contatto',
  address: 'Indirizzo',
  openingHours: 'Orari',
  privacy: 'Informativa privacy',
  cookie: 'Informativa cookie',
  callToAction: 'Invito all’azione',
  servicesSection: 'Sezione servizi',
  booking: 'Prenotazione online',
  appointment: 'Appuntamenti online',
  ordering: 'Ordini online',
  menu: 'Menu',
  ecommerce: 'Negozio online',
  rooms: 'Camere',
  schedule: 'Calendario corsi',
  catalog: 'Catalogo',
  otaLinks: 'Link a portali di prenotazione',
  social: 'Profili social',
  hiring: 'Lavora con noi',
};

export function auditJobStatusText(job: AuditJob): string {
  if (job.status === 'running' && job.cancelRequested) return 'Annullamento in corso…';
  if (job.status === 'running' && job.pauseRequested) return 'Messa in pausa in corso…';
  if (job.status === 'paused' && job.pauseReason === 'interrupted') return 'Interrotta: riprendibile';
  return JOB_STATUS[job.status].label;
}

export function auditJobTitle(job: AuditJob): string {
  const n = job.progress.total;
  return `Verifica di ${n} ${n === 1 ? 'azienda' : 'aziende'}`;
}

export const ms = (v: number | null | undefined) =>
  v === null || v === undefined
    ? '—'
    : v >= 1000
      ? `${(v / 1000).toFixed(1).replace('.', ',')} s`
      : `${Math.round(v)} ms`;

export const kb = (bytes: number) => `${Math.round(bytes / 1024).toLocaleString('it-IT')} kB`;

/** Esito di un'azienda in un job, in parole. */
export function outcomeLabel(outcome: string | null): string {
  if (!outcome) return '—';
  if (outcome === 'recent') return 'Riusato un audit recente dello stesso sito';
  if (outcome === 'audit_failed') return 'Errore interno';
  return WEBSITE_STATUS[outcome as WebsiteStatus]?.label ?? outcome;
}
