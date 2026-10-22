import { useState, type FormEvent } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import {
  ApiError,
  post,
  type AiConfigResponse,
  type AiEstimate,
  type AiJobDetail,
  type BulkAddResult,
  type BusinessSummary,
  type DiscoveryMeta,
  type HunterMeta,
  type Paged,
  type ServiceList,
} from '../api/client.ts';
import { StartAudit } from '../components/AuditControls.tsx';
import { Attribution } from '../components/Attribution.tsx';
import { AreaPicker } from '../components/AreaPicker.tsx';
import { ExportButton } from '../components/ExportButton.tsx';
import { SavedFilters } from '../components/SavedFilters.tsx';
import { ScoreSelected } from '../components/ScoreControls.tsx';
import {
  Button,
  Checkbox,
  ConfirmDialog,
  Empty,
  ErrorNotice,
  Field,
  Loading,
  PageHeader,
  Pagination,
  SelectField,
  Status,
} from '../components/ui.tsx';
import { WEBSITE_STATUS } from '../lib/audit.ts';
import { EXCLUSION_LABEL, formatUsd, LEVEL_LABEL, sourceLabel } from '../lib/ai.ts';
import { STAGE_LABEL } from '../lib/crm.ts';
import { placeLabel } from '../lib/discovery.ts';
import { formatRelative } from '../lib/format.ts';
import { CONFIDENCE_LABEL, leadHeadline, PRIORITY_FILTERS } from '../lib/scoring.ts';
import { MATCH_STATUS, MATCH_STATUS_FILTERS } from '../lib/services.ts';
import { useApi } from '../lib/useApi.ts';
import { NAV_ITEMS, navIndex } from '../navigation.ts';

const FILTER_KEYS = [
  'q',
  'region',
  'province',
  'municipality',
  'category',
  'website',
  'minCompleteness',
  'review',
  'job',
  'audit',
  'priority',
  'minScore',
  'confidence',
  'service',
  'minMatch',
  'matchStatus',
  'hunt',
  'sector',
  'excluded',
  'contact',
  'maxPerSector',
  'maxPerRegion',
  'crm',
  'minCommercial',
  'maxCommercial',
  'aiStatus',
  'aiConfidence',
  'minAcquisition',
  'minServiceFit',
] as const;

const COLUMNS: { key: string; label: string; sort?: string }[] = [
  { key: 'name', label: 'Azienda', sort: 'name' },
  { key: 'place', label: 'Comune', sort: 'municipality' },
  { key: 'audit', label: 'Sito web e audit', sort: 'audited' },
  { key: 'commercial', label: 'Valutazione commerciale', sort: 'commercial' },
  { key: 'score', label: 'Punteggio a regole', sort: 'score' },
  { key: 'service', label: 'Servizio consigliato', sort: 'match' },
  { key: 'next', label: 'Prossimo passo' },
];

const SORT_OPTIONS = [
  { value: 'verified', label: 'Ultima conferma della fonte' },
  { value: 'commercial', label: 'Punteggio commerciale (AI o regole)' },
  { value: 'acquisition', label: 'Probabilità stimata di acquisizione (AI)' },
  { value: 'serviceFit', label: 'Compatibilità con i servizi (AI)' },
  { value: 'score', label: 'Punteggio a regole' },
  { value: 'confidence', label: 'Affidabilità delle prove' },
  { value: 'match', label: 'Corrispondenza del servizio' },
  { value: 'audited', label: 'Data dell’ultimo audit' },
  { value: 'name', label: 'Nome' },
  { value: 'municipality', label: 'Comune' },
  { value: 'category', label: 'Categoria' },
  { value: 'completeness', label: 'Completezza dei dati' },
  { value: 'discovered', label: 'Data di acquisizione' },
];
const ASC_SORTS = new Set(['name', 'municipality', 'category']);

function SortHeader({
  col,
  sort,
  dir,
  onSort,
}: {
  col: (typeof COLUMNS)[number];
  sort: string;
  dir: string;
  onSort: (s: string) => void;
}) {
  if (!col.sort) return <th scope="col">{col.label}</th>;
  const active = sort === col.sort;
  return (
    <th scope="col" aria-sort={active ? (dir === 'asc' ? 'ascending' : 'descending') : 'none'}>
      <button type="button" className="sort" onClick={() => onSort(col.sort!)}>
        {col.label}
        <span aria-hidden="true" className="sort__mark">
          {active ? (dir === 'asc' ? '↑' : '↓') : '↕'}
        </span>
      </button>
    </th>
  );
}

function Website({ b }: { b: BusinessSummary }) {
  const status = WEBSITE_STATUS[b.audit.websiteStatus];
  if (!b.website) return <span className="muted small">Non indicato dalla fonte</span>;
  return (
    <span className="stack stack--tight">
      <a href={b.website.url} target="_blank" rel="noopener noreferrer nofollow" className="mono small">
        {b.website.domain}
      </a>
      {b.website.shared ? (
        <span className="muted small">Pagina su piattaforma, non un sito proprio</span>
      ) : (
        <span>
          <Status tone={status.tone}>{status.label}</Status>
          {b.audit.runStatus === 'partial' && <span className="small muted"> · audit parziale</span>}
        </span>
      )}
    </span>
  );
}

function PrimaryService({ b, filtered }: { b: BusinessSummary; filtered: string | null }) {
  const p = b.services?.primary;
  if (!p) {
    // con un servizio filtrato la corrispondenza mostrata è quella del servizio, anche se non è il primo della lista
    if (filtered && b.services?.matchScore !== null && b.services?.matchScore !== undefined)
      return <span className="small">Corrispondenza {b.services.matchScore}/100</span>;
    return <span className="muted small">—</span>;
  }
  return (
    <span className="stack stack--tight">
      <span className="small">
        <strong>{p.name}</strong>
        {p.others > 0 && <span className="muted"> +{p.others}</span>}
      </span>
      <span className="small">
        <span className="mono">{p.score}</span>/100 ·{' '}
        <Status tone={MATCH_STATUS[p.status].tone}>{MATCH_STATUS[p.status].label}</Status>
      </span>
      {filtered && filtered !== p.serviceId && b.services?.matchScore !== null && (
        <span className="small muted">servizio filtrato: {b.services?.matchScore}/100</span>
      )}
    </span>
  );
}

function Audit({ b }: { b: BusinessSummary }) {
  const a = b.audit;
  if (!a.lastAuditId) return null;
  return (
    <span className="small lead-audit">
      <Link to={`/audit/esiti/${a.lastAuditId}`}>
        <span className="mono">{a.actionableFindings ?? 0}</span> rilievi utili
      </Link>
      {a.lastAuditAt && (
        <span className="muted">
          {' '}
          · <time dateTime={a.lastAuditAt}>{formatRelative(a.lastAuditAt)}</time>
        </span>
      )}
    </span>
  );
}

/** Recapiti pubblici indicati dalla fonte: telefono ed email generica. Un'email personale non viene salvata. */
function Contacts({ b }: { b: BusinessSummary }) {
  const { phone, email } = b.contacts;
  if (!phone && !email) return null;
  return (
    <span className="small lead-contacts">
      {phone && (
        <a href={`tel:${phone.replace(/\s/g, '')}`} className="mono">
          {phone}
        </a>
      )}
      {email && <a href={`mailto:${email}`}>{email}</a>}
    </span>
  );
}

/** Punteggio commerciale con la sua fonte: valutazione AI oppure punteggio a regole come riserva. */
function Commercial({ b }: { b: BusinessSummary }) {
  const c = b.commercial;
  const state = b.assessment;
  // stato della valutazione, distinto da punteggio e affidabilità
  const stateNote =
    state && !['assessed', 'incomplete', 'excluded'].includes(state.state) ? state.label.toLowerCase() : null;
  if (!c) return <span className="muted small">{state?.label ?? 'Non ancora valutata'}</span>;
  return (
    <span className="lead-cell">
      <span className="lead-cell__value mono">{c.exclusion ? '—' : c.score}</span>
      <span className="stack stack--tight small">
        <span>{c.exclusion ? EXCLUSION_LABEL[c.exclusion] : c.band?.label}</span>
        <span className="muted">
          {sourceLabel(c)}
          {c.source === 'ai' && ` · affidabilità ${LEVEL_LABEL[c.confidence]}`}
          {c.needsReview && ' · da qualificare'}
          {stateNote ? ` · ${stateNote}` : c.outdated && ' · da aggiornare'}
        </span>
      </span>
    </span>
  );
}

/**
 * Valutazione AI delle aziende selezionate: prima la stima (quante da valutare, quante riusate, costo stimato),
 * poi la conferma esplicita. Il lotto gira in background e si segue dalla pagina Analisi AI.
 */
function AiBatch({ businessIds }: { businessIds: string[] }) {
  const navigate = useNavigate();
  const [est, setEst] = useState<AiEstimate | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const estimate = async () => {
    setBusy(true);
    setError(null);
    try {
      setEst(await post<AiEstimate>('/ai/estimate', { businessIds }));
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Stima non riuscita.');
    } finally {
      setBusy(false);
    }
  };
  const confirm = async () => {
    setBusy(true);
    try {
      const r = await post<AiJobDetail>('/ai/jobs', { businessIds });
      void navigate(`/analisi-ai/lotti/${r.job.id}`);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Avvio non riuscito.');
      setEst(null);
      setBusy(false);
    }
  };
  return (
    <span className="export">
      <Button
        variant="secondary"
        busy={busy && !est}
        disabled={businessIds.length === 0}
        onClick={() => void estimate()}
      >
        Valuta con AI
      </Button>
      {error && (
        <span role="status" className="small export__result--error">
          {error}
        </span>
      )}
      <ConfirmDialog
        open={est !== null}
        title="Valutare le aziende selezionate con l’AI?"
        confirmLabel={est?.toAssess ? `Valuta ${est.toAssess}` : 'Aggiorna lo stato'}
        busy={busy}
        confirmDisabled={!est?.configured}
        onConfirm={() => void confirm()}
        onCancel={() => setEst(null)}
      >
        {est && (
          <div className="stack">
            {!est.configured && <p>La valutazione AI non è configurata sul server (AI_API_KEY).</p>}
            <p>
              <strong>{est.toAssess}</strong> da valutare, <strong>{est.cached}</strong> già valutate con le stesse
              prove (riusate senza costo){est.missing ? `, ${est.missing} non trovate` : ''}.
            </p>
            <p>
              Costo stimato: <strong>{formatUsd(est.estimatedCostUsd)}</strong> ({est.basis}). È una stima: il costo
              reale dipende dai token usati e compare a lavoro finito.
            </p>
          </div>
        )}
      </ConfirmDialog>
    </span>
  );
}

function Score({ b }: { b: BusinessSummary }) {
  const h = leadHeadline(b.lead);
  return (
    <span className="lead-cell">
      <span className="lead-cell__value mono">{h.value}</span>
      <span className="stack stack--tight">
        <Status tone={h.tone}>{h.label}</Status>
        {b.lead && (
          <span className="small muted">
            affidabilità {CONFIDENCE_LABEL[b.lead.confidence.level]}
            {b.lead.outdated && ' · da aggiornare'}
          </span>
        )}
      </span>
    </span>
  );
}

/**
 * Aggiunta in blocco al CRM delle aziende selezionate (Fase 7): solo su richiesta esplicita, con il riepilogo
 * di quante sono state aggiunte, saltate (già nel CRM o escluse) o non riuscite.
 */
function AddToCrm({ businessIds, onDone }: { businessIds: string[]; onDone: () => void }) {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ tone: 'ok' | 'warn' | 'error'; text: string } | null>(null);
  async function run() {
    setBusy(true);
    setResult(null);
    try {
      const r = await post<BulkAddResult>('/crm/opportunities/bulk', { businessIds });
      const parts = [`${r.created.length} aggiunte al CRM`];
      const already = r.skipped.filter((s) => s.reason === 'OPPORTUNITY_EXISTS').length;
      const excluded = r.skipped.filter((s) => s.reason === 'BUSINESS_EXCLUDED').length;
      const other = r.skipped.length - already - excluded;
      if (already) parts.push(`${already} già con un’opportunità aperta`);
      if (excluded) parts.push(`${excluded} escluse dalla prospezione`);
      if (other) parts.push(`${other} saltate`);
      if (r.failed.length) parts.push(`${r.failed.length} non riuscite`);
      setResult({ tone: r.failed.length ? 'warn' : 'ok', text: `${parts.join(', ')}.` });
      onDone();
    } catch (e) {
      setResult({ tone: 'error', text: e instanceof ApiError ? e.message : 'Aggiunta non riuscita.' });
    } finally {
      setBusy(false);
    }
  }
  return (
    <span className="export">
      <Button variant="secondary" busy={busy} disabled={businessIds.length === 0} onClick={() => void run()}>
        Aggiungi al CRM
      </Button>
      {result && (
        <span role="status" className={`small export__result--${result.tone}`}>
          {result.text}
        </span>
      )}
    </span>
  );
}

export function LeadsPage() {
  const item = NAV_ITEMS.find((i) => i.path === '/aziende')!;
  const [params, setParams] = useSearchParams();
  const meta = useApi<DiscoveryMeta>('/discovery/meta');
  const services = useApi<ServiceList>('/services');
  const hunter = useApi<HunterMeta>('/hunter/meta');
  const aiConfig = useApi<AiConfigResponse>('/ai/config');
  const [q, setQ] = useState(params.get('q') ?? '');
  const [selected, setSelected] = useState<Set<string>>(() => new Set());

  const sort = params.get('sort') ?? 'verified';
  const dir = params.get('dir') ?? (ASC_SORTS.has(sort) ? 'asc' : 'desc');
  const page = Number(params.get('page') ?? 1);
  const pageSize = Number(params.get('pageSize') ?? 25);

  const query = new URLSearchParams();
  for (const k of FILTER_KEYS) if (params.get(k)) query.set(k, params.get(k)!);
  query.set('sort', sort);
  query.set('dir', dir);
  query.set('page', String(page));
  query.set('pageSize', String(pageSize));
  const list = useApi<Paged<BusinessSummary>>(`/businesses?${query}`);
  // l'esportazione usa gli stessi filtri e lo stesso ordinamento dell'elenco, senza la paginazione
  const exportQuery = new URLSearchParams(query);
  exportQuery.delete('page');
  exportQuery.delete('pageSize');
  const pending = useApi<Paged<unknown>>('/duplicates?pageSize=1');

  /** Cambia filtri o ordinamento: si torna alla prima pagina, salvo cambio di pagina esplicito. */
  const update = (changes: Record<string, string | null>, keepPage = false) => {
    const next = new URLSearchParams(params);
    for (const [k, v] of Object.entries(changes)) {
      if (v) next.set(k, v);
      else next.delete(k);
    }
    if (!keepPage) next.delete('page');
    setParams(next);
  };
  const onSort = (s: string) => {
    const defaultDir = ASC_SORTS.has(s) ? 'asc' : 'desc';
    update({ sort: s, dir: sort === s ? (dir === 'asc' ? 'desc' : 'asc') : defaultDir });
  };
  const filtered = FILTER_KEYS.some((k) => params.get(k));

  return (
    <>
      <PageHeader index={navIndex(item.path)} title={item.label} lede={item.lede} />

      <nav className="tabs" aria-label="Viste del database">
        <Link to="/aziende" aria-current="page" className="tabs__item">
          Aziende
        </Link>
        <Link to="/aziende/duplicati" className="tabs__item">
          Possibili duplicati {pending.data && <span className="mono muted">{pending.data.total}</span>}
        </Link>
      </nav>

      <SavedFilters scope="businesses" query={params.toString()} basePath="/aziende" />

      <section className="filters" aria-label="Filtri">
        <form
          className="filters__search"
          role="search"
          onSubmit={(e: FormEvent) => {
            e.preventDefault();
            update({ q: q.trim() || null });
          }}
        >
          <Field
            label="Cerca per nome, dominio o comune"
            type="search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            maxLength={100}
          />
          <Button type="submit" variant="secondary">
            Cerca
          </Button>
        </form>
        <AreaPicker
          value={{
            region: params.get('region') ?? '',
            province: params.get('province') ?? '',
            municipality: params.get('municipality') ?? '',
          }}
          onChange={(v) =>
            update({ region: v.region || null, province: v.province || null, municipality: v.municipality || null })
          }
          allLabel="Tutte le regioni"
        />
        <div className="filters__row">
          <SelectField
            label="Priorità"
            value={params.get('priority') ?? ''}
            onChange={(e) => update({ priority: e.target.value || null })}
          >
            {PRIORITY_FILTERS.map((p) => (
              <option key={p.value} value={p.value}>
                {p.label}
              </option>
            ))}
          </SelectField>
          <SelectField
            label="Punteggio minimo"
            value={params.get('minScore') ?? ''}
            onChange={(e) => update({ minScore: e.target.value || null })}
          >
            <option value="">Nessuno</option>
            {[40, 50, 60, 70, 80, 90].map((n) => (
              <option key={n} value={n}>
                Almeno {n}
              </option>
            ))}
          </SelectField>
          <SelectField
            label="Affidabilità delle prove"
            value={params.get('confidence') ?? ''}
            onChange={(e) => update({ confidence: e.target.value || null })}
          >
            <option value="">Qualsiasi</option>
            <option value="high">Alta</option>
            <option value="high,medium">Alta o media</option>
            <option value="low">Bassa</option>
          </SelectField>
          <SelectField
            label="Categoria"
            value={params.get('category') ?? ''}
            onChange={(e) => update({ category: e.target.value || null })}
          >
            <option value="">Tutte</option>
            {meta.data?.categories.map((c) => (
              <option key={c.id} value={c.id}>
                {c.label}
              </option>
            ))}
          </SelectField>
        </div>
        <div className="filters__row">
          <SelectField
            label="Servizio consigliato"
            value={params.get('service') ?? ''}
            onChange={(e) => update({ service: e.target.value || null })}
          >
            <option value="">Qualsiasi</option>
            {services.data?.services
              .filter((s) => s.active && s.autoMatch)
              .map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
          </SelectField>
          <SelectField
            label="Corrispondenza minima"
            value={params.get('minMatch') ?? ''}
            onChange={(e) => update({ minMatch: e.target.value || null })}
          >
            <option value="">Nessuna</option>
            {[40, 50, 60, 70, 80].map((n) => (
              <option key={n} value={n}>
                Almeno {n}
              </option>
            ))}
          </SelectField>
          <SelectField
            label="Stato dell’abbinamento"
            value={params.get('matchStatus') ?? ''}
            onChange={(e) => update({ matchStatus: e.target.value || null })}
          >
            {MATCH_STATUS_FILTERS.map((s) => (
              <option key={s.value} value={s.value}>
                {s.label}
              </option>
            ))}
          </SelectField>
        </div>
        <div className="filters__row">
          <SelectField
            label="Sito web"
            value={params.get('website') ?? ''}
            onChange={(e) => update({ website: e.target.value || null })}
          >
            <option value="">Indifferente</option>
            <option value="own">Con un sito proprio</option>
            <option value="yes">Con un indirizzo web qualsiasi</option>
            <option value="no">Senza sito indicato</option>
          </SelectField>
          <SelectField
            label="Audit del sito"
            value={params.get('audit') ?? ''}
            onChange={(e) => update({ audit: e.target.value || null })}
          >
            <option value="">Indifferente</option>
            <option value="unaudited">Sito proprio non ancora verificato</option>
            <option value="audited">Verificato</option>
            <option value="problems">Verificato, con problemi gravi</option>
            <option value="unavailable">Irraggiungibile, bloccato o non valido</option>
            <option value="failed">Verifica non riuscita</option>
            <option value="no_website">Nessun sito proprio</option>
          </SelectField>
          <SelectField
            label="Completezza"
            value={params.get('minCompleteness') ?? ''}
            onChange={(e) => update({ minCompleteness: e.target.value || null })}
          >
            <option value="">Qualsiasi</option>
            {[1, 2, 3, 4, 5].map((n) => (
              <option key={n} value={n}>
                Almeno {n} su 5
              </option>
            ))}
          </SelectField>
          <SelectField
            label="Ordina per"
            value={sort}
            onChange={(e) => update({ sort: e.target.value, dir: ASC_SORTS.has(e.target.value) ? 'asc' : 'desc' })}
          >
            {SORT_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </SelectField>
          <Checkbox
            label="Solo da verificare (possibili duplicati)"
            checked={params.get('review') === '1'}
            onChange={(e) => update({ review: e.target.checked ? '1' : null })}
          />
        </div>
        <div className="filters__row">
          <SelectField
            label="Settore"
            value={params.get('sector') ?? ''}
            onChange={(e) => update({ sector: e.target.value || null })}
          >
            <option value="">Tutti</option>
            {hunter.data &&
              Object.entries(hunter.data.groups).map(([group, label]) => (
                <optgroup key={group} label={label}>
                  {hunter
                    .data!.sectors.filter((s) => s.group === group)
                    .map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.label}
                      </option>
                    ))}
                </optgroup>
              ))}
          </SelectField>
          <SelectField
            label="Recapiti pubblici"
            value={params.get('contact') ?? ''}
            onChange={(e) => update({ contact: e.target.value || null })}
          >
            <option value="">Indifferente</option>
            <option value="phone">Con telefono</option>
            <option value="any">Con telefono o email generica</option>
          </SelectField>
          <SelectField
            label="Varietà dei risultati"
            value={params.get('maxPerSector') ?? ''}
            onChange={(e) => update({ maxPerSector: e.target.value || null })}
            hint="Limita le aziende per settore senza cambiare i punteggi."
          >
            <option value="">Nessun limite</option>
            {[3, 5, 10, 25].map((n) => (
              <option key={n} value={n}>
                Al massimo {n} per settore
              </option>
            ))}
          </SelectField>
          <SelectField
            label="Escluse dalla prospezione"
            value={params.get('excluded') ?? ''}
            onChange={(e) => update({ excluded: e.target.value || null })}
          >
            <option value="">Nascoste</option>
            <option value="include">Mostrate insieme alle altre</option>
            <option value="only">Solo le escluse</option>
          </SelectField>
          <SelectField
            label="CRM"
            value={params.get('crm') ?? ''}
            onChange={(e) => update({ crm: e.target.value || null })}
          >
            <option value="">Indifferente</option>
            <option value="none">Non ancora nel CRM</option>
            <option value="open">Con un’opportunità aperta</option>
          </SelectField>
        </div>
        <div className="filters__row">
          <SelectField
            label="Fascia commerciale"
            value={
              params.get('minCommercial') ? `${params.get('minCommercial')}-${params.get('maxCommercial') ?? 100}` : ''
            }
            onChange={(e) => {
              const [min, max] = e.target.value ? e.target.value.split('-') : [null, null];
              update({ minCommercial: min ?? null, maxCommercial: max === '100' ? null : (max ?? null) });
            }}
            hint="Valutazione AI, altrimenti punteggio a regole."
          >
            <option value="">Tutte</option>
            {aiConfig.data?.config.bands.map((band, i, all) => {
              const max = i === 0 ? 100 : all[i - 1]!.min - 1;
              return (
                <option key={band.id} value={`${band.min}-${max}`}>
                  {band.min}–{max}: {band.label}
                </option>
              );
            })}
          </SelectField>
          <SelectField
            label="Valutazione AI"
            value={params.get('aiStatus') ?? ''}
            onChange={(e) => update({ aiStatus: e.target.value || null })}
          >
            <option value="">Indifferente</option>
            <option value="assessed">Valutate</option>
            <option value="state_assessed">Valutate e aggiornate</option>
            <option value="state_incomplete">Valutazione incompleta</option>
            <option value="state_pending">Da valutare</option>
            <option value="state_outdated">Da aggiornare (dati cambiati)</option>
            <option value="state_running">In valutazione</option>
            <option value="state_failed">Errore di valutazione</option>
            <option value="needs_review">Da qualificare a mano</option>
            <option value="excluded">Escluse (cessate o non contattare)</option>
          </SelectField>
          <SelectField
            label="Affidabilità AI"
            value={params.get('aiConfidence') ?? ''}
            onChange={(e) => update({ aiConfidence: e.target.value || null })}
          >
            <option value="">Qualsiasi</option>
            <option value="high">Alta</option>
            <option value="high,medium">Alta o media</option>
            <option value="low">Bassa</option>
          </SelectField>
          <SelectField
            label="Acquisizione stimata (AI)"
            value={params.get('minAcquisition') ?? ''}
            onChange={(e) => update({ minAcquisition: e.target.value || null })}
          >
            <option value="">Qualsiasi</option>
            {[50, 60, 70, 80].map((n) => (
              <option key={n} value={n}>
                Almeno {n}
              </option>
            ))}
          </SelectField>
          <SelectField
            label="Compatibilità servizi (AI)"
            value={params.get('minServiceFit') ?? ''}
            onChange={(e) => update({ minServiceFit: e.target.value || null })}
          >
            <option value="">Qualsiasi</option>
            {[50, 60, 70, 80].map((n) => (
              <option key={n} value={n}>
                Almeno {n}
              </option>
            ))}
          </SelectField>
        </div>
        {params.get('hunt') && (
          <p className="small">
            Solo le aziende della <Link to={`/lead-hunter/${params.get('hunt')}`}>ricerca di lead selezionata</Link>.{' '}
            <button type="button" className="link-button" onClick={() => update({ hunt: null })}>
              Mostra tutte
            </button>
          </p>
        )}
        {params.get('job') && (
          <p className="small">
            Solo le aziende della <Link to={`/scoperta/ricerche/${params.get('job')}`}>ricerca selezionata</Link>.{' '}
            <button type="button" className="link-button" onClick={() => update({ job: null })}>
              Mostra tutte
            </button>
          </p>
        )}
        {filtered && (
          <p>
            <button type="button" className="link-button" onClick={() => setParams(new URLSearchParams())}>
              Azzera i filtri
            </button>
          </p>
        )}
      </section>

      <p className="small muted">
        Il punteggio indica quanto un’azienda sembra adatta ai servizi di Noventra in base alle prove raccolte: è un
        criterio di priorità, non una probabilità di acquisto.
      </p>

      {list.loading && !list.data && <Loading />}
      {list.error && <ErrorNotice error={list.error} onRetry={list.reload} />}
      {list.data &&
        list.data.total === 0 &&
        (filtered ? (
          <Empty title="Nessuna azienda con questi filtri">
            Prova ad allargare l’area o a togliere qualche filtro.
          </Empty>
        ) : (
          <Empty title="Il database è vuoto">
            Le aziende arrivano dalle ricerche: <Link to="/scoperta">avvia una ricerca</Link> su un comune o una
            provincia.
          </Empty>
        ))}
      {list.data && list.data.total > 0 && (
        <>
          <div className="selection" aria-live="polite">
            <span className="small">
              <span className="mono">{selected.size}</span> {selected.size === 1 ? 'selezionata' : 'selezionate'}
            </span>
            <StartAudit
              businessIds={[...selected]}
              label="Avvia audit dei selezionati"
              variant="secondary"
              disabled={selected.size === 0}
            />
            <ScoreSelected businessIds={[...selected]} onDone={list.reload} />
            <AiBatch businessIds={[...selected]} />
            <AddToCrm
              businessIds={[...selected]}
              onDone={() => {
                setSelected(new Set());
                list.reload();
              }}
            />
            {selected.size > 0 && (
              <ExportButton ids={[...selected]} name="aziende_selezionate" label="Esporta i selezionati" />
            )}
            {selected.size > 0 && (
              <button type="button" className="link-button small" onClick={() => setSelected(new Set())}>
                Deseleziona tutto
              </button>
            )}
            <span className="selection__end">
              <ExportButton query={exportQuery.toString()} total={list.data.total} label="Esporta" />
            </span>
          </div>
          <p className="small muted results-count" aria-live="polite">
            <span className="mono">{list.data.total}</span> {list.data.total === 1 ? 'azienda' : 'aziende'}
            {list.loading && ' · aggiornamento…'}
          </p>
          <div className="table-wrap">
            <table className="table table--stack">
              <thead>
                <tr>
                  <th scope="col" className="col-select">
                    <input
                      type="checkbox"
                      aria-label="Seleziona tutte le aziende di questa pagina"
                      checked={list.data.items.length > 0 && list.data.items.every((b) => selected.has(b.id))}
                      onChange={(e) => {
                        const next = new Set(selected);
                        for (const b of list.data!.items) {
                          if (e.target.checked) next.add(b.id);
                          else next.delete(b.id);
                        }
                        setSelected(next);
                      }}
                    />
                  </th>
                  {COLUMNS.map((col) => (
                    <SortHeader key={col.key} col={col} sort={sort} dir={dir} onSort={onSort} />
                  ))}
                </tr>
              </thead>
              <tbody>
                {list.data.items.map((b) => (
                  <tr key={b.id}>
                    <td className="col-select" data-label="Seleziona">
                      <input
                        type="checkbox"
                        aria-label={`Seleziona ${b.name}`}
                        checked={selected.has(b.id)}
                        onChange={(e) => {
                          const next = new Set(selected);
                          if (e.target.checked) next.add(b.id);
                          else next.delete(b.id);
                          setSelected(next);
                        }}
                      />
                    </td>
                    <td data-label="Azienda">
                      <Link to={`/aziende/${b.id}`} className="strong-link">
                        {b.name}
                      </Link>
                      <span className="small muted lead-category">{b.sector?.label ?? b.categoryLabel}</span>
                      <Contacts b={b} />
                      {b.pendingReviews > 0 && <span className="flag">Possibile duplicato</span>}
                      {b.excluded && <span className="flag">Esclusa dalla prospezione</span>}
                      {b.crm?.open && (
                        <Link to={`/pipeline/${b.crm.opportunityId}`} className="small crm-flag">
                          Nel CRM: {STAGE_LABEL[b.crm.stage]}
                        </Link>
                      )}
                    </td>
                    <td data-label="Comune">{placeLabel(b)}</td>
                    <td data-label="Sito web e audit">
                      <Website b={b} />
                      <Audit b={b} />
                    </td>
                    <td data-label="Valutazione commerciale">
                      <Commercial b={b} />
                    </td>
                    <td data-label="Punteggio a regole">
                      <Score b={b} />
                    </td>
                    <td data-label="Servizio consigliato">
                      <PrimaryService b={b} filtered={params.get('service')} />
                    </td>
                    <td data-label="Prossimo passo" className="small">
                      {b.lead ? b.lead.nextStep : <span className="muted">Calcola il punteggio dalla scheda.</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="row between">
            <Pagination
              page={page}
              pageSize={pageSize}
              total={list.data.total}
              onPage={(p) => update({ page: String(p) }, true)}
            />
            <SelectField
              label="Per pagina"
              value={String(pageSize)}
              onChange={(e) => update({ pageSize: e.target.value })}
            >
              {[25, 50, 100].map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </SelectField>
          </div>
        </>
      )}
      <Attribution />
    </>
  );
}
