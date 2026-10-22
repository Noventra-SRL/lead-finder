import { useEffect, useRef, useState } from 'react';
import { Link, Outlet, useLocation } from 'react-router';
import { useAuth, useUser } from '../auth/AuthContext.tsx';
import { roleLabel } from '../lib/format.ts';
import type { AiStatus, EmailTodo, Reminders } from '../api/client.ts';
import { useApi } from '../lib/useApi.ts';
import { ACTIVE_PHASE, isActive, MENU_ITEMS } from '../navigation.ts';
import { Icon, type IconName } from './icons.tsx';
import { Button } from './ui.tsx';

const NAV_ICON: Record<string, IconName> = {
  '/': 'today',
  '/trova': 'search',
  '/email': 'mail',
  '/pipeline': 'deals',
  '/impostazioni': 'settings',
};

function Brand() {
  return (
    // nome accessibile = testo visibile ("Noventra Lead Finder"), come richiede WCAG 2.5.3
    <Link to="/" className="brand">
      <span className="brand__mark" aria-hidden="true" />
      <span className="brand__text">
        <span className="brand__name">Noventra</span>
        <span className="brand__product">Lead Finder</span>
      </span>
    </Link>
  );
}

const AI_STATE = {
  available: { text: 'AI attiva', tone: 'ok' },
  error: { text: 'AI: errore all’ultima chiamata', tone: 'danger' },
  not_configured: { text: 'AI non configurata', tone: 'idle' },
} as const;

/** Stato della valutazione AI, letto una volta all'apertura: niente dettagli tecnici, solo lo stato e dove vederlo. */
function AiIndicator() {
  const status = useApi<AiStatus>('/ai/status');
  if (!status.data) return null;
  const s = AI_STATE[status.data.state];
  return (
    <Link
      to="/analisi-ai"
      className={`rail-chip rail-chip--${s.tone}`}
      title="Stato della valutazione commerciale con AI"
    >
      {s.text}
    </Link>
  );
}

/**
 * Promemoria dei follow-up da leggere: riletti ogni 2 minuti mentre l'applicazione è aperta e a ogni cambio di
 * pagina (dopo aver completato un follow-up o letto i promemoria il numero si aggiorna).
 */
function RemindersIndicator() {
  const { pathname } = useLocation();
  const reminders = useApi<Reminders>('/notifications?unread=1&limit=1', 120_000);
  const { reload } = reminders;
  const shownOn = useRef(pathname);
  useEffect(() => {
    if (shownOn.current === pathname) return;
    shownOn.current = pathname;
    reload();
  }, [pathname, reload]);
  const r = reminders.data;
  return (
    <Link to="/promemoria" className="rail-link" aria-current={pathname === '/promemoria' ? 'page' : undefined}>
      <Icon name="bell" />
      <span>Promemoria</span>
      {r && r.unread > 0 ? (
        <span className={`nav__count mono${r.unreadOverdue > 0 ? ' nav__count--alert' : ''}`}>
          {r.unread}
          <span className="visually-hidden">
            {' '}
            da leggere{r.unreadOverdue > 0 ? `, ${r.unreadOverdue} scaduti` : ''}
          </span>
        </span>
      ) : (
        <span className="rail-link__note">nessuno</span>
      )}
    </Link>
  );
}

/**
 * Lavoro in attesa nelle email, accanto a «Email commerciali» (riletto ogni 2 minuti): bozze AI da revisionare,
 * risposte da leggere e follow-up da inviare oggi.
 */
function EmailTodoBadge() {
  const todo = useApi<EmailTodo>('/emails/todo', 120_000).data;
  const parts = [
    [todo?.review ?? 0, 'da revisionare'],
    [todo?.replies ?? 0, 'risposte da leggere'],
    [todo?.followupsDue ?? 0, 'follow-up da inviare'],
  ] as const;
  const n = parts.reduce((t, [c]) => t + c, 0);
  if (!n) return null;
  const text = parts
    .filter(([c]) => c > 0)
    .map(([c, label]) => `${c} ${label}`)
    .join(', ');
  return (
    <span className="nav__count" title={text}>
      {n}
      <span className="visually-hidden"> ({text})</span>
    </span>
  );
}

export function AppShell() {
  const user = useUser();
  const { logout } = useAuth();
  const location = useLocation();
  // il menu mobile resta aperto solo sulla pagina in cui è stato aperto: cambiando pagina si chiude
  const [menuPath, setMenuPath] = useState<string | null>(null);
  const menuOpen = menuPath === location.pathname;
  const setMenuOpen = (open: boolean) => setMenuPath(open ? location.pathname : null);
  const [leaving, setLeaving] = useState(false);

  useEffect(() => {
    if (!menuOpen) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setMenuPath(null);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [menuOpen]);

  const initials = user.displayName
    .split(/\s+/)
    .map((w) => w[0])
    .join('')
    .slice(0, 2)
    .toUpperCase();

  return (
    <div className="shell" data-menu={menuOpen ? 'open' : 'closed'}>
      <a className="skip-link" href="#contenuto">
        Vai al contenuto
      </a>
      <header className="topbar">
        <Brand />
        <Button
          variant="secondary"
          aria-expanded={menuOpen}
          aria-controls="navigazione"
          onClick={() => setMenuOpen(!menuOpen)}
        >
          <Icon name={menuOpen ? 'close' : 'menu'} size={18} />
          {menuOpen ? 'Chiudi' : 'Menu'}
        </Button>
      </header>

      <aside className="rail" id="navigazione">
        <Brand />
        <nav className="nav" aria-label="Sezioni">
          <ul>
            {MENU_ITEMS.map((item) => (
              <li key={item.path}>
                <Link
                  to={item.path}
                  className="nav__link"
                  title={item.hint}
                  aria-current={isActive(item, location.pathname) ? 'page' : undefined}
                >
                  <Icon name={NAV_ICON[item.path] ?? 'arrow'} />
                  <span>{item.label}</span>
                  {item.path === '/email' && <EmailTodoBadge />}
                  {item.phase > ACTIVE_PHASE && (
                    <span className="nav__state" title={`Disponibile dalla fase ${item.phase}`}>
                      <span aria-hidden="true">F{item.phase}</span>
                      <span className="visually-hidden">, non ancora attivo</span>
                    </span>
                  )}
                </Link>
              </li>
            ))}
          </ul>
        </nav>
        <div className="rail__aux">
          <RemindersIndicator />
          <AiIndicator />
        </div>
        <div className="rail__user">
          <span className="rail__avatar" aria-hidden="true">
            {initials}
          </span>
          <div className="rail__who">
            <span className="rail__name">{user.displayName}</span>
            <span className="rail__role">
              {roleLabel(user.role)} · {user.email}
            </span>
          </div>
          <Button
            variant="ghost"
            className="rail__logout"
            busy={leaving}
            onClick={() => {
              setLeaving(true);
              void logout().finally(() => setLeaving(false));
            }}
          >
            Esci
          </Button>
        </div>
      </aside>

      <main className="main" id="contenuto" tabIndex={-1}>
        <div className="main__inner">
          <Outlet />
        </div>
      </main>
    </div>
  );
}
