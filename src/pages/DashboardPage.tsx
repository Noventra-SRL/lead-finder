import { useState } from 'react';
import { Link } from 'react-router';
import type { AgendaWeek, BusinessSummary, EmailTodo, HomeOverview } from '../api/client.ts';
import { EmailComposer } from '../components/EmailComposer.tsx';
import { ExportButton } from '../components/ExportButton.tsx';
import { Icon } from '../components/icons.tsx';
import { ProspectTable } from '../components/ProspectTable.tsx';
import { Button, ErrorNotice, Loading } from '../components/ui.tsx';
import { useApi } from '../lib/useApi.ts';

/*
 * Dashboard «Oggi»: il lavoro del giorno come agenda.
 *  - quattro numeri d'azione (aziende trovate, pronte da contattare, email inviate, in attesa di risposta), ognuno
 *    apre l'elenco che lo spiega;
 *  - agenda della settimana: invii, risposte, follow-up delle sequenze e del CRM, giorno per giorno (dati reali);
 *  - migliori prospect da contattare con «Invia email».
 * Numeri da /api/home e /api/home/agenda con le stesse definizioni degli elenchi; nessun dato dimostrativo.
 */

const n = (v: number) => v.toLocaleString('it-IT');

/** Il lavoro di oggi: tre azioni con il loro conteggio, ognuna porta alla vista dove si fa. */
function TodayActions({ ready }: { ready: number }) {
  const todo = useApi<EmailTodo>('/emails/todo').data;
  const actions = [
    {
      count: todo?.replies,
      one: 'risposta da leggere',
      many: 'risposte da leggere',
      to: '/email?vista=risposte',
      tone: 'positive',
    },
    {
      count: todo?.followupsDue,
      one: 'follow-up da inviare',
      many: 'follow-up da inviare',
      to: '/email?vista=follow-up',
      tone: 'followup',
    },
    {
      count: ready,
      one: 'azienda da contattare',
      many: 'aziende da contattare',
      to: '/email?vista=da-contattare',
      tone: 'sent',
    },
  ];
  return (
    <ul className="actions" aria-label="Da fare oggi">
      {actions.map((a) => (
        <li key={a.to}>
          <Link to={a.to} className={`action action--${a.tone}${a.count === 0 ? ' action--done' : ''}`}>
            <span className="action__count">{a.count === undefined ? '…' : n(a.count)}</span>
            <span className="action__label">{a.count === 1 ? a.one : a.many}</span>
            <Icon name="arrow" size={20} className="action__arrow" />
          </Link>
        </li>
      ))}
    </ul>
  );
}

function Kpis({ h }: { h: HomeOverview }) {
  const s = h.sales;
  const items = [
    { label: 'Aziende trovate', value: s.found, note: 'nel database, escluse le «non contattare»', to: '/trova' },
    {
      label: 'Pronte da contattare',
      value: s.readyToContact,
      note: 'mai contattate, con email',
      to: '/email?vista=da-contattare',
    },
    {
      label: 'Email inviate',
      value: s.emailsSent,
      note: 'accettate dal server di posta',
      to: '/email?vista=storico&status=sent',
    },
    {
      label: 'In attesa di risposta',
      value: s.awaitingReply,
      note: 'contattate, senza risposta',
      to: '/email?vista=in-attesa',
    },
  ];
  return (
    <ul className="kpis" aria-label="Numeri principali">
      {items.map((k) => (
        <li key={k.label}>
          <Link to={k.to} className="kpi" title={k.note}>
            <span className="kpi__label">{k.label}</span>
            <span className="kpi__value">{n(k.value)}</span>
            <span className="kpi__note">{k.note}</span>
          </Link>
        </li>
      ))}
    </ul>
  );
}

const TONE_LABEL = {
  positive: 'Risposta positiva',
  followup: 'Follow-up',
  sent: 'Inviata',
  attention: 'Da controllare',
  blocked: 'Bloccata',
} as const;

const dayName = (iso: string, style: 'short' | 'long') =>
  new Date(`${iso}T12:00:00Z`).toLocaleDateString('it-IT', { weekday: style, timeZone: 'UTC' });
const dayNum = (iso: string) => Number(iso.slice(8, 10));
const shift = (iso: string, days: number) => {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};
const longDate = (iso: string) =>
  new Date(`${iso}T12:00:00Z`).toLocaleDateString('it-IT', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    timeZone: 'UTC',
  });

/** Agenda della settimana: sette caselle, eventi reali colorati per stato. */
function Agenda() {
  const [week, setWeek] = useState<string | null>(null);
  const agenda = useApi<AgendaWeek>(`/home/agenda${week ? `?settimana=${week}` : ''}`);
  const a = agenda.data;
  const total = a?.days.reduce((t, d) => t + d.events.length, 0) ?? 0;
  const range = a
    ? `${dayNum(a.monday)} – ${new Date(`${shift(a.monday, 6)}T12:00:00Z`).toLocaleDateString('it-IT', { day: 'numeric', month: 'long', timeZone: 'UTC' })}`
    : '';
  return (
    <section className="week" aria-labelledby="agenda-titolo">
      <div className="week__head">
        <h2 id="agenda-titolo" className="block-title">
          Agenda della settimana
        </h2>
        <span className="week__range">{range}</span>
        <div className="week__nav">
          <Button
            variant="secondary"
            aria-label="Settimana precedente"
            disabled={!a}
            onClick={() => a && setWeek(shift(a.monday, -7))}
          >
            <Icon name="chevronLeft" size={18} />
          </Button>
          <Button variant="secondary" disabled={!a || week === null} onClick={() => setWeek(null)}>
            Questa settimana
          </Button>
          <Button
            variant="secondary"
            aria-label="Settimana successiva"
            disabled={!a}
            onClick={() => a && setWeek(shift(a.monday, 7))}
          >
            <Icon name="chevronRight" size={18} />
          </Button>
        </div>
      </div>
      {agenda.loading && !a && <Loading label="Caricamento dell’agenda…" />}
      {agenda.error && <ErrorNotice error={agenda.error} onRetry={agenda.reload} />}
      {a && (
        <>
          <ol
            className={`week__grid${total === 0 ? ' week__grid--empty' : ''}`}
            aria-label={`Settimana dal ${longDate(a.monday)}`}
          >
            {a.days.map((d) => {
              const isToday = d.date === a.today;
              const past = d.date < a.today;
              return (
                <li
                  key={d.date}
                  className={`week__day${isToday ? ' week__day--today' : ''}${past ? ' week__day--past' : ''}${d.events.length === 0 ? ' week__day--free' : ''}`}
                  aria-current={isToday ? 'date' : undefined}
                >
                  <p className="week__date">
                    <span className="week__dow">{dayName(d.date, 'short')}</span>
                    <span className="week__num">{dayNum(d.date)}</span>
                    <span className="visually-hidden">
                      {longDate(d.date)}
                      {isToday ? ', oggi' : ''}
                    </span>
                  </p>
                  {d.events.length > 0 && (
                    <ul className="week__events">
                      {d.events.slice(0, 5).map((e, i) => (
                        <li key={i}>
                          <Link to={e.link} className={`week-event week-event--${e.tone}`}>
                            <span className="week-event__title">{e.title}</span>
                            <span className="week-event__business">{e.business}</span>
                            <span className="visually-hidden">, {TONE_LABEL[e.tone]}</span>
                          </Link>
                        </li>
                      ))}
                      {d.events.length > 5 && <li className="week__more">+{d.events.length - 5} altri</li>}
                    </ul>
                  )}
                </li>
              );
            })}
          </ol>
          <div className="week__foot">
            <ul className="week__legend" aria-label="Legenda">
              {Object.entries(TONE_LABEL).map(([tone, label]) => (
                <li key={tone}>
                  <span className={`week__swatch week-event--${tone}`} aria-hidden="true" />
                  {label}
                </li>
              ))}
            </ul>
            {total === 0 && (
              <p className="small">
                Settimana libera: nessun invio, risposta o follow-up.{' '}
                <Link to="/email?vista=da-contattare" className="block__link">
                  Scrivi alle aziende da contattare <Icon name="arrow" size={16} />
                </Link>
              </p>
            )}
          </div>
        </>
      )}
    </section>
  );
}

export function DashboardPage() {
  const home = useApi<HomeOverview>('/home');
  const [composeFor, setComposeFor] = useState<BusinessSummary | null>(null);
  const h = home.data;
  const today = new Date().toLocaleDateString('it-IT', { weekday: 'long', day: 'numeric', month: 'long' });
  return (
    <>
      <header className="today">
        <div className="today__title">
          <h1 className="page-head__title">Oggi</h1>
          <p className="today__date">{today}</p>
        </div>
        <div className="row">
          <Link to="/trova" className="btn">
            <Icon name="search" size={18} />
            Trova aziende
          </Link>
          <Link to="/email" className="btn btn--secondary">
            <Icon name="mail" size={18} />
            Email commerciali
          </Link>
        </div>
      </header>

      {home.loading && !h && <Loading label="Caricamento dei dati…" />}
      {home.error && <ErrorNotice error={home.error} onRetry={home.reload} />}
      {h && (
        <>
          <TodayActions ready={h.sales.readyToContact} />
          <Kpis h={h} />
        </>
      )}
      <Agenda />
      {h && (
        <>
          <section className="block" aria-labelledby="home-migliori">
            <div className="block__head">
              <h2 id="home-migliori" className="block-title">
                I migliori prospect da contattare
              </h2>
              <Link to="/email?vista=da-contattare" className="block__link">
                Tutte le aziende da contattare <Icon name="arrow" size={16} />
              </Link>
            </div>
            {h.sales.bestProspects.length === 0 ? (
              <div className="empty">
                <p className="empty__title">Nessuna azienda da contattare con un’email disponibile.</p>
                <p className="empty__text">
                  Avvia una ricerca da <Link to="/trova">Trova aziende</Link>: le più promettenti compaiono qui.
                </p>
              </div>
            ) : (
              <ProspectTable
                items={h.sales.bestProspects}
                onCompose={setComposeFor}
                caption="Migliori prospect da contattare"
              />
            )}
            <p className="small muted after">
              In ordine di punteggio commerciale: valutazione AI o, in sua assenza, punteggio a regole.
            </p>
          </section>
          <section className="block" aria-labelledby="home-altro">
            <h2 id="home-altro" className="block-title">
              Altro
            </h2>
            <div className="row after">
              <Link to="/report" className="btn btn--secondary">
                Report completi
              </Link>
              <Link to="/pipeline" className="btn btn--secondary">
                Trattative
              </Link>
              <Link to="/promemoria" className="btn btn--secondary">
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
