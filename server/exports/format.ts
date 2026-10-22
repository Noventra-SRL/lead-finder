import { audit } from '../audit.ts';
import type { Queryable } from '../db/client.ts';
import { todayInRome } from '../crm/model.ts';
import { xlsx, type Cell } from './xlsx.ts';

/*
 * Esportazioni (Fase 8): stesse regole per ogni elenco.
 *  - CSV: UTF-8 con BOM, separatore ";" (Excel in italiano), righe CRLF; una cella che inizia con = + - @ tabulazione o
 *    a capo è preceduta da "'" (protezione dall'iniezione di formule); virgolette quando servono.
 *  - XLSX: scrittore interno senza dipendenze (xlsx.ts); il testo non diventa mai una formula.
 *  - Colonne scelte dall'utente tra quelle del catalogo; righe lette a blocchi da 1.000, al massimo EXPORT_LIMIT.
 *  - Ogni esportazione è registrata nel registro delle attività (chi, quale elenco, quante righe, con quali filtri).
 * Si esporta solo ciò che l'utente vede già nell'applicazione: mai credenziali, sessioni o dati di autenticazione.
 */

export const EXPORT_LIMIT = 10_000;
const BATCH = 1000;
/** Byte order mark UTF-8: Excel riconosce la codifica e mostra correttamente accenti e simboli. */
const BOM = String.fromCharCode(0xfeff);

/** Cella CSV sicura: neutralizza le formule e mette tra virgolette quando serve. */
export function csvCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  let s = String(value);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[;"\r\n]/.test(s) || s !== s.trim() ? `"${s.replace(/"/g, '""')}"` : s;
}

export const csvRow = (cells: unknown[]) => cells.map(csvCell).join(';');

export interface Column<R> {
  id: string;
  label: string;
  /** Inclusa quando l'utente non sceglie le colonne. */
  default: boolean;
  get: (row: R) => Cell;
}

export type ExportFormat = 'csv' | 'xlsx';

export interface ExportResult {
  content: string | Buffer;
  contentType: string;
  filename: string;
  rows: number;
  truncated: boolean;
}

/** Colonne richieste (in ordine di catalogo); nessuna scelta = quelle predefinite. */
export function pickColumns<R>(catalog: Column<R>[], fields: string[] | undefined): Column<R>[] {
  if (!fields?.length) return catalog.filter((c) => c.default);
  const wanted = new Set(fields);
  return catalog.filter((c) => wanted.has(c.id));
}

/** Catalogo delle colonne per l'interfaccia di esportazione. */
export const describeColumns = <R>(catalog: Column<R>[]) =>
  catalog.map((c) => ({ id: c.id, label: c.label, default: c.default }));

/** Legge le righe a blocchi (mai l'intero elenco in un'unica query) fino al limite. */
export async function readAll<R>(
  fetch: (limit: number, offset: number) => Promise<R[]>,
): Promise<{ rows: R[]; truncated: boolean }> {
  const rows: R[] = [];
  for (let offset = 0; ; offset += BATCH) {
    const batch = await fetch(Math.min(BATCH, EXPORT_LIMIT + 1 - offset), offset);
    rows.push(...batch);
    if (batch.length < BATCH || rows.length > EXPORT_LIMIT) break;
  }
  const truncated = rows.length > EXPORT_LIMIT;
  return { rows: rows.slice(0, EXPORT_LIMIT), truncated };
}

/** Nome del file: elenco, "noventra" e data italiana, es. prospect_noventra_2026-10-22.csv. */
export const exportFilename = (name: string, format: ExportFormat) => `${name}_noventra_${todayInRome()}.${format}`;

export async function buildExport<R>(
  db: Queryable,
  opts: {
    dataset: string;
    name: string;
    format: ExportFormat;
    columns: Column<R>[];
    rows: R[];
    truncated: boolean;
    /** Raggruppamento in fogli (XLSX) o ordinamento per gruppo (CSV). */
    groupBy?: (row: R) => string;
    groupOrder?: string[];
    userId: string;
    filters: Record<string, unknown>;
  },
): Promise<ExportResult> {
  const header = opts.columns.map((c) => c.label);
  const toCells = (r: R) => opts.columns.map((c) => c.get(r));
  let content: string | Buffer;
  if (opts.format === 'xlsx') {
    if (opts.groupBy) {
      const groups = new Map<string, R[]>();
      for (const key of opts.groupOrder ?? []) groups.set(key, []);
      for (const r of opts.rows) {
        const key = opts.groupBy(r);
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key)!.push(r);
      }
      content = xlsx(
        [...groups]
          .filter(([, rows]) => rows.length > 0)
          .map(([name, rows]) => ({ name, header, rows: rows.map(toCells) })),
      );
      // nessuna riga: un foglio con le sole intestazioni
      if (opts.rows.length === 0) content = xlsx([{ name: 'Nessun risultato', header, rows: [] }]);
    } else content = xlsx([{ name: opts.name, header, rows: opts.rows.map(toCells) }]);
  } else {
    content = `${BOM}${[csvRow(header), ...opts.rows.map((r) => csvRow(toCells(r)))].join('\r\n')}\r\n`;
  }
  await audit(db, {
    userId: opts.userId,
    action: 'leads.exported',
    entityType: opts.dataset,
    details: {
      dataset: opts.dataset,
      format: opts.format,
      rows: opts.rows.length,
      truncated: opts.truncated,
      fields: opts.columns.map((c) => c.id),
      filters: opts.filters,
    },
  });
  return {
    content,
    contentType:
      opts.format === 'xlsx'
        ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
        : 'text/csv; charset=utf-8',
    filename: exportFilename(opts.name, opts.format),
    rows: opts.rows.length,
    truncated: opts.truncated,
  };
}

const DATE_TIME = new Intl.DateTimeFormat('it-IT', {
  timeZone: 'Europe/Rome',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
});
/** Data (AAAA-MM-GG) e data e ora italiane per le celle. */
export const day = (d: Date | string | null | undefined) =>
  !d ? null : typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d) ? d : todayInRome(new Date(d));
export const dateTime = (d: Date | string | null | undefined) => (d ? DATE_TIME.format(new Date(d)) : null);
export const yesNo = (v: boolean | null | undefined) => (v === null || v === undefined ? null : v ? 'Sì' : 'No');
