import { Link } from 'react-router';
import type { EmailList } from '../api/client.ts';
import { formatDateTime } from '../lib/format.ts';
import { useApi } from '../lib/useApi.ts';
import { STATUS_TONE } from '../pages/EmailListPage.tsx';
import { ErrorNotice, Section, Status } from './ui.tsx';

/**
 * Email commerciali di un'azienda o di un'opportunità (Fase 9): bozze e inviate distinte dallo stato, con il link
 * per scriverne una nuova (l'azienda è preselezionata). Nessuna generazione e nessun invio da qui.
 */
export function EmailHistory({ businessId, opportunityId }: { businessId: string; opportunityId?: string }) {
  const filter = opportunityId ? `opportunity=${opportunityId}` : `business=${businessId}`;
  const list = useApi<EmailList>(`/emails?${filter}&status=all&pageSize=10&sort=updated&dir=desc`);
  const write = `/email/nuova?business=${businessId}${opportunityId ? `&opportunity=${opportunityId}` : ''}`;
  return (
    <Section
      title="Email commerciali"
      description="Bozze e email inviate. «Inviata» significa accettata dal server di posta, non consegnata."
    >
      <div className="stack stack--tight">
        {list.error && <ErrorNotice error={list.error} onRetry={list.reload} />}
        {list.data && list.data.total === 0 && <p className="small muted">Nessuna email per ora.</p>}
        {list.data && list.data.total > 0 && (
          <ul className="plain-list small email-history">
            {list.data.items.map((e) => (
              <li key={e.id}>
                <Status tone={STATUS_TONE[e.status]}>{e.statusLabel}</Status>{' '}
                <Link to={`/email/${e.id}`}>{e.subject || 'Senza oggetto'}</Link>
                <span className="muted">
                  {' '}
                  · {e.sentAt ? `inviata ${formatDateTime(e.sentAt)}` : `modificata ${formatDateTime(e.updatedAt)}`}
                  {e.recipient && ` · ${e.recipient}`}
                </span>
              </li>
            ))}
          </ul>
        )}
        <p>
          <Link to={write} className="btn btn--secondary">
            Scrivi un’email
          </Link>
        </p>
      </div>
    </Section>
  );
}
