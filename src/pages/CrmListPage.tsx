import { useState, type FormEvent } from 'react';
import { Link, useSearchParams } from 'react-router';
import type { CrmMeta, HunterMeta, OpportunityCard, Paged } from '../api/client.ts';
import { AreaPicker } from '../components/AreaPicker.tsx';
import { CrmTabs } from '../components/CrmControls.tsx';
import { ExportButton } from '../components/ExportButton.tsx';
import { SavedFilters } from '../components/SavedFilters.tsx';
import {
  Button,
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
import { dueText, formatEuro, PRIORITY_LABEL, STAGE_TONE } from '../lib/crm.ts';
import { formatRelative } from '../lib/format.ts';
import { useApi } from '../lib/useApi.ts';
import { NAV_ITEMS, navIndex, pageTitle } from '../navigation.ts';

/* Elenco delle opportunità del CRM con filtri, ordinamento e paginazione; i filtri restano nell'indirizzo. */

const FILTER_KEYS = [
  'q',
  'stage',
  'state',
  'crmPriority',
  'owner',
  'followUp',
  'sector',
  'region',
  'province',
  'municipality',
  'minCommercial',
  'website',
  'audit',
  'service',
] as const;

const SORTS = [
  { value: 'activity', label: 'Ultima attività' },
  { value: 'due', label: 'Scadenza della prossima azione' },
  { value: 'score', label: 'Punteggio commerciale' },
  { value: 'created', label: 'Data di creazione' },
  { value: 'value', label: 'Valore stimato' },
  { value: 'stage', label: 'Fase' },
  { value: 'name', label: 'Nome' },
];
const ASC = new Set(['due', 'name', 'stage']);

export function CrmListPage() {
  const item = NAV_ITEMS.find((i) => i.path === '/pipeline')!;
  const [params, setParams] = useSearchParams();
  const meta = useApi<CrmMeta>('/crm/meta');
  const hunter = useApi<HunterMeta>('/hunter/meta');
  const [q, setQ] = useState(params.get('q') ?? '');
  const sort = params.get('sort') ?? 'activity';
  const dir = params.get('dir') ?? (ASC.has(sort) ? 'asc' : 'desc');
  const page = Number(params.get('page') ?? 1);
  const query = new URLSearchParams();
  for (const k of FILTER_KEYS) if (params.get(k)) query.set(k, params.get(k)!);
  // una fase chiusa si vede solo tra le chiuse: lo stato segue la fase scelta
  if (!params.get('state') && ['vinto', 'perso', 'non_contattare'].includes(params.get('stage') ?? ''))
    query.set('state', 'closed');
  query.set('sort', sort);
  query.set('dir', dir);
  query.set('page', String(page));
  const list = useApi<Paged<OpportunityCard> & { today: string }>(`/crm/opportunities?${query}`);
  // l'esportazione usa gli stessi filtri e ordinamento, senza paginazione
  const exportQuery = new URLSearchParams(query);
  exportQuery.delete('page');

  const update = (changes: Record<string, string | null>, keepPage = false) => {
    const next = new URLSearchParams(params);
    for (const [k, v] of Object.entries(changes)) {
      if (v) next.set(k, v);
      else next.delete(k);
    }
    if (!keepPage) next.delete('page');
    setParams(next);
  };
  const filtered = FILTER_KEYS.some((k) => params.get(k));

  return (
    <>
      <PageHeader index={navIndex(item.path)} title={pageTitle(item)} lede={item.lede} />
      <CrmTabs current="elenco" />
      <SavedFilters scope="opportunities" query={params.toString()} basePath="/pipeline/elenco" />
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
            maxLength={100}
            onChange={(e) => setQ(e.target.value)}
          />
          <Button type="submit" variant="secondary">
            Cerca
          </Button>
        </form>
        <div className="filters__row">
          <SelectField
            label="Fase"
            value={params.get('stage') ?? ''}
            onChange={(e) => update({ stage: e.target.value || null })}
          >
            <option value="">Tutte</option>
            {meta.data?.stages.map((s) => (
              <option key={s.id} value={s.id}>
                {s.label}
              </option>
            ))}
          </SelectField>
          <SelectField
            label="Stato"
            value={params.get('state') ?? ''}
            onChange={(e) => update({ state: e.target.value || null })}
          >
            <option value="">Aperte</option>
            <option value="closed">Chiuse</option>
            <option value="all">Tutte</option>
          </SelectField>
          <SelectField
            label="Priorità commerciale"
            value={params.get('crmPriority') ?? ''}
            onChange={(e) => update({ crmPriority: e.target.value || null })}
          >
            <option value="">Tutte</option>
            {meta.data?.priorities.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
              </option>
            ))}
          </SelectField>
          <SelectField
            label="Prossima azione"
            value={params.get('followUp') ?? ''}
            onChange={(e) => update({ followUp: e.target.value || null })}
          >
            <option value="">Indifferente</option>
            <option value="overdue">Scaduta</option>
            <option value="today">Oggi</option>
            <option value="upcoming">Nei prossimi giorni</option>
            <option value="none">Nessuna pianificata</option>
          </SelectField>
          <SelectField
            label="Responsabile"
            value={params.get('owner') ?? ''}
            onChange={(e) => update({ owner: e.target.value || null })}
          >
            <option value="">Tutti</option>
            <option value="me">Le mie</option>
            <option value="none">Senza responsabile</option>
            {meta.data?.owners.map((o) => (
              <option key={o.id} value={o.id}>
                {o.name}
              </option>
            ))}
          </SelectField>
        </div>
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
            label="Settore"
            value={params.get('sector') ?? ''}
            onChange={(e) => update({ sector: e.target.value || null })}
          >
            <option value="">Tutti</option>
            {hunter.data?.sectors.map((s) => (
              <option key={s.id} value={s.id}>
                {s.label}
              </option>
            ))}
          </SelectField>
          <SelectField
            label="Punteggio commerciale"
            value={params.get('minCommercial') ?? ''}
            onChange={(e) => update({ minCommercial: e.target.value || null })}
          >
            <option value="">Qualsiasi</option>
            {[40, 60, 80].map((n) => (
              <option key={n} value={n}>
                Almeno {n}
              </option>
            ))}
          </SelectField>
          <SelectField
            label="Sito web"
            value={params.get('website') ?? ''}
            onChange={(e) => update({ website: e.target.value || null })}
          >
            <option value="">Indifferente</option>
            <option value="own">Con un sito proprio</option>
            <option value="no">Senza sito indicato</option>
          </SelectField>
          <SelectField
            label="Audit del sito"
            value={params.get('audit') ?? ''}
            onChange={(e) => update({ audit: e.target.value || null })}
          >
            <option value="">Indifferente</option>
            <option value="audited">Verificato</option>
            <option value="problems">Verificato, con problemi gravi</option>
            <option value="unaudited">Non ancora verificato</option>
            <option value="unavailable">Irraggiungibile o non valido</option>
          </SelectField>
          <SelectField
            label="Servizio consigliato"
            value={params.get('service') ?? ''}
            onChange={(e) => update({ service: e.target.value || null })}
          >
            <option value="">Qualsiasi</option>
            {meta.data?.services
              .filter((s) => s.active)
              .map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
          </SelectField>
          <SelectField
            label="Ordina per"
            value={sort}
            onChange={(e) => update({ sort: e.target.value, dir: ASC.has(e.target.value) ? 'asc' : 'desc' })}
          >
            {SORTS.map((s) => (
              <option key={s.value} value={s.value}>
                {s.label}
              </option>
            ))}
          </SelectField>
        </div>
        {filtered && (
          <p>
            <button type="button" className="link-button" onClick={() => setParams(new URLSearchParams())}>
              Azzera i filtri
            </button>
          </p>
        )}
      </section>

      <p className="small muted">
        Punteggio commerciale (valutazione AI o, in sua assenza, a regole), priorità commerciale (decisa da una persona)
        e fase della pipeline sono tre informazioni distinte.
      </p>

      {list.loading && !list.data && <Loading />}
      {list.error && <ErrorNotice error={list.error} onRetry={list.reload} />}
      {list.data && list.data.total === 0 && (
        <Empty title={filtered ? 'Nessuna opportunità con questi filtri' : 'Nessuna opportunità aperta'}>
          {filtered ? (
            'Prova a togliere qualche filtro o a includere le opportunità chiuse.'
          ) : (
            <>
              Aggiungi aziende dall’<Link to="/aziende">elenco delle aziende</Link>.
            </>
          )}
        </Empty>
      )}
      {list.data && list.data.total > 0 && (
        <>
          <div className="row between">
            <p className="small muted results-count" aria-live="polite">
              <span className="mono">{list.data.total}</span> opportunità
              {list.loading && ' · aggiornamento…'}
            </p>
            <span className="row">
              <ExportButton
                dataset="opportunities"
                query={exportQuery.toString()}
                total={list.data.total}
                name="opportunita"
              />
              <ExportButton dataset="activities" name="attivita" label="Esporta la cronologia delle attività" />
            </span>
          </div>
          <div className="table-wrap">
            <table className="table table--stack">
              <thead>
                <tr>
                  <th scope="col">Azienda</th>
                  <th scope="col">Fase</th>
                  <th scope="col">Priorità</th>
                  <th scope="col">Punteggio commerciale</th>
                  <th scope="col">Prossima azione</th>
                  <th scope="col">Valore</th>
                  <th scope="col">Ultima attività</th>
                </tr>
              </thead>
              <tbody>
                {list.data.items.map((o) => {
                  const b = o.business;
                  return (
                    <tr key={o.id}>
                      <td data-label="Azienda">
                        <Link to={`/pipeline/${o.id}`} className="strong-link">
                          {b.name}
                        </Link>
                        <span className="small muted lead-category">
                          {b.sector?.label ?? b.categoryLabel}
                          {b.place.municipality && ` · ${b.place.municipality}`}
                        </span>
                        <span className="small muted">{WEBSITE_STATUS[b.audit.websiteStatus].label}</span>
                      </td>
                      <td data-label="Fase">
                        <Status tone={STAGE_TONE[o.stage]}>{o.stageLabel}</Status>
                      </td>
                      <td data-label="Priorità">{PRIORITY_LABEL[o.priority]}</td>
                      <td data-label="Punteggio" className="mono">
                        {b.commercial && !b.commercial.exclusion ? b.commercial.score : '—'}
                        {b.commercial && (
                          <span className="small muted"> {b.commercial.source === 'ai' ? 'AI' : 'regole'}</span>
                        )}
                      </td>
                      <td data-label="Prossima azione" className="small">
                        {o.nextFollowUp ? (
                          <span className={o.nextFollowUp.overdue ? 'text-danger' : undefined}>
                            {dueText(o.nextFollowUp, list.data!.today)} — {o.nextFollowUp.description}
                          </span>
                        ) : (
                          <span className="muted">{o.open ? 'Nessuna' : '—'}</span>
                        )}
                      </td>
                      <td data-label="Valore" className="mono">
                        {formatEuro(o.estimatedValue)}
                      </td>
                      <td data-label="Ultima attività" className="small">
                        {o.lastActivity ? (
                          <>
                            {o.lastActivity.summary}
                            <span className="muted"> · {formatRelative(o.lastActivity.occurredAt)}</span>
                          </>
                        ) : (
                          '—'
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <Pagination
            page={page}
            pageSize={list.data.pageSize}
            total={list.data.total}
            onPage={(p) => update({ page: String(p) }, true)}
          />
        </>
      )}
    </>
  );
}
