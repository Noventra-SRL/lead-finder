import { useState } from 'react';
import { Link } from 'react-router';
import type { AuditJob, AuditMeta, Paged } from '../api/client.ts';
import {
  Empty,
  ErrorNotice,
  Loading,
  Notice,
  PageHeader,
  Pagination,
  Progress,
  Section,
  Status,
} from '../components/ui.tsx';
import { auditJobStatusText, auditJobTitle } from '../lib/audit.ts';
import { isActive, JOB_STATUS } from '../lib/discovery.ts';
import { formatDateTime } from '../lib/format.ts';
import { useApi } from '../lib/useApi.ts';
import { NAV_ITEMS, navIndex } from '../navigation.ts';

function Rules({ meta }: { meta: AuditMeta }) {
  const l = meta.limits;
  return (
    <dl className="props">
      <dt>Pagine per sito</dt>
      <dd>
        <span className="mono">{l.defaultPages}</span> (al massimo <span className="mono">{l.maxPages}</span>): pagina
        principale e pagine interne utili (contatti, servizi, prenotazioni)
      </dd>
      <dt>Ritmo</dt>
      <dd>
        Una richiesta ogni <span className="mono">{(l.hostIntervalMs / 1000).toLocaleString('it-IT')}</span> s per sito,
        robots.txt rispettato, nessun JavaScript eseguito, nessun file scaricato
      </dd>
      <dt>Limiti di sicurezza</dt>
      <dd>
        Solo indirizzi pubblici sulle porte <span className="mono">{l.allowedPorts.join(', ')}</span>, risposte fino a{' '}
        <span className="mono">{l.maxResponseKb.toLocaleString('it-IT')}</span> kB, tempo massimo{' '}
        <span className="mono">{l.requestTimeoutMs / 1000}</span> s per richiesta
      </dd>
      <dt>Ripetizioni</dt>
      <dd>
        Un sito verificato da meno di <span className="mono">{l.reauditHours}</span> ore con la stessa configurazione
        non viene riverificato, salvo richiesta esplicita
      </dd>
      <dt>Prestazioni</dt>
      <dd>
        {meta.performance.configured ? (
          <>
            PageSpeed Insights ({meta.performance.strategies.join(', ')}): misure di laboratorio e, se disponibili, dati
            reali degli utenti
          </>
        ) : (
          <span className="muted">
            Non misurate: PageSpeed Insights non è configurato sul server (PAGESPEED_API_KEY). Gli audit restano
            completi per tutto il resto.
          </span>
        )}
      </dd>
    </dl>
  );
}

function JobRow({ job }: { job: AuditJob }) {
  const p = job.progress;
  return (
    <li className="job">
      <div className="job__head">
        <Link to={`/audit/verifiche/${job.id}`} className="job__title">
          {auditJobTitle(job)}
        </Link>
        <Status tone={JOB_STATUS[job.status].tone}>{auditJobStatusText(job)}</Status>
      </div>
      {isActive(job.status) && <Progress value={p.done} max={p.total} label={`Avanzamento: ${auditJobTitle(job)}`} />}
      <p className="small muted">
        <span className="mono">
          {p.done}/{p.total}
        </span>{' '}
        verificate
        {p.skipped > 0 && <> · {p.skipped} con audit recente riusato</>}
        {p.failed > 0 && <span className="text-danger"> · {p.failed} non riuscite</span>} · fino a{' '}
        {job.settings.maxPages} {job.settings.maxPages === 1 ? 'pagina' : 'pagine'} · {formatDateTime(job.createdAt)}
        {job.createdBy && <> · {job.createdBy}</>}
      </p>
    </li>
  );
}

export function AuditPage() {
  const item = NAV_ITEMS.find((i) => i.path === '/audit')!;
  const meta = useApi<AuditMeta>('/audits/meta');
  const [page, setPage] = useState(1);
  const [poll, setPoll] = useState(false);
  const jobs = useApi<Paged<AuditJob>>(`/audits/jobs?page=${page}&pageSize=20`, poll ? 3000 : false);
  const anyActive = Boolean(jobs.data?.items.some((j) => isActive(j.status)));
  if (anyActive !== poll) setPoll(anyActive);

  return (
    <>
      <PageHeader index={navIndex(item.path)} title={item.label} lede={item.lede} />

      {meta.data && !meta.data.workerActive && (
        <Notice tone="warn" title="Esecutore delle verifiche disattivato">
          <p>Le verifiche restano in coda finché il server non viene avviato con AUDIT_WORKER=on.</p>
        </Notice>
      )}

      <Section
        title="Verifiche"
        description="Ogni verifica analizza le aziende selezionate nell’elenco delle aziende. Si aggiorna da sola mentre è in corso."
      >
        {jobs.loading && !jobs.data && <Loading />}
        {jobs.error && <ErrorNotice error={jobs.error} onRetry={jobs.reload} />}
        {jobs.data && jobs.data.total === 0 && (
          <Empty title="Nessuna verifica avviata">
            Seleziona le aziende nell’<Link to="/aziende?website=own&audit=unaudited">elenco delle aziende</Link> (ad
            esempio quelle con un sito proprio non ancora verificato) e avvia l’audit, oppure aprine una scheda.
          </Empty>
        )}
        {jobs.data && jobs.data.total > 0 && (
          <>
            <ul className="job-list">
              {jobs.data.items.map((j) => (
                <JobRow key={j.id} job={j} />
              ))}
            </ul>
            <Pagination page={page} pageSize={20} total={jobs.data.total} onPage={setPage} />
          </>
        )}
      </Section>

      <Section
        title="Come funziona"
        description="Un controllo dall’esterno, come farebbe un visitatore: non è un test di sicurezza."
      >
        {meta.loading && <Loading />}
        {meta.error && <ErrorNotice error={meta.error} onRetry={meta.reload} />}
        {meta.data && <Rules meta={meta.data} />}
        <p className="small after">
          <Link to="/aziende?website=own&audit=unaudited">Aziende con un sito proprio non ancora verificate</Link>
        </p>
      </Section>
    </>
  );
}
