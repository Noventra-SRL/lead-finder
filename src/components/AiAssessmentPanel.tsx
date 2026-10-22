import { useState } from 'react';
import { ApiError, post, type AiAssessment, type AiAssessmentDetail } from '../api/client.ts';
import { EXCLUSION_LABEL, formatUsd, LEVEL_LABEL, SEVERITY_LABEL } from '../lib/ai.ts';
import { formatDateTime } from '../lib/format.ts';
import { useApi } from '../lib/useApi.ts';
import { Button, ErrorNotice, Loading, Notice, Section, SelectField, Status, TextAreaField } from './ui.tsx';

/*
 * Valutazione commerciale con AI di un'azienda: punteggio calcolato dal server sulle cinque componenti del modello,
 * penalità applicate con il loro peso, affidabilità separata dal punteggio, segnali, ostacoli, servizi consigliati,
 * fatti, deduzioni, informazioni mancanti e prove citate (verificabili). Valutazione e revisione solo su richiesta.
 */

const refs = (r: string[]) => (r.length ? <span className="mono small muted"> [{r.join(', ')}]</span> : null);

function Statements({
  title,
  items,
}: {
  title: string;
  items: { text: string; evidence_refs: string[] }[] | undefined;
}) {
  if (!items?.length) return null;
  return (
    <div>
      <h4 className="sub-title">{title}</h4>
      <ul className="plain-list small">
        {items.map((s, i) => (
          <li key={i}>
            {s.text}
            {refs(s.evidence_refs)}
          </li>
        ))}
      </ul>
    </div>
  );
}

function Result({ a }: { a: AiAssessment }) {
  const applied = (a.penalties ?? []).filter((p) => p.applied);
  const penaltyTotal = applied.reduce((s, p) => s + p.points, 0);
  return (
    <div className="stack ai-result">
      <div className="ai-headline">
        <span className="ai-headline__score mono">{a.score}</span>
        <div className="stack stack--tight">
          <strong>{a.band?.label}</strong>
          <span className="small muted">
            Punteggio commerciale stimato dall’AI (0–100): una priorità, non una probabilità di vendita.
          </span>
          <span className="small">
            Affidabilità delle prove: <strong>{a.confidence ? LEVEL_LABEL[a.confidence.level] : '—'}</strong>
            {a.exclusion && (
              <>
                {' · '}
                <Status tone="danger">{EXCLUSION_LABEL[a.exclusion]}: esclusa dalle classifiche</Status>
              </>
            )}
          </span>
        </div>
      </div>
      {a.needsReview && (
        <Notice tone="warn" title="Da qualificare a mano">
          <p>Motivi: {a.reviewReasons?.join('; ')}.</p>
        </Notice>
      )}
      {a.summary && <p>{a.summary}</p>}

      <table className="table table--stack ai-components">
        <caption className="visually-hidden">Componenti della valutazione</caption>
        <thead>
          <tr>
            <th scope="col">Componente</th>
            <th scope="col">Peso</th>
            <th scope="col">Valore</th>
            <th scope="col">Motivazione e prove</th>
          </tr>
        </thead>
        <tbody>
          {a.components?.map((c) => (
            <tr key={c.id}>
              <th scope="row" data-label="Componente">
                {c.label}
              </th>
              <td className="mono" data-label="Peso">
                {c.weight}%
              </td>
              <td className="mono ai-components__value" data-label="Valore">
                {c.score}
                {c.adjustedFrom !== undefined && <span className="small muted"> (dal modello {c.adjustedFrom})</span>}
                <span className="ai-bar" aria-hidden="true">
                  <span style={{ width: `${c.score}%` }} />
                </span>
              </td>
              <td className="small" data-label="Motivazione e prove">
                {c.explanation}
                {refs(c.evidenceRefs)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="small">
        Calcolo del server: punteggio pesato <span className="mono">{a.weighted?.toLocaleString('it-IT')}</span>
        {penaltyTotal > 0 && (
          <>
            {' '}
            − penalità <span className="mono">{penaltyTotal}</span>
          </>
        )}{' '}
        = <span className="mono">{a.score}</span> (limitato tra 0 e 100).
      </p>
      {a.adjustments && a.adjustments.length > 0 && (
        <ul className="plain-list small">
          {a.adjustments.map((x, i) => (
            <li key={i}>Correzione: {x}</li>
          ))}
        </ul>
      )}

      {(a.penalties?.length ?? 0) > 0 && (
        <div>
          <h4 className="sub-title">Ostacoli commerciali e penalità</h4>
          <ul className="plain-list small">
            {a.penalties!.map((p, i) => (
              <li key={i}>
                <strong>{p.label}</strong> ({p.source === 'crm' ? 'dal CRM' : `gravità ${SEVERITY_LABEL[p.severity]}`}):{' '}
                {p.applied ? (
                  <span className="mono">−{p.points}</span>
                ) : (
                  <span className="muted">non applicata, {p.reason}</span>
                )}
                {refs(p.evidenceRefs)}
                <span className="muted"> — {p.rationale}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="grid-2 ai-signals">
        <Statements title="Segnali positivi" items={a.positiveSignals} />
        <Statements
          title="Segnali negativi e ostacoli"
          items={[
            ...(a.negativeSignals ?? []),
            ...(a.obstacles ?? []).map((o) => ({ text: o.text, evidence_refs: o.evidence_refs })),
          ]}
        />
      </div>

      <p className="small">
        <strong>Servizi consigliati:</strong>{' '}
        {a.recommendedServices?.length
          ? a.recommendedServices.map((s) => s.name).join(', ')
          : 'nessuno con prove sufficienti'}
      </p>
      <p className="small">
        <strong>Prossimo passo di qualificazione:</strong> {a.nextStep}
      </p>
      {a.confidence && <p className="small muted">{a.confidence.explanation}</p>}

      <details>
        <summary className="small">Fatti, deduzioni, informazioni mancanti e prove</summary>
        <div className="stack ai-details">
          <Statements title="Fatti verificati" items={a.verifiedFacts} />
          <Statements title="Deduzioni ragionevoli" items={a.inferences} />
          {a.unknowns && a.unknowns.length > 0 && (
            <div>
              <h4 className="sub-title">Informazioni mancanti o sconosciute</h4>
              <ul className="plain-list small">
                {a.unknowns.map((u, i) => (
                  <li key={i}>{u}</li>
                ))}
              </ul>
            </div>
          )}
          <div>
            <h4 className="sub-title">Prove inviate al modello</h4>
            <dl className="props props--compact small">
              {a.evidence?.map((e) => (
                <div key={e.id} className="props__pair">
                  <dt className="mono">{e.id}</dt>
                  <dd>{e.text}</dd>
                </div>
              ))}
            </dl>
          </div>
          {a.warnings && a.warnings.length > 0 && (
            <p className="small muted">Controlli del server: {a.warnings.join('; ')}.</p>
          )}
        </div>
      </details>
      <p className="small muted">
        {formatDateTime(a.createdAt)} · {a.model} · prompt v{a.promptVersion} · configurazione v{a.configVersion}
        {a.usage.inputTokens !== null && ` · ${a.usage.inputTokens + (a.usage.outputTokens ?? 0)} token`}
        {a.usage.costUsd !== null && ` · costo stimato ${formatUsd(a.usage.costUsd)}`}
        {a.requestedBy && ` · richiesta da ${a.requestedBy}`}
      </p>
    </div>
  );
}

function Review({
  businessId,
  assessmentId,
  onDone,
}: {
  businessId: string;
  assessmentId: string;
  onDone: () => void;
}) {
  const [verdict, setVerdict] = useState<'inaccurate' | 'confirmed' | 'note'>('inaccurate');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  return (
    <form
      className="stack crm-form"
      aria-label="Revisione della valutazione"
      onSubmit={(e) => {
        e.preventDefault();
        setBusy(true);
        setError(null);
        post(`/businesses/${businessId}/assessment/review`, { assessmentId, verdict, note: note.trim() || undefined })
          .then(() => {
            setNote('');
            onDone();
          })
          .catch((err: unknown) =>
            setError(err instanceof ApiError ? err : new ApiError(0, 'UNKNOWN', 'Revisione non riuscita.')),
          )
          .finally(() => setBusy(false));
      }}
    >
      <h4 className="sub-title">Revisione di una persona</h4>
      <div className="grid-2">
        <SelectField label="Esito" value={verdict} onChange={(e) => setVerdict(e.target.value as typeof verdict)}>
          <option value="inaccurate">Segnala come imprecisa</option>
          <option value="confirmed">Confermata dopo la verifica</option>
          <option value="note">Solo una nota</option>
        </SelectField>
      </div>
      <TextAreaField
        label={verdict === 'confirmed' ? 'Nota (facoltativa)' : 'Nota (obbligatoria)'}
        value={note}
        maxLength={2000}
        rows={2}
        onChange={(e) => setNote(e.target.value)}
        hint="Le segnalazioni restano nello storico: servono a migliorare prompt e regole, la valutazione non cambia da sola."
      />
      {error && <p className="field__error">{error.message}</p>}
      <div>
        <Button type="submit" variant="secondary" busy={busy} disabled={verdict !== 'confirmed' && !note.trim()}>
          Registra la revisione
        </Button>
      </div>
    </form>
  );
}

export function AiAssessmentPanel({ businessId, merged }: { businessId: string; merged: boolean }) {
  const [polling, setPolling] = useState(false);
  const d = useApi<AiAssessmentDetail>(`/businesses/${businessId}/assessment`, polling ? 2000 : false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const running = Boolean(d.data?.running);
  if (running !== polling) setPolling(running);

  const start = async (force: boolean) => {
    setBusy(true);
    setError(null);
    try {
      await post(`/businesses/${businessId}/assessment`, { force });
      setPolling(true);
      d.reload();
    } catch (e) {
      setError(e instanceof ApiError ? e : new ApiError(0, 'UNKNOWN', 'Avvio non riuscito.'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Section
      title="Valutazione commerciale AI"
      description="Quanto è realistico acquisire l’azienda come cliente: cinque componenti valutate dal modello con prove, punteggio e penalità calcolati dal server."
    >
      {d.loading && !d.data && <Loading />}
      {d.error && <ErrorNotice error={d.error} onRetry={d.reload} />}
      {d.data && (
        <div className="stack">
          {!d.data.configured && (
            <Notice tone="info" title="Valutazione AI non configurata">
              <p>
                Il server non ha una chiave del fornitore AI: resta il punteggio a regole (sotto) come riserva. Un
                amministratore può impostare AI_API_KEY.
              </p>
            </Notice>
          )}
          {d.data.state && (
            <p className="small">
              Stato:{' '}
              <Status
                tone={
                  d.data.state.state === 'assessed'
                    ? 'ok'
                    : d.data.state.state === 'failed'
                      ? 'danger'
                      : d.data.state.state === 'excluded'
                        ? 'idle'
                        : 'warn'
                }
              >
                {d.data.state.label}
              </Status>
              <span className="muted">
                {d.data.state.state === 'outdated' &&
                  ' · i dati sono cambiati dopo la valutazione: il punteggio sotto è quello precedente, in coda per l’aggiornamento.'}
                {d.data.state.state === 'pending' && ' · in coda per la valutazione automatica.'}
                {d.data.state.state === 'incomplete' &&
                  ' · prove insufficienti o ostacoli: punteggio con affidabilità bassa, da verificare a mano.'}
                {d.data.state.state === 'failed' &&
                  (d.data.state.nextAttemptAt
                    ? ` · nuovo tentativo automatico dopo le ${new Date(d.data.state.nextAttemptAt).toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' })}.`
                    : ' · nessun altro tentativo automatico: usa «Valuta» o «Riprova» dalla pagina Valuta potenziali clienti.')}
              </span>
            </p>
          )}
          {running && (
            <p role="status" className="small">
              Valutazione in corso… può richiedere fino a un minuto.
            </p>
          )}
          {(d.data.lastError || d.data.lastFailure) && !running && (
            <Notice tone="warn" title="Ultima valutazione non riuscita">
              <p>
                {d.data.lastError ?? d.data.lastFailure?.error?.message}
                {d.data.current && ' La valutazione valida precedente resta in uso.'}
              </p>
            </Notice>
          )}
          {d.data.current ? (
            <Result a={d.data.current} />
          ) : (
            !running && <p className="small muted">Nessuna valutazione AI per questa azienda.</p>
          )}
          {error && <Notice tone="error">{error.message}</Notice>}
          {d.data.configured && !merged && (
            <div className="row">
              <Button
                variant={d.data.current ? 'secondary' : 'primary'}
                busy={busy || running}
                onClick={() => void start(Boolean(d.data?.current))}
              >
                {d.data.current ? 'Rivaluta con AI' : 'Valuta con AI'}
              </Button>
              <span className="small muted">
                {d.data.current
                  ? 'Rifà la valutazione anche se le prove non sono cambiate (ha un costo).'
                  : 'Una chiamata al fornitore AI, con un costo per token.'}
              </span>
            </div>
          )}
          {d.data.current && <Review businessId={businessId} assessmentId={d.data.current.id} onDone={d.reload} />}
          {d.data.reviews.length > 0 && (
            <ul className="plain-list small">
              {d.data.reviews.map((r) => (
                <li key={r.id}>
                  {formatDateTime(r.createdAt)} · {r.user ?? 'utente rimosso'} ·{' '}
                  {r.verdict === 'inaccurate'
                    ? 'segnalata come imprecisa'
                    : r.verdict === 'confirmed'
                      ? 'confermata'
                      : 'nota'}
                  {r.note && `: ${r.note}`}
                </li>
              ))}
            </ul>
          )}
          {d.data.history.length > 1 && (
            <details>
              <summary className="small">Storico delle valutazioni ({d.data.history.length})</summary>
              <ul className="plain-list small">
                {d.data.history.map((h) => (
                  <li key={h.id}>
                    {formatDateTime(h.createdAt)} ·{' '}
                    {h.status === 'succeeded' ? `${h.score} (${h.band})` : `non riuscita: ${h.error}`} · {h.model} ·
                    prompt v{h.promptVersion} · configurazione v{h.configVersion}
                    {h.current && ' · in uso'}
                  </li>
                ))}
              </ul>
            </details>
          )}
        </div>
      )}
    </Section>
  );
}
