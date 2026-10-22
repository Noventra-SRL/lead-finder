import { useState, type FormEvent } from 'react';
import { Link, useSearchParams } from 'react-router';
import {
  ApiError,
  post,
  type BusinessSummary,
  type EmailList,
  type EmailMeta,
  type EmailStatus,
  type Paged,
  type SendingStatus,
} from '../api/client.ts';
import { EmailComposer } from '../components/EmailComposer.tsx';
import { ProspectTable } from '../components/ProspectTable.tsx';
import { useUser } from '../auth/AuthContext.tsx';
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
import { formatDateTime, formatRelative } from '../lib/format.ts';
import { useApi } from '../lib/useApi.ts';
import { NAV_ITEMS, navIndex, pageTitle } from '../navigation.ts';

/*
 * Email commerciali (Fase 9): bozze, email da revisionare, pronte, inviate, non riuscite, archiviate.
 * Aprire questa pagina non genera e non invia nulla.
 */

const FILTERS: { id: EmailStatus | 'all'; label: string }[] = [
  { id: 'all', label: 'Tutte' },
  { id: 'draft', label: 'Bozze' },
  { id: 'review', label: 'Da revisionare' },
  { id: 'ready', label: 'Pronte per l’invio' },
  { id: 'sent', label: 'Inviate' },
  { id: 'failed', label: 'Invio non riuscito' },
  { id: 'archived', label: 'Archiviate' },
];

const SORTS = [
  { id: 'updated', label: 'Ultima modifica' },
  { id: 'created', label: 'Data di creazione' },
  { id: 'sent', label: 'Data di invio' },
  { id: 'business', label: 'Azienda (A–Z)' },
  { id: 'status', label: 'Stato' },
] as const;

export const STATUS_TONE: Record<EmailStatus, 'ok' | 'warn' | 'danger' | 'idle'> = {
  draft: 'idle',
  review: 'warn',
  ready: 'ok',
  sending: 'warn',
  sent: 'ok',
  failed: 'danger',
  archived: 'idle',
};

const SENDING_TONE: Record<SendingStatus['state'], 'ok' | 'warn' | 'danger' | 'idle'> = {
  ready: 'ok',
  missing: 'idle',
  verification_needed: 'warn',
  provider_error: 'danger',
};

/** Stato della configurazione dell'invio, con la verifica della connessione per gli amministratori. */
export function SendingStatusBar({ status, onChange }: { status: SendingStatus; onChange?: () => void }) {
  const user = useUser();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <section className="sending-status" aria-label="Configurazione dell’invio">
      <Status tone={SENDING_TONE[status.state]}>{status.label}</Status>
      <p className="small">
        {status.from && (
          <>
            Mittente:{' '}
            <span className="mono">
              {status.from.name} &lt;{status.from.address}&gt;
            </span>
            .{' '}
          </>
        )}
        {status.explanation}
      </p>
      {user.role === 'admin' && status.state !== 'missing' && (
        <Button
          variant="ghost"
          busy={busy}
          onClick={() => {
            setBusy(true);
            setError(null);
            post('/email/verify')
              .then(() => onChange?.())
              .catch((e: unknown) => setError(e instanceof ApiError ? e.message : 'Verifica non riuscita.'))
              .finally(() => setBusy(false));
          }}
        >
          Verifica connessione
        </Button>
      )}
      {error && <p className="field__error">{error}</p>}
    </section>
  );
}

/** Storico dei messaggi: bozze, inviate, non riuscite, archiviate (con ricerca e ordinamento). */
function HistoryView() {
  const [params, setParams] = useSearchParams();
  const [q, setQ] = useState(params.get('q') ?? '');
  const status = (FILTERS.find((f) => f.id === params.get('status'))?.id ?? 'all') as EmailStatus | 'all';
  const sort = SORTS.find((s) => s.id === params.get('sort'))?.id ?? 'updated';
  const dir = params.get('dir') ?? (sort === 'business' ? 'asc' : 'desc');
  const page = Number(params.get('page') ?? 1);
  const query = new URLSearchParams({ status, sort, dir, page: String(page) });
  if (params.get('q')) query.set('q', params.get('q')!);
  const list = useApi<EmailList>(`/emails?${query}`);
  const update = (changes: Record<string, string | null>) => {
    const next = new URLSearchParams(params);
    for (const [k, v] of Object.entries(changes)) {
      if (v) next.set(k, v);
      else next.delete(k);
    }
    if (!('page' in changes)) next.delete('page');
    setParams(next);
  };

  return (
    <>
      <section className="filters" aria-label="Filtri delle email">
        <nav className="segmented" aria-label="Email per stato">
          {FILTERS.map((f) => {
            const next = new URLSearchParams(params);
            next.set('vista', 'storico');
            if (f.id === 'all') next.delete('status');
            else next.set('status', f.id);
            next.delete('page');
            const count = list.data ? (list.data.counts[f.id] ?? 0) : undefined;
            return (
              <Link key={f.id} to={`?${next}`} aria-current={status === f.id ? 'page' : undefined}>
                {f.label} {count !== undefined && <span className="mono">{count}</span>}
              </Link>
            );
          })}
        </nav>
        <div className="filters__row">
          <form
            className="filters__search"
            role="search"
            onSubmit={(e: FormEvent) => {
              e.preventDefault();
              update({ q: q.trim() || null });
            }}
          >
            <Field
              label="Cerca per azienda, oggetto o destinatario"
              type="search"
              value={q}
              maxLength={100}
              onChange={(e) => setQ(e.target.value)}
            />
            <Button type="submit" variant="secondary">
              Cerca
            </Button>
          </form>
          <SelectField label="Ordina per" value={sort} onChange={(e) => update({ sort: e.target.value, dir: null })}>
            {SORTS.map((s) => (
              <option key={s.id} value={s.id}>
                {s.label}
              </option>
            ))}
          </SelectField>
        </div>
      </section>

      {list.loading && !list.data && <Loading />}
      {list.error && <ErrorNotice error={list.error} onRetry={list.reload} />}
      {list.data && list.data.total === 0 && (
        <Empty title={params.get('q') || status !== 'all' ? 'Nessuna email con questi filtri' : 'Ancora nessuna email'}>
          Scegli un’azienda e crea una bozza dal modello commerciale standard di Noventra.{' '}
          <Link to="/email/nuova">Nuova email</Link>
        </Empty>
      )}
      {list.data && list.data.total > 0 && (
        <>
          <div className="table-wrap">
            <table className="table table--stack">
              <thead>
                <tr>
                  <th scope="col">Azienda</th>
                  <th scope="col">Oggetto</th>
                  <th scope="col">Destinatario</th>
                  <th scope="col">Stato</th>
                  <th scope="col">Data</th>
                </tr>
              </thead>
              <tbody>
                {list.data.items.map((e) => (
                  <tr key={e.id}>
                    <td data-label="Azienda">
                      <Link to={`/email/${e.id}`}>{e.businessName}</Link>
                    </td>
                    <td data-label="Oggetto">{e.subject || <span className="muted">Senza oggetto</span>}</td>
                    <td data-label="Destinatario" className="mono small">
                      {e.recipient ?? <span className="muted">—</span>}
                    </td>
                    <td data-label="Stato">
                      <Status tone={STATUS_TONE[e.status]}>{e.statusLabel}</Status>
                      {e.mode === 'ai' && <span className="small muted"> · AI</span>}
                    </td>
                    <td data-label="Data" className="small">
                      {e.sentAt ? (
                        <>Inviata {formatDateTime(e.sentAt)}</>
                      ) : (
                        <time dateTime={e.updatedAt}>Modificata {formatRelative(e.updatedAt)}</time>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <Pagination
            page={page}
            pageSize={list.data.pageSize}
            total={list.data.total}
            onPage={(p) => update({ page: String(p) })}
          />
        </>
      )}
      <p className="small muted email-legal">
        Un recapito pubblico non autorizza automaticamente l’invio di comunicazioni commerciali: prima di ogni invio
        verifica che il contatto sia lecito secondo le norme italiane ed europee su privacy e marketing elettronico
        (GDPR, Codice privacy). Nessuna email parte senza la tua conferma; nessun invio massivo o automatico.
      </p>
    </>
  );
}

// ---------------------------------------------------------------- spazio di lavoro

const VIEWS = [
  { id: 'da-contattare', label: 'Da contattare' },
  { id: 'in-attesa', label: 'In attesa' },
  { id: 'storico', label: 'Storico' },
] as const;
type View = (typeof VIEWS)[number]['id'];

/**
 * Potenziali clienti per stato di contatto (dai dati salvati): «Da contattare» (nessun contatto, con email per
 * impostazione) oppure «In attesa» (contattati, in attesa di risposta).
 */
function ProspectView({ view }: { view: 'da-contattare' | 'in-attesa' }) {
  const [params, setParams] = useSearchParams();
  const [q, setQ] = useState(params.get('q') ?? '');
  const [composeFor, setComposeFor] = useState<BusinessSummary | null>(null);
  const page = Number(params.get('page') ?? 1);
  const withoutEmail = params.get('senzaEmail') === '1';
  const query = new URLSearchParams({
    contactStatus: view === 'da-contattare' ? 'da_contattare' : 'in_attesa',
    sort: view === 'da-contattare' ? 'commercial' : 'lastContact',
    dir: 'desc',
    page: String(page),
    pageSize: '25',
  });
  if (view === 'da-contattare' && !withoutEmail) query.set('email', 'yes');
  if (params.get('q')) query.set('q', params.get('q')!);
  const list = useApi<Paged<BusinessSummary>>(`/businesses?${query}`);
  const update = (changes: Record<string, string | null>) => {
    const next = new URLSearchParams(params);
    for (const [k, v] of Object.entries(changes)) {
      if (v) next.set(k, v);
      else next.delete(k);
    }
    if (!('page' in changes)) next.delete('page');
    setParams(next);
  };
  return (
    <>
      <section className="filters filters--compact" aria-label="Filtri">
        <div className="filters__row">
          <form
            className="filters__search"
            role="search"
            onSubmit={(e: FormEvent) => {
              e.preventDefault();
              update({ q: q.trim() || null });
            }}
          >
            <Field
              label="Cerca un’azienda"
              type="search"
              value={q}
              maxLength={100}
              onChange={(e) => setQ(e.target.value)}
            />
            <Button type="submit" variant="secondary">
              Cerca
            </Button>
          </form>
          {view === 'da-contattare' && (
            <label className="check check--inline filters__check">
              <input
                type="checkbox"
                checked={withoutEmail}
                onChange={(e) => update({ senzaEmail: e.target.checked ? '1' : null })}
              />
              <span>Mostra anche le aziende senza email</span>
            </label>
          )}
        </div>
      </section>
      {list.loading && !list.data && <Loading />}
      {list.error && <ErrorNotice error={list.error} onRetry={list.reload} />}
      {list.data && list.data.total === 0 && (
        <Empty title={view === 'da-contattare' ? 'Nessuna azienda da contattare' : 'Nessuna risposta in attesa'}>
          {view === 'da-contattare' ? (
            <>
              Trova nuove aziende da <Link to="/trova">Trova aziende</Link>.
            </>
          ) : (
            'Le aziende a cui hai scritto compaiono qui finché la trattativa non va avanti.'
          )}
        </Empty>
      )}
      {list.data && list.data.total > 0 && (
        <>
          <p className="small muted results-count" aria-live="polite">
            <span className="mono">{list.data.total.toLocaleString('it-IT')}</span>{' '}
            {list.data.total === 1 ? 'azienda' : 'aziende'}
            {view === 'da-contattare'
              ? ' da contattare, in ordine di punteggio commerciale'
              : ' in attesa di risposta, dalla più recente'}
          </p>
          <ProspectTable
            items={list.data.items}
            onCompose={setComposeFor}
            caption={view === 'da-contattare' ? 'Aziende da contattare' : 'Aziende in attesa di risposta'}
            waiting={view === 'in-attesa'}
          />
          <Pagination
            page={page}
            pageSize={list.data.pageSize}
            total={list.data.total}
            onPage={(p) => update({ page: String(p) })}
          />
        </>
      )}
      {composeFor && <EmailComposer business={composeFor} onClose={() => setComposeFor(null)} onSent={list.reload} />}
    </>
  );
}

export function EmailListPage() {
  const item = NAV_ITEMS.find((i) => i.path === '/email')!;
  const [params] = useSearchParams();
  const meta = useApi<EmailMeta>('/emails/meta');
  // indirizzi della Fase 9 (?status=…) aprono lo storico
  const view = (VIEWS.find((v) => v.id === params.get('vista'))?.id ??
    (params.get('status') ? 'storico' : 'da-contattare')) as View;
  return (
    <>
      <div className="page-head-row">
        <PageHeader index={navIndex(item.path)} title={pageTitle(item)} lede={item.lede} />
        <Link to="/email/nuova" className="btn btn--secondary">
          Nuova email
        </Link>
      </div>
      {meta.data && <SendingStatusBar status={meta.data.sending} onChange={meta.reload} />}
      <nav className="tabs" aria-label="Viste delle email">
        {VIEWS.map((v) => (
          <Link
            key={v.id}
            to={`?vista=${v.id}`}
            className="tabs__item"
            aria-current={view === v.id ? 'page' : undefined}
          >
            {v.label}
          </Link>
        ))}
      </nav>
      {view === 'storico' ? <HistoryView /> : <ProspectView key={view} view={view} />}
      <p className="small">
        <Link to="/pipeline">Trattative (fasi, attività e follow-up)</Link> · <Link to="/promemoria">Promemoria</Link>
      </p>
    </>
  );
}
