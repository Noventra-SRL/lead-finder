import { useState } from 'react';
import { Link } from 'react-router';
import { ApiError, post, type SessionInfo, type SystemStatus, type UserSummary } from '../api/client.ts';
import { useUser } from '../auth/AuthContext.tsx';
import { EmailSettings } from '../components/EmailSettings.tsx';
import { PasswordForm } from '../components/PasswordForm.tsx';
import { ScoringSettings } from '../components/ScoringSettings.tsx';
import {
  Button,
  ConfirmDialog,
  Empty,
  ErrorNotice,
  Loading,
  Notice,
  PageHeader,
  Section,
  Status,
} from '../components/ui.tsx';
import { describeUserAgent, formatDateTime, formatDuration, formatRelative, roleLabel } from '../lib/format.ts';
import { useApi } from '../lib/useApi.ts';
import { NAV_ITEMS, navIndex } from '../navigation.ts';

function Sessions() {
  const { data, error, loading, reload } = useApi<{ sessions: SessionInfo[] }>('/auth/sessions');
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);
  const others = data?.sessions.filter((s) => !s.current).length ?? 0;

  async function revoke() {
    setBusy(true);
    try {
      const r = await post<{ closed: number }>('/auth/sessions/revoke-others');
      setResult({
        tone: 'ok',
        text: r.closed === 1 ? 'È stata chiusa 1 sessione.' : `Sono state chiuse ${r.closed} sessioni.`,
      });
      reload();
    } catch (e) {
      setResult({ tone: 'error', text: e instanceof ApiError ? e.message : 'Operazione non riuscita.' });
    } finally {
      setBusy(false);
      setConfirming(false);
    }
  }

  if (loading && !data) return <Loading />;
  if (error) return <ErrorNotice error={error} onRetry={reload} />;
  if (!data) return null;
  return (
    <div className="stack">
      {result && <Notice tone={result.tone}>{result.text}</Notice>}
      <div className="table-wrap">
        <table className="table table--stack">
          <thead>
            <tr>
              <th scope="col">Dispositivo</th>
              <th scope="col">Ultima attività</th>
              <th scope="col">Aperta il</th>
              <th scope="col">Scade il</th>
            </tr>
          </thead>
          <tbody>
            {data.sessions.map((s) => (
              <tr key={s.createdAt + s.userAgent}>
                <td data-label="Dispositivo">
                  {describeUserAgent(s.userAgent)}
                  {s.current && <span className="muted"> · questa sessione</span>}
                </td>
                <td data-label="Ultima attività">{formatRelative(s.lastSeenAt)}</td>
                <td data-label="Aperta il">{formatDateTime(s.createdAt)}</td>
                <td data-label="Scade il">{formatDateTime(s.expiresAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div>
        <Button variant="danger" disabled={others === 0} onClick={() => setConfirming(true)}>
          Chiudi le altre sessioni
        </Button>
      </div>
      <ConfirmDialog
        open={confirming}
        title="Chiudere le altre sessioni?"
        confirmLabel={others === 1 ? 'Chiudi 1 sessione' : `Chiudi ${others} sessioni`}
        tone="danger"
        busy={busy}
        onConfirm={() => void revoke()}
        onCancel={() => setConfirming(false)}
      >
        Gli altri dispositivi verranno disconnessi subito e dovranno accedere di nuovo. Questa sessione resta aperta.
      </ConfirmDialog>
    </div>
  );
}

function Users() {
  const { data, error, loading, reload } = useApi<{ users: UserSummary[] }>('/users');
  if (loading && !data) return <Loading />;
  if (error) return <ErrorNotice error={error} onRetry={reload} />;
  if (!data?.users.length) return <Empty title="Nessun utente" />;
  return (
    <div className="stack">
      <div className="table-wrap">
        <table className="table table--stack">
          <thead>
            <tr>
              <th scope="col">Nome</th>
              <th scope="col">Email</th>
              <th scope="col">Ruolo</th>
              <th scope="col">Stato</th>
              <th scope="col">Ultimo accesso</th>
            </tr>
          </thead>
          <tbody>
            {data.users.map((u) => (
              <tr key={u.id}>
                <td data-label="Nome">{u.displayName}</td>
                <td data-label="Email" className="mono">
                  {u.email}
                </td>
                <td data-label="Ruolo">{roleLabel(u.role)}</td>
                <td data-label="Stato">
                  {u.disabled ? (
                    <Status tone="danger">Disattivato</Status>
                  ) : u.mustChangePassword ? (
                    <Status tone="warn">Password temporanea</Status>
                  ) : (
                    <Status tone="ok">Attivo</Status>
                  )}
                </td>
                <td data-label="Ultimo accesso">{formatDateTime(u.lastLoginAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="small muted">
        Gli account si gestiscono dal server con{' '}
        <code>npm run user -- crea | reimposta | disattiva | riattiva | ruolo</code>: la password temporanea compare una
        sola volta nel terminale e va cambiata al primo accesso.
      </p>
    </div>
  );
}

export function SettingsPage() {
  const user = useUser();
  const item = NAV_ITEMS.find((i) => i.path === '/impostazioni')!;
  return (
    <>
      <PageHeader index={navIndex(item.path)} title={item.label} lede={item.lede} />
      <Section
        title="Strumenti avanzati"
        description="Le sezioni di dettaglio, fuori dal menu ma con tutte le loro funzioni: dati, valutazioni, configurazioni e report."
      >
        <ul className="tools-list">
          {NAV_ITEMS.filter((s) => !s.inNav).map((s) => (
            <li key={s.path}>
              <Link to={s.path}>{s.label}</Link>
              <span className="small muted"> · {s.hint}</span>
            </li>
          ))}
          <li>
            <Link to="/promemoria">Promemoria</Link>
            <span className="small muted"> · follow-up scaduti e in scadenza</span>
          </li>
        </ul>
      </Section>
      <Section title="Account" description="I dati dell’account sono gestiti dall’amministratore.">
        <dl className="props">
          <dt>Nome</dt>
          <dd>{user.displayName}</dd>
          <dt>Email</dt>
          <dd className="mono">{user.email}</dd>
          <dt>Ruolo</dt>
          <dd>{roleLabel(user.role)}</dd>
        </dl>
      </Section>
      <Section title="Password" description="Cambiandola, le altre sessioni aperte vengono chiuse.">
        <PasswordForm />
      </Section>
      <Section
        title="Sessioni attive"
        description="Dispositivi da cui hai effettuato l’accesso e che non sono ancora scaduti."
      >
        <Sessions />
      </Section>
      <Section
        title="Punteggio dei lead"
        description="Pesi, fasce e soglie del modello. Ogni modifica è una nuova versione: i punteggi già calcolati restano interpretabili."
      >
        <ScoringSettings admin={user.role === 'admin'} />
      </Section>
      {user.role === 'admin' && (
        <Section
          title="Invio email"
          description="Server di posta per le email commerciali (Google Workspace). Le credenziali restano sul server."
        >
          <EmailSettings />
        </Section>
      )}
      {user.role === 'admin' && (
        <Section
          title="Utenti"
          description="Persone del team con accesso a Lead Finder. Visibile solo agli amministratori."
        >
          <Users />
        </Section>
      )}
      <Section
        title="Stato del sistema"
        description="Connessione al database, schema e processo del server, verificati a ogni caricamento."
      >
        <SystemStatusView />
      </Section>
    </>
  );
}

/** Stato tecnico del server (spostato dalla pagina iniziale: informazioni per chi gestisce l'applicazione). */
function SystemStatusView() {
  const { data, error, loading, reload } = useApi<SystemStatus>('/system/status');
  if (loading && !data) return <Loading label="Verifica del sistema…" />;
  if (error) return <ErrorNotice error={error} onRetry={reload} />;
  if (!data) return null;
  return (
    <div className="stack">
      <dl className="props">
        <dt>Database</dt>
        <dd>
          <Status tone="ok">Connesso</Status>{' '}
          <span className="muted small">· risposta in {data.database.latencyMs} ms</span>
          <div className="small muted">{data.database.description}</div>
        </dd>
        <dt>Schema</dt>
        <dd>
          {data.database.migrationsPending.length === 0 ? (
            <Status tone="ok">Aggiornato</Status>
          ) : (
            <Status tone="warn">{data.database.migrationsPending.length} migrazioni da applicare</Status>
          )}
          <div className="small muted mono">
            {data.database.migrationsApplied.map((m) => `${m.version}_${m.name}`).join(', ') || 'nessuna migrazione'}
          </div>
        </dd>
        <dt>Server</dt>
        <dd>
          <span className="mono">v{data.version}</span> · Node <span className="mono">{data.node}</span> · ambiente{' '}
          <span className="mono">{data.environment}</span>
          <div className="small muted">
            Avviato {formatDateTime(data.startedAt)} · attivo da {formatDuration(data.uptimeSeconds)}
          </div>
        </dd>
        <dt>Utenti</dt>
        <dd>
          <span className="mono">{data.counts.activeUsers}</span>{' '}
          {data.counts.activeUsers === 1 ? 'utente attivo' : 'utenti attivi'} ·{' '}
          <span className="mono">{data.counts.activeSessions}</span>{' '}
          {data.counts.activeSessions === 1 ? 'sessione aperta' : 'sessioni aperte'}
        </dd>
      </dl>
      <div>
        <Button variant="secondary" onClick={reload} busy={loading}>
          Verifica di nuovo
        </Button>
      </div>
    </div>
  );
}
