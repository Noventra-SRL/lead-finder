import { useState } from 'react';
import { ApiError, post, type SendingStatus } from '../api/client.ts';
import { formatDateTime } from '../lib/format.ts';
import { useApi } from '../lib/useApi.ts';
import { Button, ConfirmDialog, ErrorNotice, Field, Loading, Status } from './ui.tsx';

/*
 * Invio email (solo amministratori): stato della configurazione, verifica della connessione senza inviare nulla e
 * «Invia email di prova» a un indirizzo scritto e confermato. Le credenziali non arrivano mai qui: il server indica
 * solo mittente, stato ed esito dell'ultimo controllo.
 */

type Tone = 'ok' | 'warn' | 'danger' | 'idle';

const CHECK_TONE: Record<NonNullable<SendingStatus['lastCheck']>['kind'], Tone> = {
  verified: 'ok',
  test_sent: 'ok',
  sent: 'ok',
  auth_error: 'danger',
  connection_error: 'danger',
  send_failed: 'danger',
};

const EMAIL = /^[^\s@<>,;"]+@[^\s@<>,;"]+\.[^\s@<>,;"]+$/;

export function EmailSettings() {
  const { data, error, loading, reload } = useApi<SendingStatus>('/email/status');
  const [busy, setBusy] = useState<'verify' | 'test' | null>(null);
  const [to, setTo] = useState('');
  const [confirming, setConfirming] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
  const [fieldError, setFieldError] = useState<string | null>(null);

  if (loading && !data) return <Loading label="Stato dell’invio…" />;
  if (error) return <ErrorNotice error={error} onRetry={reload} />;
  if (!data) return null;
  const s = data;
  const missing = s.state === 'missing';

  const run = async (key: 'verify' | 'test', fn: () => Promise<{ ok: boolean; message: string }>) => {
    setBusy(key);
    setResult(null);
    try {
      const r = await fn();
      setResult({ ok: r.ok, text: r.message });
    } catch (e) {
      setResult({ ok: false, text: e instanceof ApiError ? e.message : 'Operazione non riuscita.' });
    } finally {
      setBusy(null);
      reload();
    }
  };

  return (
    <div className="stack">
      <dl className="props props--compact">
        <dt>Stato</dt>
        <dd>
          <Status
            tone={missing ? 'idle' : s.state === 'provider_error' ? 'danger' : s.state === 'ready' ? 'ok' : 'warn'}
          >
            {missing ? 'Configurazione mancante' : s.label}
          </Status>
        </dd>
        <dt>Mittente</dt>
        <dd className="mono">{s.from ? `${s.from.name} <${s.from.address}>` : '—'}</dd>
        <dt>Ultimo controllo</dt>
        <dd>
          {s.lastCheck ? (
            <>
              <Status tone={CHECK_TONE[s.lastCheck.kind]}>{s.lastCheck.label}</Status>{' '}
              <span className="small muted">
                {formatDateTime(s.lastCheck.at)} — {s.lastCheck.message}
              </span>
            </>
          ) : (
            <span className="muted">Nessuno dall’avvio del server</span>
          )}
        </dd>
      </dl>
      <p className="small">{s.explanation}</p>
      {missing && (
        <p className="small muted">
          Per Google Workspace imposta sul server SMTP_HOST=smtp.gmail.com, SMTP_PORT=587, SMTP_SECURE=false,
          SMTP_USER=staff@noventra.it, SMTP_PASS (password per le app), EMAIL_SENDER=staff@noventra.it,
          EMAIL_SENDER_NAME=Noventra, EMAIL_SENDER_AUTHORIZED=si e riavvia il server.
        </p>
      )}

      {!missing && (
        <>
          <div>
            <Button
              variant="secondary"
              busy={busy === 'verify'}
              disabled={busy !== null}
              onClick={() => void run('verify', () => post('/email/verify'))}
            >
              Verifica connessione
            </Button>
            <p className="small muted">Controlla connessione e autenticazione senza inviare messaggi.</p>
          </div>
          <form
            className="row email-test"
            aria-label="Email di prova"
            noValidate
            onSubmit={(e) => {
              e.preventDefault();
              if (!EMAIL.test(to.trim())) {
                setFieldError('Indirizzo email non valido.');
                return;
              }
              setFieldError(null);
              setConfirming(true);
            }}
          >
            <Field
              label="Indirizzo per la prova"
              type="email"
              value={to}
              maxLength={254}
              onChange={(e) => setTo(e.target.value)}
              error={fieldError ?? undefined}
              hint="Un solo messaggio di prova, a questo indirizzo, solo dopo la conferma."
            />
            <Button type="submit" variant="secondary" busy={busy === 'test'} disabled={busy !== null || !to.trim()}>
              Invia email di prova
            </Button>
          </form>
        </>
      )}
      {result && (
        <p role="status" className={`small export__result export__result--${result.ok ? 'ok' : 'error'}`}>
          {result.text}
        </p>
      )}

      <ConfirmDialog
        open={confirming}
        title="Inviare l’email di prova?"
        confirmLabel="Invia la prova"
        busy={busy === 'test'}
        onCancel={() => setConfirming(false)}
        onConfirm={() => {
          setConfirming(false);
          void run('test', () => post('/email/test', { to: to.trim(), confirm: true }));
        }}
      >
        <p>
          Un messaggio di prova partirà da <span className="mono">{s.from?.address}</span> verso{' '}
          <span className="mono">{to.trim()}</span>. Non è un’email commerciale e non viene registrato nel CRM.
        </p>
      </ConfirmDialog>
    </div>
  );
}
