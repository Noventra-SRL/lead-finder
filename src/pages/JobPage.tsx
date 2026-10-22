import { useState } from 'react';
import { Link, useParams } from 'react-router';
import { ApiError, post, type DiscoveryJob, type JobUnit } from '../api/client.ts';
import { Attribution } from '../components/Attribution.tsx';
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
import { areaLabel, isActive, JOB_STATUS, jobStatusText, savedCount } from '../lib/discovery.ts';
import { formatDate, formatDateTime } from '../lib/format.ts';
import { useApi } from '../lib/useApi.ts';

const UNIT_STATUS: Record<JobUnit['status'], string> = {
  pending: 'Da eseguire',
  running: 'In corso',
  done: 'Completata',
  failed: 'Non riuscita',
  split: 'Divisa in due parti',
  skipped: 'Saltata (limite raggiunto)',
};

const UNIT_TONE: Record<JobUnit['status'], 'ok' | 'warn' | 'danger' | 'idle'> = {
  pending: 'idle',
  running: 'warn',
  done: 'ok',
  failed: 'danger',
  split: 'idle',
  skipped: 'idle',
};

function Actions({ job, onDone }: { job: DiscoveryJob; onDone: () => void }) {
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const run = async (action: 'cancel' | 'pause' | 'resume') => {
    setBusy(action);
    setError(null);
    try {
      await post(`/discovery/jobs/${job.id}/${action}`);
      onDone();
    } catch (e) {
      setError(e instanceof ApiError ? e : new ApiError(0, 'UNKNOWN', 'Operazione non riuscita.'));
    } finally {
      setBusy(null);
      setConfirm(false);
    }
  };
  const canPause =
    (job.status === 'running' || job.status === 'pending') && !job.pauseRequested && !job.cancelRequested;
  const canCancel = isActive(job.status) && !job.cancelRequested;
  const canResume = job.status === 'paused' || job.status === 'failed' || job.status === 'completed_with_warnings';
  if (!canPause && !canCancel && !canResume) return null;
  return (
    <div className="stack">
      {error && <Notice tone="error">{error.message}</Notice>}
      <div className="row">
        {canResume && (
          <Button busy={busy === 'resume'} onClick={() => void run('resume')}>
            {job.status === 'paused' ? 'Riprendi' : 'Ripeti le parti non riuscite'}
          </Button>
        )}
        {canPause && (
          <Button variant="secondary" busy={busy === 'pause'} onClick={() => void run('pause')}>
            Metti in pausa
          </Button>
        )}
        {canCancel && (
          <Button variant="danger" onClick={() => setConfirm(true)}>
            Annulla la ricerca
          </Button>
        )}
      </div>
      <ConfirmDialog
        open={confirm}
        title="Annullare la ricerca?"
        confirmLabel="Annulla la ricerca"
        tone="danger"
        busy={busy === 'cancel'}
        onConfirm={() => void run('cancel')}
        onCancel={() => setConfirm(false)}
      >
        La richiesta in corso viene interrotta e la ricerca non potrà essere ripresa. Le aziende già salvate restano nel
        database.
      </ConfirmDialog>
    </div>
  );
}

export function JobPage() {
  const { id } = useParams();
  const [active, setActive] = useState(true);
  const { data, error, loading, reload } = useApi<{ job: DiscoveryJob; units: JobUnit[] }>(
    `/discovery/jobs/${id}`,
    active ? 2000 : false,
  );
  const nowActive = data ? isActive(data.job.status) : true;
  if (nowActive !== active) setActive(nowActive);

  if (loading && !data) return <Loading />;
  if (error) return <ErrorNotice error={error} onRetry={reload} />;
  if (!data) return null;
  const { job, units } = data;
  const c = job.counts;
  const problems = units.filter((u) => u.status === 'failed' || u.missing.length > 0);

  return (
    <>
      <p className="breadcrumb">
        <Link to="/lead-hunter">Trova aziende</Link> / <Link to="/scoperta">Ricerca manuale</Link> / Ricerca
      </p>
      <PageHeader
        title={areaLabel(job)}
        lede={`${job.area.context ?? ''} · ${job.categories.map((x) => x.label).join(', ')}`}
      />

      <Section title="Stato" description="Aggiornato in tempo reale dal database mentre la ricerca è attiva.">
        <div className="stack">
          <p>
            <Status tone={JOB_STATUS[job.status].tone}>{jobStatusText(job)}</Status>
          </p>
          <Progress value={job.progress.unitsDone} max={job.progress.unitsTotal} label="Avanzamento della ricerca" />
          <p className="small">
            <span className="mono">
              {job.progress.unitsDone} / {job.progress.unitsTotal}
            </span>{' '}
            richieste completate
            {job.limitReached && ' · limite di risultati raggiunto'}
          </p>
          <Actions job={job} onDone={reload} />
        </div>
      </Section>

      <Section
        title="Risultati"
        description="Conteggi registrati dalla ricerca. Le aziende salvate sono nell’elenco delle aziende."
      >
        <dl className="props">
          <dt>Trovate presso la fonte</dt>
          <dd className="mono">{c.discovered}</dd>
          <dt>Salvate</dt>
          <dd>
            <span className="mono">{savedCount(job)}</span> — <span className="mono">{c.inserted}</span> nuove,{' '}
            <span className="mono">{c.updated}</span> aggiornate, <span className="mono">{c.unchanged}</span> già
            presenti e invariate, <span className="mono">{c.merged}</span> collegate a un’azienda esistente
          </dd>
          <dt>Possibili duplicati</dt>
          <dd>
            <span className="mono">{c.flaggedForReview}</span> da verificare
            {c.flaggedForReview > 0 && (
              <>
                {' '}
                · <Link to="/aziende/duplicati">Apri la revisione</Link>
              </>
            )}
          </dd>
          <dt>Non salvate</dt>
          <dd>
            <span className="mono">{c.skippedIncomplete}</span> sotto la completezza richiesta,{' '}
            <span className="mono">{c.duplicatesSkipped}</span> ripetute nella stessa ricerca
          </dd>
          <dt>Richieste al server</dt>
          <dd>
            <span className="mono">{c.requestsSent}</span> inviate,{' '}
            <span className={c.failedRequests ? 'mono text-danger' : 'mono'}>{c.failedRequests}</span> non riuscite
          </dd>
          <dt>Parametri</dt>
          <dd>
            Massimo <span className="mono">{job.maxResults}</span> risultati
            {job.minCompleteness > 0 && `, completezza almeno ${job.minCompleteness} su 5`}
            {job.requireWebsite && ', solo con sito web'}
          </dd>
          <dt>Tempi</dt>
          <dd>
            Creata {formatDateTime(job.createdAt)} da {job.createdBy ?? 'utente rimosso'}
            {job.startedAt && <> · avviata {formatDateTime(job.startedAt)}</>}
            {job.finishedAt && <> · terminata {formatDateTime(job.finishedAt)}</>}
          </dd>
        </dl>
        {savedCount(job) > 0 && (
          <p className="after">
            <Link to={`/aziende?job=${job.id}`}>Vedi le aziende di questa ricerca</Link>
          </p>
        )}
      </Section>

      <Section title="Messaggi" description="Avvisi ed errori della fonte, in ordine di tempo.">
        {job.messages.length === 0 ? (
          <p className="muted small">Nessun messaggio.</p>
        ) : (
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
        )}
      </Section>

      <Section
        title="Richieste"
        description={`Ogni richiesta copre fino a un gruppo di comuni della stessa provincia.${problems.length ? ` ${problems.length} con problemi.` : ''}`}
      >
        <div className="table-wrap">
          <table className="table table--stack">
            <thead>
              <tr>
                <th scope="col">N.</th>
                <th scope="col">Comuni</th>
                <th scope="col">Stato</th>
                <th scope="col">Elementi</th>
                <th scope="col">Note</th>
              </tr>
            </thead>
            <tbody>
              {units.map((u) => (
                <tr key={u.seq}>
                  <td data-label="N." className="mono muted">
                    {u.seq + 1}
                  </td>
                  <td data-label="Comuni">
                    {u.municipalities
                      .slice(0, 4)
                      .map((m) => m.name)
                      .join(', ')}
                    {u.municipalities.length > 4 && (
                      <span className="muted"> e altri {u.municipalities.length - 4}</span>
                    )}
                  </td>
                  <td data-label="Stato">
                    <Status tone={UNIT_TONE[u.status]}>{UNIT_STATUS[u.status]}</Status>
                  </td>
                  <td data-label="Elementi" className="mono">
                    {u.status === 'done' ? u.recordsFound : '—'}
                  </td>
                  <td data-label="Note" className="small notes">
                    {u.error && <span className="text-danger">{u.error}</span>}
                    {u.missing.length > 0 && <span>Non trovati su OSM: {u.missing.length}</span>}
                    {u.fromCache && <span className="muted">Dalla cache</span>}
                    {u.sourceDataAt && <span className="muted note">Dati OSM al {formatDate(u.sourceDataAt)}</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <Attribution />
      </Section>
    </>
  );
}
