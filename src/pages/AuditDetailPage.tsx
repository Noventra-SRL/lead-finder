import { Link, useParams, useSearchParams } from 'react-router';
import type {
  AuditDetail,
  AuditFinding,
  AuditMeta,
  AuditPerformance,
  FindingCategory,
  Severity,
} from '../api/client.ts';
import {
  Checkbox,
  Empty,
  ErrorNotice,
  Loading,
  Notice,
  PageHeader,
  Section,
  SelectField,
  Status,
} from '../components/ui.tsx';
import {
  CATEGORIES,
  CATEGORY,
  CONFIDENCE,
  kb,
  ms,
  RUN_STATUS,
  SEVERITIES,
  SEVERITY,
  SIGNAL_LABEL,
  WEBSITE_STATUS,
} from '../lib/audit.ts';
import { formatDateTime } from '../lib/format.ts';
import { useApi } from '../lib/useApi.ts';

const ROLE: Record<string, string> = { home: 'Principale', extra: 'Interna' };

const PERF_ERROR: Record<string, string> = {
  quota: 'quota del servizio esaurita',
  timeout: 'il servizio non ha risposto in tempo',
  unavailable: 'servizio non disponibile',
  target_failed: 'il servizio non è riuscito a caricare il sito',
  invalid_response: 'risposta del servizio non interpretabile',
  rejected: 'richiesta rifiutata dal servizio',
};

const pathOf = (url: string) => {
  try {
    const u = new URL(url);
    return u.pathname + u.search || '/';
  } catch {
    return url;
  }
};

function EvidenceValue({ value }: { value: unknown }) {
  if (value === null || value === undefined) return <span className="muted">—</span>;
  if (Array.isArray(value)) {
    if (value.length === 0) return <span className="muted">nessuno</span>;
    return (
      <ul className="evidence__list">
        {value.slice(0, 8).map((v, i) => (
          <li key={i}>
            <EvidenceValue value={v} />
          </li>
        ))}
        {value.length > 8 && <li className="muted">e altri {value.length - 8}</li>}
      </ul>
    );
  }
  if (typeof value === 'object') return <span className="mono">{JSON.stringify(value)}</span>;
  if (typeof value === 'boolean') return <>{value ? 'sì' : 'no'}</>;
  return <span className="mono">{String(value)}</span>;
}

function Finding({ f, services }: { f: AuditFinding; services: Record<string, string> }) {
  const evidence = Object.entries(f.evidence ?? {});
  return (
    <li className="finding">
      <div className="finding__head">
        <Status tone={SEVERITY[f.severity].tone}>{SEVERITY[f.severity].label}</Status>
        <h4 className="finding__title">{f.title}</h4>
        <span className="mono small muted">{f.code}</span>
      </div>
      <p className="finding__text">{f.explanation}</p>
      {evidence.length > 0 && (
        <dl className="evidence">
          {evidence.map(([k, v]) => (
            <div key={k} className="evidence__pair">
              <dt>{k}</dt>
              <dd>
                <EvidenceValue value={v} />
              </dd>
            </div>
          ))}
        </dl>
      )}
      {f.actionable && (
        <p className="finding__fix">
          <strong>Intervento suggerito.</strong> {f.remediation}
        </p>
      )}
      <p className="small muted">
        Pagina <span className="mono">{pathOf(f.page)}</span> · affidabilità {CONFIDENCE[f.confidence] ?? f.confidence}
        {f.observation === 'not_inspected' && ' · non è stato possibile verificarlo'}
        {f.service && <> · area: {services[f.service] ?? f.service}</>}
      </p>
    </li>
  );
}

function Performance({ rows, measured }: { rows: AuditPerformance[]; measured: boolean }) {
  if (!measured || rows.length === 0)
    return (
      <p className="muted small">
        Non misurate in questo audit (PageSpeed Insights non configurato o escluso dalla verifica). Nessun valore viene
        stimato.
      </p>
    );
  return (
    <div className="stack">
      {rows.map((r) => (
        <div key={r.strategy} className="stack stack--tight">
          <h3 className="sub-title">{r.strategy === 'mobile' ? 'Smartphone' : 'Desktop'}</h3>
          {r.status === 'error' ? (
            <p className="small text-danger">
              Misura non disponibile: {PERF_ERROR[r.errorKind ?? ''] ?? r.errorMessage ?? 'errore del servizio'}.
            </p>
          ) : (
            <>
              <dl className="props props--compact">
                <div className="props__pair">
                  <dt>Punteggio (laboratorio)</dt>
                  <dd className="mono">{r.lab?.performanceScore ?? '—'}</dd>
                </div>
                <div className="props__pair">
                  <dt>LCP · FCP (laboratorio)</dt>
                  <dd className="mono">
                    {ms(r.lab?.lcpMs)} · {ms(r.lab?.fcpMs)}
                  </dd>
                </div>
                <div className="props__pair">
                  <dt>CLS · TBT (laboratorio)</dt>
                  <dd className="mono">
                    {r.lab?.cls ?? '—'} · {ms(r.lab?.tbtMs)}
                  </dd>
                </div>
                <div className="props__pair">
                  <dt>Utenti reali (CrUX)</dt>
                  <dd>
                    {r.field ? (
                      <>
                        <span className="mono">
                          LCP {ms(r.field.lcpMs)} · INP {ms(r.field.inpMs)} · CLS {r.field.cls ?? '—'}
                        </span>{' '}
                        <span className="small muted">
                          ({r.field.scope === 'url' ? 'dati della pagina' : 'dati dell’intero sito'})
                        </span>
                      </>
                    ) : (
                      <span className="muted small">
                        Traffico insufficiente: Google non pubblica dati reali per questo sito.
                      </span>
                    )}
                  </dd>
                </div>
              </dl>
              <p className="small muted">
                Analizzata {formatDateTime(r.analyzedAt)}
                {r.lighthouseVersion && <> · Lighthouse {r.lighthouseVersion}</>}. I valori di laboratorio sono una
                simulazione, quelli degli utenti reali sono la media degli ultimi 28 giorni.
              </p>
            </>
          )}
        </div>
      ))}
    </div>
  );
}

export function AuditDetailPage() {
  const { id } = useParams();
  const [params, setParams] = useSearchParams();
  const severity = params.get('severity') ?? '';
  const category = params.get('category') ?? '';
  const actionable = params.get('actionable') === '1';
  const query = new URLSearchParams();
  if (severity) query.set('severity', severity);
  if (category) query.set('category', category);
  if (actionable) query.set('actionable', '1');
  const { data, error, loading, reload } = useApi<AuditDetail>(`/audits/${id}?${query}`);
  const meta = useApi<AuditMeta>('/audits/meta');
  const set = (k: string, v: string | null) => {
    const next = new URLSearchParams(params);
    if (v) next.set(k, v);
    else next.delete(k);
    setParams(next, { replace: true });
  };

  if (loading && !data) return <Loading />;
  if (error) return <ErrorNotice error={error} onRetry={reload} />;
  if (!data) return null;
  const { audit, findings, pages, performance, businesses } = data;
  const s = audit.summary;
  const site = WEBSITE_STATUS[audit.websiteStatus];
  const run = RUN_STATUS[audit.runStatus];
  const services = meta.data?.services ?? {};
  const filtered = Boolean(severity || category || actionable);
  const grouped = CATEGORIES.map((c) => ({ c, list: findings.filter((f) => f.category === c) })).filter(
    (g) => g.list.length,
  );
  const host = (() => {
    try {
      return new URL(audit.finalUrl ?? audit.originalUrl).host;
    } catch {
      return audit.originalUrl;
    }
  })();

  return (
    <>
      <p className="breadcrumb">
        <Link to="/audit">Analizza siti web</Link> / Esito
      </p>
      <PageHeader
        title={host}
        lede={
          <>
            <Status tone={run.tone}>{run.label}</Status> <Status tone={site.tone}>{site.label}</Status>{' '}
            <span className="muted">· {formatDateTime(audit.finishedAt)}</span>
          </>
        }
      />

      {audit.runStatus === 'failed' && (
        <Notice tone="error" title="Audit non riuscito">
          <p>
            {audit.error ?? 'Errore interno durante l’audit.'} I dati del sito restano quelli dell’ultimo audit
            riuscito.
          </p>
        </Notice>
      )}
      {audit.runStatus === 'partial' && (
        <Notice tone="warn" title="Audit parziale">
          <p>
            Alcuni controlli non sono stati completati: i rilievi riguardano solo ciò che è stato esaminato. Vedi i
            limiti in fondo.
          </p>
        </Notice>
      )}
      {s?.statusReason && audit.websiteStatus !== 'valid' && audit.websiteStatus !== 'redirected' && (
        <Notice tone="warn" title={site.label}>
          <p>
            Motivo tecnico: <span className="mono">{s.statusReason}</span>. Un singolo controllo non basta a concludere
            che il sito sia fuori uso: ripetere la verifica più tardi.
          </p>
        </Notice>
      )}

      <Section
        title="Sintesi"
        description="Conteggi di questo audit. Nessun punteggio complessivo: ogni rilievo va letto con la sua evidenza."
      >
        <dl className="figures">
          <div>
            <dt>Rilievi utili</dt>
            <dd className="mono">{audit.actionableCount}</dd>
          </div>
          <div>
            <dt>Gravità alta</dt>
            <dd className="mono">{s?.findings.bySeverity.high ?? 0}</dd>
          </div>
          <div>
            <dt>Gravità media</dt>
            <dd className="mono">{s?.findings.bySeverity.medium ?? 0}</dd>
          </div>
          <div>
            <dt>Pagine esaminate</dt>
            <dd className="mono">{audit.pagesInspected}</dd>
          </div>
          <div>
            <dt>Prestazioni mobile</dt>
            <dd className="mono">
              {s?.performance.mobile?.status === 'ok' ? (s.performance.mobile.score ?? '—') : '—'}
            </dd>
          </div>
        </dl>
        <dl className="props after">
          <dt>Indirizzo</dt>
          <dd className="mono small">
            {audit.originalUrl}
            {audit.finalUrl && audit.finalUrl !== audit.originalUrl && <> → {audit.finalUrl}</>}
          </dd>
          <dt>Aziende con questo sito</dt>
          <dd>
            {businesses.length === 0 && <span className="muted">Nessuna</span>}
            {businesses.map((b, i) => (
              <span key={b.id}>
                {i > 0 && ', '}
                <Link to={`/aziende/${b.id}`}>{b.name}</Link>
              </span>
            ))}
          </dd>
          {s?.https && (
            <>
              <dt>HTTPS</dt>
              <dd>
                {s.https.available === null
                  ? 'Non verificato'
                  : s.https.available
                    ? `Disponibile${s.https.certDaysToExpiry !== null ? `, certificato valido ancora ${s.https.certDaysToExpiry} giorni` : ''}`
                    : `Non disponibile${s.https.tlsErrorCode ? ` (${s.https.tlsErrorCode})` : ''}`}
                {s.https.httpRedirectsToHttps === false && ' · la versione http non reindirizza a https'}
              </dd>
            </>
          )}
          {s && (
            <>
              <dt>Indicazioni per i motori</dt>
              <dd>
                robots.txt {s.robots === 'parsed' ? 'presente' : s.robots === 'missing' ? 'assente' : 'non leggibile'}
                {' · '}sitemap {s.sitemap === null ? 'non verificata' : s.sitemap ? 'trovata' : 'non trovata'}
              </dd>
              <dt>Piattaforma</dt>
              <dd>{s.platforms.length ? s.platforms.join(', ') : <span className="muted">Non riconosciuta</span>}</dd>
            </>
          )}
          <dt>Configurazione</dt>
          <dd className="small">
            Fino a {audit.settings.maxPages} {audit.settings.maxPages === 1 ? 'pagina' : 'pagine'}, prestazioni{' '}
            {audit.settings.usePerformance ? 'misurate' : 'non misurate'} · versione dell’audit {audit.auditVersion}
            {audit.jobId && (
              <>
                {' '}
                · <Link to={`/audit/verifiche/${audit.jobId}`}>verifica di origine</Link>
              </>
            )}
          </dd>
        </dl>
      </Section>

      <Section
        title="Rilievi"
        description="Ogni rilievo indica cosa è stato osservato, dove, con quale affidabilità e quale intervento risolverebbe. Gli indicatori di sicurezza e mobile sono letti dal codice della pagina: non sono un test di sicurezza né una prova su dispositivi reali."
      >
        <div className="filters__row">
          <SelectField label="Gravità" value={severity} onChange={(e) => set('severity', e.target.value || null)}>
            <option value="">Tutte</option>
            <option value="high,medium">Alta e media</option>
            {SEVERITIES.map((v: Severity) => (
              <option key={v} value={v}>
                {SEVERITY[v].label}
              </option>
            ))}
          </SelectField>
          <SelectField label="Area" value={category} onChange={(e) => set('category', e.target.value || null)}>
            <option value="">Tutte</option>
            {CATEGORIES.map((c: FindingCategory) => (
              <option key={c} value={c}>
                {CATEGORY[c]}
              </option>
            ))}
          </SelectField>
          <Checkbox
            label="Solo rilievi con un intervento"
            checked={actionable}
            onChange={(e) => set('actionable', e.target.checked ? '1' : null)}
          />
        </div>
        {findings.length === 0 &&
          (filtered ? (
            <Empty title="Nessun rilievo con questi filtri" />
          ) : (
            <Empty title="Nessun rilievo">Non sono emersi problemi nelle pagine esaminate.</Empty>
          ))}
        {grouped.map(({ c, list }) => (
          <div key={c} className="finding-group">
            <h3 className="sub-title">
              {CATEGORY[c]} <span className="mono muted">{list.length}</span>
            </h3>
            <ul className="plain-list findings">
              {list.map((f) => (
                <Finding key={`${f.code}-${f.page}`} f={f} services={services} />
              ))}
            </ul>
          </div>
        ))}
      </Section>

      <Section title="Prestazioni" description="Misure di Google PageSpeed Insights, se configurato sul server.">
        <Performance rows={performance} measured={audit.settings.usePerformance} />
      </Section>

      {s?.signals && (
        <Section
          title="Contenuti rilevati"
          description="Elementi trovati nelle pagine esaminate. «Non rilevato» vale solo per quelle pagine: il sito potrebbe averli altrove."
        >
          <ul className="signals">
            {Object.entries(s.signals).map(([k, v]) => (
              <li key={k} className={v ? 'signals__on' : 'signals__off'}>
                <span aria-hidden="true">{v ? '●' : '○'}</span> {SIGNAL_LABEL[k] ?? k}
                <span className="visually-hidden">{v ? ': rilevato' : ': non rilevato'}</span>
              </li>
            ))}
          </ul>
        </Section>
      )}

      <Section title="Pagine esaminate" description="Richieste effettuate dall’audit, con esito e tempi.">
        <div className="table-wrap">
          <table className="table table--stack">
            <thead>
              <tr>
                <th scope="col">Pagina</th>
                <th scope="col">Indirizzo</th>
                <th scope="col">HTTP</th>
                <th scope="col">Tempo</th>
                <th scope="col">Dimensione</th>
              </tr>
            </thead>
            <tbody>
              {pages.map((p) => (
                <tr key={p.seq}>
                  <td data-label="Pagina">{ROLE[p.role] ?? p.role}</td>
                  <td data-label="Indirizzo" className="mono small">
                    {p.finalUrl}
                    {p.redirects && p.redirects.length > 0 && (
                      <div className="muted">
                        {p.redirects.length} {p.redirects.length === 1 ? 'reindirizzamento' : 'reindirizzamenti'}
                      </div>
                    )}
                    {p.error && <div className="text-danger">{p.error.message}</div>}
                  </td>
                  <td data-label="HTTP" className="mono">
                    {p.status ?? '—'}
                  </td>
                  <td data-label="Tempo" className="mono small">
                    {ms(p.totalMs)}
                    {p.ttfbMs !== null && <div className="muted">primo byte {ms(p.ttfbMs)}</div>}
                  </td>
                  <td data-label="Dimensione" className="mono small">
                    {kb(p.bytes)}
                    {p.truncated && <div className="text-danger">troncata</div>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Section>

      <Section title="Limiti di questo audit" description="Cosa non è stato verificato e perché.">
        {audit.limitations.length === 0 ? (
          <p className="muted small">Nessun limite registrato.</p>
        ) : (
          <ul className="limits">
            {audit.limitations.map((l, i) => (
              <li key={i}>{l}</li>
            ))}
          </ul>
        )}
      </Section>
    </>
  );
}
