import { useEffect, useId, useRef, useState } from 'react';
import { Link } from 'react-router';
import {
  ApiError,
  get,
  patch,
  post,
  type EmailDetail,
  type EmailMeta,
  type EmailPrecheck,
  type EmailSendResult,
} from '../api/client.ts';
import { formatDateTime } from '../lib/format.ts';
import { Button, Checkbox, Field, Loading, TextAreaField } from './ui.tsx';

/*
 * Composer rapido: «Invia email» → messaggio già pronto → «Conferma e invia».
 *  - riprende la bozza non inviata dell'azienda (nessun doppione) o ne crea una dal modello ufficiale Noventra;
 *  - se l'AI è configurata personalizza apertura e dettagli con le prove verificate; se non lo è o non riesce resta il
 *    modello standard (la scrittura non è mai bloccata);
 *  - «Conferma e invia» è la conferma esplicita: salva le modifiche e invia con un requestId (un clic ripetuto non
 *    invia due volte); i controlli del server restano tutti (destinatario, «non contattare», configurazione);
 *  - il risultato è quello del server di posta: «accettata» non significa consegnata.
 * Nessuna email parte aprendo, modificando o chiudendo il composer.
 */

const errorOf = (e: unknown, fallback: string) => (e instanceof ApiError ? e : new ApiError(0, 'UNKNOWN', fallback));
const isEmail = (s: string) => /^[^\s@<>,;"]+@[^\s@<>,;"]+\.[^\s@<>,;"]+$/.test(s.trim());

export function EmailComposer({
  business,
  onClose,
  onSent,
}: {
  business: { id: string; name: string };
  onClose: () => void;
  onSent?: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const [openRequest] = useState(() => crypto.randomUUID());
  const [sendRequest, setSendRequest] = useState(() => crypto.randomUUID());
  const [meta, setMeta] = useState<EmailMeta | null>(null);
  const [d, setD] = useState<EmailDetail | null>(null);
  const [check, setCheck] = useState<EmailPrecheck | null>(null);
  const [recipient, setRecipient] = useState('');
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [phase, setPhase] = useState<'loading' | 'personalizing' | 'ready' | 'sending' | 'sent'>('loading');
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [acceptUncertain, setAcceptUncertain] = useState(false);
  const [result, setResult] = useState<EmailSendResult | null>(null);

  useEffect(() => {
    ref.current?.showModal();
  }, []);

  const load = (detail: EmailDetail) => {
    setD(detail);
    setRecipient(detail.email.recipient ?? '');
    setSubject(detail.email.subject);
    setBody(detail.email.body);
  };

  // apertura: bozza (ripresa o nuova), poi personalizzazione AI se possibile, poi controlli prima dell'invio
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [m, created] = await Promise.all([
          get<EmailMeta>('/emails/meta'),
          post<EmailDetail>('/emails', { requestId: openRequest, businessId: business.id, reuseOpen: true }),
        ]);
        if (cancelled) return;
        setMeta(m);
        load(created);
        let current = created;
        const fresh = created.email.mode === 'standard' && !created.email.editedAfterGeneration;
        if (m.aiConfigured && fresh && created.email.status === 'draft') {
          setPhase('personalizing');
          try {
            current = await post<EmailDetail>(`/emails/${created.email.id}/generate`, {
              version: created.email.version,
              mode: 'ai',
              objective: 'presentazione',
              tone: 'consulenziale',
              overwrite: false,
            });
            if (cancelled) return;
            load(current);
            setNote(
              'Messaggio personalizzato con le informazioni verificate sull’azienda: rileggilo prima di inviare.',
            );
          } catch (e) {
            if (cancelled) return;
            setNote(
              `Personalizzazione non disponibile (${errorOf(e, 'errore').message.replace(/\.$/, '')}): resta il modello standard Noventra.`,
            );
          }
        } else if (!m.aiConfigured && fresh) {
          setNote('Modello standard Noventra (personalizzazione AI non configurata sul server).');
        }
        const c = await get<EmailPrecheck>(`/emails/${current.email.id}/precheck`);
        if (cancelled) return;
        setCheck(c);
        setPhase('ready');
      } catch (e) {
        if (!cancelled) {
          setError(errorOf(e, 'Impossibile preparare l’email.'));
          setPhase('ready');
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [business.id, openRequest]);

  const close = () => {
    if (phase === 'sending') return;
    ref.current?.close();
    onClose();
  };

  const e = d?.email;
  const dirty = Boolean(e) && (recipient !== (e!.recipient ?? '') || subject !== e!.subject || body !== e!.body);
  const sending = meta?.sending;
  // blocchi che una modifica nel composer può risolvere (destinatario, oggetto, testo) si ricontrollano qui
  const editableBlockers = new Set([
    'Manca l’indirizzo del destinatario.',
    'L’indirizzo del destinatario non è valido.',
    'Manca l’oggetto.',
    'Il testo è vuoto.',
  ]);
  const serverBlockers = (check?.blockers ?? []).filter((b) => !editableBlockers.has(b));
  const localBlockers = [
    ...(!recipient.trim() ? ['Email non disponibile: inserisci un indirizzo verificato.'] : []),
    ...(recipient.trim() && !isEmail(recipient) ? ['L’indirizzo del destinatario non è valido.'] : []),
    ...(!subject.trim() ? ['Manca l’oggetto.'] : []),
    ...(!body.trim() ? ['Il testo è vuoto.'] : []),
  ];
  const blockers = [...serverBlockers, ...localBlockers];
  const canSend = phase === 'ready' && Boolean(e) && blockers.length === 0 && (!e!.failureUncertain || acceptUncertain);

  const confirmAndSend = async () => {
    if (!e) return;
    setPhase('sending');
    setError(null);
    try {
      let version = e.version;
      if (dirty) {
        const saved = await patch<EmailDetail>(`/emails/${e.id}`, {
          version,
          recipient: recipient.trim(),
          subject,
          body,
        });
        load(saved);
        version = saved.email.version;
      }
      const r = await post<EmailSendResult>(`/emails/${e.id}/send`, {
        requestId: sendRequest,
        version,
        reviewed: true,
        lawful: true,
        acceptUncertain,
      });
      load(r);
      setResult(r);
      if (r.outcome === 'accepted') {
        setPhase('sent');
        onSent?.();
      } else {
        // nuovo tentativo = nuova conferma
        setSendRequest(crypto.randomUUID());
        setCheck(await get<EmailPrecheck>(`/emails/${e.id}/precheck`));
        setPhase('ready');
      }
    } catch (err) {
      setError(errorOf(err, 'Invio non riuscito.'));
      setSendRequest(crypto.randomUUID());
      setPhase('ready');
    }
  };

  return (
    <dialog
      ref={ref}
      className="dialog dialog--wide composer"
      aria-labelledby={titleId}
      onCancel={(ev) => {
        ev.preventDefault();
        close();
      }}
    >
      <form
        onSubmit={(ev) => {
          ev.preventDefault();
          void confirmAndSend();
        }}
      >
        <div className="dialog__body">
          <h2 className="dialog__title" id={titleId}>
            Email a {business.name}
          </h2>
          {phase === 'loading' && <Loading label="Preparazione del messaggio…" />}
          {e && phase !== 'sent' && (
            <>
              {phase === 'personalizing' && <Loading label="Personalizzazione con le informazioni sull’azienda…" />}
              {note && <p className="small muted">{note}</p>}
              <Field
                label="Destinatario"
                type="email"
                value={recipient}
                maxLength={254}
                disabled={phase !== 'ready'}
                onChange={(ev) => setRecipient(ev.target.value)}
                hint={
                  !recipient
                    ? 'Email non disponibile: la fonte non indica un indirizzo dell’azienda.'
                    : recipient === d?.business.publicEmail
                      ? 'Email pubblica indicata dalla fonte (OpenStreetMap): non verificata.'
                      : 'Indirizzo inserito a mano: non verificato.'
                }
              />
              <Field
                label="Oggetto"
                value={subject}
                maxLength={200}
                disabled={phase !== 'ready'}
                onChange={(ev) => setSubject(ev.target.value)}
              />
              <TextAreaField
                label="Testo"
                className="input textarea composer__body"
                value={body}
                rows={14}
                maxLength={20000}
                disabled={phase !== 'ready'}
                onChange={(ev) => setBody(ev.target.value)}
              />
              {blockers.length > 0 && (
                <ul className="composer__blockers" role="alert">
                  {blockers.map((b) => (
                    <li key={b}>{b}</li>
                  ))}
                </ul>
              )}
              {(check?.warnings ?? []).length > 0 && (
                <ul className="send-dialog__warnings">
                  {check!.warnings.map((w) => (
                    <li key={w}>{w}</li>
                  ))}
                </ul>
              )}
              {e.failureUncertain && (
                <Checkbox
                  label="Ho controllato la posta inviata: il tentativo precedente non è partito, invia di nuovo."
                  checked={acceptUncertain}
                  onChange={(ev) => setAcceptUncertain(ev.target.checked)}
                />
              )}
              {result && result.outcome !== 'accepted' && (
                <p role="alert" className="field__error">
                  {result.message ?? 'Invio non riuscito.'} Il messaggio è salvato: puoi correggerlo e riprovare.
                </p>
              )}
              {error && (
                <p role="alert" className="field__error">
                  {error.message}
                </p>
              )}
              <p className="small muted composer__legal">
                {sending && !sending.canSend
                  ? `${sending.label}: ${sending.explanation}`
                  : `Mittente: ${check?.from ? `${check.from.name} <${check.from.address}>` : '—'}. «Conferma e invia» conferma che hai riletto il messaggio e che il contatto è lecito (norme italiane ed europee su privacy e marketing elettronico).`}
                {check?.needsOpportunity && ' L’azienda verrà aggiunta alle trattative per registrare il contatto.'}
              </p>
            </>
          )}
          {phase === 'sent' && e && (
            <div role="status" className="composer__done stack stack--tight">
              <p className="composer__done-title">Email accettata dal server di posta</p>
              <p className="small">
                Inviata a <span className="mono">{e.recipient}</span> il {formatDateTime(e.sentAt)} e registrata nella
                cronologia dell’azienda: lo stato passa a «In attesa di risposta». L’accettazione non conferma la
                consegna nella casella del destinatario.
              </p>
            </div>
          )}
          {e && (
            <p className="small">
              <Link to={`/email/${e.id}`} onClick={() => onClose()}>
                Apri nell’editor completo
              </Link>{' '}
              ·{' '}
              <Link to={`/aziende/${business.id}`} onClick={() => onClose()}>
                Dettagli azienda
              </Link>
            </p>
          )}
        </div>
        <div className="dialog__actions">
          <Button variant="ghost" type="button" onClick={close} disabled={phase === 'sending'}>
            {phase === 'sent' ? 'Chiudi' : 'Annulla'}
          </Button>
          {phase !== 'sent' && (
            <Button
              type="submit"
              busy={phase === 'sending'}
              disabled={!canSend || Boolean(sending && !sending.canSend)}
            >
              Conferma e invia
            </Button>
          )}
        </div>
      </form>
    </dialog>
  );
}
