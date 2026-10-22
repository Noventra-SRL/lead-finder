import { useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { ApiError, patch, post, type CrmMeta, type FollowUpListItem, type Paged } from '../api/client.ts';
import { CrmTabs } from '../components/CrmControls.tsx';
import { ExportButton } from '../components/ExportButton.tsx';
import { SavedFilters } from '../components/SavedFilters.tsx';
import {
  Button,
  Empty,
  ErrorNotice,
  Field,
  Loading,
  Notice,
  PageHeader,
  Pagination,
  SelectField,
} from '../components/ui.tsx';
import { formatDue, PRIORITY_LABEL, todayRome } from '../lib/crm.ts';
import { formatDateTime } from '../lib/format.ts';
import { useApi } from '../lib/useApi.ts';
import { NAV_ITEMS, navIndex, pageTitle } from '../navigation.ts';

/*
 * Follow-up: filtri per scadenza, stato, priorità e fase dell'opportunità; completare, spostare, annullare.
 * Completare un follow-up non cambia la fase dell'opportunità. I filtri restano nell'indirizzo (e si possono salvare).
 */

const DUE = [
  { id: '', label: 'Tutti' },
  { id: 'overdue', label: 'Scaduti' },
  { id: 'today', label: 'Oggi' },
  { id: 'soon', label: 'Prossimi 7 giorni' },
  { id: 'later', label: 'Più avanti' },
] as const;
const STATUS = [
  { id: '', label: 'Da fare' },
  { id: 'completed', label: 'Completati' },
  { id: 'cancelled', label: 'Annullati' },
  { id: 'all', label: 'Tutti' },
] as const;
const FILTER_KEYS = ['due', 'status', 'priority', 'stage', 'owner'] as const;

/** Indirizzi della Fase 7 (?view=…) tradotti nei filtri attuali. */
function fromLegacy(params: URLSearchParams): URLSearchParams | null {
  const view = params.get('view');
  if (!view) return null;
  const next = new URLSearchParams(params);
  next.delete('view');
  if (view === 'completed' || view === 'cancelled') next.set('status', view);
  else if (view === 'upcoming') next.set('due', 'soon');
  else next.set('due', view);
  return next;
}

function FollowUpRow({ f, today, onDone }: { f: FollowUpListItem; today: string; onDone: () => void }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [moving, setMoving] = useState<string | null>(null);
  const act = async (key: string, fn: () => Promise<unknown>) => {
    setBusy(key);
    setError(null);
    try {
      await fn();
      setMoving(null);
      onDone();
    } catch (e) {
      setError(e instanceof ApiError ? e : new ApiError(0, 'UNKNOWN', 'Operazione non riuscita.'));
    } finally {
      setBusy(null);
    }
  };
  return (
    <li className={`followup${f.overdue ? ' followup--overdue' : ''}`}>
      <div className="followup__when mono small">
        {f.status === 'completed' ? (
          <>Completato {formatDateTime(f.completedAt)}</>
        ) : f.status === 'cancelled' ? (
          <>Annullato {formatDateTime(f.cancelledAt)}</>
        ) : (
          <>
            {f.overdue && <span className="text-danger">Scaduto · </span>}
            {formatDue(f.dueDate, f.dueTime, today)}
          </>
        )}
      </div>
      <div className="followup__what">
        <p>
          <strong>{f.description}</strong>{' '}
          <span className={`small priority priority--${f.priority}`}>
            Priorità {PRIORITY_LABEL[f.priority].toLowerCase()}
          </span>
        </p>
        <p className="small">
          <Link to={`/pipeline/${f.opportunity.id}`}>{f.business.name}</Link>
          <span className="muted">
            {f.business.municipality && ` · ${f.business.municipality}`} · {f.opportunity.stageLabel}
            {f.opportunity.owner && ` · ${f.opportunity.owner}`}
          </span>{' '}
          · <Link to={`/aziende/${f.business.id}`}>scheda azienda</Link>
        </p>
        {f.notes && <p className="small muted">{f.notes}</p>}
        {f.status === 'cancelled' && f.cancelReason === 'opportunity_closed' && (
          <p className="small muted">Annullato perché l’opportunità è stata chiusa.</p>
        )}
        {moving !== null && (
          <div className="row">
            <Field
              label="Nuova scadenza"
              type="date"
              min={todayRome()}
              value={moving}
              onChange={(e) => setMoving(e.target.value)}
            />
            <Button
              variant="secondary"
              busy={busy === 'move'}
              disabled={!moving}
              onClick={() => void act('move', () => patch(`/crm/followups/${f.id}`, { dueDate: moving }))}
            >
              Salva
            </Button>
            <Button variant="ghost" onClick={() => setMoving(null)}>
              Lascia com’è
            </Button>
          </div>
        )}
        {error && <p className="field__error">{error.message}</p>}
      </div>
      {f.status === 'pending' && (
        <div className="row followup__actions">
          <Button
            variant="secondary"
            busy={busy === 'complete'}
            onClick={() => void act('complete', () => post(`/crm/followups/${f.id}/complete`))}
          >
            Completa
          </Button>
          <Button variant="ghost" onClick={() => setMoving(f.dueDate < todayRome() ? todayRome() : f.dueDate)}>
            Sposta
          </Button>
          <Button
            variant="ghost"
            busy={busy === 'cancel'}
            onClick={() => void act('cancel', () => post(`/crm/followups/${f.id}/cancel`))}
          >
            Annulla
          </Button>
        </div>
      )}
    </li>
  );
}

export function CrmFollowUpsPage() {
  const item = NAV_ITEMS.find((i) => i.path === '/pipeline')!;
  const [rawParams, setParams] = useSearchParams();
  const params = fromLegacy(rawParams) ?? rawParams;
  const meta = useApi<CrmMeta>('/crm/meta');
  const page = Number(params.get('page') ?? 1);
  const due = params.get('due') ?? '';
  const status = params.get('status') ?? '';
  const criteria = new URLSearchParams();
  for (const k of FILTER_KEYS) if (params.get(k)) criteria.set(k, params.get(k)!);
  // la scadenza riguarda i follow-up da fare
  const query = new URLSearchParams(criteria);
  query.set('page', String(page));
  const list = useApi<Paged<FollowUpListItem> & { today: string }>(`/crm/followups?${query}`);
  const set = (k: string, v: string | null) => {
    const next = new URLSearchParams(params);
    if (v) next.set(k, v);
    else next.delete(k);
    if (k === 'due' && v) next.delete('status');
    if (k === 'status' && v && v !== '') next.delete('due');
    if (k !== 'page') next.delete('page');
    setParams(next);
  };
  const filtered = FILTER_KEYS.some((k) => params.get(k));

  return (
    <>
      <PageHeader index={navIndex(item.path)} title={pageTitle(item)} lede={item.lede} />
      <CrmTabs current="follow-up" />
      <SavedFilters scope="followups" query={criteria.toString()} basePath="/pipeline/follow-up" />
      <section className="filters" aria-label="Filtri dei follow-up">
        <nav className="segmented" aria-label="Follow-up per scadenza">
          {DUE.map((d) => {
            const next = new URLSearchParams(criteria);
            if (d.id) next.set('due', d.id);
            else next.delete('due');
            if (d.id) next.delete('status');
            return (
              <Link
                key={d.id}
                to={`?${next}`}
                aria-current={due === d.id && (!d.id ? !status : true) ? 'page' : undefined}
              >
                {d.label}
              </Link>
            );
          })}
        </nav>
        <div className="filters__row">
          <SelectField label="Stato" value={status} onChange={(e) => set('status', e.target.value || null)}>
            {STATUS.map((s) => (
              <option key={s.id} value={s.id}>
                {s.label}
              </option>
            ))}
          </SelectField>
          <SelectField
            label="Priorità"
            value={params.get('priority') ?? ''}
            onChange={(e) => set('priority', e.target.value || null)}
          >
            <option value="">Tutte</option>
            <option value="alta">Alta</option>
            <option value="media">Media</option>
            <option value="bassa">Bassa</option>
          </SelectField>
          <SelectField
            label="Fase dell’opportunità"
            value={params.get('stage') ?? ''}
            onChange={(e) => set('stage', e.target.value || null)}
          >
            <option value="">Tutte</option>
            {meta.data?.stages.map((s) => (
              <option key={s.id} value={s.id}>
                {s.label}
              </option>
            ))}
          </SelectField>
          <label className="check check--inline filters__check">
            <input
              type="checkbox"
              checked={params.get('owner') === 'me'}
              onChange={(e) => set('owner', e.target.checked ? 'me' : null)}
            />
            <span>Solo le mie opportunità</span>
          </label>
        </div>
        {filtered && (
          <p>
            <button type="button" className="link-button" onClick={() => setParams(new URLSearchParams())}>
              Azzera i filtri
            </button>
          </p>
        )}
      </section>
      {due === 'overdue' && list.data && list.data.total > 0 && (
        <Notice tone="warn">
          <p>Questi follow-up hanno superato la scadenza: completali, spostali a una nuova data o annullali.</p>
        </Notice>
      )}
      {list.loading && !list.data && <Loading />}
      {list.error && <ErrorNotice error={list.error} onRetry={list.reload} />}
      {list.data && list.data.total === 0 && (
        <Empty title={filtered ? 'Nessun follow-up con questi filtri' : 'Nessun follow-up da fare'}>
          {due === 'overdue'
            ? 'Nessun follow-up scaduto.'
            : 'I follow-up si pianificano dalla scheda di un’opportunità o di un’azienda.'}
        </Empty>
      )}
      {list.data && list.data.total > 0 && (
        <>
          <div className="row between">
            <p className="small muted results-count" aria-live="polite">
              <span className="mono">{list.data.total}</span> follow-up
              {list.loading && ' · aggiornamento…'}
            </p>
            <ExportButton dataset="followups" query={criteria.toString()} total={list.data.total} name="follow_up" />
          </div>
          <ol className="followup-list">
            {list.data.items.map((f) => (
              <FollowUpRow key={f.id} f={f} today={list.data!.today} onDone={list.reload} />
            ))}
          </ol>
          <Pagination
            page={page}
            pageSize={list.data.pageSize}
            total={list.data.total}
            onPage={(p) => set('page', String(p))}
          />
        </>
      )}
    </>
  );
}
