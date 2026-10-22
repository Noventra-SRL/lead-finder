import { useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import {
  ApiError,
  post,
  type CrmBoard,
  type CrmDashboard,
  type CrmMeta,
  type HunterMeta,
  type StageId,
} from '../api/client.ts';
import { CrmTabs, OpportunityCardView } from '../components/CrmControls.tsx';
import { Empty, ErrorNotice, Field, Loading, Notice, PageHeader, Section, SelectField } from '../components/ui.tsx';
import { formatEuro } from '../lib/crm.ts';
import { useApi } from '../lib/useApi.ts';
import { NAV_ITEMS, navIndex, pageTitle } from '../navigation.ts';

/*
 * Pipeline commerciale: numeri della pipeline (dal database) e Kanban per fase.
 * Le schede si spostano con il menu "Sposta in" (sempre disponibile, anche da tastiera e su telefono) oppure
 * trascinandole su un'altra colonna; chiudere un'opportunità chiede sempre conferma.
 */

function Metrics({ d }: { d: CrmDashboard }) {
  const item = (label: string, value: string | number, to: string | null, note?: string, alert = false) => (
    <div className={`crm-metric${alert ? ' crm-metric--alert' : ''}`}>
      <dt>{to ? <Link to={to}>{label}</Link> : label}</dt>
      <dd>
        <span className="crm-metric__value mono">{value}</span>
        {note && <span className="crm-metric__note">{note}</span>}
      </dd>
    </div>
  );
  return (
    <>
      <dl className="crm-metrics">
        {item('Opportunità aperte', d.active, '/pipeline/elenco')}
        {item('Da qualificare', d.toQualify, '/pipeline/elenco?stage=da_qualificare')}
        {item('Pronte da contattare', d.readyToContact, '/pipeline/elenco?stage=da_contattare')}
        {item('Follow-up di oggi', d.followUps.today, '/pipeline/follow-up?view=today')}
        {item(
          'Follow-up scaduti',
          d.followUps.overdue,
          '/pipeline/follow-up?view=overdue',
          d.followUps.overdue ? 'da recuperare' : undefined,
          d.followUps.overdue > 0,
        )}
        {item('Appuntamenti fissati', d.meetings, '/pipeline/elenco?stage=appuntamento')}
        {item('Preventivi inviati', d.quotes, '/pipeline/elenco?stage=preventivo')}
        {item('Vinte', d.won, '/pipeline/elenco?stage=vinto&state=closed')}
        {item('Perse', d.lost, '/pipeline/elenco?stage=perso&state=closed')}
        {item(
          'Valore pipeline attiva',
          d.activeValue.euro === null ? '—' : formatEuro(d.activeValue.euro),
          null,
          d.activeValue.euro === null
            ? 'nessun valore stimato inserito'
            : `su ${d.activeValue.withValue} di ${d.active} aperte`,
        )}
        {item(
          'Valore vinto',
          d.wonValue.euro === null ? '—' : formatEuro(d.wonValue.euro),
          null,
          d.wonValue.euro === null ? 'nessun valore registrato' : `su ${d.wonValue.withValue} vinte`,
        )}
      </dl>
      <details className="crm-definitions small">
        <summary>Come si calcolano</summary>
        <ul>
          <li>Aperte: tutte le opportunità tranne Vinto, Perso e Non contattare.</li>
          <li>
            Follow-up: azioni in attesa di opportunità aperte; «scaduti» ha una data precedente a oggi (ora italiana).
          </li>
          <li>Appuntamenti e preventivi: opportunità che si trovano ora in quella fase.</li>
          <li>
            Valori: somma dei valori stimati inseriti a mano. Vinte e perse non entrano nel valore della pipeline
            attiva. Nessun valore è calcolato o stimato dal sistema.
          </li>
        </ul>
      </details>
    </>
  );
}

function Board({ meta, filters, onChanged }: { meta: CrmMeta; filters: string; onChanged: () => void }) {
  const board = useApi<CrmBoard>(`/crm/board?perStage=20${filters ? `&${filters}` : ''}`);
  const [over, setOver] = useState<StageId | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [showClosed, setShowClosed] = useState(false);

  async function drop(stage: StageId, data: string) {
    setOver(null);
    let moved: { id: string; stage: StageId };
    try {
      moved = JSON.parse(data) as { id: string; stage: StageId };
    } catch {
      return;
    }
    if (moved.stage === stage) return;
    // le fasi di chiusura chiedono conferma (e il motivo): si usa il menu della scheda
    if (meta.stages.find((s) => s.id === stage)?.closed) {
      setError(
        new ApiError(
          0,
          'USE_MENU',
          'Per chiudere un’opportunità usa il menu «Sposta in» della scheda: serve una conferma.',
        ),
      );
      return;
    }
    try {
      await post(`/crm/opportunities/${moved.id}/stage`, { stage });
      setError(null);
      board.reload();
      onChanged();
    } catch (e) {
      setError(e instanceof ApiError ? e : new ApiError(0, 'UNKNOWN', 'Spostamento non riuscito.'));
    }
  }

  if (board.loading && !board.data) return <Loading />;
  if (board.error) return <ErrorNotice error={board.error} onRetry={board.reload} />;
  if (!board.data) return null;
  const columns = board.data.stages.filter((s) => showClosed || !s.closed);
  const totalOpen = board.data.stages.filter((s) => !s.closed).reduce((n, s) => n + s.total, 0);
  return (
    <>
      {error && <Notice tone={error.code === 'USE_MENU' ? 'warn' : 'error'}>{error.message}</Notice>}
      <div className="row between board-head">
        <p className="small muted">
          <span className="mono">{totalOpen}</span> opportunità aperte. Scadute per prime in ogni colonna, poi per
          scadenza e punteggio.
        </p>
        <label className="check check--inline">
          <input type="checkbox" checked={showClosed} onChange={(e) => setShowClosed(e.target.checked)} />
          <span>Mostra anche vinte, perse e non contattare</span>
        </label>
      </div>
      {/* la pipeline scorre in orizzontale: raggiungibile da tastiera per scorrerla con le frecce */}
      <div className="board" role="list" aria-label="Pipeline per fase" tabIndex={0}>
        {columns.map((col) => (
          <section
            key={col.id}
            role="listitem"
            className={`board__col${over === col.id ? ' board__col--over' : ''}${col.closed ? ' board__col--closed' : ''}`}
            aria-label={`${col.label}: ${col.total}`}
            onDragOver={(e) => {
              if (e.dataTransfer.types.includes('text/x-opportunity')) {
                e.preventDefault();
                setOver(col.id);
              }
            }}
            onDragLeave={() => setOver((cur) => (cur === col.id ? null : cur))}
            onDrop={(e) => {
              e.preventDefault();
              void drop(col.id, e.dataTransfer.getData('text/x-opportunity'));
            }}
          >
            <h2 className={`board__title board__title--${col.id}`}>
              {col.label} <span className="board__count">{col.total}</span>
            </h2>
            {col.items.length === 0 ? (
              <p className="small muted board__empty">Nessuna opportunità.</p>
            ) : (
              col.items.map((o) => (
                <OpportunityCardView
                  key={o.id}
                  o={o}
                  meta={meta}
                  today={board.data!.today}
                  onChanged={() => {
                    board.reload();
                    onChanged();
                  }}
                  draggable
                />
              ))
            )}
            {col.total > col.items.length && (
              <p className="small">
                <Link
                  to={`/pipeline/elenco?stage=${col.id}${col.closed ? '&state=closed' : ''}${filters ? `&${filters}` : ''}`}
                >
                  Tutte le {col.total} nell’elenco
                </Link>
              </p>
            )}
          </section>
        ))}
      </div>
    </>
  );
}

export function CrmPage() {
  const item = NAV_ITEMS.find((i) => i.path === '/pipeline')!;
  const [params, setParams] = useSearchParams();
  const meta = useApi<CrmMeta>('/crm/meta');
  const hunter = useApi<HunterMeta>('/hunter/meta');
  const dash = useApi<CrmDashboard>('/crm/dashboard');
  const [q, setQ] = useState(params.get('q') ?? '');
  const filters = new URLSearchParams();
  for (const k of ['q', 'owner', 'crmPriority', 'sector']) if (params.get(k)) filters.set(k, params.get(k)!);
  const set = (k: string, v: string) => {
    const next = new URLSearchParams(params);
    if (v) next.set(k, v);
    else next.delete(k);
    setParams(next);
  };

  return (
    <>
      <PageHeader index={navIndex(item.path)} title={pageTitle(item)} lede={item.lede} />
      <CrmTabs current="pipeline" />
      <Section title="Situazione" description="Contati sulle opportunità salvate. Nessun valore è stimato dal sistema.">
        {dash.loading && !dash.data && <Loading />}
        {dash.error && <ErrorNotice error={dash.error} onRetry={dash.reload} />}
        {dash.data && dash.data.total === 0 ? (
          <Empty title="Nessuna opportunità ancora">
            Le opportunità nascono dalle aziende: dall’<Link to="/aziende">elenco delle aziende</Link> seleziona quelle
            da seguire e scegli «Aggiungi al CRM», oppure aprile dalla scheda di un’azienda.
          </Empty>
        ) : (
          dash.data && <Metrics d={dash.data} />
        )}
      </Section>
      <Section
        title="Pipeline"
        description="Sposta le opportunità con il menu della scheda o trascinandole su un’altra fase."
      >
        <form
          className="filters__row board-filters"
          role="search"
          onSubmit={(e) => {
            e.preventDefault();
            set('q', q.trim());
          }}
        >
          <Field
            label="Cerca azienda, comune o dominio"
            type="search"
            value={q}
            maxLength={100}
            onChange={(e) => setQ(e.target.value)}
            onBlur={() => set('q', q.trim())}
          />
          <SelectField
            label="Responsabile"
            value={params.get('owner') ?? ''}
            onChange={(e) => set('owner', e.target.value)}
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
          <SelectField
            label="Priorità commerciale"
            value={params.get('crmPriority') ?? ''}
            onChange={(e) => set('crmPriority', e.target.value)}
          >
            <option value="">Tutte</option>
            {meta.data?.priorities.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
              </option>
            ))}
          </SelectField>
          <SelectField
            label="Settore"
            value={params.get('sector') ?? ''}
            onChange={(e) => set('sector', e.target.value)}
          >
            <option value="">Tutti</option>
            {hunter.data?.sectors.map((s) => (
              <option key={s.id} value={s.id}>
                {s.label}
              </option>
            ))}
          </SelectField>
        </form>
        {meta.error && <ErrorNotice error={meta.error} onRetry={meta.reload} />}
        {meta.data && <Board meta={meta.data} filters={filters.toString()} onChanged={dash.reload} />}
      </Section>
    </>
  );
}
