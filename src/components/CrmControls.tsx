import { useState } from 'react';
import { Link } from 'react-router';
import { ApiError, post, type CrmMeta, type OpportunityCard, type StageId } from '../api/client.ts';
import { dueText, formatEuro, PRIORITY_LABEL } from '../lib/crm.ts';
import { formatRelative } from '../lib/format.ts';
import { ConfirmDialog, Notice, TextAreaField } from './ui.tsx';

/* Controlli condivisi del CRM (Fase 7): cambio di fase, schede del Kanban, schede di navigazione. */

const CLOSE_TEXT: Partial<Record<StageId, string>> = {
  vinto: 'L’opportunità viene chiusa come vinta. I follow-up in attesa vengono annullati.',
  perso: 'L’opportunità viene chiusa come persa. I follow-up in attesa vengono annullati.',
  non_contattare:
    'L’azienda viene esclusa dalla prospezione: non comparirà negli elenchi, nelle esportazioni e nelle nuove ricerche. I follow-up in attesa vengono annullati.',
};

/**
 * Cambio di fase esplicito. Le fasi aperte si applicano subito; chiudere (vinto, perso, non contattare) chiede
 * conferma e, per "perso", il motivo. Ogni cambio finisce nella cronologia.
 */
export function StageControl({
  opportunity,
  meta,
  onDone,
  label = 'Fase',
  hideLabel = false,
}: {
  opportunity: { id: string; stage: StageId; business: { name: string } };
  meta: CrmMeta;
  onDone: () => void;
  label?: string;
  hideLabel?: boolean;
}) {
  const [pending, setPending] = useState<StageId | null>(null);
  const [reason, setReason] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const closed = (s: StageId) => meta.stages.find((x) => x.id === s)?.closed ?? false;

  async function apply(stage: StageId) {
    setBusy(true);
    setError(null);
    try {
      await post(`/crm/opportunities/${opportunity.id}/stage`, {
        stage,
        ...(stage === 'perso' ? { lostReason: reason.trim() } : {}),
        ...(note.trim() ? { note: note.trim() } : {}),
      });
      setPending(null);
      setReason('');
      setNote('');
      onDone();
    } catch (e) {
      setError(e instanceof ApiError ? e : new ApiError(0, 'UNKNOWN', 'Cambio di fase non riuscito.'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="stage-control">
      <label className={hideLabel ? 'visually-hidden' : 'field__label'} htmlFor={`stage-${opportunity.id}`}>
        {hideLabel ? `${label}: ${opportunity.business.name}` : label}
      </label>
      <select
        id={`stage-${opportunity.id}`}
        className="input select"
        value={opportunity.stage}
        disabled={busy}
        onChange={(e) => {
          const next = e.target.value as StageId;
          if (closed(next)) setPending(next);
          else void apply(next);
        }}
      >
        {meta.stages.map((s) => (
          <option key={s.id} value={s.id}>
            {s.label}
          </option>
        ))}
      </select>
      {error && !pending && <p className="field__error">{error.message}</p>}
      <ConfirmDialog
        open={pending !== null}
        title={pending ? `Chiudere come «${meta.stages.find((s) => s.id === pending)?.label}»?` : ''}
        confirmLabel="Conferma"
        tone={pending === 'vinto' ? 'primary' : 'danger'}
        busy={busy}
        confirmDisabled={pending === 'perso' && !reason.trim()}
        onConfirm={() => pending && void apply(pending)}
        onCancel={() => {
          setPending(null);
          setError(null);
        }}
      >
        <div className="stack">
          <p>
            <strong>{opportunity.business.name}</strong>. {pending ? CLOSE_TEXT[pending] : ''}
          </p>
          {pending === 'perso' && (
            <TextAreaField
              label="Motivo (obbligatorio)"
              value={reason}
              maxLength={500}
              onChange={(e) => setReason(e.target.value)}
              hint="Es. ha già un fornitore, budget non disponibile, nessuna risposta dopo più tentativi."
            />
          )}
          <TextAreaField
            label="Nota (facoltativa)"
            value={note}
            maxLength={1000}
            onChange={(e) => setNote(e.target.value)}
          />
          {error && <Notice tone="error">{error.message}</Notice>}
        </div>
      </ConfirmDialog>
    </div>
  );
}

/** Scheda di un'opportunità nel Kanban: le informazioni per decidere il prossimo passo, nient'altro. */
export function OpportunityCardView({
  o,
  meta,
  today,
  onChanged,
  draggable,
}: {
  o: OpportunityCard;
  meta: CrmMeta;
  today: string;
  onChanged: () => void;
  draggable: boolean;
}) {
  const b = o.business;
  const place = [b.place.municipality, b.place.region].filter(Boolean).join(', ');
  const commercial = b.commercial;
  const services = o.services.length
    ? o.services
    : (o.recommended ?? []).map((s) => ({ id: s.serviceId, name: s.name }));
  const attention = o.nextFollowUp?.overdue || (o.open && !o.nextFollowUp);
  return (
    <article
      className={`opp-card${o.nextFollowUp?.overdue ? ' opp-card--overdue' : ''}`}
      draggable={draggable}
      onDragStart={(e) => {
        e.dataTransfer.setData('text/x-opportunity', JSON.stringify({ id: o.id, stage: o.stage }));
        e.dataTransfer.effectAllowed = 'move';
      }}
      aria-label={b.name}
    >
      <h3 className="opp-card__name">
        <Link to={`/pipeline/${o.id}`}>{b.name}</Link>
      </h3>
      <p className="small muted">
        {b.sector?.label ?? b.categoryLabel}
        {place && ` · ${place}`}
      </p>
      <p className="opp-card__facts small">
        <span title="Punteggio commerciale: valutazione AI, altrimenti punteggio a regole. Una priorità, non una probabilità di vendita">
          Punteggio <span className="mono">{commercial && !commercial.exclusion ? commercial.score : '—'}</span>
          {commercial && <span className="muted"> {commercial.source === 'ai' ? 'AI' : 'regole'}</span>}
        </span>
        <span>Priorità {PRIORITY_LABEL[o.priority].toLowerCase()}</span>
        {o.estimatedValue !== null && <span className="mono">{formatEuro(o.estimatedValue)}</span>}
      </p>
      {services.length > 0 && (
        <p className="small opp-card__services">
          {o.services.length ? 'Proposti: ' : 'Consigliati: '}
          {services
            .slice(0, 2)
            .map((s) => s.name)
            .join(', ')}
          {services.length > 2 && ` +${services.length - 2}`}
        </p>
      )}
      <p className={`small opp-card__next${attention ? ' opp-card__next--attention' : ''}`}>
        {o.nextFollowUp
          ? `${dueText(o.nextFollowUp, today)} — ${o.nextFollowUp.description}`
          : o.open
            ? 'Nessuna prossima azione'
            : o.stageLabel}
      </p>
      {o.lastActivity && (
        <p className="small muted">
          Ultima attività: {o.lastActivity.summary} ·{' '}
          <time dateTime={o.lastActivity.occurredAt}>{formatRelative(o.lastActivity.occurredAt)}</time>
        </p>
      )}
      <StageControl opportunity={o} meta={meta} onDone={onChanged} label="Sposta in" hideLabel />
    </article>
  );
}

export function CrmTabs({ current }: { current: 'pipeline' | 'elenco' | 'follow-up' }) {
  const tab = (key: typeof current, to: string, label: string) => (
    <Link to={to} className="tabs__item" aria-current={current === key ? 'page' : undefined}>
      {label}
    </Link>
  );
  return (
    <nav className="tabs" aria-label="Viste del CRM">
      {tab('pipeline', '/pipeline', 'Pipeline')}
      {tab('elenco', '/pipeline/elenco', 'Elenco')}
      {tab('follow-up', '/pipeline/follow-up', 'Follow-up')}
    </nav>
  );
}
