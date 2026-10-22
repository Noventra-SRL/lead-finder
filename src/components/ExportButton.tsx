import { useEffect, useId, useRef, useState } from 'react';
import { ApiError, download, get, type ExportColumns, type ExportDataset } from '../api/client.ts';
import { Button, Loading } from './ui.tsx';

const ENDPOINT: Record<ExportDataset, string> = {
  businesses: '/businesses/export',
  opportunities: '/crm/opportunities/export',
  followups: '/crm/followups/export',
  activities: '/crm/activities/export',
};

/** Catalogo delle colonne: uguale per tutta la sessione, letto una volta. */
let columnsCache: Promise<ExportColumns> | null = null;
const loadColumns = () => {
  columnsCache ??= get<ExportColumns>('/exports/columns').catch((e: unknown) => {
    columnsCache = null;
    throw e;
  });
  return columnsCache;
};

/**
 * Esportazione CSV o Excel: un dialogo per scegliere formato e colonne. Si esportano TUTTE le righe dei filtri
 * attuali (non solo la pagina visibile) oppure le aziende selezionate. Dopo il download dice quante righe sono state
 * esportate e se il limite le ha troncate.
 */
export function ExportButton({
  dataset = 'businesses',
  query,
  ids,
  name,
  total,
  label = 'Esporta',
  variant = 'secondary',
}: {
  dataset?: ExportDataset;
  /** Filtri attuali (query string, senza paginazione). */
  query?: string;
  /** Aziende selezionate: l'esportazione riguarda solo queste. */
  ids?: string[];
  /** Prima parte del nome del file, es. "prospect" → prospect_noventra_2026-10-22.csv. */
  name?: string;
  /** Righe attese, se note (mostrate nel dialogo). */
  total?: number;
  label?: string;
  variant?: 'primary' | 'secondary';
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const [open, setOpen] = useState(false);
  const [columns, setColumns] = useState<ExportColumns | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [format, setFormat] = useState<'csv' | 'xlsx'>('csv');
  const [fields, setFields] = useState<Set<string> | null>(null);
  const [byStage, setByStage] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ tone: 'ok' | 'warn' | 'error'; text: string } | null>(null);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  useEffect(() => {
    if (!open || columns) return;
    loadColumns()
      .then((c) => {
        setColumns(c);
        setFields((f) => f ?? new Set(c[dataset].filter((x) => x.default).map((x) => x.id)));
      })
      .catch((e: unknown) => setLoadError(e instanceof ApiError ? e.message : 'Colonne non disponibili.'));
  }, [open, columns, dataset]);

  const catalog = columns?.[dataset] ?? [];
  const defaults = catalog.filter((c) => c.default).map((c) => c.id);
  const chosen = catalog.filter((c) => fields?.has(c.id)).map((c) => c.id);
  const isDefault = chosen.length === defaults.length && chosen.every((id) => defaults.includes(id));

  async function run() {
    setBusy(true);
    setResult(null);
    const options: Record<string, string> = { format };
    if (!isDefault) options.fields = chosen.join(',');
    if (name) options.name = name;
    if (dataset === 'opportunities' && byStage) options.groupByStage = '1';
    try {
      const r = ids
        ? await download(ENDPOINT[dataset], {
            ids,
            format,
            ...(isDefault ? {} : { fields: chosen }),
            ...(name ? { name } : {}),
          })
        : await download(
            `${ENDPOINT[dataset]}?${[query, new URLSearchParams(options).toString()].filter(Boolean).join('&')}`,
          );
      const limit = columns?.limit ?? 10_000;
      setResult(
        r.truncated
          ? {
              tone: 'warn',
              text: `Esportate le prime ${limit.toLocaleString('it-IT')} righe: restringi i filtri per esportare il resto.`,
            }
          : r.rows === 0
            ? { tone: 'warn', text: 'Nessuna riga con questi filtri: il file contiene solo le intestazioni.' }
            : {
                tone: 'ok',
                text: r.rows === 1 ? 'Esportata 1 riga.' : `Esportate ${(r.rows ?? 0).toLocaleString('it-IT')} righe.`,
              },
      );
      setOpen(false);
    } catch (e) {
      setResult({ tone: 'error', text: e instanceof ApiError ? e.message : 'Esportazione non riuscita.' });
    } finally {
      setBusy(false);
    }
  }

  const toggle = (id: string, on: boolean) =>
    setFields((f) => {
      const next = new Set(f);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });

  return (
    <span className="export">
      <Button variant={variant} onClick={() => setOpen(true)}>
        {label}
      </Button>
      {result && !open && (
        <span role="status" className={`small export__result export__result--${result.tone}`}>
          {result.text}
        </span>
      )}
      <dialog
        ref={ref}
        className="dialog dialog--wide"
        aria-labelledby={titleId}
        onCancel={(e) => {
          e.preventDefault();
          if (!busy) setOpen(false);
        }}
      >
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void run();
          }}
        >
          <div className="dialog__body">
            <h2 className="dialog__title" id={titleId}>
              {label}
            </h2>
            <p className="dialog__text">
              {ids
                ? `Solo ${ids.length === 1 ? 'l’azienda selezionata' : `le ${ids.length} aziende selezionate`}.`
                : total !== undefined
                  ? `Tutte le ${total.toLocaleString('it-IT')} righe dei filtri attuali, non solo la pagina visibile.`
                  : 'Tutte le righe dei filtri attuali, non solo la pagina visibile.'}{' '}
              Intestazioni in italiano, UTF-8.
            </p>
            <fieldset className="fieldset fieldset--plain">
              <legend>Formato</legend>
              <div className="row">
                <label className="check check--inline">
                  <input type="radio" name="format" checked={format === 'csv'} onChange={() => setFormat('csv')} />
                  <span>CSV (separatore ;)</span>
                </label>
                <label className="check check--inline">
                  <input type="radio" name="format" checked={format === 'xlsx'} onChange={() => setFormat('xlsx')} />
                  <span>Excel (.xlsx)</span>
                </label>
              </div>
              {dataset === 'opportunities' && (
                <label className="check check--inline">
                  <input type="checkbox" checked={byStage} onChange={(e) => setByStage(e.target.checked)} />
                  <span>
                    Raggruppa per fase {format === 'xlsx' ? '(un foglio per fase)' : '(righe ordinate per fase)'}
                  </span>
                </label>
              )}
            </fieldset>
            <fieldset className="fieldset fieldset--plain">
              <legend>
                Colonne{' '}
                {columns && (
                  <span className="muted">
                    · {chosen.length} di {catalog.length}
                  </span>
                )}
              </legend>
              {loadError && <p className="field__error">{loadError}</p>}
              {!columns && !loadError && <Loading label="Colonne…" />}
              {columns && (
                <>
                  <div className="row">
                    <Button variant="ghost" type="button" onClick={() => setFields(new Set(defaults))}>
                      Predefinite
                    </Button>
                    <Button variant="ghost" type="button" onClick={() => setFields(new Set(catalog.map((c) => c.id)))}>
                      Tutte
                    </Button>
                  </div>
                  <div className="export-columns">
                    {catalog.map((c) => (
                      <label key={c.id} className="check check--inline">
                        <input
                          type="checkbox"
                          checked={fields?.has(c.id) ?? false}
                          onChange={(e) => toggle(c.id, e.target.checked)}
                        />
                        <span>{c.label}</span>
                      </label>
                    ))}
                  </div>
                </>
              )}
            </fieldset>
            {result?.tone === 'error' && (
              <p role="alert" className="field__error">
                {result.text}
              </p>
            )}
          </div>
          <div className="dialog__actions">
            <Button variant="ghost" type="button" onClick={() => setOpen(false)} disabled={busy}>
              Annulla
            </Button>
            <Button type="submit" busy={busy} disabled={!columns || chosen.length === 0}>
              Scarica {format === 'xlsx' ? 'Excel' : 'CSV'}
            </Button>
          </div>
        </form>
      </dialog>
    </span>
  );
}
