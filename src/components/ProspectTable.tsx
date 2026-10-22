import { Link } from 'react-router';
import type { BusinessSummary, ContactStatus } from '../api/client.ts';
import { formatDate } from '../lib/format.ts';
import { Button, Status } from './ui.tsx';

/*
 * Tabella dei potenziali clienti: solo ciò che serve per decidere e contattare. Nome, città e settore, sito, email
 * disponibile, punteggio commerciale con il motivo principale, stato del contatto e «Invia email».
 * I dettagli (audit, valutazione completa, prove, note, trattativa) sono nella scheda dell'azienda.
 */

export const CONTACT_TONE: Record<ContactStatus, 'ok' | 'warn' | 'danger' | 'idle'> = {
  da_contattare: 'idle',
  in_attesa: 'warn',
  in_trattativa: 'ok',
  cliente: 'ok',
  perso: 'idle',
  non_contattare: 'danger',
};

/** Email a cui si può scrivere: generica, pubblica e azienda non esclusa. */
export const canEmail = (b: BusinessSummary) =>
  Boolean(b.contacts.email) && b.contacts.emailKind !== 'personal' && b.contact?.status !== 'non_contattare';

const short = (s: string, n = 140) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);

export function ProspectTable({
  items,
  onCompose,
  caption,
  waiting = false,
}: {
  items: BusinessSummary[];
  onCompose: (b: BusinessSummary) => void;
  caption: string;
  /** Vista «In attesa»: la prossima azione è registrare la risposta nella trattativa. */
  waiting?: boolean;
}) {
  return (
    <div className="table-wrap">
      <table className="table table--stack prospects">
        <caption className="visually-hidden">{caption}</caption>
        <thead>
          <tr>
            <th scope="col">Azienda</th>
            <th scope="col">Email</th>
            <th scope="col">Punteggio commerciale</th>
            <th scope="col">Contatto</th>
            <th scope="col">
              <span className="visually-hidden">Azioni</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {items.map((b) => {
            const c = b.commercial;
            const excluded = c?.exclusion;
            return (
              <tr key={b.id}>
                <td data-label="Azienda">
                  <Link to={`/aziende/${b.id}`} className="prospects__name">
                    {b.name}
                  </Link>
                  <span className="small muted prospects__meta">
                    {[b.place.municipality, b.sector?.label ?? b.categoryLabel].filter(Boolean).join(' · ')}
                  </span>
                  {b.website && !b.website.shared && (
                    <a className="small prospects__site" href={b.website.url} target="_blank" rel="noopener noreferrer">
                      {b.website.domain ?? b.website.url}
                    </a>
                  )}
                </td>
                <td data-label="Email" className="small">
                  {b.contacts.email && b.contacts.emailKind !== 'personal' ? (
                    <span className="mono">{b.contacts.email}</span>
                  ) : (
                    <span className="muted">Email non disponibile</span>
                  )}
                </td>
                <td data-label="Punteggio commerciale">
                  {c && !excluded ? (
                    <span className="prospects__score">
                      <span className="prospects__band">
                        <span className={`score score--${c.band?.id ?? 'none'}`}>{c.score}</span>
                        <span className="small">{c.band?.label}</span>
                      </span>
                      <span className="small">
                        {c.source === 'rules' && <span className="muted">a regole</span>}
                        {c.outdated && <span className="muted">{c.source === 'rules' ? ' · ' : ''}da aggiornare</span>}
                      </span>
                      {b.commercialReason && (
                        <span className="small muted prospects__reason" title={b.commercialReason}>
                          {short(b.commercialReason)}
                        </span>
                      )}
                    </span>
                  ) : (
                    <Status tone="warn">{b.assessment?.label ?? 'Non ancora valutata'}</Status>
                  )}
                </td>
                <td data-label="Contatto" className="small">
                  {b.contact && <Status tone={CONTACT_TONE[b.contact.status]}>{b.contact.label}</Status>}
                  {b.contact?.lastContactAt && (
                    <span className="muted"> · ultimo {formatDate(b.contact.lastContactAt)}</span>
                  )}
                </td>
                <td data-label="Azioni" className="prospects__actions">
                  {waiting && b.crm && (
                    <Link
                      to={`/pipeline/${b.crm.opportunityId}`}
                      className="btn"
                      aria-label={`Registra la risposta di ${b.name}`}
                    >
                      Registra la risposta
                    </Link>
                  )}
                  <Button
                    variant={
                      !canEmail(b)
                        ? 'ghost'
                        : b.contact?.status === 'da_contattare' && !waiting
                          ? 'primary'
                          : 'secondary'
                    }
                    disabled={!canEmail(b)}
                    title={
                      !b.contacts.email
                        ? 'Email non disponibile'
                        : b.contact?.status === 'non_contattare'
                          ? 'Azienda da non contattare'
                          : undefined
                    }
                    aria-label={`${waiting ? 'Scrivi ancora a' : 'Invia email a'} ${b.name}`}
                    onClick={() => onCompose(b)}
                  >
                    {waiting ? 'Scrivi ancora' : 'Invia email'}
                  </Button>
                  <Link to={`/aziende/${b.id}`} className="small" aria-label={`Dettagli di ${b.name}`}>
                    Dettagli
                  </Link>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
