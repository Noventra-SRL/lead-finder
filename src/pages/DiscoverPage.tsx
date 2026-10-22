import { useState, type FormEvent } from 'react';
import { FindTabs } from '../components/FindTabs.tsx';
import { Link } from 'react-router';
import { ApiError, post, type DiscoveryJob, type DiscoveryMeta, type Paged } from '../api/client.ts';
import { Attribution } from '../components/Attribution.tsx';
import { AreaPicker, areaOf, EMPTY_AREA, type AreaValue } from '../components/AreaPicker.tsx';
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
import { areaLabel, COVERAGE_LABEL, isActive, JOB_STATUS, jobStatusText, savedCount } from '../lib/discovery.ts';
import { formatDateTime, formatRelative } from '../lib/format.ts';
import { useApi } from '../lib/useApi.ts';
import { NAV_ITEMS, navIndex } from '../navigation.ts';

const RADII = [1, 2, 5, 10, 20];

function SearchForm({ meta, onCreated }: { meta: DiscoveryMeta; onCreated: (job: DiscoveryJob) => void }) {
  const [area, setArea] = useState<AreaValue>(EMPTY_AREA);
  const [radius, setRadius] = useState('');
  const [categories, setCategories] = useState<string[]>([]);
  const [maxResults, setMaxResults] = useState('200');
  const [minCompleteness, setMinCompleteness] = useState('0');
  const [requireWebsite, setRequireWebsite] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);

  const disabled = !meta.provider.configured;
  const toggle = (id: string) => setCategories((c) => (c.includes(id) ? c.filter((x) => x !== id) : [...c, id]));

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const { job } = await post<{ job: DiscoveryJob }>('/discovery/jobs', {
        area: areaOf(area),
        ...(radius && area.municipality ? { radiusKm: Number(radius) } : {}),
        categories,
        maxResults: Number(maxResults),
        minCompleteness: Number(minCompleteness),
        requireWebsite,
      });
      onCreated(job);
    } catch (err) {
      setError(err instanceof ApiError ? err : new ApiError(0, 'UNKNOWN', 'Ricerca non avviata.'));
    } finally {
      setBusy(false);
    }
  }

  const duplicateOf = error?.code === 'DUPLICATE_JOB' ? (error.data?.jobId as string | undefined) : undefined;

  return (
    <form className="stack search-form" onSubmit={submit} noValidate aria-label="Nuova ricerca">
      {error && (
        <Notice tone="error" title="Ricerca non avviata">
          <p>{error.message}</p>
          {duplicateOf && (
            <p>
              <Link to={`/scoperta/ricerche/${duplicateOf}`}>Apri la ricerca esistente</Link>
            </p>
          )}
        </Notice>
      )}
      <fieldset className="fieldset">
        <legend>Dove</legend>
        <AreaPicker value={area} onChange={setArea} allLabel="Tutta Italia" disabled={disabled} />
        <SelectField
          label="Raggio intorno al comune"
          value={radius}
          onChange={(e) => setRadius(e.target.value)}
          disabled={disabled || !area.municipality}
          hint="Include le attività dei comuni vicini entro questa distanza dal confine del comune scelto."
          error={error?.fields.radiusKm}
        >
          <option value="">Solo il comune</option>
          {RADII.map((r) => (
            <option key={r} value={r}>
              + {r} km
            </option>
          ))}
        </SelectField>
      </fieldset>

      <fieldset className="fieldset">
        <legend>Cosa</legend>
        {error?.fields.categories && <p className="field__error">{error.fields.categories}</p>}
        <div className="checklist">
          {meta.categories.map((c) => (
            <Checkbox
              key={c.id}
              checked={categories.includes(c.id)}
              onChange={() => toggle(c.id)}
              disabled={disabled}
              label={
                <>
                  {c.label} <span className={`coverage coverage--${c.coverage}`}>{COVERAGE_LABEL[c.coverage]}</span>
                </>
              }
              hint={c.note ?? c.description}
            />
          ))}
        </div>
      </fieldset>

      <fieldset className="fieldset">
        <legend>Limiti e completezza</legend>
        <div className="grid-2">
          <Field
            label="Risultati massimi"
            type="number"
            inputMode="numeric"
            min={1}
            max={meta.limits.maxResultsPerJob}
            value={maxResults}
            onChange={(e) => setMaxResults(e.target.value)}
            disabled={disabled}
            hint={`Fino a ${meta.limits.maxResultsPerJob}. La ricerca si ferma al raggiungimento.`}
            error={error?.fields.maxResults}
          />
          <SelectField
            label="Completezza minima"
            value={minCompleteness}
            onChange={(e) => setMinCompleteness(e.target.value)}
            disabled={disabled}
            hint="Quanti dati tra sito, indirizzo, telefono, email e orari deve riportare la fonte."
          >
            <option value="0">Nessun minimo</option>
            {[1, 2, 3, 4, 5].map((n) => (
              <option key={n} value={n}>
                Almeno {n} su 5
              </option>
            ))}
          </SelectField>
        </div>
        <Checkbox
          label="Solo attività con un sito web indicato"
          checked={requireWebsite}
          onChange={(e) => setRequireWebsite(e.target.checked)}
          disabled={disabled}
        />
      </fieldset>

      <div className="row">
        <Button type="submit" busy={busy} disabled={disabled || categories.length === 0}>
          Avvia la ricerca
        </Button>
        <span className="small muted">
          Richieste al server una alla volta, a distanza di {meta.limits.minIntervalSeconds} s.
        </span>
      </div>
    </form>
  );
}

export function JobRow({ job }: { job: DiscoveryJob }) {
  const status = JOB_STATUS[job.status];
  return (
    <li className="job">
      <div className="job__head">
        <Link to={`/scoperta/ricerche/${job.id}`} className="job__title">
          {areaLabel(job)}
        </Link>
        <Status tone={status.tone}>{jobStatusText(job)}</Status>
      </div>
      <p className="small muted">{job.categories.map((c) => c.label).join(', ')}</p>
      {isActive(job.status) && (
        <Progress
          value={job.progress.unitsDone}
          max={job.progress.unitsTotal}
          label={`Avanzamento della ricerca ${areaLabel(job)}`}
        />
      )}
      <p className="small">
        <span className="mono">{savedCount(job)}</span> aziende salvate (
        <span className="mono">{job.counts.inserted}</span> nuove) ·{' '}
        <span className="mono">
          {job.progress.unitsDone}/{job.progress.unitsTotal}
        </span>{' '}
        richieste
        {job.counts.failedRequests > 0 && (
          <>
            {' '}
            · <span className="text-danger">{job.counts.failedRequests} non riuscite</span>
          </>
        )}
      </p>
      <p className="small muted">
        {job.createdBy ?? 'Utente rimosso'} ·{' '}
        <time dateTime={job.createdAt} title={formatDateTime(job.createdAt)}>
          {formatRelative(job.createdAt)}
        </time>
      </p>
    </li>
  );
}

export function DiscoverPage() {
  const item = NAV_ITEMS.find((i) => i.path === '/lead-hunter')!;
  const meta = useApi<DiscoveryMeta>('/discovery/meta');
  const [hasActive, setHasActive] = useState(false);
  const jobs = useApi<Paged<DiscoveryJob>>('/discovery/jobs?pageSize=15', hasActive ? 2000 : false);
  const active = jobs.data?.items.some((j) => isActive(j.status)) ?? false;
  if (active !== hasActive) setHasActive(active);
  const [created, setCreated] = useState<DiscoveryJob | null>(null);

  return (
    <>
      <p className="breadcrumb">
        <Link to="/trova">Trova aziende</Link> / Nuova ricerca
      </p>
      <PageHeader index={navIndex(item.path)} title={item.label} lede={item.lede} />
      <FindTabs current="manual" />

      {meta.data && !meta.data.provider.configured && (
        <Notice tone="error" title="Ricerca non disponibile">
          <p>{meta.data.provider.setupHint}</p>
        </Notice>
      )}
      {meta.data && meta.data.provider.configured && !meta.data.workerActive && (
        <Notice tone="warn" title="Esecuzione delle ricerche disattivata in questo server">
          <p>Le ricerche vengono messe in coda ma eseguite solo da un’istanza con DISCOVERY_WORKER=on.</p>
        </Notice>
      )}

      <Section
        title="Nuova ricerca"
        description={
          meta.data?.provider.configured ? (
            <>
              Fonte: {meta.data.provider.label} su <span className="mono">{meta.data.provider.endpointHost}</span>. Si
              cercano solo attività con un nome; i dati mancanti restano sconosciuti.
            </>
          ) : (
            'Le attività vengono cercate per comune, tramite il codice ISTAT, mai per nome.'
          )
        }
      >
        {meta.loading && !meta.data && <Loading />}
        {meta.error && <ErrorNotice error={meta.error} onRetry={meta.reload} />}
        {meta.data && (
          <SearchForm
            meta={meta.data}
            onCreated={(job) => {
              setCreated(job);
              jobs.reload();
            }}
          />
        )}
        {created && (
          <Notice tone="ok" title="Ricerca avviata">
            <p>
              {areaLabel(created)}: {created.messages.at(-1)?.message}{' '}
              <Link to={`/scoperta/ricerche/${created.id}`}>Segui l’avanzamento</Link>
            </p>
          </Notice>
        )}
      </Section>

      <Section
        title="Ricerche recenti"
        description="Lo stato è quello registrato nel database e si aggiorna da solo mentre una ricerca è attiva."
      >
        {jobs.loading && !jobs.data && <Loading />}
        {jobs.error && <ErrorNotice error={jobs.error} onRetry={jobs.reload} />}
        {jobs.data && jobs.data.items.length === 0 && (
          <Empty title="Nessuna ricerca ancora">
            Avvia la prima ricerca dal modulo qui sopra: le aziende trovate compariranno nell’elenco delle aziende.
          </Empty>
        )}
        {jobs.data && jobs.data.items.length > 0 && (
          <ol className="job-list">
            {jobs.data.items.map((j) => (
              <JobRow key={j.id} job={j} />
            ))}
          </ol>
        )}
        <Attribution geo />
      </Section>
    </>
  );
}
