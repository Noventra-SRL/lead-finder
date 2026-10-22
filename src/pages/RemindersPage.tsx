import { useState } from 'react';
import { Link } from 'react-router';
import { ApiError, post, type ReminderItem, type Reminders } from '../api/client.ts';
import { Button, Empty, ErrorNotice, Loading, PageHeader } from '../components/ui.tsx';
import { formatDue, PRIORITY_LABEL } from '../lib/crm.ts';
import { formatRelative } from '../lib/format.ts';
import { useApi } from '../lib/useApi.ts';

/*
 * Promemoria dei follow-up (Fase 8): solo nell'applicazione. Il server li aggiorna ogni 5 minuti e quando si apre
 * questa pagina (al più una volta al minuto); lo stesso evento non genera due promemoria. Nessuna email, SMS o
 * messaggio: con l'applicazione chiusa non arriva nulla.
 */

const KIND = {
  followup_overdue: 'Scaduto',
  followup_due_soon: 'In scadenza',
} as const;

function Row({ r, today, onDone }: { r: ReminderItem; today: string; onDone: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <li
      className={`reminder${r.read ? ' reminder--read' : ''}${r.kind === 'followup_overdue' ? ' reminder--overdue' : ''}`}
    >
      <p className="reminder__kind small">
        <span className={r.kind === 'followup_overdue' ? 'text-danger' : undefined}>{KIND[r.kind]}</span>
        <span className="muted"> · {formatDue(r.followUp.dueDate, r.followUp.dueTime, today)}</span>
      </p>
      <div className="reminder__what">
        <p>
          <strong>{r.followUp.description}</strong>{' '}
          <span className={`small priority priority--${r.followUp.priority}`}>
            Priorità {PRIORITY_LABEL[r.followUp.priority].toLowerCase()}
          </span>
        </p>
        <p className="small">
          <Link to={`/pipeline/${r.opportunity.id}`}>{r.business.name}</Link>
          <span className="muted"> · {r.opportunity.stageLabel}</span> ·{' '}
          <Link to={`/aziende/${r.business.id}`}>scheda azienda</Link>
          <span className="muted"> · avviso {formatRelative(r.createdAt)}</span>
        </p>
        {error && <p className="field__error">{error}</p>}
      </div>
      {!r.read && (
        <Button
          variant="ghost"
          busy={busy}
          onClick={() => {
            setBusy(true);
            setError(null);
            post(`/notifications/${r.id}/read`)
              .then(onDone)
              .catch((e: unknown) => setError(e instanceof ApiError ? e.message : 'Operazione non riuscita.'))
              .finally(() => setBusy(false));
          }}
        >
          Segna come letto
        </Button>
      )}
    </li>
  );
}

export function RemindersPage() {
  const list = useApi<Reminders>('/notifications?limit=100');
  const [busy, setBusy] = useState(false);
  return (
    <>
      <p className="breadcrumb">
        <Link to="/pipeline/follow-up">Follow-up</Link> / Promemoria
      </p>
      <PageHeader
        title="Promemoria"
        lede="Follow-up delle tue opportunità scaduti o in scadenza (oggi e domani). Solo nell’applicazione: nessuna email, SMS o messaggio viene inviato, né a te né alle aziende."
      />
      {list.loading && !list.data && <Loading />}
      {list.error && <ErrorNotice error={list.error} onRetry={list.reload} />}
      {list.data && list.data.items.length === 0 && (
        <Empty title="Nessun promemoria">
          Quando un follow-up di cui sei responsabile scade o è in scadenza, compare qui.{' '}
          <Link to="/pipeline/follow-up">Tutti i follow-up</Link>
        </Empty>
      )}
      {list.data && list.data.items.length > 0 && (
        <>
          <div className="row between">
            <p className="small muted" aria-live="polite">
              <span className="mono">{list.data.unread}</span> da leggere
              {list.data.unreadOverdue > 0 && (
                <>
                  {' '}
                  · <span className="text-danger">{list.data.unreadOverdue} scaduti</span>
                </>
              )}
            </p>
            {list.data.unread > 0 && (
              <Button
                variant="secondary"
                busy={busy}
                onClick={() => {
                  setBusy(true);
                  post('/notifications/read-all')
                    .then(list.reload)
                    .finally(() => setBusy(false));
                }}
              >
                Segna tutti come letti
              </Button>
            )}
          </div>
          <ol className="reminder-list">
            {list.data.items.map((r) => (
              <Row key={r.id} r={r} today={list.data!.today} onDone={list.reload} />
            ))}
          </ol>
        </>
      )}
      <p className="small muted">
        Un promemoria si chiude da solo quando il follow-up viene completato, annullato o spostato; spostare la scadenza
        crea un nuovo promemoria per la nuova data. Il responsabile è quello dell’opportunità, altrimenti chi ha creato
        il follow-up.
      </p>
    </>
  );
}
