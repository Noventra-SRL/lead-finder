import { useState, type FormEvent } from 'react';
import { Link, useSearchParams } from 'react-router';
import type { BusinessSummary, HunterMeta, Paged } from '../api/client.ts';
import { AreaPicker } from '../components/AreaPicker.tsx';
import { CoverageSummary } from '../components/CoveragePanel.tsx';
import { EmailComposer } from '../components/EmailComposer.tsx';
import { ProspectTable } from '../components/ProspectTable.tsx';
import { Button, Empty, ErrorNotice, Field, Loading, PageHeader, Pagination, SelectField } from '../components/ui.tsx';
import { useApi } from '../lib/useApi.ts';
import { NAV_ITEMS, navIndex, pageTitle } from '../navigation.ts';

/*
 * Trova aziende: la schermata di lavoro. Filtri essenziali in alto, elenco paginato dal server (mai tutte le aziende
 * nel browser), «Invia email» su ogni riga. La ricerca di nuove aziende (per obiettivo o manuale) parte da qui; il
 * database completo con tutti i filtri resta disponibile come vista avanzata.
 */

const FILTERS = [
  'q',
  'region',
  'province',
  'municipality',
  'sector',
  'minCommercial',
  'email',
  'contactStatus',
] as const;
const SORTS = [
  { id: 'commercial', label: 'Punteggio commerciale', dir: 'desc' },
  { id: 'name', label: 'Nome (A–Z)', dir: 'asc' },
  { id: 'lastContact', label: 'Ultimo contatto', dir: 'desc' },
  { id: 'discovered', label: 'Trovate di recente', dir: 'desc' },
] as const;

export function ProspectsPage() {
  const item = NAV_ITEMS.find((i) => i.path === '/trova')!;
  const [params, setParams] = useSearchParams();
  const hunter = useApi<HunterMeta>('/hunter/meta');
  const [q, setQ] = useState(params.get('q') ?? '');
  const [composeFor, setComposeFor] = useState<BusinessSummary | null>(null);
  const sort = SORTS.find((s) => s.id === params.get('sort')) ?? SORTS[0];
  const page = Number(params.get('page') ?? 1);
  const query = new URLSearchParams();
  for (const k of FILTERS) if (params.get(k)) query.set(k, params.get(k)!);
  query.set('sort', sort.id);
  query.set('dir', sort.dir);
  query.set('page', String(page));
  query.set('pageSize', '25');
  const list = useApi<Paged<BusinessSummary>>(`/businesses?${query}`);
  const update = (changes: Record<string, string | null>, keepPage = false) => {
    const next = new URLSearchParams(params);
    for (const [k, v] of Object.entries(changes)) {
      if (v) next.set(k, v);
      else next.delete(k);
    }
    if (!keepPage) next.delete('page');
    setParams(next);
  };
  const filtered = FILTERS.some((k) => params.get(k));

  return (
    <>
      <div className="page-head-row">
        <PageHeader index={navIndex(item.path)} title={pageTitle(item)} lede={item.lede} />
        <Link to="/lead-hunter" className="btn">
          Avvia o riprendi una ricerca
        </Link>
      </div>
      <CoverageSummary />

      <section className="filters filters--compact" aria-label="Filtri">
        <form
          className="filters__search"
          role="search"
          onSubmit={(e: FormEvent) => {
            e.preventDefault();
            update({ q: q.trim() || null });
          }}
        >
          <Field
            label="Cerca per nome dell’azienda"
            type="search"
            value={q}
            maxLength={100}
            onChange={(e) => setQ(e.target.value)}
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
          allLabel="Tutta Italia"
        />
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
            label="Punteggio commerciale"
            value={params.get('minCommercial') ?? ''}
            onChange={(e) => update({ minCommercial: e.target.value || null })}
          >
            <option value="">Qualsiasi</option>
            <option value="80">Almeno 80 (alta priorità)</option>
            <option value="60">Almeno 60</option>
            <option value="40">Almeno 40</option>
          </SelectField>
          <SelectField
            label="Email"
            value={params.get('email') ?? ''}
            onChange={(e) => update({ email: e.target.value || null })}
          >
            <option value="">Indifferente</option>
            <option value="yes">Con email</option>
            <option value="no">Senza email</option>
          </SelectField>
          <SelectField
            label="Stato del contatto"
            value={params.get('contactStatus') ?? ''}
            onChange={(e) => update({ contactStatus: e.target.value || null })}
          >
            <option value="">Tutti</option>
            <option value="da_contattare">Da contattare</option>
            <option value="in_attesa">In attesa di risposta</option>
            <option value="in_trattativa">In trattativa</option>
            <option value="cliente">Cliente</option>
            <option value="perso">Perso</option>
          </SelectField>
          <SelectField label="Ordina per" value={sort.id} onChange={(e) => update({ sort: e.target.value })}>
            {SORTS.map((s) => (
              <option key={s.id} value={s.id}>
                {s.label}
              </option>
            ))}
          </SelectField>
        </div>
        <p className="small">
          {filtered && (
            <>
              <button
                type="button"
                className="link-button"
                onClick={() => (setQ(''), setParams(new URLSearchParams()))}
              >
                Azzera i filtri
              </button>{' '}
              ·{' '}
            </>
          )}
          <Link to="/aziende">Vista avanzata (tutti i filtri, selezione ed esportazioni)</Link>
        </p>
      </section>

      {list.loading && !list.data && <Loading />}
      {list.error && <ErrorNotice error={list.error} onRetry={list.reload} />}
      {list.data && list.data.total === 0 && (
        <Empty title={filtered ? 'Nessuna azienda con questi filtri' : 'Ancora nessuna azienda'}>
          {filtered ? 'Prova a togliere qualche filtro.' : 'Avvia una ricerca per trovare le prime aziende.'}{' '}
          <Link to="/lead-hunter">Avvia una ricerca</Link>
        </Empty>
      )}
      {list.data && list.data.total > 0 && (
        <>
          <p className="small muted results-count" aria-live="polite">
            <span className="mono">{list.data.total.toLocaleString('it-IT')}</span>{' '}
            {list.data.total === 1 ? 'azienda' : 'aziende'}
            {list.loading && ' · aggiornamento…'}
          </p>
          <ProspectTable items={list.data.items} onCompose={setComposeFor} caption="Aziende trovate" />
          <Pagination
            page={page}
            pageSize={list.data.pageSize}
            total={list.data.total}
            onPage={(p) => update({ page: String(p) }, true)}
          />
        </>
      )}
      {composeFor && <EmailComposer business={composeFor} onClose={() => setComposeFor(null)} onSent={list.reload} />}
    </>
  );
}
