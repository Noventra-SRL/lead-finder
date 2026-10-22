import { useState } from 'react';
import { Link } from 'react-router';
import { ApiError, post, type AiCoverage, type AiState } from '../api/client.ts';
import { useUser } from '../auth/AuthContext.tsx';
import { formatDateTime } from '../lib/format.ts';
import { useApi } from '../lib/useApi.ts';
import { Button, ErrorNotice, Loading, Notice, Progress, Section } from './ui.tsx';

/*
 * Valutazione commerciale di ogni azienda: numeri dal database (GET /api/ai/coverage), stato della coda automatica e
 * comandi. «Tutte valutate» compare solo quando il database lo conferma (nessuna da valutare, da aggiornare, in corso,
 * in errore o ancora da controllare).
 */

const n = (v: number) => v.toLocaleString('it-IT');
const pct = (part: number, total: number) => (total ? `${Math.round((part / total) * 100)}%` : '—');

const ROWS: { state: AiState; label: string; hint: string; filter: string }[] = [
  {
    state: 'assessed',
    label: 'Valutate',
    hint: 'valutazione aggiornata con i dati di oggi',
    filter: 'aiStatus=state_assessed',
  },
  {
    state: 'incomplete',
    label: 'Valutazione incompleta',
    hint: 'prove deboli o ostacoli: punteggio con affidabilità bassa, da verificare',
    filter: 'aiStatus=state_incomplete',
  },
  { state: 'pending', label: 'Da valutare', hint: 'mai valutate', filter: 'aiStatus=state_pending' },
  {
    state: 'outdated',
    label: 'Da aggiornare',
    hint: 'i dati sono cambiati dopo la valutazione: il punteggio mostrato è quello vecchio',
    filter: 'aiStatus=state_outdated',
  },
  { state: 'running', label: 'In valutazione', hint: 'adesso', filter: 'aiStatus=state_running' },
  {
    state: 'failed',
    label: 'Errore di valutazione',
    hint: 'nuovo tentativo automatico o a mano',
    filter: 'aiStatus=state_failed',
  },
  {
    state: 'excluded',
    label: 'Escluse (non contattare)',
    hint: 'non inviate al modello',
    filter: 'excluded=only',
  },
];

export function CoveragePanel() {
  const user = useUser();
  const [active, setActive] = useState(false);
  const cov = useApi<AiCoverage>('/ai/coverage', active ? 5000 : 30_000);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);
  const c = cov.data;
  const working = Boolean(
    c && (c.counts.running > 0 || (c.auto.enabled && c.auto.providerConfigured && c.remaining > 0)),
  );
  if (working !== active) setActive(working);

  const run = async (key: string, path: string, body: unknown, done: (r: { affected?: number }) => string) => {
    setBusy(key);
    setMessage(null);
    try {
      const r = await post<{ affected?: number }>(path, body);
      setMessage({ tone: 'ok', text: done(r) });
      cov.reload();
    } catch (e) {
      setMessage({ tone: 'error', text: e instanceof ApiError ? e.message : 'Operazione non riuscita.' });
    } finally {
      setBusy(null);
    }
  };

  const complete = c && c.remaining === 0 && c.unchecked === 0 && c.counts.running === 0;
  return (
    <Section
      title="Valutazione di tutte le aziende"
      description="Ogni azienda censita riceve una valutazione commerciale automatica, senza aprirla una per una. Il punteggio è una priorità commerciale, non una probabilità di vendita."
    >
      {cov.loading && !c && <Loading />}
      {cov.error && <ErrorNotice error={cov.error} onRetry={cov.reload} />}
      {c && (
        <div className="stack ai-coverage">
          <div className="ai-coverage__head">
            <p className="ai-coverage__figure">
              <span className="mono">{n(c.covered)}</span> di <span className="mono">{n(c.eligible)}</span> aziende
              valutabili hanno una valutazione aggiornata <span className="muted">({pct(c.covered, c.eligible)})</span>
            </p>
            <Progress value={c.covered} max={c.eligible} label="Aziende con una valutazione aggiornata" />
            <p className="small muted">
              {n(c.total)} aziende uniche nel database
              {c.unchecked > 0 && ` · controllo dei dati in corso per ${n(c.unchecked)}`}
              {complete && ' · tutte le aziende valutabili hanno una valutazione aggiornata'}
            </p>
          </div>

          <dl className="ai-coverage__counts">
            {ROWS.map((r) => (
              <div
                key={r.state}
                className={`ai-coverage__row ai-coverage__row--${r.state}${r.state === 'failed' && c.counts.failed > 0 ? ' ai-coverage__row--alert' : ''}`}
              >
                <dt>
                  <Link to={`/aziende?${r.filter}`}>{r.label}</Link>
                  <span className="small muted"> · {r.hint}</span>
                </dt>
                <dd className="mono">{n(c.counts[r.state])}</dd>
              </div>
            ))}
          </dl>

          {!c.auto.providerConfigured && (
            <Notice tone="warn" title="Valutazione AI non configurata">
              <p>
                Il server non ha una chiave del fornitore AI (AI_API_KEY): nessuna valutazione può partire. Lo stato
                delle aziende viene comunque aggiornato e, dove esiste, resta il punteggio a regole come riserva
                dichiarata.
              </p>
            </Notice>
          )}
          {c.auto.providerConfigured && !c.autoActive && (
            <Notice tone="info">
              <p>Valutazione automatica disattivata sul server (AI_AUTO_ASSESS=off): restano i lotti manuali.</p>
            </Notice>
          )}
          {c.auto.providerConfigured && c.autoActive && (
            <p className="small">
              {!c.auto.enabled
                ? 'Valutazione automatica in pausa.'
                : c.auto.pausedReason
                  ? `Valutazione automatica sospesa fino alle ${formatDateTime(c.auto.backoffUntil)}: ${c.auto.pausedReason}`
                  : c.auto.usedLast24h >= c.auto.dailyLimit
                    ? `Limite giornaliero raggiunto (${n(c.auto.dailyLimit)} valutazioni automatiche nelle ultime 24 ore): riprende da solo.`
                    : c.remaining > 0
                      ? 'Valutazione automatica attiva: le aziende in coda vengono valutate poche alla volta.'
                      : 'Valutazione automatica attiva: nessuna azienda in coda.'}{' '}
              <span className="muted">
                Ultime 24 ore: {n(c.usageLast24h.assessments)} valutazioni
                {c.usageLast24h.costUsd !== null && `, ${c.usageLast24h.costUsd.toFixed(2)} USD`} · limite automatico{' '}
                {n(c.auto.dailyLimit)}/giorno
                {c.estimatedRemainingCostUsd !== null &&
                  c.remaining > 0 &&
                  ` · per completare: circa ${c.estimatedRemainingCostUsd.toFixed(2)} USD (${c.costBasis})`}
              </span>
            </p>
          )}

          <div className="row">
            {user.role === 'admin' && c.autoActive && (
              <Button
                variant={c.auto.enabled ? 'secondary' : 'primary'}
                busy={busy === 'auto'}
                disabled={!c.auto.providerConfigured}
                onClick={() =>
                  void run('auto', '/ai/auto', { enabled: !c.auto.enabled }, () =>
                    c.auto.enabled ? 'Valutazione automatica in pausa.' : 'Valutazione automatica avviata.',
                  )
                }
              >
                {c.auto.enabled ? 'Metti in pausa' : 'Avvia o riprendi la valutazione'}
              </Button>
            )}
            <Button
              variant="secondary"
              busy={busy === 'retry'}
              disabled={c.counts.failed === 0}
              onClick={() =>
                void run(
                  'retry',
                  '/ai/coverage/retry-failed',
                  {},
                  (r) => `${n(r.affected ?? 0)} aziende di nuovo in coda.`,
                )
              }
            >
              Riprova le valutazioni non riuscite
            </Button>
            <Button
              variant="ghost"
              busy={busy === 'recheck'}
              onClick={() =>
                void run(
                  'recheck',
                  '/ai/coverage/recheck',
                  {},
                  () => 'Ricontrollo dei dati avviato: le aziende con dati cambiati tornano «Da aggiornare» e in coda.',
                )
              }
            >
              Rivaluta le aziende con dati cambiati
            </Button>
            <Link to="/aziende?aiStatus=state_pending" className="btn btn--ghost">
              Vedi le aziende da valutare
            </Link>
          </div>
          <p className="small muted">
            Per rivalutare aziende precise: selezionale nell’elenco <Link to="/aziende">Aziende</Link> e scegli «Valuta
            con AI». Aprire una scheda non avvia nessuna valutazione.
          </p>
          {message && (
            <p role="status" className={`small export__result export__result--${message.tone}`}>
              {message.text}
            </p>
          )}
        </div>
      )}
    </Section>
  );
}

/** Riepilogo per «Trova aziende»: quante aziende trovate sono già valutate, con il collegamento al pannello. */
export function CoverageSummary() {
  const cov = useApi<AiCoverage>('/ai/coverage');
  const c = cov.data;
  if (!c) return null;
  return (
    <p className="ai-coverage-summary small">
      Valutazione commerciale: <span className="mono">{n(c.covered)}</span> di{' '}
      <span className="mono">{n(c.eligible)}</span> aziende valutate ({pct(c.covered, c.eligible)})
      {c.remaining > 0 && (
        <>
          , <span className="mono">{n(c.remaining)}</span> in attesa
        </>
      )}
      {!c.auto.providerConfigured && ' · AI non configurata'} · <Link to="/analisi-ai">Dettagli e comandi</Link>
    </p>
  );
}
