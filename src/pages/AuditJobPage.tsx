import { useState } from 'react';
import { Link, useParams } from 'react-router';
import type { AuditJob, AuditJobItem } from '../api/client.ts';
import { AuditJobActions } from '../components/AuditControls.tsx';
import { ErrorNotice, Loading, PageHeader, Progress, Section, Status } from '../components/ui.tsx';
import { auditJobStatusText, auditJobTitle, ITEM_STATUS, outcomeLabel } from '../lib/audit.ts';
import { isActive, JOB_STATUS } from '../lib/discovery.ts';
import { formatDateTime } from '../lib/format.ts';
import { useApi } from '../lib/useApi.ts';

export function AuditJobPage() {
  const { id } = useParams();
  const [active, setActive] = useState(true);
  const { data, error, loading, reload } = useApi<{ job: AuditJob; items: AuditJobItem[] }>(
    `/audits/jobs/${id}`,
    active ? 2000 : false,
  );
  const nowActive = data ? isActive(data.job.status) : true;
  if (nowActive !== active) setActive(nowActive);

  if (loading && !data) return <Loading />;
  if (error) return <ErrorNotice error={error} onRetry={reload} />;
  if (!data) return null;
  const { job, items } = data;
  const p = job.progress;

  return (
    <>
      <p className="breadcrumb">
        <Link to="/audit">Analizza siti web</Link> / Verifica
      </p>
      <PageHeader
        title={auditJobTitle(job)}
        lede={`Fino a ${job.settings.maxPages} ${job.settings.maxPages === 1 ? 'pagina' : 'pagine'} per sito · prestazioni ${job.settings.usePerformance ? `misurate (${job.settings.strategies.join(', ')})` : 'non misurate'}${job.force ? ' · ripetizione forzata' : ''}`}
      />

      <Section title="Stato" description="Aggiornato in tempo reale dal database mentre la verifica è attiva.">
        <div className="stack">
          <p>
            <Status tone={JOB_STATUS[job.status].tone}>{auditJobStatusText(job)}</Status>
          </p>
          <Progress value={p.done} max={p.total} label="Avanzamento della verifica" />
          <p className="small">
            <span className="mono">
              {p.done} / {p.total}
            </span>{' '}
            aziende elaborate
            {p.skipped > 0 && <> · {p.skipped} con un audit recente riusato</>}
            {p.failed > 0 && <span className="text-danger"> · {p.failed} non riuscite</span>}
          </p>
          <p className="small muted">
            Creata {formatDateTime(job.createdAt)} da {job.createdBy ?? 'utente rimosso'}
            {job.startedAt && <> · avviata {formatDateTime(job.startedAt)}</>}
            {job.finishedAt && <> · terminata {formatDateTime(job.finishedAt)}</>}
          </p>
          <AuditJobActions job={job} onDone={reload} />
        </div>
      </Section>

      <Section
        title="Aziende"
        description="Esito per azienda. Lo stesso sito condiviso da più aziende viene analizzato una volta sola."
      >
        <div className="table-wrap">
          <table className="table table--stack">
            <thead>
              <tr>
                <th scope="col">Azienda</th>
                <th scope="col">Stato</th>
                <th scope="col">Esito del sito</th>
                <th scope="col">Rilievi utili</th>
                <th scope="col">Audit</th>
              </tr>
            </thead>
            <tbody>
              {items.map((i) => (
                <tr key={i.seq}>
                  <td data-label="Azienda">
                    <Link to={`/aziende/${i.business.id}`}>{i.business.name}</Link>
                    {i.business.website && <div className="mono small muted">{i.business.website}</div>}
                  </td>
                  <td data-label="Stato">
                    <Status tone={ITEM_STATUS[i.status]?.tone ?? 'idle'}>
                      {ITEM_STATUS[i.status]?.label ?? i.status}
                    </Status>
                  </td>
                  <td data-label="Esito del sito" className="small">
                    {outcomeLabel(i.outcome)}
                    {i.error && <div className="text-danger">{i.error}</div>}
                  </td>
                  <td data-label="Rilievi utili" className="mono">
                    {i.actionableFindings ?? '—'}
                  </td>
                  <td data-label="Audit">
                    {i.auditId ? <Link to={`/audit/esiti/${i.auditId}`}>Apri</Link> : <span className="muted">—</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Section>

      <Section title="Messaggi" description="Avvisi ed errori della verifica, in ordine di tempo.">
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
    </>
  );
}
