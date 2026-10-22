import { useState } from 'react';
import { Link, useParams } from 'react-router';
import { ApiError, post, type HuntRun, type HuntRunDetail } from '../api/client.ts';
import { Attribution } from '../components/Attribution.tsx';
import { ExportButton } from '../components/ExportButton.tsx';
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
import { isActive, JOB_STATUS } from '../lib/discovery.ts';
import { formatDateTime } from '../lib/format.ts';
import { useApi } from '../lib/useApi.ts';
import { huntStatusText } from './LeadHunterPage.tsx';

const PREFERENCE: Record<HuntRun['options']['websitePreference'], string> = {
  any: 'tutte le aziende',
  no_website: 'solo senza sito proprio indicato',
  website_issues: 'solo con problemi del sito documentati',
};

function Actions({ run, failedAudits, onDone }: { run: HuntRun; failedAudits: number; onDone: () => void }) {
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const act = async (action: 'pause' | 'resume' | 'cancel' | 'retry-audits') => {
    setBusy(action);
    setError(null);
    setInfo(null);
    try {
      const r = await post<{ resumed?: number }>(`/hunter/runs/${run.id}/${action}`);
      if (action === 'retry-audits')
        setInfo(r.resumed ? 'Le verifiche non riuscite sono di nuovo in coda.' : 'Nessuna verifica da ripetere.');
      onDone();
    } catch (e) {
      setError(e instanceof ApiError ? e : new ApiError(0, 'UNKNOWN', 'Operazione non riuscita.'));
    } finally {
      setBusy(null);
      setConfirm(false);
    }
  };
  const canPause =
    (run.status === 'running' || run.status === 'pending') && !run.pauseRequested && !run.cancelRequested;
  const canCancel = isActive(run.status) && !run.cancelRequested;
  const canResume = run.status === 'paused';
  const canRetry = failedAudits > 0;
  if (!canPause && !canCancel && !canResume && !canRetry) return null;
  return (
    <div className="stack">
      {error && <Notice tone="error">{error.message}</Notice>}
      {info && <Notice tone="info">{info}</Notice>}
      <div className="row">
        {canResume && (
          <Button busy={busy === 'resume'} onClick={() => void act('resume')}>
            Riprendi
          </Button>
        )}
        {canPause && (
          <Button variant="secondary" busy={busy === 'pause'} onClick={() => void act('pause')}>
            Metti in pausa
          </Button>
        )}
        {canRetry && (
          <Button variant="secondary" busy={busy === 'retry-audits'} onClick={() => void act('retry-audits')}>
            Ripeti le verifiche non riuscite
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
        title="Annullare la ricerca di lead?"
        confirmLabel="Annulla la ricerca"
        tone="danger"
        busy={busy === 'cancel'}
        onConfirm={() => void act('cancel')}
        onCancel={() => setConfirm(false)}
      >
        La scoperta e le verifiche in corso vengono interrotte e la ricerca non potrà essere ripresa. Le aziende già
        raccolte restano nel database e nell’elenco di questa ricerca.
      </ConfirmDialog>
    </div>
  );
}

/** Distribuzione come elenco con barra proporzionale: le quantità si leggono come numeri, la barra è solo un aiuto. */
function Distribution({
  title,
  rows,
}: {
  title: string;
  rows: { key: string; label: string; count: number; href?: string }[];
}) {
  const max = Math.max(1, ...rows.map((r) => r.count));
  return (
    <div className="dist">
      <h3 className="sub-title">{title}</h3>
      {rows.length === 0 ? (
        <p className="small muted">Ancora nessuna azienda.</p>
      ) : (
        <table className="dist__table">
          <tbody>
            {rows.map((r) => (
              <tr key={r.key}>
                <th scope="row">{r.href ? <Link to={r.href}>{r.label}</Link> : r.label}</th>
                <td className="mono">{r.count}</td>
                <td aria-hidden="true" className="dist__bar-cell">
                  <span className="dist__bar" style={{ width: `${(r.count / max) * 100}%` }} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

export function HuntRunPage() {
  const { id } = useParams();
  const [active, setActive] = useState(true);
  const { data, error, loading, reload } = useApi<HuntRunDetail>(`/hunter/runs/${id}`, active ? 3000 : false);
  const nowActive = data ? isActive(data.run.status) || data.progress.audits.pending > 0 : true;
  if (nowActive !== active) setActive(nowActive);

  if (loading && !data) return <Loading />;
  if (error) return <ErrorNotice error={error} onRetry={reload} />;
  if (!data) return null;
  const { run, progress: p, currentJob, distribution, top } = data;
  const leads = `/aziende?hunt=${run.id}&sort=commercial&dir=desc`;
  // stato dei tentativi verso la fonte: l'ultimo avviso della ricerca in corso, con l'ora (si vede se è vecchio)
  const lastJobMessage = currentJob && isActive(currentJob.status) ? currentJob.messages.at(-1) : undefined;
  const retry = lastJobMessage?.level === 'warning' ? lastJobMessage : null;

  return (
    <>
      <p className="breadcrumb">
        <Link to="/lead-hunter">Trova aziende</Link> / Ricerca
      </p>
      <PageHeader
        title={`${run.target.toLocaleString('it-IT')} aziende · ${run.area.name}`}
        lede={`${run.sectors.length} ${run.sectors.length === 1 ? 'settore' : 'settori'}: ${run.sectors.map((s) => s.label).join(', ')}`}
      />

      <Section
        title="Stato"
        description="Conteggi letti dal database; si aggiornano da soli mentre la ricerca è attiva."
      >
        <div className="stack">
          <p>
            <Status tone={JOB_STATUS[run.status].tone}>{huntStatusText(run)}</Status>
          </p>
          <Progress
            value={Math.min(p.qualified, run.target)}
            max={run.target}
            label="Aziende che soddisfano i criteri sull’obiettivo"
          />
          <p className="hunt-figure">
            <span className="hunt-figure__value mono">{p.qualified.toLocaleString('it-IT')}</span>
            <span className="hunt-figure__label">
              di {run.target.toLocaleString('it-IT')} aziende che soddisfano i criteri (
              <span className="mono">{Math.min(100, Math.floor((p.qualified / run.target) * 100))}%</span>)
              {p.targetReached
                ? ' · obiettivo raggiunto'
                : run.status === 'completed' || run.status === 'completed_with_warnings'
                  ? ' · obiettivo non raggiunto'
                  : ''}
            </span>
          </p>
          {run.plan.total > 0 && (
            <p className="small">
              Aree: <span className="mono">{run.plan.done}</span> di <span className="mono">{run.plan.total}</span>{' '}
              province cercate
              {run.plan.current && isActive(run.status) && <> · ora: {run.plan.current}</>}
              {currentJob && isActive(currentJob.status) && (
                <>
                  {' '}
                  (
                  <Link to={`/scoperta/ricerche/${currentJob.id}`}>
                    richieste {currentJob.unitsDone}/{currentJob.unitsTotal}
                  </Link>
                  )
                </>
              )}
              {' · '}
              <span className="mono">{p.requests}</span> richieste al server,{' '}
              <span className={p.failedRequests ? 'mono text-danger' : 'mono'}>{p.failedRequests}</span> non riuscite
              dopo i tentativi
            </p>
          )}
          {retry && (
            <p className="small hunt-retry" role="status">
              Ultimo avviso della fonte ({formatDateTime(retry.at)}): {retry.message}
            </p>
          )}
          <Actions run={run} failedAudits={p.audits.failed} onDone={reload} />
        </div>
      </Section>

      <Section
        title="Risultati"
        description="Ogni numero corrisponde ad aziende effettivamente salvate e collegate a questa ricerca."
      >
        <dl className="props">
          <dt>Trovate presso la fonte</dt>
          <dd>
            <span className="mono">{p.discovered}</span> elementi, <span className="mono">{p.duplicatesAvoided}</span>{' '}
            duplicati evitati
          </dd>
          <dt>Raccolte da questa ricerca</dt>
          <dd>
            <span className="mono">{p.linked}</span> — <span className="mono">{p.linkedNew}</span> nuove nel database,{' '}
            <span className="mono">{p.linked - p.linkedNew}</span> già presenti
            {p.excluded > 0 && (
              <>
                , <span className="mono">{p.excluded}</span> escluse dalla prospezione
              </>
            )}
          </dd>
          <dt>Siti web</dt>
          <dd>
            <span className="mono">{p.websites.found}</span> con sito proprio indicato,{' '}
            <span className="mono">{p.websites.missing}</span> senza (assenza non verificata) ·{' '}
            <span className="mono">{p.websites.verified}</span> raggiungibili,{' '}
            <span className="mono">{p.websites.unreachable}</span> irraggiungibili,{' '}
            <span className="mono">{p.websites.invalid}</span> con indirizzo non valido,{' '}
            <span className="mono">{p.websites.unverified}</span> da verificare
          </dd>
          <dt>Verifiche dei siti</dt>
          <dd>
            {run.options.audit ? (
              <>
                <span className="mono">{p.audits.completed}</span> completate,{' '}
                <span className="mono">{p.audits.pending}</span> in coda,{' '}
                <span className={p.audits.failed ? 'mono text-danger' : 'mono'}>{p.audits.failed}</span> non riuscite
              </>
            ) : (
              'Disattivate per questa ricerca'
            )}
          </dd>
          <dt>Punteggio</dt>
          <dd>
            <span className="mono">{p.scored}</span> con punteggio, <span className="mono">{p.ranked}</span>{' '}
            classificate
          </dd>
          <dt>Richieste al server</dt>
          <dd>
            <span className="mono">{p.requests}</span> inviate,{' '}
            <span className={p.failedRequests ? 'mono text-danger' : 'mono'}>{p.failedRequests}</span> non riuscite
            {p.failedAreas > 0 && (
              <>
                , <span className="mono text-danger">{p.failedAreas}</span> province non completate
              </>
            )}
          </dd>
          <dt>Criteri</dt>
          <dd>
            {PREFERENCE[run.options.websitePreference]}
            {run.options.minScore !== null && `, punteggio almeno ${run.options.minScore}`}
            {run.options.excludeKnown && ', solo aziende nuove'}
          </dd>
          <dt>Tempi</dt>
          <dd>
            Creata {formatDateTime(run.createdAt)} da {run.createdBy ?? 'utente rimosso'}
            {run.startedAt && <> · avviata {formatDateTime(run.startedAt)}</>}
            {run.finishedAt && <> · terminata {formatDateTime(run.finishedAt)}</>}
          </dd>
        </dl>
        {p.linked > 0 && (
          <div className="row after">
            <Link className="btn" to={leads}>
              Apri i lead di questa ricerca
            </Link>
            <ExportButton
              query={`hunt=${run.id}&sort=commercial&dir=desc`}
              name="lead_hunter"
              total={p.linked}
              label="Esporta"
            />
          </div>
        )}
      </Section>

      {p.linked > 0 && (
        <Section
          title="Distribuzione"
          description="Per verificare che i risultati non siano concentrati in pochi settori o regioni."
        >
          <div className="grid-2 dist-grid">
            <Distribution
              title="Per settore"
              rows={distribution.sectors.map((s) => ({
                key: s.sector ?? '-',
                label: s.label,
                count: s.count,
                href: s.sector ? `/aziende?hunt=${run.id}&sector=${s.sector}&sort=commercial&dir=desc` : undefined,
              }))}
            />
            <Distribution
              title="Per regione"
              rows={distribution.regions.map((r) => ({ key: r.regionCode ?? '-', label: r.region, count: r.count }))}
            />
          </div>
        </Section>
      )}

      {top.length > 0 && (
        <Section
          title="Migliori opportunità"
          description="Punteggio commerciale più alto, al massimo due per settore: valutazione AI se presente, altrimenti punteggio a regole. È un criterio di priorità, non una probabilità di vendita."
        >
          <ol className="top-list">
            {top.map((t) => (
              <li key={t.id}>
                <span className="mono top-list__score">{t.score}</span>
                <span>
                  <Link to={`/aziende/${t.id}`}>{t.name}</Link>
                  <span className="small muted">
                    {' '}
                    · {t.sector}
                    {t.municipality && ` · ${t.municipality}`} · {t.band} ·{' '}
                    {t.source === 'ai' ? 'valutazione AI' : 'punteggio a regole'}
                  </span>
                </span>
              </li>
            ))}
          </ol>
          <p className="after small">
            <Link to={leads}>Tutti i lead per punteggio</Link>
          </p>
        </Section>
      )}

      <Section title="Messaggi" description="Avanzamento, avvisi ed errori, in ordine di tempo.">
        {run.messages.length === 0 ? (
          <p className="muted small">Nessun messaggio.</p>
        ) : (
          <ol className="log">
            {[...run.messages].reverse().map((m, i) => (
              <li key={`${m.at}-${i}`} className={`log__item log__item--${m.level}`}>
                <time className="mono small muted" dateTime={m.at}>
                  {formatDateTime(m.at)}
                </time>
                <span>{m.message}</span>
              </li>
            ))}
          </ol>
        )}
        <Attribution />
      </Section>
    </>
  );
}
