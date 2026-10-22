import type { CommercialScore, Level } from '../api/client.ts';

export const LEVEL_LABEL: Record<Level, string> = { high: 'alta', medium: 'media', low: 'bassa' };

const USD = new Intl.NumberFormat('it-IT', { style: 'currency', currency: 'USD', maximumFractionDigits: 4 });
export const formatUsd = (v: number | null) => (v === null ? 'non stimabile' : USD.format(v));

export const SEVERITY_LABEL = { low: 'lieve', medium: 'media', high: 'alta' } as const;

/** Etichetta della fonte del punteggio commerciale: mai un numero senza dire da dove viene. */
export const sourceLabel = (c: CommercialScore) =>
  c.source === 'ai' ? 'valutazione AI' : 'punteggio a regole (riserva)';

export const EXCLUSION_LABEL = {
  do_not_contact: 'Non contattare',
  inactive: 'Attività cessata',
} as const;
