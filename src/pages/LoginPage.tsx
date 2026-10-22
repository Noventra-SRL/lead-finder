import { useState, type FormEvent } from 'react';
import { ApiError } from '../api/client.ts';
import { useAuth } from '../auth/AuthContext.tsx';
import { Button, Field, Notice } from '../components/ui.tsx';

export function LoginPage({ notice }: { notice?: string }) {
  const { login } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await login(email, password);
    } catch (err) {
      setError(err instanceof ApiError ? err : new ApiError(0, 'UNKNOWN', 'Accesso non riuscito.'));
      setPassword('');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="auth">
      <section className="auth__statement" aria-label="Lead Finder">
        <span className="brand__name">Noventra</span>
        <h2 className="auth__headline">
          Meno contatti.
          <br />
          <span>Più opportunità vere.</span>
        </h2>
        <ol className="auth__principles">
          <li>
            <span className="mono">01</span>
            <strong>Evidenze, non supposizioni</strong>
            Ogni segnalazione su un sito riporta cosa è stato osservato, quando e con quale affidabilità.
          </li>
          <li>
            <span className="mono">02</span>
            <strong>Fonti aperte e tracciate</strong>
            Ogni azienda conserva la fonte da cui proviene e la data dell’ultima verifica.
          </li>
          <li>
            <span className="mono">03</span>
            <strong>Il contatto lo decide una persona</strong>
            Nessun messaggio parte in automatico. Esclusioni e opposizioni sono sempre rispettate.
          </li>
        </ol>
      </section>

      <section className="auth__panel">
        <form className="auth__form" onSubmit={submit} noValidate>
          <div className="stack stack--tight">
            <span className="eyebrow">Lead Finder · area riservata</span>
            <h1>Accedi</h1>
          </div>
          {notice && !error && <Notice tone="warn">{notice}</Notice>}
          {error && (
            <Notice tone="error">
              <p>{error.message}</p>
            </Notice>
          )}
          <Field
            label="Email di lavoro"
            type="email"
            name="email"
            autoComplete="username"
            inputMode="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            error={error?.fields.email}
          />
          <Field
            label="Password"
            type="password"
            name="password"
            autoComplete="current-password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            error={error?.fields.password}
          />
          <Button type="submit" busy={busy} block disabled={!email || !password}>
            Accedi
          </Button>
        </form>
        <p className="auth__foot">
          Gli account sono creati dall’amministratore. Se hai dimenticato la password, chiedigli di reimpostarla.
        </p>
      </section>
    </div>
  );
}
