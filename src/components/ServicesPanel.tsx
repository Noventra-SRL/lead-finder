import { useId, useState } from 'react';
import { Link } from 'react-router';
import {
  ApiError,
  post,
  type BusinessServices,
  type LeadSummary,
  type ReviewAction,
  type ServiceMatch,
  type ServiceReview,
} from '../api/client.ts';
import { SEVERITY } from '../lib/audit.ts';
import { formatDateTime } from '../lib/format.ts';
import { BAND, CONFIDENCE_LABEL, SCORE_STATUS } from '../lib/scoring.ts';
import {
  MATCH_DIMENSION_LABEL,
  MATCH_DIMENSIONS,
  MATCH_STATUS,
  REVIEW_ACTION,
  REVIEW_STATUS,
} from '../lib/services.ts';
import { useApi } from '../lib/useApi.ts';
import { Button, Empty, ErrorNotice, Loading, Notice, Section, Status } from './ui.tsx';

/*
 * Servizi Noventra consigliati per l'azienda: lista breve con prove, problema, spiegazione e verifica da fare;
 * revisione da parte di una persona (accetta, archivia con motivo, da verificare, nota, riapri). Nessun invio di
 * messaggi: sono suggerimenti per chi vende, da verificare.
 */

function Review({
  businessId,
  serviceId,
  review,
  onDone,
}: {
  businessId: string;
  serviceId: string;
  review: ServiceReview;
  onDone: () => void;
}) {
  const [mode, setMode] = useState<'dismiss' | 'note' | null>(null);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState<ReviewAction | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const textId = useId();
  const act = async (action: ReviewAction, note?: string) => {
    setBusy(action);
    setError(null);
    try {
      await post(`/businesses/${businessId}/services/${serviceId}/review`, { action, note: note?.trim() || undefined });
      setMode(null);
      setText('');
      onDone();
    } catch (e) {
      setError(e instanceof ApiError ? e : new ApiError(0, 'UNKNOWN', 'Operazione non riuscita.'));
    } finally {
      setBusy(null);
    }
  };
  return (
    <div className="stack stack--tight">
      <div className="row">
        {review.status === 'dismissed' ? (
          <Button variant="secondary" busy={busy === 'reopened'} onClick={() => void act('reopened')}>
            Riapri
          </Button>
        ) : (
          <>
            {review.status !== 'accepted_for_review' && (
              <Button
                variant="secondary"
                busy={busy === 'accepted_for_review'}
                onClick={() => void act('accepted_for_review')}
              >
                Accetta per la valutazione
              </Button>
            )}
            {review.status !== 'needs_review' && (
              <Button variant="ghost" busy={busy === 'needs_review'} onClick={() => void act('needs_review')}>
                Da verificare a mano
              </Button>
            )}
            <Button variant="ghost" onClick={() => setMode(mode === 'dismiss' ? null : 'dismiss')}>
              Archivia…
            </Button>
          </>
        )}
        <Button variant="ghost" onClick={() => setMode(mode === 'note' ? null : 'note')}>
          Nota…
        </Button>
      </div>
      {mode && (
        <div className="stack stack--tight review-form">
          <label className="field__label" htmlFor={textId}>
            {mode === 'dismiss' ? 'Motivo dell’archiviazione (facoltativo)' : 'Nota'}
          </label>
          <textarea
            id={textId}
            className="input"
            rows={2}
            maxLength={1000}
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
          <div className="row">
            <Button
              busy={busy === (mode === 'dismiss' ? 'dismissed' : 'note')}
              disabled={mode === 'note' && !text.trim()}
              onClick={() => void act(mode === 'dismiss' ? 'dismissed' : 'note', text)}
            >
              {mode === 'dismiss' ? 'Archivia' : 'Salva la nota'}
            </Button>
            <Button variant="ghost" onClick={() => setMode(null)}>
              Annulla
            </Button>
          </div>
        </div>
      )}
      {error && <Notice tone="error">{error.message}</Notice>}
      {review.history.length > 0 && (
        <details>
          <summary className="small">Revisioni ({review.history.length})</summary>
          <ol className="log after">
            {review.history.map((h, i) => (
              <li key={i} className="log__item">
                <time className="mono small muted" dateTime={h.at}>
                  {formatDateTime(h.at)}
                </time>
                <span className="small">
                  {REVIEW_ACTION[h.action]}
                  {h.user && ` · ${h.user}`}
                  {h.note && <span className="muted"> — {h.note}</span>}
                </span>
              </li>
            ))}
          </ol>
        </details>
      )}
    </div>
  );
}

function StatusLine({ m }: { m: ServiceMatch }) {
  const review = m.review.status ? REVIEW_STATUS[m.review.status] : null;
  return (
    <span className="row match-status">
      <Status tone={MATCH_STATUS[m.status].tone}>{MATCH_STATUS[m.status].label}</Status>
      {review && <Status tone={review.tone}>{review.label}</Status>}
    </span>
  );
}

function Recommendation({
  m,
  rank,
  businessId,
  onDone,
}: {
  m: ServiceMatch;
  rank: number;
  businessId: string;
  onDone: () => void;
}) {
  return (
    <li className="match">
      <div className="match__head">
        <span className="match__rank mono" aria-hidden="true">
          {rank}
        </span>
        <h3 className="match__title">{m.service.name}</h3>
        <span className="match__score">
          <span className="mono">{m.score}</span>
          <span className="small muted">/100 corrispondenza · affidabilità {CONFIDENCE_LABEL[m.confidence.level]}</span>
        </span>
      </div>
      <StatusLine m={m} />
      {m.review.changedSince && (
        <p className="small text-warn">Le prove sono cambiate dopo l’ultima decisione: rivalutare.</p>
      )}
      {m.problem && (
        <p>
          <strong>Problema osservato.</strong> {m.problem}
        </p>
      )}
      <p className="match__text">{m.explanation}</p>
      {(m.evidence.findings.length > 0 ||
        m.evidence.capabilities.some((c) => c.state === 'missing' || c.state === 'not_detected')) && (
        <ul className="plain-list match__evidence small">
          {m.evidence.findings.slice(0, 5).map((f) => (
            <li key={f.code}>
              <Status tone={SEVERITY[f.severity].tone}>{SEVERITY[f.severity].label}</Status> {f.title}{' '}
              {m.evidence.auditId && <Link to={`/audit/esiti/${m.evidence.auditId}`}>prova</Link>}
            </li>
          ))}
          {m.evidence.capabilities
            .filter((c) => c.capability !== 'website' && (c.state === 'missing' || c.state === 'not_detected'))
            .map((c) => (
              <li key={c.capability}>
                <span className={`signal-kind${c.state === 'not_detected' ? ' signal-kind--inference' : ''}`}>
                  {c.state === 'missing' ? 'Fatto' : 'Deduzione'}
                </span>{' '}
                {c.label}: {c.state === 'missing' ? 'assente (misurato)' : 'non rilevato nelle pagine esaminate'}
              </li>
            ))}
        </ul>
      )}
      <p className="match__verify">
        <strong>Da verificare prima di proporlo.</strong> {m.nextStep}
        {m.service.nextSteps.slice(1).map((s) => ` ${s}`)}
      </p>
      {m.reasons.length > 0 && <p className="small muted">{m.reasons.join(' ')}</p>}
      {m.signals.unknown.length > 0 && (
        <p className="small muted">Non verificato: {m.signals.unknown.map((s) => s.text).join(' ')}</p>
      )}
      <details>
        <summary className="small">Come è calcolata</summary>
        <dl className="props props--compact after">
          {MATCH_DIMENSIONS.map((d) => (
            <div key={d} className="props__pair">
              <dt>{MATCH_DIMENSION_LABEL[d]}</dt>
              <dd className="mono small">
                {m.dimensions[d].score === null
                  ? 'sconosciuta, esclusa'
                  : `${m.dimensions[d].score}/100 × ${String(m.dimensions[d].effectiveWeight).replace('.', ',')}% = ${String(m.dimensions[d].contribution).replace('.', ',')}`}
              </dd>
            </div>
          ))}
        </dl>
        {m.service.source && (
          <p className="small after">
            Servizio descritto su{' '}
            <a href={m.service.source} target="_blank" rel="noopener noreferrer">
              noventra.it
            </a>
            .
          </p>
        )}
      </details>
      <Review businessId={businessId} serviceId={m.serviceId} review={m.review} onDone={onDone} />
    </li>
  );
}

export function ServicesPanel({
  businessId,
  lead,
  merged,
}: {
  businessId: string;
  lead: LeadSummary | null;
  merged: boolean;
}) {
  const { data, error, loading, reload } = useApi<BusinessServices>(`/businesses/${businessId}/services`);
  const [busy, setBusy] = useState(false);
  const [calcError, setCalcError] = useState<ApiError | null>(null);
  const recalc = async (force: boolean) => {
    setBusy(true);
    setCalcError(null);
    try {
      await post(`/businesses/${businessId}/services/recalculate`, { force });
      reload();
    } catch (e) {
      setCalcError(e instanceof ApiError ? e : new ApiError(0, 'UNKNOWN', 'Calcolo non riuscito.'));
    } finally {
      setBusy(false);
    }
  };
  const byId = new Map(data?.matches.map((m) => [m.serviceId, m]) ?? []);
  const listed = (data?.shortlist ?? []).map((id) => byId.get(id)!).filter(Boolean);
  const others = (data?.matches ?? []).filter((m) => !data!.shortlist.includes(m.serviceId));
  const site = byId.get('sviluppo_siti_web');
  const insufficient =
    data?.matches.length &&
    data.matches.every((m) => m.status === 'insufficient_evidence' || m.status === 'not_relevant') &&
    data.matches.some((m) => m.status === 'insufficient_evidence');

  return (
    <Section
      title="Servizi Noventra consigliati"
      description="Suggerimenti basati sulle prove raccolte, da verificare prima di qualsiasi proposta: indicano una possibile pertinenza, non una domanda confermata."
    >
      <div className="stack">
        <p className="small">
          Punteggio del lead:{' '}
          {lead?.score !== null && lead?.score !== undefined && lead.band ? (
            <strong>
              {lead.score} · {BAND[lead.band].label}
            </strong>
          ) : (
            <strong>{lead ? SCORE_STATUS[lead.status].label : 'non calcolato'}</strong>
          )}
          {lead && <> · affidabilità delle prove {CONFIDENCE_LABEL[lead.confidence.level]}</>}
          <span className="muted"> — priorità dell’azienda, distinta dalla corrispondenza di ogni servizio.</span>
        </p>
        {loading && !data && <Loading label="Caricamento dei servizi…" />}
        {error && <ErrorNotice error={error} onRetry={reload} />}
        {calcError && <Notice tone="error">{calcError.message}</Notice>}
        {data && !data.run && !merged && (
          <Empty title="Abbinamento non ancora calcolato">
            <div className="after">
              <Button busy={busy} onClick={() => void recalc(false)}>
                Calcola i servizi consigliati
              </Button>
            </div>
          </Empty>
        )}
        {data?.run && data.run.outdated.length > 0 && (
          <Notice tone="warn" title="Abbinamento da aggiornare">
            <p>{data.run.outdated.join(' ')}</p>
          </Notice>
        )}
        {data?.run && listed.length === 0 && (
          <Empty title={insufficient ? 'Prove insufficienti per consigliare un servizio' : 'Nessun servizio proposto'}>
            {insufficient ? (
              <p>{site?.nextStep ?? 'Raccogliere più prove (audit del sito) prima di valutare i servizi.'}</p>
            ) : (
              <p>
                Le prove raccolte non indicano un bisogno chiaro per i servizi abbinabili in automatico. Nessun servizio
                viene proposto per riempire la lista.
              </p>
            )}
          </Empty>
        )}
        {listed.length > 0 && (
          <ol className="plain-list matches" aria-label="Servizi consigliati">
            {listed.map((m, i) => (
              <Recommendation key={m.serviceId} m={m} rank={i + 1} businessId={businessId} onDone={reload} />
            ))}
          </ol>
        )}
        {data?.run && (
          <div className="row">
            <Button variant="secondary" busy={busy} disabled={merged} onClick={() => void recalc(true)}>
              Ricalcola i servizi consigliati
            </Button>
          </div>
        )}
        {others.length > 0 && (
          <details>
            <summary className="small">Altri servizi valutati ({others.length})</summary>
            <div className="table-wrap after">
              <table className="table table--stack">
                <thead>
                  <tr>
                    <th scope="col">Servizio</th>
                    <th scope="col">Esito</th>
                    <th scope="col">Corrispondenza</th>
                    <th scope="col">Motivo</th>
                  </tr>
                </thead>
                <tbody>
                  {others.map((m) => (
                    <tr key={m.serviceId}>
                      <th scope="row" data-label="Servizio">
                        {m.service.name}
                      </th>
                      <td data-label="Esito">
                        <StatusLine m={m} />
                      </td>
                      <td data-label="Corrispondenza" className="mono">
                        {m.score ?? '—'}
                      </td>
                      <td data-label="Motivo" className="small">
                        {m.reasons.join(' ') || m.explanation}
                        {(m.review.status === 'dismissed' || m.score !== null) && (
                          <div className="after">
                            <Review businessId={businessId} serviceId={m.serviceId} review={m.review} onDone={reload} />
                          </div>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </details>
        )}
        {data && data.manualServices.length > 0 && (
          <details>
            <summary className="small">Servizi valutabili solo a colloquio ({data.manualServices.length})</summary>
            <p className="small muted after">
              Servizi di Noventra per cui le prove raccolte automaticamente non indicano un bisogno (ad esempio un’app o
              una campagna pubblicitaria): non vengono mai proposti in automatico.
            </p>
            <ul className="plain-list stack">
              {data.manualServices.map((s) => (
                <li key={s.service.id} className="stack stack--tight">
                  <p>
                    <strong>{s.service.name}</strong> <span className="small muted">— {s.service.description}</span>{' '}
                    {s.review.status && (
                      <Status tone={REVIEW_STATUS[s.review.status].tone}>{REVIEW_STATUS[s.review.status].label}</Status>
                    )}
                  </p>
                  <Review businessId={businessId} serviceId={s.service.id} review={s.review} onDone={reload} />
                </li>
              ))}
            </ul>
          </details>
        )}
        {data?.run && (
          <p className="small muted">
            Calcolato il {formatDateTime(data.run.calculatedAt)} · catalogo v{data.run.catalogVersion}, algoritmo v
            {data.run.algorithmVersion}
          </p>
        )}
      </div>
    </Section>
  );
}
