import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { ApiError, post, type BusinessSummary, type ExclusionCode } from '../api/client.ts';
import { formatDateTime } from '../lib/format.ts';
import { Button, Field } from './ui.tsx';

/*
 * «Gestisci contatto»: escludere un'azienda dai potenziali clienti (motivo obbligatorio, conferma esplicita),
 * riportarla tra i potenziali clienti, e per gli amministratori revocare un divieto di contatto con un motivo.
 * Nessuna cancellazione: l'azienda, la trattativa, le email, le note e le attività restano. Il «Rifiuto commerciale»
 * attiva anche il divieto di contatto, che resta se l'azienda viene reinclusa o ritrovata da una ricerca.
 */

export const EXCLUSION_OPTIONS: { id: ExclusionCode; label: string; hint: string }[] = [
  { id: 'nessun_contatto', label: 'Nessun contatto disponibile', hint: 'Né email né telefono utilizzabili.' },
  { id: 'contatti_non_validi', label: 'Contatti non validi', hint: 'Email o telefono errati o inesistenti.' },
  {
    id: 'rifiuto_commerciale',
    label: 'Rifiuto commerciale',
    hint: 'Ha chiesto di non ricevere comunicazioni commerciali: si attiva anche il divieto di contatto.',
  },
  { id: 'attivita_chiusa', label: 'Attività chiusa', hint: 'Cessata o chiusa definitivamente.' },
  { id: 'non_pertinente', label: 'Azienda non pertinente', hint: 'Fuori target per i servizi di Noventra.' },
  { id: 'duplicato', label: 'Duplicato', hint: 'È un doppione di un’altra scheda.' },
  { id: 'altro', label: 'Altro', hint: 'Indica il motivo nella nota.' },
];

const SCOPE_LABEL = { tutti: 'tutti i canali', email: 'solo email', telefono: 'solo telefono' } as const;

export function ManageContact({
  business: b,
  isAdmin,
  onClose,
  onChanged,
}: {
  business: Pick<BusinessSummary, 'id' | 'name' | 'excluded' | 'doNotContact'>;
  isAdmin: boolean;
  onClose: () => void;
  onChanged: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const [code, setCode] = useState<ExclusionCode | ''>('');
  const [note, setNote] = useState('');
  const [scope, setScope] = useState<'tutti' | 'email' | 'telefono'>('tutti');
  const [revokeNote, setRevokeNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    ref.current?.showModal();
  }, []);

  const close = () => {
    if (busy) return;
    ref.current?.close();
    onClose();
  };
  const run = async (path: string, body: unknown) => {
    setBusy(true);
    setError(null);
    try {
      await post(path, body);
      onChanged();
      ref.current?.close();
      onClose();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Operazione non riuscita.');
      setBusy(false);
    }
  };
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!code) return setError('Scegli il motivo dell’esclusione.');
    if (code === 'altro' && !note.trim()) return setError('Per «Altro» scrivi una breve nota.');
    void run(`/businesses/${b.id}/exclusion`, {
      excluded: true,
      code,
      note: note.trim() || undefined,
      ...(code === 'rifiuto_commerciale' ? { scope } : {}),
    });
  };

  return (
    <dialog
      ref={ref}
      className="dialog"
      aria-labelledby={titleId}
      onCancel={(ev) => {
        ev.preventDefault();
        close();
      }}
    >
      <div className="dialog__body">
        <h2 className="dialog__title" id={titleId}>
          Gestisci contatto
        </h2>
        <p className="dialog__text">{b.name}</p>

        {b.doNotContact && (
          <div className="manage__block manage__block--danger">
            <p>
              <strong>Contatto vietato</strong> ({SCOPE_LABEL[b.doNotContact.scope]}) dal{' '}
              {formatDateTime(b.doNotContact.at)}
              {b.doNotContact.note ? ` — ${b.doNotContact.note}` : ''}. L’applicazione blocca l’invio di email
              {b.doNotContact.scope === 'email' ? '' : ' e il pulsante «Chiama»'}, anche reincludendo l’azienda.
            </p>
            {isAdmin && (
              <form
                className="stack stack--tight"
                onSubmit={(e) => {
                  e.preventDefault();
                  void run(`/businesses/${b.id}/do-not-contact/revoke`, { note: revokeNote });
                }}
              >
                <Field
                  label="Motivo della revoca (solo amministratori)"
                  value={revokeNote}
                  maxLength={300}
                  onChange={(e) => setRevokeNote(e.target.value)}
                  hint="Es. consenso scritto ricevuto il… La revoca viene registrata."
                />
                <Button variant="secondary" type="submit" busy={busy} disabled={revokeNote.trim().length < 5}>
                  Revoca il divieto di contatto
                </Button>
              </form>
            )}
          </div>
        )}

        {b.excluded ? (
          <div className="manage__block">
            <p>
              Esclusa dai potenziali clienti dal {formatDateTime(b.excluded.at)} — {b.excluded.label}
              {b.excluded.reason ? ` (${b.excluded.reason})` : ''}.
            </p>
            <p className="small muted">
              Riportandola tra i potenziali clienti torna negli elenchi.
              {b.doNotContact ? ' Il divieto di contatto resta attivo.' : ''}
            </p>
            <Button
              variant="secondary"
              busy={busy}
              onClick={() => void run(`/businesses/${b.id}/exclusion`, { excluded: false })}
            >
              Riporta tra i potenziali clienti
            </Button>
          </div>
        ) : (
          <form className="manage__form" aria-label="Escludi azienda" onSubmit={submit}>
            <fieldset className="manage__reasons">
              <legend>Escludi azienda: motivo</legend>
              {EXCLUSION_OPTIONS.map((o) => (
                <label key={o.id} className="manage__reason">
                  <input
                    type="radio"
                    name="motivo"
                    value={o.id}
                    checked={code === o.id}
                    disabled={busy}
                    onChange={() => setCode(o.id)}
                  />
                  <span>
                    {o.label}
                    <span className="small muted"> — {o.hint}</span>
                  </span>
                </label>
              ))}
            </fieldset>
            {code === 'rifiuto_commerciale' && (
              <fieldset className="manage__reasons">
                <legend>Il rifiuto riguarda</legend>
                {(['tutti', 'email', 'telefono'] as const).map((s) => (
                  <label key={s} className="manage__reason">
                    <input
                      type="radio"
                      name="canali"
                      value={s}
                      checked={scope === s}
                      disabled={busy}
                      onChange={() => setScope(s)}
                    />
                    <span>{s === 'tutti' ? 'Tutti i canali (consigliato se non è chiaro)' : SCOPE_LABEL[s]}</span>
                  </label>
                ))}
              </fieldset>
            )}
            <Field
              label={code === 'altro' ? 'Nota (obbligatoria)' : 'Nota (facoltativa)'}
              value={note}
              maxLength={300}
              disabled={busy}
              onChange={(e) => setNote(e.target.value)}
            />
            <p className="small muted">
              L’azienda esce da «Trova aziende», «Da contattare», raccomandazioni ed esportazioni; scheda, trattativa,
              email inviate e attività restano. Nessuna cancellazione.
            </p>
            {error && (
              <p role="alert" className="field__error">
                {error}
              </p>
            )}
            <div className="row">
              <Button type="submit" variant="danger" busy={busy} disabled={!code}>
                Conferma l’esclusione
              </Button>
            </div>
          </form>
        )}
        {error && b.excluded && (
          <p role="alert" className="field__error">
            {error}
          </p>
        )}
      </div>
      <div className="dialog__actions">
        <Button variant="ghost" type="button" onClick={close} disabled={busy}>
          Annulla
        </Button>
      </div>
    </dialog>
  );
}
