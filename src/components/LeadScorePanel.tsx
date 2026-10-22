import { useState } from 'react';
import { Link } from 'react-router';
import { ApiError, post, type LeadScore, type Paged, type ScoreSignal } from '../api/client.ts';
import { SEVERITY } from '../lib/audit.ts';
import { formatDateTime } from '../lib/format.ts';
import { BAND, CAPABILITY_STATE, CONFIDENCE_LABEL, DIMENSION_LABEL, DIMENSIONS, SCORE_STATUS } from '../lib/scoring.ts';
import { useApi } from '../lib/useApi.ts';
import { Button, Empty, ErrorNotice, Loading, Notice, Section, Status } from './ui.tsx';

/*
 * Punteggio del lead nella scheda dell'azienda: valore, spiegazione, dimensioni, segnali (fatti misurati distinti
 * dalle opportunità dedotte), rilievi collegati all'audit, versione e storico. Mostra solo dati salvati.
 */

const TRIGGER: Record<string, string> = {
  manual: 'calcolo richiesto',
  audit: 'dopo un audit',
  discovery: 'dopo una ricerca',
  bulk: 'ricalcolo generale',
};

function SignalList({ title, items, empty }: { title: string; items: ScoreSignal[]; empty: string }) {
  return (
    <div className="signal-col">
      <h3 className="sub-title">{title}</h3>
      {items.length === 0 ? (
        <p className="small muted">{empty}</p>
      ) : (
        <ul className="signal-list">
          {items.map((s, i) => (
            <li key={i}>
              <span className={`signal-kind signal-kind--${s.kind}`}>{s.kind === 'fact' ? 'Fatto' : 'Deduzione'}</span>{' '}
              {s.text}
              {s.ref?.auditId && s.ref.codes && (
                <>
                  {' '}
                  <Link to={`/audit/esiti/${s.ref.auditId}`} className="small">
                    prova
                  </Link>
                </>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function Detail({ score }: { score: LeadScore }) {
  const b = score.breakdown!;
  return (
    <>
      <div className="table-wrap">
        <table className="table table--stack">
          <caption className="visually-hidden">Dimensioni del punteggio</caption>
          <thead>
            <tr>
              <th scope="col">Dimensione</th>
              <th scope="col">Valore</th>
              <th scope="col">Peso</th>
              <th scope="col">Contributo</th>
              <th scope="col">Su cosa si basa</th>
            </tr>
          </thead>
          <tbody>
            {DIMENSIONS.map((d) => {
              const v = b.dimensions[d];
              return (
                <tr key={d}>
                  <th scope="row" data-label="Dimensione">
                    {DIMENSION_LABEL[d]}
                  </th>
                  <td data-label="Valore" className="mono nowrap">
                    {v.score === null ? <span className="muted">sconosciuta</span> : `${v.score}/100`}
                  </td>
                  <td data-label="Peso" className="mono small nowrap">
                    {v.weight}
                    {v.score !== null && (
                      <span className="muted"> → {String(v.effectiveWeight).replace('.', ',')}%</span>
                    )}
                  </td>
                  <td data-label="Contributo" className="mono">
                    {v.score === null ? (
                      <span className="muted small">esclusa</span>
                    ) : (
                      String(v.contribution).replace('.', ',')
                    )}
                  </td>
                  <td data-label="Su cosa si basa" className="small">
                    {v.basis.join(' ')}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="small muted">
        Punteggio grezzo {b.rawScore === null ? '—' : String(b.rawScore).replace('.', ',')} = somma dei contributi delle
        dimensioni con prove; le dimensioni sconosciute sono escluse e i pesi delle altre riproporzionati.
      </p>

      <div className="signal-grid">
        <SignalList title="A favore della priorità" items={b.signals.positive} empty="Nessun segnale a favore." />
        <SignalList title="A sfavore della priorità" items={b.signals.negative} empty="Nessun segnale a sfavore." />
        <SignalList title="Non verificato o sconosciuto" items={b.signals.unknown} empty="Nessun dato mancante." />
      </div>

      {b.topFindings.length > 0 && (
        <div className="stack stack--tight">
          <h3 className="sub-title">Problemi che pesano di più</h3>
          <ol className="plain-list top-findings">
            {b.topFindings.map((f) => (
              <li key={f.group}>
                <Status tone={SEVERITY[f.severity].tone}>{SEVERITY[f.severity].label}</Status> {f.title}{' '}
                <span className="small muted">
                  · {String(f.points).replace('.', ',')} punti
                  {f.codes.length > 1 && ` · ${f.codes.length} rilievi dello stesso problema`} ·{' '}
                </span>
                <Link to={`/audit/esiti/${f.auditId}`} className="small">
                  apri l’audit
                </Link>
              </li>
            ))}
          </ol>
        </div>
      )}

      {b.capabilities.length > 0 && (
        <div className="stack stack--tight">
          <h3 className="sub-title">Capacità digitali pertinenti al settore</h3>
          <ul className="plain-list capability-list">
            {b.capabilities.map((c) => (
              <li key={c.capability}>
                <Status tone={CAPABILITY_STATE[c.state].tone}>{CAPABILITY_STATE[c.state].label}</Status> {c.label}
              </li>
            ))}
          </ul>
          <p className="small muted">
            «Non rilevato»: cercato nelle pagine esaminate e non trovato, potrebbe esistere altrove. «Assente»:
            proprietà misurata nel codice della pagina.
          </p>
        </div>
      )}

      {b.services.some((s) => s.supported) && (
        <div className="stack stack--tight">
          <h3 className="sub-title">Servizi di Noventra collegati alle prove</h3>
          <ul className="plain-list">
            {b.services
              .filter((s) => s.supported)
              .map((s) => (
                <li key={s.service}>
                  <strong>{s.label}</strong> <span className="small muted">— {s.evidence.join('; ')}</span>
                </li>
              ))}
          </ul>
          <p className="small muted">
            Opportunità dedotte dalle prove: da valutare caso per caso, non bisogni confermati.
          </p>
        </div>
      )}

      <dl className="props props--compact">
        <div className="props__pair">
          <dt>Affidabilità</dt>
          <dd>
            {CONFIDENCE_LABEL[b.confidence.level]} <span className="mono">({b.confidence.value}/100)</span>
          </dd>
        </div>
        <div className="props__pair">
          <dt>Completezza dei dati</dt>
          <dd className="mono">{b.completeness.value}/100</dd>
        </div>
        <div className="props__pair">
          <dt>Calcolo</dt>
          <dd>
            {formatDateTime(score.calculatedAt)} · {TRIGGER[score.trigger] ?? score.trigger}
            {score.requestedBy && ` da ${score.requestedBy}`} · algoritmo v{score.algorithmVersion}, configurazione v
            {score.configVersion}
          </dd>
        </div>
        {score.auditId && (
          <div className="props__pair">
            <dt>Audit usato</dt>
            <dd>
              <Link to={`/audit/esiti/${score.auditId}`}>
                {b.evidence.auditFinishedAt ? formatDateTime(b.evidence.auditFinishedAt) : 'Apri l’audit'}
              </Link>
            </dd>
          </div>
        )}
      </dl>
    </>
  );
}

export function LeadScorePanel({ businessId, merged }: { businessId: string; merged: boolean }) {
  const current = useApi<{ score: LeadScore | null }>(`/businesses/${businessId}/score`);
  const history = useApi<Paged<LeadScore>>(`/businesses/${businessId}/scores?pageSize=10`);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const calculate = async (force: boolean) => {
    setBusy(true);
    setError(null);
    try {
      await post(`/businesses/${businessId}/score`, { force });
      current.reload();
      history.reload();
    } catch (e) {
      setError(e instanceof ApiError ? e : new ApiError(0, 'UNKNOWN', 'Calcolo non riuscito.'));
    } finally {
      setBusy(false);
    }
  };
  const score = current.data?.score;
  const missing = current.data !== null && current.data.score === null;

  return (
    <Section
      title="Punteggio del lead"
      description="Punteggio a regole, deterministico: quanto l’azienda sembra adatta ai servizi di Noventra secondo le prove raccolte. Fa da riserva dichiarata quando manca la valutazione AI. Criterio di priorità, non una probabilità di acquisto."
    >
      <div className="stack">
        {current.loading && !current.data && <Loading label="Caricamento del punteggio…" />}
        {current.error && <ErrorNotice error={current.error} onRetry={current.reload} />}
        {error && <Notice tone="error">{error.message}</Notice>}
        {merged && (
          <p className="small muted">Scheda unita a un’altra: il punteggio si calcola sulla scheda mantenuta.</p>
        )}
        {missing && !merged && (
          <Empty title="Punteggio non ancora calcolato">
            <p>Il calcolo usa i dati della fonte e, se c’è, l’ultimo audit del sito.</p>
            <div className="after">
              <Button busy={busy} onClick={() => void calculate(false)}>
                Calcola il punteggio
              </Button>
            </div>
          </Empty>
        )}
        {score && (
          <>
            <div className="score-head">
              <p
                className="score-head__value mono"
                aria-label={score.score === null ? 'Nessun punteggio' : `Punteggio ${score.score} su 100`}
              >
                {score.score ?? '—'}
              </p>
              <div className="stack stack--tight">
                <p>
                  {score.band && score.score !== null ? (
                    <Status
                      tone={
                        score.status === 'ranked' && score.band === 'A'
                          ? 'ok'
                          : score.status === 'needs_review'
                            ? 'warn'
                            : 'idle'
                      }
                    >
                      {BAND[score.band].label}
                      {score.status === 'needs_review' && ' · da verificare'}
                    </Status>
                  ) : (
                    <Status tone={SCORE_STATUS[score.status].tone}>{SCORE_STATUS[score.status].label}</Status>
                  )}{' '}
                  <span className="small muted">
                    affidabilità {CONFIDENCE_LABEL[score.confidence.level]} · completezza {score.completeness}/100
                  </span>
                </p>
                <p className="score-head__text">{score.explanation}</p>
                <p>
                  <strong>Prossimo passo.</strong> {score.nextStep}
                </p>
              </div>
            </div>
            {score.outdated && score.outdated.length > 0 && (
              <Notice tone="warn" title="Punteggio da aggiornare">
                <p>{score.outdated.join(' ')}</p>
              </Notice>
            )}
            <div className="row">
              <Button variant="secondary" busy={busy} onClick={() => void calculate(true)} disabled={merged}>
                Ricalcola il punteggio
              </Button>
            </div>
            <Detail score={score} />
          </>
        )}
        {history.data && history.data.total > 1 && (
          <div className="stack stack--tight">
            <h3 className="sub-title">Storico dei punteggi</h3>
            <ol className="log" aria-label="Storico dei punteggi">
              {history.data.items.map((h) => (
                <li key={h.id} className="log__item">
                  <time className="mono small muted" dateTime={h.calculatedAt}>
                    {formatDateTime(h.calculatedAt)}
                  </time>
                  <span>
                    {h.score !== null && h.band ? `${h.score} · ${BAND[h.band].label}` : SCORE_STATUS[h.status].label}
                    <span className="small muted">
                      {' '}
                      · affidabilità {CONFIDENCE_LABEL[h.confidence.level]} · configurazione v{h.configVersion} ·{' '}
                      {TRIGGER[h.trigger] ?? h.trigger}
                      {h.isCurrent && ' · attuale'}
                    </span>
                  </span>
                </li>
              ))}
            </ol>
          </div>
        )}
      </div>
    </Section>
  );
}
