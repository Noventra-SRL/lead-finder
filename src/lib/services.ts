import type { MatchDimension, MatchStatus, ReviewAction, ReviewStatus } from '../api/client.ts';

/* Etichette italiane dell'abbinamento ai servizi. Una corrispondenza è una possibile pertinenza da verificare. */

type Tone = 'ok' | 'warn' | 'danger' | 'idle';

export const MATCH_STATUS: Record<MatchStatus, { label: string; tone: Tone }> = {
  recommended: { label: 'Consigliato', tone: 'ok' },
  possible: { label: 'Possibile', tone: 'idle' },
  needs_review: { label: 'Da verificare', tone: 'warn' },
  insufficient_evidence: { label: 'Prove insufficienti', tone: 'idle' },
  not_relevant: { label: 'Non pertinente', tone: 'idle' },
};

export const REVIEW_STATUS: Record<NonNullable<ReviewStatus>, { label: string; tone: Tone }> = {
  accepted_for_review: { label: 'Accettato per la valutazione commerciale', tone: 'ok' },
  dismissed: { label: 'Archiviato', tone: 'idle' },
  needs_review: { label: 'Da verificare a mano', tone: 'warn' },
};

export const REVIEW_ACTION: Record<ReviewAction, string> = {
  accepted_for_review: 'Accettato per la valutazione commerciale',
  dismissed: 'Archiviato',
  needs_review: 'Segnato da verificare a mano',
  reopened: 'Riaperto',
  note: 'Nota',
};

export const MATCH_DIMENSION_LABEL: Record<MatchDimension, string> = {
  findings: 'Rilievi dell’audit pertinenti',
  capabilities: 'Capacità mancanti',
  category: 'Pertinenza del settore',
  evidence: 'Affidabilità delle prove',
  context: 'Contesto verificato',
};
export const MATCH_DIMENSIONS: MatchDimension[] = ['findings', 'capabilities', 'category', 'evidence', 'context'];

export const MATCH_STATUS_FILTERS = [
  { value: '', label: 'Qualsiasi' },
  { value: 'recommended', label: 'Consigliato' },
  { value: 'recommended,possible', label: 'Consigliato o possibile' },
  { value: 'needs_review', label: 'Da verificare' },
  { value: 'insufficient_evidence', label: 'Prove insufficienti' },
  { value: 'accepted_for_review', label: 'Accettato per la valutazione' },
  { value: 'dismissed', label: 'Archiviato' },
];
