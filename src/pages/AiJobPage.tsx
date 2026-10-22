import { useState } from 'react';
import { Link, useParams } from 'react-router';
import { ApiError, post, type AiJobDetail } from '../api/client.ts';
import {
  Button,
  ConfirmDialog,
  ErrorNotice,
  Loading,
  Notice,
  PageHeader,
  Progress,
  Section,
  Status,
} from '../components/ui.tsx';
import { formatUsd } from '../lib/ai.ts';
import { isActive, JOB_STATUS } from '../lib/discovery.ts';
import { formatDateTime } from '../lib/format.ts';
import { useApi } from '../lib/useApi.ts';

/* Avanzamento di una valutazione AI in blocco: conteggi reali, costo stimato e reale, pausa, ripresa, annullamento. */

const ITEM_STATUS: Record<string, { label: string; tone: 'ok' | 'warn' | 'danger' | 'idle' }> = {
  pending: { label: 'Da fare', tone: 'idle' },
  running: { label: 'In corso', tone: 'warn' },
  assessed: { label: 'Valutata', tone: 'ok' },
  cached: { label: 'Riusata (stesse prove)', tone: 'ok' },
  skipped: { label: 'Saltata', tone: 'idle' },
  failed: { label: 'Non riuscita', tone: 'danger' },
};

export function AiJobPage() {
  const { id } = useParams();
  const [active, setActive] = useState(true);
  const d = useApi<AiJobDetail>(`/ai/jobs/${id}`, active ? 2000 : false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [confirm, setConfirm] = useState(false);
  const nowActive = d.data ? isActive(d.data.job.status) : true;
  if (nowActive !== active) setActive(nowActive);
  if (d.loading && !d.data) return <Loading />;
  if (d.error) return <ErrorNotice error={d.error} onRetry={d.reload} />;
  if (!d.data) return null;
  const { job, items } = d.data;
  const done = job.total - job.counts.pending;
  const act = async (action: 'pause' | 'resume' | 'cancel') => {
    setBusy(action);
    setError(null);
    try {
      await post(`/ai/jobs/${job.id}/${action}`);
      d.reload();
    } catch (e) {
      setError(e instanceof ApiError ? e : new ApiError(0, 'UNKNOWN', 'Operazione non riuscita.'));
    } finally {
      setBusy(null);
      setConfirm(false);
    }
  };
  return (
    <>
      <p className="breadcrumb">
        <Link to="/analisi-ai">Valuta potenziali clienti</Link> / Valutazione in blocco
      </p>
      <PageHeader
        title={`Valutazione di ${job.total} aziende`}
        lede={`Avviata il ${formatDateTime(job.createdAt)}${job.createdBy ? ` da ${job.createdBy}` : ''}.`}
      />
      <Section
        title="Stato"
        description="Conteggi letti dal database; si aggiornano da soli mentre il lavoro è attivo."
      >
        <div className="stack">
          <p>
            <Status tone={JOB_STATUS[job.status].tone}>
              {job.status === 'paused' && job.pauseReason === 'not_configured'
                ? 'In pausa: AI non configurata'
                : JOB_STATUS[job.status].label}
            </Status>
          </p>
          <Progress value={done} max={job.total} label="Avanzamento della valutazione" />
          <p className="small">
            <span className="mono">{job.counts.assessed}</span> valutate,{' '}
            <span className="mono">{job.counts.cached}</span> riusate,{' '}
            <span className="mono">{job.counts.skipped}</span> saltate,{' '}
            <span className={job.counts.failed ? 'mono text-danger' : 'mono'}>{job.counts.failed}</span> non riuscite,{' '}
            <span className="mono">{job.counts.pending}</span> da fare
          </p>
          <p className="small">
            Costo: <strong>{formatUsd(job.usage.costUsd)}</strong>
            {job.usage.inputTokens !== null && ` (${job.usage.inputTokens + (job.usage.outputTokens ?? 0)} token)`} ·
            stimato prima dell’avvio {formatUsd(job.estimatedCostUsd)}
          </p>
          {error && <Notice tone="error">{error.message}</Notice>}
          <div className="row">
            {job.status === 'paused' && (
              <Button busy={busy === 'resume'} onClick={() => void act('resume')}>
                Riprendi
              </Button>
            )}
            {(job.status === 'running' || job.status === 'pending') && !job.pauseRequested && (
              <Button variant="secondary" busy={busy === 'pause'} onClick={() => void act('pause')}>
                Metti in pausa
              </Button>
            )}
            {isActive(job.status) && !job.cancelRequested && (
              <Button variant="danger" onClick={() => setConfirm(true)}>
                Annulla
              </Button>
            )}
          </div>
          <ConfirmDialog
            open={confirm}
            title="Annullare la valutazione in blocco?"
            confirmLabel="Annulla la valutazione"
            tone="danger"
            busy={busy === 'cancel'}
            onConfirm={() => void act('cancel')}
            onCancel={() => setConfirm(false)}
          >
            Le aziende già valutate restano valutate; le altre non verranno valutate.
          </ConfirmDialog>
        </div>
      </Section>
      <Section
        title="Aziende"
        description="Esito per azienda. Le non riuscite non hanno punteggio: la valutazione precedente, se c’era, resta in uso."
      >
        <div className="table-wrap">
          <table className="table table--stack">
            <thead>
              <tr>
                <th scope="col">Azienda</th>
                <th scope="col">Esito</th>
                <th scope="col">Punteggio</th>
                <th scope="col">Note</th>
              </tr>
            </thead>
            <tbody>
              {items.map((i) => (
                <tr key={i.seq}>
                  <td data-label="Azienda">
                    <Link to={`/aziende/${i.businessId}`}>{i.name}</Link>
                  </td>
                  <td data-label="Esito">
                    <Status tone={ITEM_STATUS[i.status]?.tone ?? 'idle'}>
                      {ITEM_STATUS[i.status]?.label ?? i.status}
                    </Status>
                  </td>
                  <td data-label="Punteggio" className="mono">
                    {i.score ?? '—'}
                  </td>
                  <td data-label="Note" className="small">
                    {i.error ?? ''}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Section>
      <Section title="Messaggi" description="Avanzamento e avvisi, dal più recente.">
        <ol className="log">
          {[...job.messages].reverse().map((m, i) => (
            <li key={`${m.at}-${i}`} className={`log__item log__item--${m.level}`}>
              <time className="mono small muted" dateTime={m.at}>
                {formatDateTime(m.at)}
              </time>
              <span>{m.message}</span>
            </li>
          ))}
        </ol>
      </Section>
    </>
  );
}
