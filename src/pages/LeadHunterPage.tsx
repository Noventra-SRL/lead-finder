import { useState, type FormEvent } from 'react';
import { CoverageSummary } from '../components/CoveragePanel.tsx';
import { FindTabs } from '../components/FindTabs.tsx';
import { Link, useNavigate } from 'react-router';
import {
  ApiError,
  post,
  type HunterMeta,
  type HuntRun,
  type HuntRunDetail,
  type HuntProgress,
  type Paged,
} from '../api/client.ts';
import { AreaPicker, areaOf, EMPTY_AREA, type AreaValue } from '../components/AreaPicker.tsx';
import { Attribution } from '../components/Attribution.tsx';
import {
  Button,
  Checkbox,
  Empty,
  ErrorNotice,
  Field,
  Loading,
  Notice,
  PageHeader,
  Progress,
  Section,
  SelectField,
  Status,
} from '../components/ui.tsx';
import { COVERAGE_LABEL, isActive, JOB_STATUS } from '../lib/discovery.ts';
import { formatDateTime } from '../lib/format.ts';
import { useApi } from '../lib/useApi.ts';
import { NAV_ITEMS, navIndex } from '../navigation.ts';

/*
 * Lead Hunter: configurazione di una ricerca di lead per obiettivo e ricerche precedenti.
 * L'obiettivo (predefinito 1.000) è un traguardo, non una promessa: i conteggi mostrati sono quelli del database.
 */

export const huntStatusText = (r: HuntRun) =>
  r.status === 'running' && r.cancelRequested
    ? 'Annullamento in corso…'
    : r.status === 'running' && r.pauseRequested
      ? 'Messa in pausa in corso…'
      : r.status === 'paused' && r.pauseReason === 'not_configured'
        ? 'Sospesa: server non configurato'
        : r.status === 'running' && r.phase === 'audit'
          ? 'Verifica dei siti in corso'
          : JOB_STATUS[r.status].label;

function NewHunt({ meta }: { meta: HunterMeta }) {
  const navigate = useNavigate();
  const [target, setTarget] = useState(String(meta.defaults.target));
  const [area, setArea] = useState<AreaValue>(EMPTY_AREA);
  const [sectors, setSectors] = useState<string[]>(() =>
    meta.sectors.filter((s) => s.coverage !== 'limitata').map((s) => s.id),
  );
  const [preference, setPreference] = useState<'any' | 'no_website' | 'website_issues'>('any');
  const [minScore, setMinScore] = useState('');
  const [excludeKnown, setExcludeKnown] = useState(false);
  const [audit, setAudit] = useState(true);
  const [publicEmail, setPublicEmail] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const groups = Object.entries(meta.groups);
  const toggle = (ids: string[], on: boolean) =>
    setSectors((cur) => (on ? [...new Set([...cur, ...ids])] : cur.filter((x) => !ids.includes(x))));

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await post<HuntRunDetail>('/hunter/runs', {
        target: Number(target),
        area: areaOf(area),
        sectors,
        options: {
          websitePreference: preference,
          minScore: minScore ? Number(minScore) : null,
          excludeKnown,
          audit: audit || publicEmail,
          publicEmail,
        },
      });
      void navigate(`/lead-hunter/${r.run.id}`);
    } catch (err) {
      setError(err instanceof ApiError ? err : new ApiError(0, 'UNKNOWN', 'Avvio non riuscito.'));
      setBusy(false);
    }
  }

  return (
    <form className="stack" aria-label="Nuova ricerca di lead" onSubmit={(e) => void submit(e)}>
      <fieldset className="fieldset">
        <legend>Obiettivo e area</legend>
        <div className="grid-2">
          <Field
            label="Aziende da trovare"
            type="number"
            min={1}
            max={meta.limits.maxTarget}
            value={target}
            onChange={(e) => setTarget(e.target.value)}
            error={error?.fields.target}
            hint="Traguardo, non garanzia: se le fonti non contengono abbastanza aziende, la ricerca lo dichiara."
          />
        </div>
        <AreaPicker value={area} onChange={setArea} allLabel="Tutta Italia" />
        <p className="small muted">
          Le province vengono cercate a turno tra le regioni, per non concentrare i risultati in poche città.
        </p>
      </fieldset>

      <fieldset className="fieldset">
        <legend>Settori</legend>
        <p className="small">
          <span className="mono">{sectors.length}</span> di <span className="mono">{meta.sectors.length}</span> settori
          selezionati. Ogni settore ha un limite per comune: nessun settore facile da trovare prevale sugli altri.{' '}
          <button type="button" className="link-button" onClick={() => setSectors([])}>
            Deseleziona tutti
          </button>
        </p>
        {(error?.fields.sectors || error?.code === 'UNKNOWN_SECTOR') && (
          <p className="field__error">{error.fields.sectors ?? error.message}</p>
        )}
        {groups.map(([group, label]) => {
          const list = meta.sectors.filter((s) => s.group === group);
          const all = list.every((s) => sectors.includes(s.id));
          return (
            <div key={group} className="sector-group">
              <div className="sector-group__head">
                <h3 className="sub-title">{label}</h3>
                <button
                  type="button"
                  className="link-button small"
                  onClick={() =>
                    toggle(
                      list.map((s) => s.id),
                      !all,
                    )
                  }
                >
                  {all ? 'Deseleziona il gruppo' : 'Seleziona il gruppo'}
                </button>
              </div>
              <div className="checklist">
                {list.map((s) => (
                  <Checkbox
                    key={s.id}
                    checked={sectors.includes(s.id)}
                    onChange={(e) => toggle([s.id], e.target.checked)}
                    label={
                      <>
                        {s.label}{' '}
                        <span className={`coverage coverage--${s.coverage}`}>{COVERAGE_LABEL[s.coverage]}</span>
                      </>
                    }
                    hint={s.note ?? undefined}
                  />
                ))}
              </div>
            </div>
          );
        })}
      </fieldset>

      <fieldset className="fieldset">
        <legend>Criteri</legend>
        <div className="grid-2">
          <SelectField
            label="Aziende di interesse"
            value={preference}
            onChange={(e) => setPreference(e.target.value as typeof preference)}
            hint="Senza sito: la fonte non ne indica uno (assenza non verificata). Con problemi: rilievi gravi documentati dall’audit."
          >
            <option value="any">Tutte</option>
            <option value="no_website">Solo senza sito proprio indicato</option>
            <option value="website_issues">Solo con problemi del sito documentati</option>
          </SelectField>
          <SelectField
            label="Punteggio minimo del lead"
            value={minScore}
            onChange={(e) => setMinScore(e.target.value)}
            hint="Conta verso l’obiettivo solo dopo il calcolo del punteggio."
          >
            <option value="">Nessuno</option>
            {[40, 60, 80].map((n) => (
              <option key={n} value={n}>
                Almeno {n}
              </option>
            ))}
          </SelectField>
        </div>
        <Checkbox
          label="Solo aziende nuove (escludi quelle già nel database)"
          checked={excludeKnown}
          onChange={(e) => setExcludeKnown(e.target.checked)}
        />
        <Checkbox
          label="Solo aziende con un’email pubblica"
          checked={publicEmail}
          onChange={(e) => {
            setPublicEmail(e.target.checked);
            if (e.target.checked && preference === 'no_website') setPreference('any');
          }}
          hint="L’obiettivo conta solo le aziende con un’email indicata dalla fonte o scritta sul loro sito, con la pagina di provenienza. Si cercano solo attività con un sito o un’email; i siti vengono controllati per trovare gli indirizzi. Trovare un’email non autorizza l’invio di comunicazioni commerciali."
        />
        <Checkbox
          label="Verifica automatica dei siti trovati"
          checked={audit || publicEmail}
          disabled={publicEmail}
          onChange={(e) => setAudit(e.target.checked)}
          hint={
            publicEmail
              ? 'Necessaria per trovare le email pubblicate sui siti.'
              : 'Audit della Fase 3, un gruppo di siti alla volta, nel rispetto dei limiti verso ogni sito.'
          }
        />
      </fieldset>

      {error && !error.fields.sectors && !error.fields.target && (
        <Notice tone={error.code === 'HUNT_ACTIVE' ? 'warn' : 'error'}>
          <p>
            {error.message}
            {typeof error.data?.jobId === 'string' && (
              <>
                {' '}
                <Link to={`/lead-hunter/${error.data.jobId}`}>Apri la ricerca attiva</Link>.
              </>
            )}
          </p>
        </Notice>
      )}
      <div>
        <Button type="submit" busy={busy} disabled={!meta.provider.configured || sectors.length === 0}>
          Avvia la ricerca di lead
        </Button>
      </div>
    </form>
  );
}

export function HuntSummary({ p, target }: { p: HuntProgress; target: number }) {
  return (
    <p className="small">
      <span className="mono">{p.qualified}</span> di <span className="mono">{target}</span> aziende che soddisfano i
      criteri · <span className="mono">{p.linked}</span> raccolte (<span className="mono">{p.linkedNew}</span> nuove) ·{' '}
      <span className="mono">{p.websites.missing}</span> senza sito indicato ·{' '}
      <span className="mono">{p.audits.completed}</span> siti verificati · <span className="mono">{p.scored}</span> con
      punteggio
    </p>
  );
}

export function LeadHunterPage() {
  const item = NAV_ITEMS.find((i) => i.path === '/lead-hunter')!;
  const meta = useApi<HunterMeta>('/hunter/meta');
  const [poll, setPoll] = useState(false);
  const runs = useApi<Paged<HuntRun & { progress: HuntProgress }>>('/hunter/runs?pageSize=10', poll ? 4000 : false);
  const active = Boolean(runs.data?.items.some((r) => isActive(r.status)));
  if (active !== poll) setPoll(active);

  return (
    <>
      <p className="breadcrumb">
        <Link to="/trova">Trova aziende</Link> / Nuova ricerca
      </p>
      <PageHeader index={navIndex(item.path)} title={item.label} lede={item.lede} />
      <FindTabs current="goal" />
      <CoverageSummary />
      {meta.data && !meta.data.provider.configured && (
        <Notice tone="warn" title="Ricerca non disponibile">
          <p>Nessun server OpenStreetMap configurato (DISCOVERY_OVERPASS_URL).</p>
        </Notice>
      )}
      {meta.data && meta.data.provider.configured && !meta.data.workerActive && (
        <Notice tone="warn" title="Coordinatore delle ricerche disattivato">
          <p>Le ricerche restano in coda finché il server non viene avviato con HUNTER_WORKER=on.</p>
        </Notice>
      )}
      <Section
        title="Ricerche di lead"
        description="Stato letto dal database; si aggiorna da solo mentre una ricerca è attiva."
      >
        {runs.loading && !runs.data && <Loading />}
        {runs.error && <ErrorNotice error={runs.error} onRetry={runs.reload} />}
        {runs.data && runs.data.total === 0 && (
          <Empty title="Nessuna ricerca di lead ancora">Configura la prima qui sotto: obiettivo, area e settori.</Empty>
        )}
        {runs.data && runs.data.total > 0 && (
          <ol className="job-list">
            {runs.data.items.map((r) => (
              <li key={r.id} className="job">
                <div className="job__head">
                  <Link to={`/lead-hunter/${r.id}`} className="job__title">
                    {r.target} aziende · {r.area.name}
                  </Link>
                  <Status tone={JOB_STATUS[r.status].tone}>{huntStatusText(r)}</Status>
                </div>
                {isActive(r.status) && (
                  <Progress
                    value={Math.min(r.progress.qualified, r.target)}
                    max={r.target}
                    label={`Avanzamento: ${r.area.name}`}
                  />
                )}
                <HuntSummary p={r.progress} target={r.target} />
                <p className="small muted">
                  {r.sectors.length} {r.sectors.length === 1 ? 'settore' : 'settori'} · {formatDateTime(r.createdAt)}
                  {r.createdBy && ` · ${r.createdBy}`}
                </p>
              </li>
            ))}
          </ol>
        )}
      </Section>
      <Section
        title="Nuova ricerca di lead"
        description="Scoperta da OpenStreetMap, verifica dei siti, punteggio e servizi consigliati: i passaggi esistenti, coordinati verso un obiettivo."
      >
        {meta.loading && !meta.data && <Loading />}
        {meta.error && <ErrorNotice error={meta.error} onRetry={meta.reload} />}
        {meta.data && <NewHunt meta={meta.data} />}
        <Attribution />
      </Section>
    </>
  );
}
