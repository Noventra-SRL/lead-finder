import type { BusinessSummary, DiscoveryJob, JobStatus } from '../api/client.ts';

/* Etichette italiane e toni di stato per ricerche e aziende. */

export const JOB_STATUS: Record<JobStatus, { label: string; tone: 'ok' | 'warn' | 'danger' | 'idle' }> = {
  pending: { label: 'In coda', tone: 'idle' },
  running: { label: 'In corso', tone: 'warn' },
  paused: { label: 'In pausa', tone: 'idle' },
  completed: { label: 'Completata', tone: 'ok' },
  completed_with_warnings: { label: 'Completata con avvisi', tone: 'warn' },
  failed: { label: 'Non riuscita', tone: 'danger' },
  cancelled: { label: 'Annullata', tone: 'idle' },
};

export const isActive = (s: JobStatus) => s === 'pending' || s === 'running' || s === 'paused';

export function jobStatusText(job: DiscoveryJob): string {
  if (job.status === 'running' && job.cancelRequested) return 'Annullamento in corso…';
  if (job.status === 'running' && job.pauseRequested) return 'Messa in pausa in corso…';
  if (job.status === 'paused' && job.pauseReason === 'interrupted') return 'Interrotta: riprendibile';
  if (job.status === 'paused' && job.pauseReason === 'not_configured') return 'Sospesa: server non configurato';
  return JOB_STATUS[job.status].label;
}

/** Aziende salvate dalla ricerca (nuove, aggiornate, invariate o collegate a una esistente). */
export const savedCount = (job: DiscoveryJob) =>
  job.counts.inserted + job.counts.updated + job.counts.unchanged + job.counts.merged;

export function areaLabel(job: DiscoveryJob): string {
  return job.radiusKm ? `${job.area.name} + ${String(job.radiusKm).replace('.', ',')} km` : job.area.name;
}

export const COMPLETENESS_FIELDS: { key: keyof BusinessSummary['has']; label: string }[] = [
  { key: 'website', label: 'Sito web' },
  { key: 'address', label: 'Indirizzo' },
  { key: 'phone', label: 'Telefono' },
  { key: 'email', label: 'Email' },
  { key: 'openingHours', label: 'Orari' },
];

export function placeLabel(b: Pick<BusinessSummary, 'place'>): string {
  const { municipality, provinceSigla } = b.place;
  if (!municipality) return 'Comune non determinato';
  return provinceSigla ? `${municipality} (${provinceSigla})` : municipality;
}

export const COVERAGE_LABEL = {
  buona: 'Copertura buona',
  parziale: 'Copertura parziale',
  limitata: 'Copertura limitata',
} as const;
