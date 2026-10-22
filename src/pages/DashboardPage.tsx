import { useState } from 'react';
import { Link } from 'react-router';
import type { BusinessSummary, HomeOverview } from '../api/client.ts';
import { EmailComposer } from '../components/EmailComposer.tsx';
import { ExportButton } from '../components/ExportButton.tsx';
import { ProspectTable } from '../components/ProspectTable.tsx';
import { ErrorNotice, Loading } from '../components/ui.tsx';
import { useApi } from '../lib/useApi.ts';

/*
 * Dashboard: quattro domande e i migliori prospect da contattare.
 *  - aziende trovate (non escluse), pronte da contattare (nessun contatto, email disponibile), email inviate
 *    (accettate dal server di posta), in attesa di risposta (contattate, trattativa non ancora avanzata);
 *  - migliori prospect: da contattare, con email, in ordine di punteggio commerciale, con «Invia email».
 * Numeri da /api/home con le stesse definizioni degli elenchi; nessuna apertura, bozza o accettazione è contata come
 * risposta o vendita. I report completi restano un'azione secondaria.
 */

const n = (v: number) => v.toLocaleString('it-IT');

function Kpis({ h }: { h: HomeOverview }) {
  const s = h.sales;
  const items = [
    {
      label: 'Aziende trovate',
      value: s.found,
      note: 'Aziende uniche nel database, escluse quelle da non contattare.',
      to: '/trova',
    },
    {
      label: 'Pronte da contattare',
      value: s.readyToContact,
      note: 'Mai contattate e con un’email disponibile.',
      to: '/email?vista=da-contattare',
    },
    {
      label: 'Email inviate',
      value: s.emailsSent,
      note: 'Accettate dal server di posta (la consegna non è confermata).',
      to: '/email?vista=storico&status=sent',
    },
    {
      label: 'In attesa di risposta',
      value: s.awaitingReply,
      note: 'Aziende contattate, in attesa di una risposta.',
      to: '/email?vista=in-attesa',
    },
  ];
  return (
    <ul className="kpis" aria-label="Numeri principali">
      {items.map((k) => (
        <li key={k.label}>
          <Link to={k.to} className="kpi">
            <span className="kpi__label">{k.label}</span>
            <span className="kpi__value mono">{n(k.value)}</span>
            <span className="kpi__note">{k.note}</span>
          </Link>
        </li>
      ))}
    </ul>
  );
}

export function DashboardPage() {
  const home = useApi<HomeOverview>('/home');
  const [composeFor, setComposeFor] = useState<BusinessSummary | null>(null);
  const h = home.data;
  return (
    <>
      <header className="home-intro">
        <p className="home-intro__eyebrow">Noventra Lead Finder</p>
        <h1 className="home-intro__title">Trova i clienti giusti per Noventra.</h1>
        <p className="home-intro__lede">
          Trova le aziende, scegli le più promettenti e scrivi loro in pochi secondi. Ogni numero viene dal database.
        </p>
        <div className="row">
          <Link to="/trova" className="btn">
            Trova aziende
          </Link>
          <Link to="/email" className="btn btn--secondary">
            Email commerciali
          </Link>
        </div>
      </header>

      {home.loading && !h && <Loading label="Caricamento dei dati…" />}
      {home.error && <ErrorNotice error={home.error} onRetry={home.reload} />}
      {h && (
        <>
          <Kpis h={h} />
          <section className="home-block" aria-labelledby="home-migliori">
            <h2 id="home-migliori" className="home-block__title">
              I migliori prospect da contattare
            </h2>
            {h.sales.bestProspects.length === 0 ? (
              <p className="small muted">
                Nessuna azienda da contattare con un’email disponibile. <Link to="/trova">Trova aziende</Link>
              </p>
            ) : (
              <ProspectTable
                items={h.sales.bestProspects}
                onCompose={setComposeFor}
                caption="Migliori prospect da contattare"
              />
            )}
            <p className="small after">
              In ordine di punteggio commerciale (valutazione AI o, in sua assenza, punteggio a regole dichiarato).{' '}
              <Link to="/email?vista=da-contattare">Tutte le aziende da contattare</Link>
            </p>
          </section>
          <section className="home-block home-more" aria-labelledby="home-altro">
            <h2 id="home-altro" className="home-block__title">
              Altro
            </h2>
            <div className="row">
              <Link to="/report" className="btn btn--ghost">
                Report completi
              </Link>
              <Link to="/pipeline" className="btn btn--ghost">
                Trattative
              </Link>
              <Link to="/promemoria" className="btn btn--ghost">
                Promemoria
              </Link>
              <ExportButton
                dataset="businesses"
                query={`minCommercial=${h.commercial.topBand.min}&sort=commercial&dir=desc`}
                name="prospect"
                label="Esporta i prospect prioritari"
                variant="secondary"
              />
            </div>
          </section>
        </>
      )}
      {composeFor && <EmailComposer business={composeFor} onClose={() => setComposeFor(null)} onSent={home.reload} />}
    </>
  );
}
