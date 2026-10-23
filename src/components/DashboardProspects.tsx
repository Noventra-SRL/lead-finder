import { useState, type FormEvent } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { useUser } from '../auth/AuthContext.tsx';
import {
  ArrowUpDown,
  Building2,
  Funnel,
  Globe,
  Layers,
  Mail,
  MapPin,
  Phone,
  Printer,
  Search,
  Send,
  X,
} from 'lucide-react';
import type { BusinessCategoriesResponse, BusinessSummary, Paged } from '../api/client.ts';
import { BUSINESS_CATEGORY_OPTIONS } from '../lib/categories.ts';
import { useApi } from '../lib/useApi.ts';
import { AreaPicker } from './AreaPicker.tsx';
import { CategoryBadge, CategoryTile } from './CategoryBadge.tsx';
import { ExportButton } from './ExportButton.tsx';
import { ManageContact } from './ManageContact.tsx';
import { canEmail, CONTACT_TONE } from './ProspectTable.tsx';
import { RowMenu } from './RowMenu.tsx';
import { Button, Empty, ErrorNotice, Pagination, SelectField, Status } from './ui.tsx';

/*
 * «I migliori prospect da contattare» della dashboard: ricerca, città, categoria, ordinamento e altri filtri, tutti
 * eseguiti dal server (mai tutto il database nel browser) e conservati nell'indirizzo; tabella paginata con contatti,
 * punteggio, stato e «Invia email» su ogni riga. Per impostazione predefinita: solo potenziali clienti contattabili
 * (né esclusi né con divieto di contatto), in ordine di punteggio commerciale decrescente.
 */

const PAGE_SIZE = 10;
const SORTS = [
  { id: 'commercial', label: 'Punteggio (decrescente)', dir: 'desc' },
  { id: 'priority', label: 'Priorità: email disponibile', dir: 'asc' },
  { id: 'name', label: 'Nome (A–Z)', dir: 'asc' },
  { id: 'city', label: 'Città (A–Z)', dir: 'asc' },
  { id: 'discovered', label: 'Trovate di recente', dir: 'desc' },
] as const;

/** Filtri della dashboard nell'indirizzo → parametri dell'API. */
const PARAMS: Record<string, string> = {
  q: 'q',
  citta: 'municipality',
  categoria: 'businessCategory',
  regione: 'region',
  provincia: 'province',
  punteggio: 'minCommercial',
  punteggioMax: 'maxCommercial',
  sito: 'website',
  email: 'contactability',
  stato: 'contactStatus',
  valutazione: 'aiStatus',
};
const ADVANCED = [
  'regione',
  'provincia',
  'punteggio',
  'punteggioMax',
  'sito',
  'email',
  'stato',
  'valutazione',
  'escluse',
];

const fmt = (n: number) => n.toLocaleString('it-IT', { useGrouping: 'always' } as Intl.NumberFormatOptions);
const telHref = (p: string) => `tel:${p.replace(/[^\d+]/g, '')}`;

export function DashboardProspects({
  onCompose,
  refreshKey,
}: {
  onCompose: (b: BusinessSummary) => void;
  refreshKey: number;
}) {
  const [params, setParams] = useSearchParams();
  const user = useUser();
  const [q, setQ] = useState(params.get('q') ?? '');
  const [advanced, setAdvanced] = useState(() => ADVANCED.some((k) => params.get(k)));
  const [managing, setManaging] = useState<BusinessSummary | null>(null);
  const sort = SORTS.find((s) => s.id === params.get('ordina')) ?? SORTS[0];
  const page = Number(params.get('pagina') ?? 1);
  const cities = useApi<{ items: { code: string; name: string; province: string | null; count: number }[] }>(
    '/businesses/cities',
  );

  const filters = new URLSearchParams();
  for (const [k, api] of Object.entries(PARAMS)) {
    const v = params.get(k);
    if (v) filters.set(api, v);
  }
  if (params.get('escluse')) filters.set('excluded', 'only');
  // predefinito: solo aziende contattabili (nessun divieto), salvo una scelta esplicita di stato o di escluse
  else if (!params.get('stato')) filters.set('doNotContact', '0');
  const query = new URLSearchParams(filters);
  query.set('sort', sort.id);
  query.set('dir', sort.dir);
  query.set('page', String(page));
  query.set('pageSize', String(PAGE_SIZE));
  const list = useApi<Paged<BusinessSummary>>(`/businesses?${query}&r=${refreshKey}`);
  const categories = useApi<BusinessCategoriesResponse>('/businesses/categories');

  const update = (changes: Record<string, string | null>, keepPage = false) => {
    const next = new URLSearchParams(params);
    for (const [k, v] of Object.entries(changes)) {
      if (v) next.set(k, v);
      else next.delete(k);
    }
    if (!keepPage) next.delete('pagina');
    setParams(next, { replace: true });
  };
  const active = Object.keys(PARAMS).some((k) => params.get(k)) || Boolean(params.get('escluse'));
  const reset = () => {
    setQ('');
    setParams(new URLSearchParams(), { replace: true });
  };
  const exportQuery = new URLSearchParams(filters);
  exportQuery.set('sort', sort.id);
  exportQuery.set('dir', sort.dir);

  return (
    <>
      <section className="dash-toolbar" aria-label="Cerca e filtra">
        <form
          className="dash-search"
          role="search"
          onSubmit={(e: FormEvent) => {
            e.preventDefault();
            update({ q: q.trim() || null });
          }}
        >
          <Search className="dash-search__icon" size={18} aria-hidden="true" />
          <label className="visually-hidden" htmlFor="dash-q">
            Cerca azienda, settore, città
          </label>
          <input
            id="dash-q"
            className="dash-search__input"
            type="search"
            placeholder="Cerca azienda, settore, città..."
            value={q}
            maxLength={100}
            onChange={(e) => setQ(e.target.value)}
            onBlur={() => q.trim() !== (params.get('q') ?? '') && update({ q: q.trim() || null })}
          />
        </form>
        <div className="dash-select">
          <MapPin size={17} aria-hidden="true" />
          <select
            aria-label="Città"
            value={params.get('citta') ?? ''}
            onChange={(e) => update({ citta: e.target.value || null })}
          >
            <option value="">Tutte le città</option>
            {cities.data?.items.map((c) => (
              <option key={c.code} value={c.code}>
                {c.name}
                {c.province ? ` (${c.province})` : ''} · {c.count}
              </option>
            ))}
          </select>
        </div>
        <div className="dash-select">
          <Layers size={17} aria-hidden="true" />
          <select
            aria-label="Categoria"
            value={params.get('categoria') ?? ''}
            onChange={(e) => update({ categoria: e.target.value || null })}
          >
            <option value="">Tutte le categorie</option>
            {BUSINESS_CATEGORY_OPTIONS.map((c) => (
              <option key={c.id} value={c.id}>
                {c.label}
              </option>
            ))}
          </select>
        </div>
        <div className="dash-select">
          <ArrowUpDown size={17} aria-hidden="true" />
          <select
            aria-label="Ordina per"
            value={sort.id}
            onChange={(e) => update({ ordina: e.target.value === 'commercial' ? null : e.target.value })}
          >
            {SORTS.map((s) => (
              <option key={s.id} value={s.id}>
                {s.label}
              </option>
            ))}
          </select>
        </div>
        <button
          type="button"
          className="dash-filter-btn"
          aria-expanded={advanced}
          aria-controls="altri-filtri"
          onClick={() => setAdvanced(!advanced)}
        >
          <Funnel size={17} aria-hidden="true" />
          Altri filtri
        </button>
      </section>

      {advanced && (
        <section id="altri-filtri" className="dash-advanced" aria-label="Altri filtri">
          <AreaPicker
            value={{
              region: params.get('regione') ?? '',
              province: params.get('provincia') ?? '',
              municipality: params.get('citta') ?? '',
            }}
            onChange={(v) =>
              update({ regione: v.region || null, provincia: v.province || null, citta: v.municipality || null })
            }
            allLabel="Tutta Italia"
          />
          <div className="dash-advanced__row">
            <SelectField
              label="Punteggio minimo"
              value={params.get('punteggio') ?? ''}
              onChange={(e) => update({ punteggio: e.target.value || null })}
            >
              <option value="">Qualsiasi</option>
              <option value="80">80</option>
              <option value="60">60</option>
              <option value="40">40</option>
              <option value="20">20</option>
            </SelectField>
            <SelectField
              label="Punteggio massimo"
              value={params.get('punteggioMax') ?? ''}
              onChange={(e) => update({ punteggioMax: e.target.value || null })}
            >
              <option value="">Qualsiasi</option>
              <option value="79">79</option>
              <option value="59">59</option>
              <option value="39">39</option>
            </SelectField>
            <SelectField
              label="Sito web"
              value={params.get('sito') ?? ''}
              onChange={(e) => update({ sito: e.target.value || null })}
            >
              <option value="">Indifferente</option>
              <option value="own">Con un sito proprio</option>
              <option value="no">Senza sito</option>
            </SelectField>
            <SelectField
              label="Email"
              value={params.get('email') ?? ''}
              onChange={(e) => update({ email: e.target.value || null })}
            >
              <option value="">Indifferente</option>
              <option value="pubblicata">Pubblicata sul sito</option>
              <option value="da_verificare">Da verificare</option>
              <option value="nessuna_email">Nessuna email trovata</option>
              <option value="da_arricchire">Sito da controllare</option>
              <option value="senza_sito">Senza sito web</option>
            </SelectField>
            <SelectField
              label="Stato del contatto"
              value={params.get('stato') ?? ''}
              onChange={(e) => update({ stato: e.target.value || null })}
            >
              <option value="">Contattabili</option>
              <option value="da_contattare">Da contattare</option>
              <option value="in_attesa">In attesa di risposta</option>
              <option value="in_trattativa">In trattativa</option>
              <option value="cliente">Cliente</option>
              <option value="perso">Perso</option>
              <option value="non_contattare">Non contattare</option>
            </SelectField>
            <SelectField
              label="Valutazione"
              value={params.get('valutazione') ?? ''}
              onChange={(e) => update({ valutazione: e.target.value || null })}
            >
              <option value="">Qualsiasi</option>
              <option value="state_assessed">Valutata con AI</option>
              <option value="state_pending">Da valutare</option>
              <option value="state_outdated">Da aggiornare</option>
              <option value="state_failed">Errore di valutazione</option>
            </SelectField>
            <SelectField
              label="Aziende escluse"
              value={params.get('escluse') ?? ''}
              onChange={(e) => update({ escluse: e.target.value || null })}
            >
              <option value="">Nascoste</option>
              <option value="1">Solo le escluse</option>
            </SelectField>
          </div>
        </section>
      )}
      {active && (
        <p className="small dash-reset">
          <button type="button" className="link-button" onClick={reset}>
            <X size={14} aria-hidden="true" /> Azzera i filtri
          </button>
        </p>
      )}

      <section className="dash-card" aria-labelledby="dash-prospects-title">
        <header className="dash-card__head">
          <span className="dash-card__icon" aria-hidden="true">
            <Building2 size={20} />
          </span>
          <div className="dash-card__titles">
            <h2 id="dash-prospects-title" className="dash-card__title">
              I migliori prospect da contattare
            </h2>
            <p className="dash-card__subtitle">Aziende selezionate in base al potenziale di interesse.</p>
          </div>
          <div className="dash-card__tools">
            {list.data && (
              <span className="small muted" aria-live="polite">
                <span className="mono">{fmt(list.data.total)}</span> {list.data.total === 1 ? 'risultato' : 'risultati'}
              </span>
            )}
            <ExportButton
              query={exportQuery.toString()}
              name="prospect"
              total={list.data?.total}
              label="Esporta lista"
            />
          </div>
        </header>

        {list.error && <ErrorNotice error={list.error} onRetry={list.reload} />}
        {!list.error && list.data && list.data.total === 0 && (
          <Empty title={active ? 'Nessuna azienda trovata con questi filtri' : 'Ancora nessuna azienda'}>
            {active ? (
              <button type="button" className="link-button" onClick={reset}>
                Azzera i filtri
              </button>
            ) : (
              <Link to="/trova">Trova le prime aziende</Link>
            )}
          </Empty>
        )}
        {!list.error && (!list.data || list.data.total > 0) && (
          <div className="table-wrap dash-table-wrap">
            <table className="dash-table" aria-busy={list.loading}>
              <caption className="visually-hidden">Migliori prospect da contattare</caption>
              <thead>
                <tr>
                  <th scope="col">Azienda</th>
                  <th scope="col">Settore</th>
                  <th scope="col">Contatti</th>
                  <th scope="col">Punteggio</th>
                  <th scope="col">Stato</th>
                  <th scope="col">
                    <span className="visually-hidden">Azioni</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {!list.data &&
                  Array.from({ length: 5 }, (_, i) => (
                    <tr key={`s${i}`} className="dash-skeleton" aria-hidden="true">
                      {Array.from({ length: 6 }, (__, j) => (
                        <td key={j}>
                          <span className="skeleton-line" />
                        </td>
                      ))}
                    </tr>
                  ))}
                {list.data?.items.map((b) => (
                  <ProspectRow key={b.id} b={b} onCompose={onCompose} onManage={setManaging} />
                ))}
              </tbody>
            </table>
          </div>
        )}
        {list.data && list.data.total > PAGE_SIZE && (
          <Pagination
            page={page}
            pageSize={list.data.pageSize}
            total={list.data.total}
            onPage={(p) => update({ pagina: String(p) }, true)}
          />
        )}
      </section>

      {managing && (
        <ManageContact
          business={managing}
          isAdmin={user.role === 'admin'}
          onClose={() => setManaging(null)}
          onChanged={() => {
            list.reload();
            categories.reload();
          }}
        />
      )}
    </>
  );
}

function ProspectRow({
  b,
  onCompose,
  onManage,
}: {
  b: BusinessSummary;
  onCompose: (b: BusinessSummary) => void;
  onManage: (b: BusinessSummary) => void;
}) {
  const email = b.contacts.email && b.contacts.emailKind !== 'personal' ? b.contacts.email : null;
  const site = b.website && !b.website.shared ? b.website : null;
  const c = b.commercial;
  const category = b.businessCategory;
  const sendable = canEmail(b);
  const navigate = useNavigate();
  return (
    <tr>
      <td data-label="Azienda">
        <div className="dash-biz">
          <CategoryTile category={category?.id ?? null} />
          <div className="dash-biz__text">
            <Link to={`/aziende/${b.id}`} className="dash-biz__name">
              {b.name}
            </Link>
            {b.place.municipality && (
              <span className="dash-biz__line">
                <MapPin size={13} aria-hidden="true" /> {b.place.municipality}
              </span>
            )}
            {site && (
              <a
                className="dash-biz__line dash-biz__site"
                href={site.url}
                target="_blank"
                rel="noopener noreferrer nofollow"
              >
                <Globe size={13} aria-hidden="true" /> {site.domain ?? site.url}
              </a>
            )}
          </div>
        </div>
      </td>
      <td data-label="Settore">
        {category ? (
          <CategoryBadge category={category.id} label={category.label} />
        ) : (
          <span className="small muted">—</span>
        )}
      </td>
      <td data-label="Contatti" className="dash-contacts">
        {email ? (
          <a href={`mailto:${email}`} className="dash-contact">
            <Mail size={14} aria-hidden="true" />
            <span className="visually-hidden">Email: </span>
            {email}
          </a>
        ) : (
          <span className="dash-contact muted">
            <Mail size={14} aria-hidden="true" /> Email non disponibile
          </span>
        )}
        {b.contacts.phone && (
          <a href={telHref(b.contacts.phone)} className="dash-contact">
            <Phone size={14} aria-hidden="true" />
            <span className="visually-hidden">Telefono: </span>
            {b.contacts.phone}
          </a>
        )}
        {b.contacts.fax && (
          <span className="dash-contact">
            <Printer size={14} aria-hidden="true" />
            <span className="visually-hidden">Fax: </span>
            {b.contacts.fax}
          </span>
        )}
      </td>
      <td data-label="Punteggio">
        {c && !c.exclusion ? (
          <div className="dash-score">
            <span className={`dash-score__value dash-score--${c.score >= 70 ? 'high' : c.score >= 50 ? 'mid' : 'low'}`}>
              {c.score}
            </span>
            <span className="dash-score__text">
              {c.band?.label}
              {c.source === 'rules' && <span className="muted"> · a regole</span>}
            </span>
          </div>
        ) : (
          <span className="small muted">{b.assessment?.label ?? 'Non ancora valutata'}</span>
        )}
      </td>
      <td data-label="Stato">
        {b.contact ? (
          <Status tone={CONTACT_TONE[b.contact.status]}>{b.contact.label}</Status>
        ) : (
          <span className="small muted">—</span>
        )}
      </td>
      <td data-label="Azioni">
        <div className="dash-actions">
          <Button
            disabled={!sendable}
            title={
              !email ? 'Email non disponibile' : !sendable ? 'Contatto non consentito per questa azienda' : undefined
            }
            aria-label={`Invia email a ${b.name}`}
            onClick={() => onCompose(b)}
          >
            <Send size={15} aria-hidden="true" />
            Invia email
          </Button>
          <Link to={`/aziende/${b.id}`} className="btn btn--secondary" aria-label={`Dettagli di ${b.name}`}>
            Dettagli
          </Link>
          <RowMenu
            label={`Altre azioni per ${b.name}`}
            items={[
              { label: 'Apri la scheda', onSelect: () => void navigate(`/aziende/${b.id}`) },
              {
                label: 'Apri sito web',
                disabled: !site,
                onSelect: () => site && window.open(site.url, '_blank', 'noopener,noreferrer'),
              },
              { label: b.excluded ? 'Gestisci contatto' : 'Escludi azienda', onSelect: () => onManage(b) },
            ]}
          />
        </div>
      </td>
    </tr>
  );
}
