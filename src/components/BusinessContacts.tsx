import { useState, type ReactNode } from 'react';
import type { BusinessDetail } from '../api/client.ts';
import { formatDate } from '../lib/format.ts';
import { Button } from './ui.tsx';

/*
 * Contatti in cima alla scheda: email, telefono, altri numeri, fax, sito e indirizzo, ognuno con il valore salvato,
 * il link (mailto:, tel:, sito), il pulsante «Copia», la provenienza e lo stato di verifica. Un dato mancante lo
 * dichiara («Email non disponibile»); nessun recapito è mai dedotto o segnato come verificato senza una verifica.
 * Subito sotto, le azioni: Invia email, Chiama, Apri sito web, Copia contatti, Gestisci contatto.
 */

const PROVIDER_LABEL: Record<string, string> = { osm: 'OpenStreetMap', google: 'Google Maps' };
const telHref = (p: string) => `tel:${p.replace(/[^\d+]/g, '')}`;

async function copyText(text: string) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // contesto non sicuro o permesso negato: selezione manuale tramite un campo temporaneo
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.className = 'visually-hidden';
    document.body.append(area);
    area.select();
    const ok = document.execCommand('copy');
    area.remove();
    return ok;
  }
}

function Row({
  label,
  value,
  copy,
  meta,
  missing,
}: {
  label: string;
  value: ReactNode | null;
  copy?: string | null;
  meta?: ReactNode;
  missing: string;
}) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="contact-row">
      <dt>{label}</dt>
      <dd>
        {value ? (
          <>
            <span className="contact-row__value">{value}</span>
            {copy && (
              <button
                type="button"
                className="contact-row__copy"
                onClick={() =>
                  void copyText(copy).then((ok) => {
                    setCopied(ok);
                    if (ok) setTimeout(() => setCopied(false), 2000);
                  })
                }
              >
                {copied ? 'Copiato' : 'Copia'}
                {/* nome accessibile = testo visibile + campo (WCAG 2.5.3) */}
                <span className="visually-hidden"> {label.toLowerCase()}</span>
              </button>
            )}
            {meta && <span className="contact-row__meta">{meta}</span>}
          </>
        ) : (
          <span className="muted">{missing}</span>
        )}
      </dd>
    </div>
  );
}

/** Testo leggibile con tutti i contatti disponibili (per «Copia contatti»). */
export function contactsText(b: BusinessDetail) {
  const a = b.address;
  const address = [[a.street, a.housenumber].filter(Boolean).join(' '), [a.postcode, a.city].filter(Boolean).join(' ')]
    .filter(Boolean)
    .join(', ');
  return [
    b.name,
    b.contacts.email && b.contacts.emailKind !== 'personal' ? `Email: ${b.contacts.email}` : null,
    b.contacts.phone ? `Telefono: ${b.contacts.phone}` : null,
    ...b.contacts.phonesExtra.map((p) => `Altro telefono: ${p}`),
    b.contacts.fax ? `Fax: ${b.contacts.fax}` : null,
    b.website && !b.website.shared ? `Sito: ${b.website.url}` : null,
    address ? `Indirizzo: ${address}` : null,
  ]
    .filter(Boolean)
    .join('\n');
}

export function BusinessContacts({
  business: b,
  canSend,
  sendBlockedReason,
  onCompose,
  onManage,
}: {
  business: BusinessDetail;
  canSend: boolean;
  sendBlockedReason: string | null;
  onCompose: () => void;
  onManage: () => void;
}) {
  const [copiedAll, setCopiedAll] = useState(false);
  const email = b.contacts.email && b.contacts.emailKind !== 'personal' ? b.contacts.email : null;
  const primary = b.sources.find((s) => s.primary) ?? b.sources[0];
  const phoneSource = primary ? (PROVIDER_LABEL[primary.provider] ?? primary.provider) : null;
  // verifica: solo DNS del dominio (mai un messaggio di prova); la casella resta non verificata
  const v = b.emailInfo?.verification;
  const checked =
    v?.level === 'delivery_verified'
      ? 'consegna verificata'
      : v?.domain === 'none'
        ? 'il dominio non riceve posta'
        : v?.level === 'domain_checked'
          ? 'dominio che riceve posta, casella non verificata'
          : 'non verificata';
  const sourceLink = (label: string) =>
    b.emailInfo?.sourceUrl ? (
      <>
        {' '}
        (
        <a href={b.emailInfo.sourceUrl} target="_blank" rel="noopener noreferrer">
          {label}
        </a>
        )
      </>
    ) : null;
  const emailMeta = b.emailInfo ? (
    b.emailInfo.source === 'website' ? (
      <>
        scritta sul sito
        {sourceLink('pagina')}
        {b.emailInfo.foundAt && ` il ${formatDate(b.emailInfo.foundAt)}`} · {checked}
      </>
    ) : b.emailInfo.source === 'manuale' ? (
      <>inserita a mano · {b.emailInfo.status === 'verificata' ? 'verificata' : 'non verificata'}</>
    ) : (
      <>
        indicata da {phoneSource ?? 'la fonte'}
        {sourceLink('scheda')}
        {b.emailInfo.foundAt && ` il ${formatDate(b.emailInfo.foundAt)}`} · {checked}
      </>
    )
  ) : null;
  // altre email dell'attività trovate sul sito, ancora presenti, utilizzabili come recapito
  const otherEmails = b.websiteEmails.filter(
    (e) => e.current && e.email !== email && (e.relation === 'same_domain' || e.relation === 'free_provider'),
  );
  const a = b.address;
  const street = [a.street, a.housenumber].filter(Boolean).join(' ');
  const address = [street, [a.postcode, a.city ?? b.place.municipality].filter(Boolean).join(' ')]
    .filter(Boolean)
    .join(', ');
  const site = b.website && !b.website.shared ? b.website : null;
  const phoneForbidden = b.doNotContact && b.doNotContact.scope !== 'email';

  return (
    <section className="biz-contacts" aria-label="Contatti">
      <dl className="contact-list">
        <Row
          label="Email"
          value={email ? <a href={`mailto:${email}`}>{email}</a> : null}
          copy={email}
          meta={emailMeta}
          missing={
            b.contacts.emailKind === 'personal'
              ? 'Email non disponibile (la fonte indica solo un indirizzo personale, non salvato)'
              : 'Email non disponibile'
          }
        />
        {otherEmails.length > 0 && (
          <Row
            label="Altre email"
            value={otherEmails.map((e, i) => (
              <span key={e.email}>
                {i > 0 && ', '}
                <a href={`mailto:${e.email}`}>{e.email}</a>
              </span>
            ))}
            copy={otherEmails.map((e) => e.email).join(', ')}
            meta="scritte sul sito · non verificate"
            missing=""
          />
        )}
        <Row
          label="Telefono"
          value={b.contacts.phone ? <a href={telHref(b.contacts.phone)}>{b.contacts.phone}</a> : null}
          copy={b.contacts.phone}
          meta={phoneSource ? `indicato da ${phoneSource} · non verificato` : 'non verificato'}
          missing="Telefono non disponibile"
        />
        {b.contacts.phonesExtra.length > 0 && (
          <Row
            label="Altri telefoni"
            value={b.contacts.phonesExtra.map((p, i) => (
              <span key={p}>
                {i > 0 && ', '}
                <a href={telHref(p)}>{p}</a>
              </span>
            ))}
            copy={b.contacts.phonesExtra.join(', ')}
            meta="indicati dalla fonte · non verificati"
            missing=""
          />
        )}
        <Row
          label="Fax"
          value={b.contacts.fax ? <span className="mono">{b.contacts.fax}</span> : null}
          copy={b.contacts.fax}
          meta="indicato dalla fonte"
          missing="Fax non indicato"
        />
        <Row
          label="Sito web"
          value={
            site ? (
              <a href={site.url} target="_blank" rel="noopener noreferrer nofollow">
                {site.domain ?? site.url}
              </a>
            ) : null
          }
          copy={site?.url}
          meta={site ? undefined : null}
          missing={b.website?.shared ? 'Solo una pagina su una piattaforma (social o directory)' : 'Sito non indicato'}
        />
        <Row label="Indirizzo" value={address || null} copy={address || null} missing="Indirizzo non indicato" />
      </dl>

      <div className="biz-actions">
        <Button
          disabled={!canSend}
          title={sendBlockedReason ?? undefined}
          aria-describedby={sendBlockedReason ? 'invio-bloccato' : undefined}
          onClick={onCompose}
        >
          Invia email
        </Button>
        {b.contacts.phone && !phoneForbidden ? (
          <a className="btn btn--secondary" href={telHref(b.contacts.phone)}>
            Chiama
          </a>
        ) : (
          <Button
            variant="secondary"
            disabled
            title={phoneForbidden ? 'Contatto telefonico vietato' : 'Telefono non disponibile'}
          >
            Chiama
          </Button>
        )}
        {site ? (
          <a className="btn btn--secondary" href={site.url} target="_blank" rel="noopener noreferrer nofollow">
            Apri sito web
          </a>
        ) : (
          <Button variant="secondary" disabled title="Sito non indicato">
            Apri sito web
          </Button>
        )}
        <Button
          variant="secondary"
          onClick={() =>
            void copyText(contactsText(b)).then((ok) => {
              setCopiedAll(ok);
              if (ok) setTimeout(() => setCopiedAll(false), 2000);
            })
          }
        >
          {copiedAll ? 'Contatti copiati' : 'Copia contatti'}
        </Button>
        <Button variant="ghost" onClick={onManage}>
          Gestisci contatto
        </Button>
      </div>
      {sendBlockedReason && (
        <p id="invio-bloccato" className="small muted">
          {sendBlockedReason}
        </p>
      )}
      <p className="visually-hidden" aria-live="polite">
        {copiedAll ? 'Contatti copiati negli appunti' : ''}
      </p>
    </section>
  );
}
