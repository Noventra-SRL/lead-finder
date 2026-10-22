import { useId, useState } from 'react';
import { Link } from 'react-router';
import {
  api,
  ApiError,
  post,
  type CatalogService,
  type ServiceCatalogResponse,
  type ServiceList,
} from '../api/client.ts';
import { useUser } from '../auth/AuthContext.tsx';
import { ScoreSelected } from '../components/ScoreControls.tsx';
import {
  Button,
  Checkbox,
  ErrorNotice,
  Field,
  Loading,
  Notice,
  PageHeader,
  Section,
  Status,
} from '../components/ui.tsx';
import { formatDateTime } from '../lib/format.ts';
import { MATCH_DIMENSION_LABEL, MATCH_DIMENSIONS } from '../lib/services.ts';
import { useApi } from '../lib/useApi.ts';
import { NAV_ITEMS, navIndex } from '../navigation.ts';

/*
 * Catalogo dei servizi di Noventra: servizi verificati sul sito ufficiale, regole di abbinamento, versioni.
 * Tutti lo consultano; solo gli amministratori lo modificano (ogni salvataggio è una versione nuova).
 */

type Catalog = ServiceCatalogResponse['active']['catalog'];
const AREA = { sviluppo: 'Sviluppo & tecnologia', marketing: 'Marketing & crescita' } as const;

function ServiceDetail({ s, vocab }: { s: CatalogService; vocab: ServiceCatalogResponse['vocabulary'] | undefined }) {
  const label = (map: Record<string, string> | undefined, k: string) => map?.[k] ?? k;
  const list = (rec: Record<string, number>, map?: Record<string, string>) =>
    Object.entries(rec)
      .sort((a, b) => b[1] - a[1])
      .map(([k, v]) => `${label(map, k)} (${String(v).replace('.', ',')})`)
      .join(' · ');
  return (
    <dl className="props props--compact after">
      {s.problems.length > 0 && (
        <div className="props__pair">
          <dt>Problemi che risolve</dt>
          <dd>{s.problems.join('; ')}</dd>
        </div>
      )}
      <div className="props__pair">
        <dt>Settori (pertinenza)</dt>
        <dd>
          {Object.keys(s.categories).length ? (
            list(s.categories, vocab?.categories)
          ) : (
            <span className="muted">nessuno</span>
          )}
        </dd>
      </div>
      {Object.keys(s.findings).length > 0 && (
        <div className="props__pair">
          <dt>Rilievi dell’audit (importanza)</dt>
          <dd className="small">{list(s.findings, vocab?.findings)}</dd>
        </div>
      )}
      {Object.keys(s.capabilityGaps).length > 0 && (
        <div className="props__pair">
          <dt>Capacità mancanti</dt>
          <dd className="small">{list(s.capabilityGaps, vocab?.capabilities)}</dd>
        </div>
      )}
      {s.repeatedFailure && (
        <div className="props__pair">
          <dt>Prova diretta</dt>
          <dd>Sito non raggiungibile in audit consecutivi</dd>
        </div>
      )}
      {s.disqualifiers.length > 0 && (
        <div className="props__pair">
          <dt>Non proposto se</dt>
          <dd>{s.disqualifiers.map((d) => d.reason).join(' ')}</dd>
        </div>
      )}
      <div className="props__pair">
        <dt>Da verificare</dt>
        <dd>{s.nextSteps.join(' ')}</dd>
      </div>
      <div className="props__pair">
        <dt>Gruppo di problemi</dt>
        <dd className="mono small">{s.dedupeGroup}</dd>
      </div>
    </dl>
  );
}

function Editor({ data, onSaved }: { data: ServiceCatalogResponse; onSaved: () => void }) {
  const [draft, setDraft] = useState<Catalog>(() => structuredClone(data.active.catalog));
  const [json, setJson] = useState(() => JSON.stringify(data.active.catalog, null, 2));
  const [jsonError, setJsonError] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [message, setMessage] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const jsonId = useId();
  const update = (next: Catalog) => {
    setDraft(next);
    setJson(JSON.stringify(next, null, 2));
  };
  const setNum = (group: 'weights' | 'thresholds' | 'shortlist', key: string, value: string) => {
    const next = structuredClone(draft) as unknown as Record<string, Record<string, number>>;
    next[group]![key] = value === '' ? Number.NaN : Number(value);
    update(next as unknown as Catalog);
  };
  const run = async (action: 'validate' | 'save') => {
    setBusy(action);
    setMessage(null);
    setErrors({});
    try {
      if (action === 'validate') {
        const r = await post<{ valid: boolean; errors: Record<string, string> }>('/service-catalog/validate', {
          catalog: draft,
        });
        setErrors(r.errors);
        setMessage(
          r.valid ? { tone: 'ok', text: 'Catalogo valido.' } : { tone: 'error', text: 'Il catalogo non è valido.' },
        );
      } else {
        const r = await api<{ version: number }>('PUT', '/service-catalog', {
          catalog: draft,
          note: note.trim() || undefined,
        });
        setMessage({
          tone: 'ok',
          text: `Salvato come versione ${r.version}. Ricalcola gli abbinamenti per applicarlo.`,
        });
        onSaved();
      }
    } catch (e) {
      const err = e instanceof ApiError ? e : new ApiError(0, 'UNKNOWN', 'Operazione non riuscita.');
      setErrors(err.fields);
      setMessage({ tone: 'error', text: err.message });
    } finally {
      setBusy(null);
    }
  };
  const numbers: { group: 'weights' | 'thresholds' | 'shortlist'; key: string; label: string }[] = [
    ...MATCH_DIMENSIONS.map((d) => ({
      group: 'weights' as const,
      key: d,
      label: `Peso: ${MATCH_DIMENSION_LABEL[d].toLowerCase()}`,
    })),
    { group: 'thresholds', key: 'recommended', label: 'Consigliato da' },
    { group: 'thresholds', key: 'possible', label: 'Possibile da' },
    { group: 'thresholds', key: 'minConfidence', label: 'Affidabilità minima' },
    { group: 'shortlist', key: 'max', label: 'Servizi in lista (massimo)' },
    { group: 'shortlist', key: 'maxWithLowConfidence', label: 'Con prove poco affidabili' },
  ];
  return (
    <div className="stack">
      <fieldset className="fieldset">
        <legend>Servizi attivi</legend>
        <div className="checklist">
          {draft.services.map((s, i) => (
            <Checkbox
              key={s.id}
              label={s.name}
              hint={s.autoMatch ? 'Abbinamento automatico' : 'Solo a colloquio'}
              checked={s.active}
              onChange={(e) => {
                const next = structuredClone(draft);
                next.services[i]!.active = e.target.checked;
                update(next);
              }}
            />
          ))}
        </div>
      </fieldset>
      <fieldset className="fieldset">
        <legend>Pesi e soglie</legend>
        <div className="grid-2">
          {numbers.map((n) => {
            const v = (draft[n.group] as Record<string, number>)[n.key];
            return (
              <Field
                key={`${n.group}.${n.key}`}
                label={n.label}
                type="number"
                min={0}
                value={Number.isFinite(v) ? String(v) : ''}
                onChange={(e) => setNum(n.group, n.key, e.target.value)}
                error={errors[`${n.group}.${n.key}`]}
              />
            );
          })}
        </div>
      </fieldset>
      <details>
        <summary className="small">
          Catalogo completo (JSON): descrizioni, settori, rilievi, capacità, esclusioni, verifiche
        </summary>
        <div className="stack stack--tight after">
          <label className="field__label" htmlFor={jsonId}>
            Catalogo completo
          </label>
          <textarea
            id={jsonId}
            className="input code-area"
            rows={18}
            spellCheck={false}
            value={json}
            onChange={(e) => setJson(e.target.value)}
          />
          {jsonError && <p className="field__error">{jsonError}</p>}
          <div>
            <Button
              variant="secondary"
              onClick={() => {
                try {
                  setDraft(JSON.parse(json) as Catalog);
                  setJsonError(null);
                } catch {
                  setJsonError('Il testo non è JSON valido.');
                }
              }}
            >
              Applica il JSON al modulo
            </Button>
          </div>
        </div>
      </details>
      <Field
        label="Nota sulla modifica (facoltativa)"
        value={note}
        maxLength={300}
        onChange={(e) => setNote(e.target.value)}
      />
      {Object.keys(errors).length > 0 && (
        <Notice tone="error" title="Da correggere">
          <ul className="plain-list small">
            {Object.entries(errors).map(([k, v]) => (
              <li key={k}>
                <span className="mono">{k}</span>: {v}
              </li>
            ))}
          </ul>
        </Notice>
      )}
      {message && Object.keys(errors).length === 0 && <Notice tone={message.tone}>{message.text}</Notice>}
      <div className="row">
        <Button variant="secondary" busy={busy === 'validate'} onClick={() => void run('validate')}>
          Verifica
        </Button>
        <Button busy={busy === 'save'} onClick={() => void run('save')}>
          Salva come nuova versione
        </Button>
        <Button variant="ghost" onClick={() => update(structuredClone(data.defaults))}>
          Ripristina il catalogo iniziale nel modulo
        </Button>
      </div>
    </div>
  );
}

export function ServicesPage() {
  const item = NAV_ITEMS.find((i) => i.path === '/servizi')!;
  const user = useUser();
  const list = useApi<ServiceList>('/services');
  const full = useApi<ServiceCatalogResponse>('/service-catalog');
  const reload = () => {
    list.reload();
    full.reload();
  };

  return (
    <>
      <PageHeader index={navIndex(item.path)} title={item.label} lede={item.lede} />
      {list.loading && !list.data && <Loading />}
      {list.error && <ErrorNotice error={list.error} onRetry={list.reload} />}
      {list.data && (
        <>
          <Notice title="Solo servizi pubblicati da Noventra">
            <p>
              Ogni servizio viene dalla sua pagina su noventra.it. Quelli per cui le prove raccolte automaticamente non
              dicono nulla (app, intelligenza artificiale, pubblicità) restano nel catalogo ma si propongono solo dopo
              un colloquio. Una corrispondenza indica una possibile pertinenza, non una domanda confermata.
            </p>
          </Notice>
          {(['sviluppo', 'marketing'] as const).map((area) => (
            <Section key={area} title={AREA[area]}>
              <ul className="plain-list service-list">
                {list
                  .data!.services.filter((s) => s.category === area)
                  .map((s) => {
                    const proposed = s.counts.recommended + s.counts.possible + s.counts.needsReview;
                    return (
                      <li key={s.id} className="service">
                        <div className="service__head">
                          <h3 className="service__name">{s.name}</h3>
                          <span className="row">
                            <Status tone={s.active ? 'ok' : 'idle'}>{s.active ? 'Attivo' : 'Disattivato'}</Status>
                            <Status tone="idle">{s.autoMatch ? 'Abbinamento automatico' : 'Solo a colloquio'}</Status>
                            {s.requiresTeamConfirmation && s.autoMatch && (
                              <Status tone="warn">Da confermare con il team</Status>
                            )}
                          </span>
                        </div>
                        <p className="service__text">
                          {s.description}{' '}
                          <a href={s.source} target="_blank" rel="noopener noreferrer" className="small">
                            Pagina del servizio
                          </a>
                        </p>
                        {s.autoMatch && (
                          <p className="small">
                            {proposed === 0 ? (
                              <span className="muted">Al momento non proposto per nessuna azienda.</span>
                            ) : (
                              <>
                                Proposto per <span className="mono">{proposed}</span>{' '}
                                {proposed === 1 ? 'azienda' : 'aziende'} (
                                <span className="mono">{s.counts.recommended}</span> consigliato,{' '}
                                <span className="mono">{s.counts.possible}</span> possibile,{' '}
                                <span className="mono">{s.counts.needsReview}</span> da verificare) ·{' '}
                                <Link to={`/aziende?service=${s.id}&sort=match&dir=desc`}>Vedi le aziende</Link>
                              </>
                            )}
                          </p>
                        )}
                        <details>
                          <summary className="small">Regole di abbinamento</summary>
                          <ServiceDetail s={s} vocab={full.data?.vocabulary} />
                        </details>
                      </li>
                    );
                  })}
              </ul>
            </Section>
          ))}
          <Section
            title="Regole di abbinamento"
            description="Corrispondenza = media pesata delle dimensioni con prove. Le dimensioni senza prove sono escluse, non valgono zero."
          >
            <div className="stack">
              <dl className="props">
                <dt>Pesi</dt>
                <dd>
                  {MATCH_DIMENSIONS.map((d, i) => (
                    <span key={d}>
                      {i > 0 && ' · '}
                      {MATCH_DIMENSION_LABEL[d]} <span className="mono">{list.data!.settings.weights[d]}</span>
                    </span>
                  ))}
                </dd>
                <dt>Soglie</dt>
                <dd>
                  consigliato da <span className="mono">{list.data.settings.thresholds.recommended}</span>, possibile da{' '}
                  <span className="mono">{list.data.settings.thresholds.possible}</span>; sotto un’affidabilità di{' '}
                  <span className="mono">{list.data.settings.thresholds.minConfidence}</span> va verificato
                </dd>
                <dt>Lista breve</dt>
                <dd>
                  al massimo <span className="mono">{list.data.settings.shortlist.max}</span> servizi (
                  <span className="mono">{list.data.settings.shortlist.maxWithLowConfidence}</span> con prove poco
                  affidabili), uno per problema di fondo
                </dd>
                <dt>Versione</dt>
                <dd>
                  v{list.data.version} del {formatDateTime(list.data.createdAt)}
                  {list.data.createdBy && ` (${list.data.createdBy})`}
                  {list.data.note && ` — ${list.data.note}`}
                </dd>
              </dl>
              {user.role === 'admin' ? (
                <>
                  {full.error && <ErrorNotice error={full.error} onRetry={full.reload} />}
                  {full.data && <Editor key={full.data.active.version} data={full.data} onSaved={reload} />}
                  <ScoreSelected
                    scope="all"
                    label="Ricalcola punteggi e abbinamenti di tutte le aziende"
                    onDone={reload}
                  />
                  {full.data && (
                    <details>
                      <summary className="small">Versioni precedenti</summary>
                      <ol className="log after">
                        {full.data.versions.map((v) => (
                          <li key={v.version} className="log__item">
                            <time className="mono small muted" dateTime={v.createdAt}>
                              {formatDateTime(v.createdAt)}
                            </time>
                            <span>
                              v{v.version}
                              {v.createdBy && ` · ${v.createdBy}`}
                              {v.note && ` · ${v.note}`}
                            </span>
                          </li>
                        ))}
                      </ol>
                    </details>
                  )}
                </>
              ) : (
                <p className="small muted">Solo un amministratore può modificare il catalogo e le regole.</p>
              )}
            </div>
          </Section>
        </>
      )}
    </>
  );
}
