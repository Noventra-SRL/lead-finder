import { useEffect, useRef, useState } from 'react';
import { Bell, House, LogOut, Mail, Search, Settings, type LucideIcon } from 'lucide-react';
import { Link, Outlet, useLocation } from 'react-router';
import { useAuth, useUser } from '../auth/AuthContext.tsx';
import { roleLabel } from '../lib/format.ts';
import type { AiStatus, EmailList, Reminders } from '../api/client.ts';
import { useApi } from '../lib/useApi.ts';
import { ACTIVE_PHASE, isActive, MENU_ITEMS } from '../navigation.ts';
import { Button, Status } from './ui.tsx';

/** Icona di ogni voce del menu (Lucide, decorativa: il nome resta il testo della voce). */
const NAV_ICON: Record<string, LucideIcon> = {
  '/': House,
  '/trova': Search,
  '/email': Mail,
  '/impostazioni': Settings,
};

/** Iniziali per l'avatar dell'utente (nessuna immagine). */
const initials = (name: string) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join('');

function Brand() {
  return (
    // nome accessibile = testo visibile ("Noventra Lead Finder"), come richiede WCAG 2.5.3
    <Link to="/" className="brand">
      <span className="brand__name">Noventra</span>
      <span className="brand__product">
        Lead Finder<span>.</span>
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
    <Link to="/analisi-ai" className="ai-indicator" title="Stato della valutazione commerciale con AI">
      <Status tone={s.tone}>{s.text}</Status>
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
    <Link to="/promemoria" className="reminders-indicator">
      <span className="reminders-indicator__label">
        <Bell size={16} aria-hidden="true" />
        Promemoria
      </span>
      {r && r.unread > 0 ? (
        <span className={`mono ${r.unreadOverdue > 0 ? 'text-danger' : ''}`}>
          {r.unread}
          <span className="visually-hidden">
            {' '}
            da leggere{r.unreadOverdue > 0 ? `, ${r.unreadOverdue} scaduti` : ''}
          </span>
        </span>
      ) : (
        <span className="muted small">nessuno</span>
      )}
    </Link>
  );
}

/** Bozze generate dall'AI da revisionare: numero accanto a «Email commerciali» (riletto ogni 2 minuti). */
function EmailReviewBadge() {
  const list = useApi<EmailList>('/emails?status=review&pageSize=1', 120_000);
  const n = list.data?.total ?? 0;
  if (!n) return null;
  return (
    <span className="nav__badge mono" title={`${n} da revisionare`}>
      {n}
      <span className="visually-hidden"> da revisionare</span>
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
          {menuOpen ? 'Chiudi' : 'Menu'}
        </Button>
      </header>

      <aside className="rail" id="navigazione">
        <Brand />
        <nav className="nav" aria-label="Sezioni">
          <div className="nav__group nav__group--main">
            <p className="nav__heading">Principale</p>
            <ol>
              {MENU_ITEMS.map((item) => (
                <li key={item.path}>
                  <Link
                    to={item.path}
                    className="nav__link"
                    title={item.hint}
                    aria-current={isActive(item, location.pathname) ? 'page' : undefined}
                  >
                    {(() => {
                      const Icon = NAV_ICON[item.path];
                      return Icon ? (
                        <Icon className="nav__icon" size={19} strokeWidth={1.9} aria-hidden="true" />
                      ) : null;
                    })()}
                    <span>{item.label}</span>
                    {item.path === '/email' && <EmailReviewBadge />}
                    {item.phase > ACTIVE_PHASE && (
                      <span className="nav__state" title={`Disponibile dalla fase ${item.phase}`}>
                        <span aria-hidden="true">F{item.phase}</span>
                        <span className="visually-hidden">, non ancora attivo</span>
                      </span>
                    )}
                  </Link>
                </li>
              ))}
            </ol>
          </div>
        </nav>
        <RemindersIndicator />
        <AiIndicator />
        <div className="rail__user">
          <span className="rail__avatar" aria-hidden="true">
            {initials(user.displayName)}
          </span>
          <div className="rail__who">
            <span className="rail__name">{user.displayName}</span>
            <span className="rail__role">
              {roleLabel(user.role)} · {user.email}
            </span>
          </div>
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
          <LogOut size={18} aria-hidden="true" />
          Esci
        </Button>
      </aside>

      <main className="main" id="contenuto" tabIndex={-1}>
        <div className="main__inner">
          <Outlet />
        </div>
      </main>
    </div>
  );
}
