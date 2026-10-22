import type {
  CapabilityState,
  ConfidenceLevel,
  LeadSummary,
  ScoreBand,
  ScoreStatus,
  ScoringDimension,
} from '../api/client.ts';

/* Etichette italiane del punteggio dei lead. Il punteggio è un criterio di priorità, non una probabilità di acquisto. */

type Tone = 'ok' | 'warn' | 'danger' | 'idle';

export const BAND: Record<ScoreBand, { label: string; short: string }> = {
  A: { label: 'Priorità A', short: 'A' },
  B: { label: 'Priorità B', short: 'B' },
  C: { label: 'Priorità C', short: 'C' },
  low: { label: 'Priorità bassa', short: 'Bassa' },
};

export const SCORE_STATUS: Record<ScoreStatus, { label: string; tone: Tone }> = {
  ranked: { label: 'Classificato', tone: 'ok' },
  needs_review: { label: 'Da verificare', tone: 'warn' },
  insufficient_data: { label: 'Dati insufficienti', tone: 'idle' },
  not_suitable: { label: 'Non adatto', tone: 'idle' },
};

export const CONFIDENCE_LABEL: Record<ConfidenceLevel, string> = { high: 'alta', medium: 'media', low: 'bassa' };

export const DIMENSION_LABEL: Record<ScoringDimension, string> = {
  technical: 'Problemi tecnici del sito',
  capabilities: 'Capacità digitali mancanti',
  industry: 'Opportunità di settore',
  evidence: 'Qualità delle prove',
  commercial: 'Indicatori commerciali',
};
export const DIMENSIONS: ScoringDimension[] = ['technical', 'capabilities', 'industry', 'evidence', 'commercial'];

export const CAPABILITY_STATE: Record<CapabilityState, { label: string; tone: Tone }> = {
  present: { label: 'Presente', tone: 'ok' },
  missing: { label: 'Assente (misurato)', tone: 'danger' },
  not_detected: { label: 'Non rilevato', tone: 'warn' },
  unknown: { label: 'Non valutabile', tone: 'idle' },
};

/** Valore principale mostrato: il numero solo quando c'è un punteggio presentabile. */
export function leadHeadline(lead: LeadSummary | null): { value: string; label: string; tone: Tone } {
  if (!lead) return { value: '—', label: 'Non calcolato', tone: 'idle' };
  if (lead.score === null || !lead.band) return { value: '—', label: SCORE_STATUS[lead.status].label, tone: 'idle' };
  if (lead.status === 'needs_review')
    return { value: String(lead.score), label: `${BAND[lead.band].label} · da verificare`, tone: 'warn' };
  return { value: String(lead.score), label: BAND[lead.band].label, tone: lead.band === 'A' ? 'ok' : 'idle' };
}

export const PRIORITY_FILTERS = [
  { value: '', label: 'Qualsiasi' },
  { value: 'A', label: 'Priorità A' },
  { value: 'B', label: 'Priorità B' },
  { value: 'C', label: 'Priorità C' },
  { value: 'A,B,C', label: 'Priorità A, B o C' },
  { value: 'low', label: 'Priorità bassa' },
  { value: 'needs_review,insufficient_data', label: 'Da verificare o dati insufficienti' },
  { value: 'needs_review', label: 'Da verificare' },
  { value: 'insufficient_data', label: 'Dati insufficienti' },
  { value: 'unscored', label: 'Punteggio non calcolato' },
];
