import { useState } from 'react';
import { CoveragePanel } from '../components/CoveragePanel.tsx';
import { Link } from 'react-router';
import { ApiError, put, type AiConfigResponse, type AiJob, type AiStatus, type Paged } from '../api/client.ts';
import { useAuth } from '../auth/AuthContext.tsx';
import {
  Button,
  Empty,
  ErrorNotice,
  Field,
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
import { NAV_ITEMS, navIndex } from '../navigation.ts';

/*
 * Analisi AI: stato del fornitore (senza segreti), valutazioni in blocco, configurazione di pesi, penalità e fasce.
 * Le valutazioni partono solo da una scelta esplicita: dall’elenco delle aziende (selezione) o dalla scheda di un'azienda.
 */

const STATE: Record<AiStatus['state'], { label: string; tone: 'ok' | 'warn' | 'danger' | 'idle' }> = {
  available: { label: 'Attiva', tone: 'ok' },
  error: { label: 'Errore del fornitore all’ultima chiamata', tone: 'danger' },
  not_configured: { label: 'Non configurata', tone: 'idle' },
};

function StatusSection({ s }: { s: AiStatus }) {
  return (
    <Section title="Stato" description="Configurazione del server: la chiave del fornitore non viene mai mostrata.">
      <dl className="props">
        <dt>Valutazione AI</dt>
        <dd>
          <Status tone={STATE[s.state].tone}>{STATE[s.state].label}</Status>
          {s.lastResult && (
            <span className="small muted">
              {' '}
              · ultima chiamata {formatDateTime(s.lastResult.at)}
              {s.lastResult.status === 'failed' && ` (non riuscita: ${s.lastResult.code})`}
            </span>
          )}
        </dd>
        <dt>Fornitore e modello</dt>
        <dd>
          {s.provider ?? 'nessuno'} · <span className="mono">{s.model}</span> · impegno {s.effort} · prompt v
          {s.promptVersion}
        </dd>
        <dt>Prezzi di riferimento</dt>
        <dd>
          {s.price
            ? `${formatUsd(s.price.inputPerMTok)} per milione di token in ingresso, ${formatUsd(s.price.outputPerMTok)} in uscita`
            : 'non noti per questo modello: il costo non viene stimato'}
        </dd>
        <dt>Aziende valutate</dt>
        <dd>
          <span className="mono">{s.assessed}</span> ·{' '}
          <Link to="/aziende?aiStatus=needs_review&sort=commercial&dir=desc">
            <span className="mono">{s.needsReview}</span> da qualificare a mano
          </Link>{' '}
          · <Link to="/aziende?aiStatus=not_assessed&sort=score&dir=desc">non ancora valutate</Link>
        </dd>
        <dt>Valutazioni in blocco</dt>
        <dd>{s.workerActive ? 'esecutore attivo in questo server' : 'esecutore disattivato (AI_WORKER=off)'}</dd>
      </dl>
      {!s.configured && (
        <Notice tone="info" title="Come attivarla">
          <p>
            Nel file <span className="mono">.env</span> del server imposta <span className="mono">AI_API_KEY</span> con
            una chiave dell’API di Anthropic (facoltativi <span className="mono">AI_MODEL</span>,{' '}
            <span className="mono">AI_EFFORT</span>) e riavvia. Finché non è configurata, l’applicazione usa il
            punteggio a regole come riserva dichiarata e nessuna valutazione viene inventata. Ogni valutazione ha un
            costo per token: vedi docs/valutazione-ai.md.
          </p>
        </Notice>
      )}
    </Section>
  );
}

function Jobs() {
  const jobs = useApi<Paged<AiJob>>('/ai/jobs?pageSize=10');
  return (
    <Section
      title="Valutazioni in blocco"
      description="Si avviano dall’elenco delle aziende: seleziona le aziende e scegli «Valuta con AI». Prima di partire viene mostrata la stima del costo."
    >
      {jobs.loading && !jobs.data && <Loading />}
      {jobs.error && <ErrorNotice error={jobs.error} onRetry={jobs.reload} />}
      {jobs.data && jobs.data.total === 0 && (
        <Empty title="Nessuna valutazione in blocco">
          Dall’<Link to="/aziende?aiStatus=not_assessed">elenco delle aziende</Link> seleziona le aziende da valutare.
        </Empty>
      )}
      {jobs.data && jobs.data.total > 0 && (
        <ol className="job-list">
          {jobs.data.items.map((j) => {
            const done = j.total - j.counts.pending;
            return (
              <li key={j.id} className="job">
                <div className="job__head">
                  <Link to={`/analisi-ai/lotti/${j.id}`} className="job__title">
                    {j.total} aziende · {formatDateTime(j.createdAt)}
                  </Link>
                  <Status tone={JOB_STATUS[j.status].tone}>{JOB_STATUS[j.status].label}</Status>
                </div>
                {isActive(j.status) && <Progress value={done} max={j.total} label="Avanzamento della valutazione" />}
                <p className="small">
                  {j.counts.assessed} valutate, {j.counts.cached} riusate, {j.counts.failed} non riuscite · costo{' '}
                  {formatUsd(j.usage.costUsd)} (stimato {formatUsd(j.estimatedCostUsd)})
                </p>
              </li>
            );
          })}
        </ol>
      )}
    </Section>
  );
}

function ConfigSection({ c, onSaved }: { c: AiConfigResponse; onSaved: () => void }) {
  const { state } = useAuth();
  const admin = state.status === 'authenticated' && state.user.role === 'admin';
  const [weights, setWeights] = useState(c.config.weights);
  const [penalties, setPenalties] = useState(c.config.penalties);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [saved, setSaved] = useState(false);
  const sum = Object.values(weights).reduce((s, v) => s + v, 0);
  const save = async () => {
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      await put('/ai/config', { config: { ...c.config, weights, penalties }, note: note.trim() || undefined });
      setSaved(true);
      onSaved();
    } catch (e) {
      setError(e instanceof ApiError ? e : new ApiError(0, 'UNKNOWN', 'Salvataggio non riuscito.'));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Section
      title="Formula e penalità"
      description={`Versione ${c.version} del ${formatDateTime(c.createdAt)}${c.note ? ` — ${c.note}` : ''}. Il punteggio finale lo calcola il server: componenti × pesi, meno le penalità applicate, tra 0 e 100.`}
    >
      <div className="stack">
        <fieldset className="fieldset">
          <legend>Pesi delle componenti (somma 100)</legend>
          <div className="grid-2">
            {c.components.map((comp) => (
              <Field
                key={comp.id}
                label={`${comp.label} (%)`}
                type="number"
                min={0}
                max={100}
                value={weights[comp.id]}
                disabled={!admin}
                onChange={(e) => setWeights({ ...weights, [comp.id]: Number(e.target.value) })}
              />
            ))}
          </div>
          <p className={`small${sum !== 100 ? ' text-danger' : ''}`}>
            Somma: <span className="mono">{sum}</span>
          </p>
        </fieldset>
        <fieldset className="fieldset">
          <legend>Penalità commerciali (punti, gravità alta)</legend>
          <p className="small muted">
            Applicate solo con prove; nello stesso gruppo (stesso ostacolo di fondo) solo la più alta. Gravità media ×
            {c.config.severity.medium}, lieve ×{c.config.severity.low}.
          </p>
          <div className="grid-2">
            {c.penalties.map((p) => (
              <Field
                key={p.id}
                label={p.label}
                type="number"
                min={0}
                max={50}
                value={penalties[p.id] ?? 0}
                disabled={!admin}
                hint={p.rationale}
                onChange={(e) => setPenalties({ ...penalties, [p.id]: Number(e.target.value) })}
              />
            ))}
          </div>
        </fieldset>
        <div>
          <h3 className="sub-title">Fasce</h3>
          <ul className="plain-list small">
            {c.config.bands.map((b) => (
              <li key={b.id}>
                da <span className="mono">{b.min}</span>: {b.label}
              </li>
            ))}
          </ul>
          <p className="small muted">
            Senza prove verificate l’opportunità di miglioramento non supera {c.config.improvementCapWithoutEvidence};
            da {c.config.reviewThreshold} con affidabilità bassa l’azienda va qualificata a mano.
          </p>
        </div>
        {admin ? (
          <div className="stack">
            <Field
              label="Nota sulla modifica (facoltativa)"
              value={note}
              maxLength={300}
              onChange={(e) => setNote(e.target.value)}
            />
            {error && (
              <Notice tone="error">
                <p>{error.message}</p>
                {Object.entries(error.fields).map(([k, v]) => (
                  <p key={k} className="small">
                    {v}
                  </p>
                ))}
              </Notice>
            )}
            <div className="row">
              <Button busy={busy} disabled={sum !== 100} onClick={() => void save()}>
                Salva come nuova versione
              </Button>
              {saved && (
                <span role="status" className="small export__result--ok">
                  Salvata. Le nuove valutazioni useranno questa versione; le esistenti restano finché non le rivaluti.
                </span>
              )}
            </div>
          </div>
        ) : (
          <p className="small muted">Solo gli amministratori possono modificare pesi e penalità.</p>
        )}
      </div>
    </Section>
  );
}

export function AiPage() {
  const item = NAV_ITEMS.find((i) => i.path === '/analisi-ai')!;
  const status = useApi<AiStatus>('/ai/status');
  const config = useApi<AiConfigResponse>('/ai/config');
  return (
    <>
      <PageHeader index={navIndex(item.path)} title={item.label} lede={item.lede} />
      {status.loading && !status.data && <Loading />}
      {status.error && <ErrorNotice error={status.error} onRetry={status.reload} />}
      {status.data && <StatusSection s={status.data} />}
      <CoveragePanel />
      <Jobs />
      {config.error && <ErrorNotice error={config.error} onRetry={config.reload} />}
      {config.data && <ConfigSection key={config.data.version} c={config.data} onSaved={config.reload} />}
    </>
  );
}
