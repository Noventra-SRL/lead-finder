import { useState, type FormEvent } from 'react';
import { ApiError, post } from '../api/client.ts';
import { Button, Field, Notice } from './ui.tsx';

const MIN = 12;

/** Cambio password: verifica della password attuale sul server; le altre sessioni vengono chiuse. */
export function PasswordForm({
  onDone,
  submitLabel = 'Cambia password',
}: {
  onDone?: () => void;
  submitLabel?: string;
}) {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const mismatch = confirm.length > 0 && confirm !== next;

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (mismatch) return;
    setBusy(true);
    setError(null);
    setDone(null);
    try {
      const r = await post<{ closedSessions: number }>('/auth/password', {
        currentPassword: current,
        newPassword: next,
      });
      setCurrent('');
      setNext('');
      setConfirm('');
      setDone(
        r.closedSessions
          ? `Password aggiornata. ${r.closedSessions === 1 ? 'È stata chiusa 1 altra sessione' : `Sono state chiuse ${r.closedSessions} altre sessioni`}.`
          : 'Password aggiornata.',
      );
      onDone?.();
    } catch (err) {
      setError(err instanceof ApiError ? err : new ApiError(0, 'UNKNOWN', 'Operazione non riuscita.'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="stack form-narrow" onSubmit={submit} noValidate>
      {done && <Notice tone="ok">{done}</Notice>}
      {error && !Object.keys(error.fields).length && <Notice tone="error">{error.message}</Notice>}
      <Field
        label="Password attuale"
        type="password"
        autoComplete="current-password"
        value={current}
        onChange={(e) => setCurrent(e.target.value)}
        error={error?.fields.currentPassword}
        required
      />
      <Field
        label="Nuova password"
        type="password"
        autoComplete="new-password"
        value={next}
        onChange={(e) => setNext(e.target.value)}
        hint={`Almeno ${MIN} caratteri. Una frase di più parole è facile da ricordare e difficile da indovinare.`}
        error={error?.fields.newPassword}
        required
      />
      <Field
        label="Ripeti la nuova password"
        type="password"
        autoComplete="new-password"
        value={confirm}
        onChange={(e) => setConfirm(e.target.value)}
        error={mismatch ? 'Le due password non coincidono.' : undefined}
        required
      />
      <div>
        <Button type="submit" busy={busy} disabled={!current || next.length < MIN || confirm !== next}>
          {submitLabel}
        </Button>
      </div>
    </form>
  );
}
