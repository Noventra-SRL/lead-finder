import { useState, type FormEvent } from 'react';
import { Link, useSearchParams } from 'react-router';
import {
  ApiError,
  post,
  type BusinessCategoriesResponse,
  type BusinessCategoryId,
  type BusinessSummary,
  type CategoryCounts,
  type HunterMeta,
  type Paged,
} from '../api/client.ts';
import { AreaPicker } from '../components/AreaPicker.tsx';
import { CategoryDiscovery } from '../components/CategoryDiscovery.tsx';
import { CategoryNav } from '../components/CategoryNav.tsx';
import { CoverageSummary } from '../components/CoveragePanel.tsx';
import { EmailComposer } from '../components/EmailComposer.tsx';
import { ProspectTable } from '../components/ProspectTable.tsx';
import { Button, Empty, ErrorNotice, Field, Loading, PageHeader, Pagination, SelectField } from '../components/ui.tsx';
import { useApi } from '../lib/useApi.ts';
import { NAV_ITEMS, navIndex, pageTitle } from '../navigation.ts';

/*
 * Trova aziende: la schermata di lavoro, organizzata per categoria commerciale.
 *  - a sinistra le categorie con il numero reale di aziende (stessi filtri dell'elenco, calcolati dal server);
 *  - per la categoria scelta: i suoi numeri (sito, email, valutate, pronte, contattate), «Cerca nuove …» che avvia
 *    una ricerca reale di quella categoria, i filtri e l'elenco paginato dal server con «Invia email» su ogni riga.
 * Categoria, filtri, ordinamento e pagina sono nell'indirizzo: si cambia categoria senza lasciare la pagina e i filtri
 * restano. Mai tutte le aziende nel browser.
 */

/** Filtri della pagina e nome del parametro dell'API. */
const FILTERS: Record<string, string> = {
  q: 'q',
  region: 'region',
  province: 'province',
  municipality: 'municipality',
  minCommercial: 'minCommercial',
  website: 'website',
  email: 'email',
  contattabilita: 'contactability',
  contactStatus: 'contactStatus',
  verifica: 'categoryReview',
  // viste: aziende escluse dai potenziali clienti, aziende con divieto di contatto
  escluse: 'excluded',
  divieto: 'doNotContact',
};
const SORTS = [
  { id: 'priority', label: 'Priorità: aziende con email disponibile', dir: 'asc' },
  { id: 'commercial', label: 'Punteggio commerciale', dir: 'desc' },
  { id: 'name', label: 'Nome (A–Z)', dir: 'asc' },
  { id: 'city', label: 'Città (A–Z)', dir: 'asc' },
  { id: 'businessCategory', label: 'Categoria', dir: 'asc' },
  { id: 'discovered', label: 'Trovate di recente', dir: 'desc' },
  { id: 'assessment', label: 'Stato della valutazione', dir: 'asc' },
  { id: 'lastContact', label: 'Ultimo contatto', dir: 'desc' },
] as const;

/** Filtro «Email» (contattabilità): valori dell'API. */
const CONTACTABILITY_OPTIONS = [
  ['', 'Tutte le aziende'],
  ['pubblicata', 'Con email pubblicata sul sito'],
  ['verificata', 'Con email verificata'],
  ['da_verificare', 'Da verificare'],
  ['nessuna_email', 'Senza email trovata'],
  ['da_arricchire', 'Sito ancora da controllare'],
  ['senza_sito', 'Senza sito web'],
  ['sito_non_accessibile', 'Sito non accessibile'],
] as const;

const fmt = (n: number) => n.toLocaleString('it-IT');

/** I numeri della categoria scelta, con i filtri attivi. */
function CategoryStats({ counts }: { counts: CategoryCounts }) {
  const items: [string, number, string?][] = [
    ['Aziende', counts.total],
    ['Con sito proprio', counts.website],
    ['Email pubblicata sul sito', counts.published, 'Scritta su una pagina del sito dell’azienda (non verificata)'],
    ['Siti da controllare', counts.toEnrich, 'Sito proprio non ancora controllato per le email'],
    ['Valutate con AI', counts.assessed],
    ['Pronte da contattare', counts.ready, 'Mai contattate, con email disponibile'],
    ['Già contattate', counts.contacted, 'Email accettata o contatto registrato nel CRM'],
  ];
  return (
    <dl className="catstats" aria-label="Numeri della categoria">
      {items.map(([label, value, hint]) => (
        <div key={label} className="catstats__item" title={hint}>
          <dt>{label}</dt>
          <dd className="mono">{fmt(value)}</dd>
        </div>
      ))}
    </dl>
  );
}

export function ProspectsPage() {
  const item = NAV_ITEMS.find((i) => i.path === '/trova')!;
  const [params, setParams] = useSearchParams();
  const hunter = useApi<HunterMeta>('/hunter/meta');
  const [q, setQ] = useState(params.get('q') ?? '');
  const [composeFor, setComposeFor] = useState<BusinessSummary | null>(null);
  const [discovering, setDiscovering] = useState(false);
  const [enrichment, setEnrichment] = useState<{
    busy: boolean;
    message: string | null;
    jobId: string | null;
    error: string | null;
  }>({ busy: false, message: null, jobId: null, error: null });
  const sort = SORTS.find((s) => s.id === params.get('sort')) ?? SORTS[0];
  const page = Number(params.get('page') ?? 1);

  // filtri comuni a elenco e conteggi
  const filterQuery = new URLSearchParams();
  for (const [k, api] of Object.entries(FILTERS)) {
    const v = params.get(k);
    if (!v) continue;
    if (k === 'escluse') filterQuery.set('excluded', 'only');
    else if (k === 'divieto') {
      filterQuery.set('doNotContact', '1');
      filterQuery.set('excluded', 'include');
    } else filterQuery.set(api, k === 'verifica' ? '1' : v);
  }
  const view = params.get('escluse') ? 'escluse' : params.get('divieto') ? 'divieto' : 'attive';
  const categories = useApi<BusinessCategoriesResponse>(`/businesses/categories?${filterQuery}`);
  const ids = categories.data?.categories.map((c) => c.id) ?? [];
  const requested = params.get('categoria') as BusinessCategoryId | null;
  const current = requested && (!categories.data || ids.includes(requested)) ? requested : null;
  const category = categories.data?.categories.find((c) => c.id === current) ?? null;

  const query = new URLSearchParams(filterQuery);
  if (current) query.set('businessCategory', current);
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
  const hrefFor = (id: BusinessCategoryId | null) => {
    const next = new URLSearchParams(params);
    next.delete('page');
    next.delete('verifica');
    if (id) next.set('categoria', id);
    else next.delete('categoria');
    const s = next.toString();
    return s ? `/trova?${s}` : '/trova';
  };
  const filtered = Object.keys(FILTERS).some((k) => params.get(k) && k !== 'escluse' && k !== 'divieto');
  const hrefForView = (v: 'escluse' | 'divieto' | null) => {
    const next = new URLSearchParams(params);
    next.delete('page');
    next.delete('escluse');
    next.delete('divieto');
    if (v) next.set(v, '1');
    const s = next.toString();
    return s ? `/trova?${s}` : '/trova';
  };
  const counts = category ? category.counts : categories.data?.all;
  const reload = () => {
    list.reload();
    categories.reload();
  };
  // arricchimento dei siti (in sottofondo): stesse aziende dei filtri attivi, in ordine di priorità
  const enrich = async (scope: 'pending' | 'retry') => {
    setEnrichment({ busy: true, message: null, jobId: null, error: null });
    try {
      const f = new URLSearchParams(filterQuery);
      if (current) f.set('businessCategory', current);
      const r = await post<{ job: { id: string } | null; queued: number; alreadyQueued: number; message?: string }>(
        '/enrichment/start',
        { scope, filters: f.toString() },
      );
      setEnrichment({
        busy: false,
        jobId: r.job?.id ?? null,
        error: null,
        message: r.job
          ? `Controllo avviato: ${r.queued} ${r.queued === 1 ? 'sito' : 'siti'} in coda${r.alreadyQueued ? `, ${r.alreadyQueued} già in corso` : ''}. I risultati compaiono qui man mano.`
          : (r.message ?? 'Niente da controllare.'),
      });
    } catch (e) {
      setEnrichment({
        busy: false,
        message: null,
        jobId: null,
        error: e instanceof ApiError ? e.message : 'Avvio non riuscito.',
      });
    }
  };

  return (
    <>
      <div className="page-head-row">
        <PageHeader index={navIndex(item.path)} title={pageTitle(item)} lede={item.lede} />
        <Link to="/lead-hunter" className="btn btn--secondary">
          Avvia o riprendi una ricerca
        </Link>
      </div>
      <CoverageSummary />

      <div className="trova">
        <CategoryNav data={categories.data} current={current} hrefFor={hrefFor} />

        <div className="trova__main">
          <header className="cathead">
            <div>
              <h2 className="cathead__title">{category?.label ?? 'Tutte le aziende'}</h2>
              <p className="small muted">
                {category?.description ??
                  'Ogni azienda una sola volta, nella sua categoria principale. Scegli una categoria a sinistra.'}
              </p>
            </div>
            {category && (
              <Button variant="secondary" onClick={() => setDiscovering(true)} disabled={!hunter.data}>
                {category.discover}
              </Button>
            )}
          </header>
          {categories.error && <ErrorNotice error={categories.error} onRetry={categories.reload} />}
          {counts && <CategoryStats counts={counts} />}
          <div className="enrich" role="group" aria-label="Email dai siti">
            <p className="small">
              Le email si cercano solo sul sito di ogni azienda (pagina dei contatti, piè di pagina, note legali), in
              sottofondo e senza inviare nulla.
            </p>
            <div className="row">
              <Button
                variant="secondary"
                busy={enrichment.busy}
                disabled={!counts || counts.toEnrich === 0}
                onClick={() => void enrich('pending')}
              >
                Cerca le email sui siti{counts ? ` (${fmt(counts.toEnrich)} da controllare)` : ''}
              </Button>
              <Button variant="ghost" disabled={enrichment.busy} onClick={() => void enrich('retry')}>
                Riprova i siti non accessibili
              </Button>
            </div>
            {enrichment.message && (
              <p className="small" role="status">
                {enrichment.message}{' '}
                {enrichment.jobId && <Link to={`/audit/verifiche/${enrichment.jobId}`}>Segui l’avanzamento</Link>}
              </p>
            )}
            {enrichment.error && (
              <p role="alert" className="field__error">
                {enrichment.error}
              </p>
            )}
          </div>
          {categories.data && (
            <nav className="status-views" aria-label="Viste delle aziende">
              <Link to={hrefForView(null)} aria-current={view === 'attive' ? 'page' : undefined}>
                Potenziali clienti
              </Link>
              <Link to={hrefForView('escluse')} aria-current={view === 'escluse' ? 'page' : undefined}>
                Aziende escluse ({fmt(categories.data.status.excluded)})
              </Link>
              <Link to={hrefForView('divieto')} aria-current={view === 'divieto' ? 'page' : undefined}>
                Con divieto di contatto ({fmt(categories.data.status.doNotContact)})
              </Link>
            </nav>
          )}
          {view !== 'attive' && (
            <p className="small">
              {view === 'escluse'
                ? 'Aziende escluse dai potenziali clienti: la loro storia resta. Si possono riportare tra i potenziali clienti dalla scheda («Gestisci contatto»).'
                : 'Aziende che hanno rifiutato le comunicazioni commerciali: l’invio di email è bloccato anche se tornano tra i potenziali clienti.'}
            </p>
          )}
          {counts && counts.review > 0 && (
            <p className="small">
              {params.get('verifica') ? (
                <>
                  Solo le aziende con la categoria da verificare.{' '}
                  <button type="button" className="link-button" onClick={() => update({ verifica: null })}>
                    Mostra tutte
                  </button>
                </>
              ) : (
                <>
                  <span className="mono">{fmt(counts.review)}</span>{' '}
                  {counts.review === 1 ? 'azienda ha' : 'aziende hanno'} la categoria da verificare (prove deboli o in
                  contrasto).{' '}
                  <button type="button" className="link-button" onClick={() => update({ verifica: '1' })}>
                    Mostrale
                  </button>
                </>
              )}
            </p>
          )}

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
                label="Sito web"
                value={params.get('website') ?? ''}
                onChange={(e) => update({ website: e.target.value || null })}
              >
                <option value="">Indifferente</option>
                <option value="own">Con un sito proprio</option>
                <option value="no">Senza sito</option>
              </SelectField>
              <SelectField
                label="Email"
                value={params.get('contattabilita') ?? ''}
                onChange={(e) => update({ contattabilita: e.target.value || null, email: null })}
              >
                {CONTACTABILITY_OPTIONS.map(([v, label]) => (
                  <option key={v} value={v}>
                    {label}
                  </option>
                ))}
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
                <option value="non_contattare">Non contattare</option>
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
                    onClick={() => {
                      setQ('');
                      setParams(current ? new URLSearchParams({ categoria: current }) : new URLSearchParams());
                    }}
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
            <Empty
              title={
                category
                  ? category.empty
                  : filtered
                    ? 'Nessuna azienda trovata con questi filtri'
                    : 'Ancora nessuna azienda'
              }
            >
              {filtered && 'Prova a togliere qualche filtro, oppure '}
              {category ? (
                <button type="button" className="link-button" onClick={() => setDiscovering(true)}>
                  {filtered ? category.discover.toLowerCase() : category.discover}
                </button>
              ) : (
                <Link to="/lead-hunter">{filtered ? 'avvia una ricerca' : 'Avvia una ricerca'}</Link>
              )}
              .
            </Empty>
          )}
          {list.data && list.data.total > 0 && (
            <>
              <p className="small muted results-count" aria-live="polite">
                <span className="mono">{fmt(list.data.total)}</span> {list.data.total === 1 ? 'azienda' : 'aziende'}
                {list.loading && ' · aggiornamento…'}
              </p>
              <ProspectTable
                items={list.data.items}
                onCompose={setComposeFor}
                caption={category ? category.label : 'Aziende trovate'}
                showCategory={!category}
              />
              <Pagination
                page={page}
                pageSize={list.data.pageSize}
                total={list.data.total}
                onPage={(p) => update({ page: String(p) }, true)}
              />
            </>
          )}
        </div>
      </div>
      {composeFor && <EmailComposer business={composeFor} onClose={() => setComposeFor(null)} onSent={reload} />}
      {discovering && category && hunter.data && (
        <CategoryDiscovery
          category={category}
          meta={hunter.data}
          initialArea={{
            region: params.get('region') ?? '',
            province: params.get('province') ?? '',
            municipality: params.get('municipality') ?? '',
          }}
          onClose={() => setDiscovering(false)}
        />
      )}
    </>
  );
}
