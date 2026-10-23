import { useState } from 'react';
import { Link } from 'react-router';
import { Building2, ChevronRight, Clock, Mail, Search, UsersRound, type LucideIcon } from 'lucide-react';
import heroImage from '../assets/dashboard-hero.svg';
import type { BusinessSummary, HomeOverview } from '../api/client.ts';
import { DashboardProspects } from '../components/DashboardProspects.tsx';
import { EmailComposer } from '../components/EmailComposer.tsx';
import { ErrorNotice } from '../components/ui.tsx';
import { useApi } from '../lib/useApi.ts';

/*
 * Dashboard: trovare i migliori potenziali clienti e scrivere loro con meno clic possibile.
 *  - quattro numeri dal database (/api/home, stesse definizioni degli elenchi), ognuno apre l'elenco che lo spiega;
 *  - ricerca e filtri eseguiti dal server, tabella paginata con «Invia email» su ogni riga (composer esistente).
 * Nessun numero o azienda di esempio: se l'API non risponde lo si dichiara, senza mostrare cifre.
 */

// separatore delle migliaia anche a 4 cifre (1.329), come nel resto dei numeri principali
const n = (v: number) => v.toLocaleString('it-IT', { useGrouping: 'always' } as Intl.NumberFormatOptions);

interface Kpi {
  label: string;
  value: number;
  note: string;
  to: string;
  icon: LucideIcon;
  tone: 'blue' | 'green' | 'orange' | 'violet';
}

function Kpis({ h }: { h: HomeOverview }) {
  const s = h.sales;
  const items: Kpi[] = [
    {
      label: 'Aziende trovate',
      value: s.found,
      note: 'Aziende uniche nel database.',
      to: '/trova',
      icon: Building2,
      tone: 'blue',
    },
    {
      label: 'Pronte da contattare',
      value: s.readyToContact,
      note: 'Con email disponibile e senza restrizioni al contatto.',
      to: '/trova?contactStatus=da_contattare&email=yes',
      icon: UsersRound,
      tone: 'green',
    },
    {
      label: 'Email inviate',
      value: s.emailsSent,
      note: 'Accettate dal server di posta.',
      to: '/email?vista=storico&status=sent',
      icon: Mail,
      tone: 'orange',
    },
    {
      label: 'In attesa di risposta',
      value: s.awaitingReply,
      note: 'Aziende contattate, in attesa di una risposta.',
      to: '/email?vista=in-attesa',
      icon: Clock,
      tone: 'violet',
    },
  ];
  return (
    <ul className="dash-kpis" aria-label="Numeri principali">
      {items.map((k) => (
        <li key={k.label}>
          <Link to={k.to} className={`dash-kpi dash-kpi--${k.tone}`}>
            <span className="dash-kpi__icon" aria-hidden="true">
              <k.icon size={26} strokeWidth={1.8} />
            </span>
            <span className="dash-kpi__body">
              <span className="dash-kpi__label">{k.label}</span>
              <span className="dash-kpi__value mono">{n(k.value)}</span>
              <span className="dash-kpi__note">{k.note}</span>
            </span>
            <ChevronRight className="dash-kpi__chevron" size={18} aria-hidden="true" />
          </Link>
        </li>
      ))}
    </ul>
  );
}

/** Spazio riservato ai numeri durante il caricamento (nessuno spostamento della pagina). */
function KpisLoading() {
  return (
    <ul className="dash-kpis" aria-hidden="true">
      {Array.from({ length: 4 }, (_, i) => (
        <li key={i}>
          <span className="dash-kpi dash-kpi--loading">
            <span className="skeleton-line" />
          </span>
        </li>
      ))}
    </ul>
  );
}

export function DashboardPage() {
  const home = useApi<HomeOverview>('/home');
  const [composeFor, setComposeFor] = useState<BusinessSummary | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const h = home.data;
  return (
    <>
      <header className="dash-hero">
        <div className="dash-hero__text">
          <p className="dash-hero__eyebrow">Noventra Lead Finder</p>
          <h1 className="dash-hero__title">
            Trova i clienti giusti per <span className="dash-hero__accent">Noventra</span>.
          </h1>
          <p className="dash-hero__lede">
            Cerca aziende, filtra i risultati e contattale in pochi secondi.
            <br />
            Gestisci i tuoi potenziali clienti da un’unica schermata.
          </p>
          <div className="dash-hero__actions">
            <Link to="/trova" className="btn btn--lg">
              <Search size={18} aria-hidden="true" />
              Trova aziende
            </Link>
            <Link to="/email" className="btn btn--secondary btn--lg">
              <Mail size={18} aria-hidden="true" />
              Email commerciali
            </Link>
          </div>
        </div>
        <img
          className="dash-hero__art"
          src={heroImage}
          alt=""
          width={640}
          height={360}
          decoding="async"
          fetchPriority="low"
        />
      </header>

      {home.error && <ErrorNotice error={home.error} onRetry={home.reload} />}
      {h ? <Kpis h={h} /> : !home.error && <KpisLoading />}

      <DashboardProspects onCompose={setComposeFor} refreshKey={refreshKey} />

      {composeFor && (
        <EmailComposer
          business={composeFor}
          onClose={() => setComposeFor(null)}
          onSent={() => {
            home.reload();
            setRefreshKey((k) => k + 1);
          }}
        />
      )}
    </>
  );
}
