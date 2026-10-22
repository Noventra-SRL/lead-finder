/*
 * Stato visibile della valutazione commerciale di ogni azienda (modulo senza dipendenze: usato anche dalle query
 * dell'anagrafica). Vedi server/ai/queue.ts.
 */

export type AiState = 'pending' | 'running' | 'assessed' | 'incomplete' | 'failed' | 'outdated' | 'excluded';

export const AI_STATE_LABEL: Record<AiState, string> = {
  pending: 'Da valutare',
  running: 'In valutazione',
  assessed: 'Valutata',
  incomplete: 'Valutazione incompleta',
  failed: 'Errore di valutazione',
  outdated: 'Da aggiornare',
  excluded: 'Esclusa (non contattare)',
};

/**
 * Stato visibile in SQL (alias: b = businesses, ast = ai_business_states, aa = valutazione corrente).
 * Senza impronta ancora calcolata, una valutazione esistente vale come aggiornata finché il controllo non dice altro.
 */
export const AI_STATE_SQL = `CASE
  WHEN b.excluded_at IS NOT NULL THEN 'excluded'
  WHEN ast.lease_expires_at > now() THEN 'running'
  WHEN aa.id IS NOT NULL AND (ast.fingerprint IS NULL OR aa.cache_key = ast.fingerprint) THEN
    CASE WHEN aa.needs_review AND NOT EXISTS (
      SELECT 1 FROM ai_assessment_reviews r WHERE r.assessment_id = aa.id AND r.verdict = 'confirmed') THEN 'incomplete'
    ELSE 'assessed' END
  WHEN ast.queue_status = 'failed' THEN 'failed'
  WHEN aa.id IS NOT NULL THEN 'outdated'
  ELSE 'pending' END`;
