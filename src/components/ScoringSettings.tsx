import { useId, useState } from 'react';
import {
  api,
  ApiError,
  post,
  type ScoringConfigResponse,
  type ScoringConfigValues,
  type ScoringStats,
} from '../api/client.ts';
import { formatDateTime } from '../lib/format.ts';
import { BAND, DIMENSION_LABEL, DIMENSIONS, SCORE_STATUS } from '../lib/scoring.ts';
import { useApi } from '../lib/useApi.ts';
import { ScoreSelected } from './ScoreControls.tsx';
import { Button, ErrorNotice, Field, Loading, Notice } from './ui.tsx';

/*
 * Configurazione del punteggio dei lead. Tutti la leggono (trasparenza del modello); solo gli amministratori la
 * modificano: ogni salvataggio crea una versione nuova, validata dal server, e i punteggi storici restano com'erano.
 */

type Path = [string, string];
const NUMBER_FIELDS: { group: string; title: string; fields: { path: Path; label: string; hint?: string }[] }[] = [
  {
    group: 'weights',
    title: 'Pesi delle dimensioni',
    fields: DIMENSIONS.map((d) => ({ path: ['weights', d] as Path, label: DIMENSION_LABEL[d] })),
  },
  {
    group: 'bands',
    title: 'Soglie delle fasce',
    fields: [
      { path: ['bands', 'A'], label: 'Priorità A da' },
      { path: ['bands', 'B'], label: 'Priorità B da' },
      { path: ['bands', 'C'], label: 'Priorità C da' },
    ],
  },
  {
    group: 'thresholds',
    title: 'Soglie delle prove',
    fields: [
      {
        path: ['thresholds', 'minCompleteness'],
        label: 'Completezza minima',
        hint: 'Sotto: «dati insufficienti», nessun punteggio mostrato.',
      },
      {
        path: ['thresholds', 'minConfidence'],
        label: 'Affidabilità minima',
        hint: 'Sotto, un lead almeno di fascia C va verificato.',
      },
    ],
  },
  {
    group: 'freshness',
    title: 'Freschezza delle prove (giorni)',
    fields: [
      { path: ['freshness', 'auditFreshDays'], label: 'Audit recente fino a' },
      { path: ['freshness', 'auditStaleDays'], label: 'Audit superato dopo' },
    ],
  },
];

function Summary({ config }: { config: ScoringConfigValues }) {
  return (
    <dl className="props">
      <dt>Pesi</dt>
      <dd>
        {DIMENSIONS.map((d, i) => (
          <span key={d}>
            {i > 0 && ' · '}
            {DIMENSION_LABEL[d]} <span className="mono">{config.weights[d]}</span>
          </span>
        ))}
      </dd>
      <dt>Fasce</dt>
      <dd>
        A da <span className="mono">{config.bands.A}</span>, B da <span className="mono">{config.bands.B}</span>, C da{' '}
        <span className="mono">{config.bands.C}</span>, sotto: priorità bassa
      </dd>
      <dt>Prove</dt>
      <dd>
        completezza minima <span className="mono">{config.thresholds.minCompleteness}</span>, affidabilità minima{' '}
        <span className="mono">{config.thresholds.minConfidence}</span>; audit recente fino a{' '}
        <span className="mono">{config.freshness.auditFreshDays}</span> giorni, superato dopo{' '}
        <span className="mono">{config.freshness.auditStaleDays}</span>
      </dd>
    </dl>
  );
}

function Editor({ data, onSaved }: { data: ScoringConfigResponse; onSaved: () => void }) {
  const [draft, setDraft] = useState<ScoringConfigValues>(() => structuredClone(data.active.config));
  const [json, setJson] = useState(() => JSON.stringify(data.active.config, null, 2));
  const [jsonError, setJsonError] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [message, setMessage] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const jsonId = useId();

  const setNumber = ([group, key]: Path, value: string) => {
    const next = structuredClone(draft) as Record<string, Record<string, unknown>>;
    next[group]![key] = value === '' ? Number.NaN : Number(value);
    setDraft(next as ScoringConfigValues);
    setJson(JSON.stringify(next, null, 2));
  };
  const applyJson = () => {
    try {
      setDraft(JSON.parse(json) as ScoringConfigValues);
      setJsonError(null);
    } catch {
      setJsonError('Il testo non è JSON valido.');
    }
  };
  const run = async (action: 'validate' | 'save') => {
    setBusy(action);
    setMessage(null);
    setErrors({});
    try {
      if (action === 'validate') {
        const r = await post<{ valid: boolean; errors: Record<string, string> }>('/scoring/config/validate', {
          config: draft,
        });
        setErrors(r.errors);
        setMessage(
          r.valid
            ? { tone: 'ok', text: 'Configurazione valida.' }
            : { tone: 'error', text: 'La configurazione non è valida.' },
        );
      } else {
        const r = await api<{ version: number }>('PUT', '/scoring/config', {
          config: draft,
          note: note.trim() || undefined,
        });
        setMessage({
          tone: 'ok',
          text: `Salvata come versione ${r.version}. I punteggi esistenti restano con la loro versione: ricalcolali per applicarla.`,
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

  return (
    <div className="stack">
      {NUMBER_FIELDS.map((g) => (
        <fieldset key={g.group} className="fieldset">
          <legend>{g.title}</legend>
          <div className="grid-2">
            {g.fields.map((f) => {
              const value = (draft as unknown as Record<string, Record<string, number>>)[f.path[0]]?.[f.path[1]];
              return (
                <Field
                  key={f.path.join('.')}
                  label={f.label}
                  type="number"
                  min={0}
                  inputMode="numeric"
                  value={Number.isFinite(value) ? String(value) : ''}
                  onChange={(e) => setNumber(f.path, e.target.value)}
                  hint={f.hint}
                  error={errors[f.path.join('.')]}
                />
              );
            })}
          </div>
        </fieldset>
      ))}
      <details>
        <summary className="small">
          Configurazione completa (JSON): gruppi di rilievi, capacità e servizi per settore, indicatori
        </summary>
        <div className="stack stack--tight after">
          <label className="field__label" htmlFor={jsonId}>
            Configurazione completa
          </label>
          <textarea
            id={jsonId}
            className="input code-area"
            rows={16}
            value={json}
            onChange={(e) => setJson(e.target.value)}
            spellCheck={false}
          />
          {jsonError && <p className="field__error">{jsonError}</p>}
          <div>
            <Button variant="secondary" onClick={applyJson}>
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
        <Button
          variant="ghost"
          onClick={() => {
            setDraft(structuredClone(data.defaults));
            setJson(JSON.stringify(data.defaults, null, 2));
          }}
        >
          Ripristina i valori iniziali nel modulo
        </Button>
      </div>
    </div>
  );
}

export function ScoringSettings({ admin }: { admin: boolean }) {
  const cfg = useApi<ScoringConfigResponse>('/scoring/config');
  const stats = useApi<ScoringStats>('/scoring/stats');
  if (cfg.loading && !cfg.data) return <Loading />;
  if (cfg.error) return <ErrorNotice error={cfg.error} onRetry={cfg.reload} />;
  if (!cfg.data) return null;
  const d = cfg.data;
  const reload = () => {
    cfg.reload();
    stats.reload();
  };
  return (
    <div className="stack">
      <p className="small">
        Versione attiva <span className="mono">v{d.active.version}</span> del {formatDateTime(d.active.createdAt)}
        {d.active.createdBy && ` (${d.active.createdBy})`}
        {d.active.note && ` — ${d.active.note}`} · algoritmo v{d.algorithmVersion}
      </p>
      <Summary config={d.active.config} />
      {stats.data && (
        <p className="small">
          Punteggi attuali:{' '}
          {stats.data.byStatus.length === 0
            ? 'nessuno'
            : stats.data.byStatus
                .map(
                  (s) =>
                    `${s.band && (s.status === 'ranked' || s.status === 'needs_review') ? BAND[s.band].label : SCORE_STATUS[s.status].label}${s.status === 'needs_review' ? ' (da verificare)' : ''} ${s.count}`,
                )
                .join(' · ')}
          {` · non calcolati ${stats.data.unscored}`}
          {stats.data.outdatedConfig > 0 && (
            <strong> · {stats.data.outdatedConfig} su una configurazione precedente</strong>
          )}
        </p>
      )}
      {admin ? (
        <>
          <ScoreSelected scope="all" label="Ricalcola tutti i punteggi" onDone={reload} />
          <Editor key={d.active.version} data={d} onSaved={reload} />
          <details>
            <summary className="small">Versioni precedenti</summary>
            <ol className="log after">
              {d.versions.map((v) => (
                <li key={v.version} className="log__item">
                  <time className="mono small muted" dateTime={v.createdAt}>
                    {formatDateTime(v.createdAt)}
                  </time>
                  <span>
                    v{v.version}
                    {v.createdBy && ` · ${v.createdBy}`}
                    {v.note && ` · ${v.note}`} · <span className="mono">{v.currentScores}</span> punteggi attuali
                  </span>
                </li>
              ))}
            </ol>
          </details>
        </>
      ) : (
        <p className="small muted">Solo un amministratore può modificare la configurazione.</p>
      )}
    </div>
  );
}
