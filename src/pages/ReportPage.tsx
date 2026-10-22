import { Link, useSearchParams } from 'react-router';
import type { CommercialReport, ReportPeriod } from '../api/client.ts';
import { BarList, bucketLabel, Columns } from '../components/charts.tsx';
import { ExportButton } from '../components/ExportButton.tsx';
import { Empty, ErrorNotice, Loading, PageHeader, Section } from '../components/ui.tsx';
import { formatEuro } from '../lib/crm.ts';
import { formatDate } from '../lib/format.ts';
import { useApi } from '../lib/useApi.ts';
import { NAV_ITEMS, navIndex, pageTitle } from '../navigation.ts';

/*
 * Report commerciali (Fase 8): numeri calcolati dal server sulle righe del database, nessuna AI e nessuna stima.
 * Ogni misura dichiara la sua definizione; dove i dati non bastano si dice, invece di mostrare un numero.
 */

const PERIODS: { id: ReportPeriod; label: string }[] = [
  { id: '7d', label: '7 giorni' },
  { id: '30d', label: '30 giorni' },
  { id: '90d', label: '90 giorni' },
  { id: 'month', label: 'Questo mese' },
  { id: 'prev_month', label: 'Mese precedente' },
  { id: 'all', label: 'Tutto il periodo' },
];

const NUM = new Intl.NumberFormat('it-IT');
const pct = (v: number) => `${Math.round(v * 100)}%`;

function Figure({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <div className="report-fig">
      <dt className="report-fig__label">{label}</dt>
      <dd className="report-fig__value mono">{value}</dd>
      {note && <dd className="report-fig__note small muted">{note}</dd>}
    </div>
  );
}

function rangeText(r: CommercialReport): string {
  if (!r.range.from) return 'Dall’inizio dei dati a oggi.';
  const last = new Date(`${r.range.toExclusive}T12:00:00Z`);
  last.setUTCDate(last.getUTCDate() - 1);
  return `Dal ${formatDate(`${r.range.from}T12:00:00Z`)} al ${formatDate(last.toISOString())} (ora italiana).`;
}

export function ReportPage() {
  const item = NAV_ITEMS.find((i) => i.path === '/report')!;
  const [params] = useSearchParams();
  const period = (PERIODS.find((p) => p.id === params.get('period'))?.id ?? '30d') as ReportPeriod;
  const report = useApi<CommercialReport>(`/reports?period=${period}`);
  const r = report.data;

  return (
    <>
      <PageHeader index={navIndex(item.path)} title={pageTitle(item)} lede={item.lede} />
      <div className="report-bar">
        <nav className="segmented" aria-label="Periodo del report">
          {PERIODS.map((p) => (
            <Link key={p.id} to={`?period=${p.id}`} aria-current={period === p.id ? 'page' : undefined}>
              {p.label}
            </Link>
          ))}
        </nav>
        {r && <p className="small muted">{rangeText(r)}</p>}
      </div>

      {report.loading && !r && <Loading />}
      {report.error && <ErrorNotice error={report.error} onRetry={report.reload} />}
      {r && r.prospecting.total === 0 && (
        <Empty title="Ancora nessun dato">
          Il report si riempie con le aziende trovate dalle ricerche e con le opportunità del CRM.{' '}
          <Link to="/lead-hunter">Avvia una ricerca</Link>
        </Empty>
      )}
      {r && r.prospecting.total > 0 && (
        <>
          {r.observations.length > 0 && (
            <section className="report-notes" aria-labelledby="report-notes">
              <h2 id="report-notes" className="report-kicker">
                Dai numeri
              </h2>
              <ul>
                {r.observations.map((o) => (
                  <li key={o}>{o}</li>
                ))}
              </ul>
            </section>
          )}

          <div>
            <Section title="Prospezione" description="Aziende censite dalle ricerche e loro valutazione.">
              <dl className="report-figs">
                <Figure
                  label="Nuove aziende nel periodo"
                  value={NUM.format(r.prospecting.discovered)}
                  note={`${NUM.format(r.prospecting.total)} in totale`}
                />
                <Figure
                  label={`In fascia «${r.prospecting.topBand.label}»`}
                  value={NUM.format(r.prospecting.highPriority)}
                  note={
                    r.prospecting.highPriorityShare === null
                      ? 'Nessuna azienda ha un punteggio commerciale.'
                      : `${pct(r.prospecting.highPriorityShare)} delle ${NUM.format(r.prospecting.scored)} con un punteggio`
                  }
                />
                <Figure
                  label="Siti verificati"
                  value={NUM.format(r.prospecting.websiteAssessed)}
                  note="Audit completato, anche parzialmente"
                />
                <Figure
                  label="Valutate con l’AI"
                  value={NUM.format(r.prospecting.aiAssessed)}
                  note={r.prospecting.aiAssessed === 0 ? 'Si usa il punteggio a regole.' : undefined}
                />
              </dl>
              <div className="report-lists">
                <div>
                  <h3 className="sub-title">Fasce del punteggio commerciale</h3>
                  <BarList
                    caption="Aziende per fascia del punteggio commerciale"
                    rows={r.prospecting.bands.map((b) => ({
                      key: b.id,
                      label: `${b.label} (${b.min}–${b.max})`,
                      count: b.count,
                    }))}
                    emptyText="Nessuna azienda ha ancora un punteggio commerciale."
                  />
                </div>
                <div>
                  <h3 className="sub-title">Settori</h3>
                  <BarList caption="Aziende per settore" rows={r.prospecting.bySector} limit={10} />
                </div>
                <div>
                  <h3 className="sub-title">Regioni</h3>
                  <BarList caption="Aziende per regione" rows={r.prospecting.byRegion} limit={10} />
                </div>
              </div>
            </Section>

            <Section
              title="Pipeline"
              description="Opportunità del CRM. Le chiusure contano nel periodo in cui sono avvenute."
            >
              <dl className="report-figs">
                <Figure label="Opportunità attive" value={NUM.format(r.crm.active)} note="Oggi, tutte le fasi aperte" />
                <Figure label="Create nel periodo" value={NUM.format(r.crm.created)} />
                <Figure
                  label="Vinte · perse"
                  value={`${NUM.format(r.crm.won)} · ${NUM.format(r.crm.lost)}`}
                  note="Chiuse nel periodo"
                />
                <Figure
                  label="Tasso di vittoria"
                  value={r.crm.winRate === null ? '—' : pct(r.crm.winRate)}
                  note={
                    r.crm.winRate === null
                      ? 'Nessuna opportunità vinta o persa nel periodo.'
                      : 'Vinte ÷ (vinte + perse) nel periodo'
                  }
                />
                <Figure
                  label="Valore vinto"
                  value={r.crm.wonValue === null ? '—' : formatEuro(r.crm.wonValue)}
                  note={
                    r.crm.wonValue === null
                      ? 'Nessuna opportunità vinta con un valore stimato.'
                      : `Somma dei valori stimati di ${r.crm.wonValued} ${r.crm.wonValued === 1 ? 'opportunità' : 'opportunità'}`
                  }
                />
                <Figure
                  label="Valore in pipeline"
                  value={r.crm.openValue === null ? '—' : formatEuro(r.crm.openValue)}
                  note={
                    r.crm.openValue === null
                      ? 'Nessuna opportunità aperta ha un valore stimato.'
                      : `Stimato, su ${r.crm.openValued} di ${r.crm.active} opportunità aperte`
                  }
                />
                <Figure
                  label="Tempo medio di chiusura"
                  value={r.crm.avgDaysToClose === null ? '—' : `${NUM.format(r.crm.avgDaysToClose)} giorni`}
                  note={
                    r.crm.avgDaysToClose === null
                      ? `Servono almeno ${r.crm.minClosedForAverage} opportunità vinte o perse nel periodo (ora ${r.crm.closedWithTimes}).`
                      : `Dalla creazione alla chiusura, su ${r.crm.closedWithTimes} chiuse`
                  }
                />
                <Figure
                  label="Follow-up scaduti"
                  value={NUM.format(r.crm.followUps.overdue)}
                  note={`${NUM.format(r.crm.followUps.dueSoon)} in scadenza nei prossimi ${r.crm.followUps.soonDays} giorni · ${NUM.format(r.crm.followUps.completed)} completati nel periodo`}
                />
              </dl>
              <h3 className="sub-title">Opportunità per fase (oggi)</h3>
              <BarList
                caption="Opportunità per fase della pipeline"
                rows={r.crm.byStage.map((s) => ({ key: s.id, label: s.label, count: s.count }))}
                emptyText="Nessuna opportunità nel CRM."
              />
              <p className="row after">
                <Link to="/pipeline/elenco?state=all">Tutte le opportunità</Link>
                <Link to="/pipeline/follow-up?due=overdue">Follow-up scaduti</Link>
              </p>
            </Section>
          </div>

          {r.trend && (
            <Section
              title="Andamento"
              description={`Per ${r.trend.bucket === 'day' ? 'giorno' : r.trend.bucket === 'week' ? 'settimana' : 'mese'}, stessa scala per tutti i grafici: altezze confrontabili.`}
            >
              <div className="report-trend">
                {(
                  [
                    ['Aziende censite', r.trend.discovered],
                    ['Opportunità create', r.trend.created],
                    ['Opportunità vinte', r.trend.won],
                    ['Opportunità perse', r.trend.lost],
                  ] as const
                ).map(([title, values]) => (
                  <Columns
                    key={title}
                    title={title}
                    buckets={r.trend!.buckets}
                    bucket={r.trend!.bucket}
                    values={values as unknown as number[]}
                    scaleMax={Math.max(...r.trend!.discovered, ...r.trend!.created, ...r.trend!.won, ...r.trend!.lost)}
                  />
                ))}
              </div>
              <details className="report-table">
                <summary className="small">Mostra i dati in tabella</summary>
                <div className="table-wrap">
                  <table className="table">
                    <thead>
                      <tr>
                        <th scope="col">Periodo</th>
                        <th scope="col">Aziende censite</th>
                        <th scope="col">Opportunità create</th>
                        <th scope="col">Vinte</th>
                        <th scope="col">Perse</th>
                      </tr>
                    </thead>
                    <tbody>
                      {r.trend.buckets.map((b, i) => (
                        <tr key={b}>
                          <th scope="row">{bucketLabel(b, r.trend!.bucket, true)}</th>
                          <td className="mono">{r.trend!.discovered[i]}</td>
                          <td className="mono">{r.trend!.created[i]}</td>
                          <td className="mono">{r.trend!.won[i]}</td>
                          <td className="mono">{r.trend!.lost[i]}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </details>
            </Section>
          )}

          <Section title="Esportazioni" description="Gli stessi dati, completi, in CSV o Excel.">
            <div className="row">
              <ExportButton
                dataset="businesses"
                query={`minCommercial=${r.prospecting.topBand.min}&sort=commercial&dir=desc`}
                name="prospect"
                label="Prospect prioritari"
              />
              <ExportButton dataset="opportunities" query="state=all" name="opportunita" label="Opportunità" />
              <ExportButton
                dataset="followups"
                query="due=overdue"
                name="follow_up_scaduti"
                label="Follow-up scaduti"
              />
              <ExportButton dataset="activities" name="attivita" label="Cronologia attività" />
            </div>
          </Section>
        </>
      )}
    </>
  );
}
