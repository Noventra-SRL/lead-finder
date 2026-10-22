import { useId, useState } from 'react';

/*
 * Grafici dei report (Fase 8), senza librerie: una sola serie per grafico, nel colore d'accento (validato sulla
 * superficie). Barre sottili con l'estremità arrotondata, griglia a filetto, valori in colore del testo; ogni grafico
 * ha la tabella dei dati come alternativa accessibile. Più misure = più grafici (mai due assi).
 */

const NUM = new Intl.NumberFormat('it-IT');

/** Barre orizzontali ordinate: etichetta, barra, valore all'estremità. */
export function BarList({
  rows,
  caption,
  limit,
  emptyText = 'Nessun dato.',
}: {
  rows: { key: string; label: string; count: number; note?: string }[];
  caption: string;
  limit?: number;
  emptyText?: string;
}) {
  const shown = limit ? rows.slice(0, limit) : rows;
  const rest = limit ? rows.slice(limit) : [];
  const max = Math.max(1, ...shown.map((r) => r.count));
  if (rows.length === 0 || rows.every((r) => r.count === 0)) return <p className="small muted">{emptyText}</p>;
  return (
    <figure className="barlist">
      <figcaption className="visually-hidden">{caption}</figcaption>
      <ol>
        {shown.map((r) => (
          <li key={r.key} className="barlist__row" title={`${r.label}: ${NUM.format(r.count)}`}>
            <span className="barlist__label">{r.label}</span>
            <span className="barlist__track" aria-hidden="true">
              {r.count > 0 && <span className="barlist__bar" style={{ width: `${(r.count / max) * 100}%` }} />}
            </span>
            <span className="barlist__value mono">{NUM.format(r.count)}</span>
          </li>
        ))}
      </ol>
      {rest.length > 0 && (
        <p className="small muted">
          Altri {rest.length}: {NUM.format(rest.reduce((a, r) => a + r.count, 0))} in totale.
        </p>
      )}
    </figure>
  );
}

const MONTHS = ['gen', 'feb', 'mar', 'apr', 'mag', 'giu', 'lug', 'ago', 'set', 'ott', 'nov', 'dic'];
export function bucketLabel(d: string, bucket: 'day' | 'week' | 'month', long = false): string {
  const [y, m, day] = d.split('-').map(Number) as [number, number, number];
  if (bucket === 'month') return `${MONTHS[m - 1]} ${long ? y : String(y).slice(2)}`;
  const base = `${day} ${MONTHS[m - 1]}`;
  return bucket === 'week' ? (long ? `settimana dal ${base}` : base) : base;
}

/** Colonne nel tempo per una misura; scala condivisa tra i grafici affiancati (stessa altezza = stesso valore). */
export function Columns({
  title,
  buckets,
  bucket,
  values,
  scaleMax,
}: {
  title: string;
  buckets: string[];
  bucket: 'day' | 'week' | 'month';
  values: number[];
  scaleMax: number;
}) {
  const id = useId();
  const [hover, setHover] = useState<number | null>(null);
  const W = 320;
  const H = 96;
  const max = Math.max(1, scaleMax);
  const slot = W / Math.max(1, buckets.length);
  const bar = Math.max(2, Math.min(24, slot - 2));
  const total = values.reduce((a, b) => a + b, 0);
  const peak = values.indexOf(Math.max(...values));
  const pick = (clientX: number, rect: DOMRect) =>
    Math.min(buckets.length - 1, Math.max(0, Math.floor(((clientX - rect.left) / rect.width) * buckets.length)));

  return (
    <figure className="columns" aria-labelledby={`${id}-t`}>
      <figcaption className="columns__head" id={`${id}-t`}>
        <span className="columns__title">{title}</span>
        <span className="columns__total mono">{NUM.format(total)}</span>
      </figcaption>
      <div className="columns__plot">
        <svg
          viewBox={`0 0 ${W} ${H}`}
          role="img"
          aria-label={`${title}: ${NUM.format(total)} nel periodo${total > 0 ? `, massimo ${NUM.format(values[peak]!)} (${bucketLabel(buckets[peak]!, bucket, true)})` : ''}`}
          onPointerMove={(e) => setHover(pick(e.clientX, e.currentTarget.getBoundingClientRect()))}
          onPointerLeave={() => setHover(null)}
        >
          <line x1="0" x2={W} y1={H - 0.5} y2={H - 0.5} className="columns__base" />
          {values.map((v, i) => {
            if (v === 0) return null;
            const h = Math.max(2, (v / max) * (H - 6));
            const x = i * slot + (slot - bar) / 2;
            const r = Math.min(4, bar / 2, h);
            // estremità arrotondata in alto, base squadrata
            return (
              <path
                key={buckets[i]}
                className={`columns__bar${hover === i ? ' is-hover' : ''}`}
                d={`M${x},${H} V${H - h + r} Q${x},${H - h} ${x + r},${H - h} H${x + bar - r} Q${x + bar},${H - h} ${x + bar},${H - h + r} V${H} Z`}
              />
            );
          })}
          {hover !== null && (
            <line x1={hover * slot + slot / 2} x2={hover * slot + slot / 2} y1="0" y2={H} className="columns__cross" />
          )}
        </svg>
        {hover !== null && (
          <p className="columns__tip" style={{ left: `${((hover + 0.5) / buckets.length) * 100}%` }} aria-hidden="true">
            <strong className="mono">{NUM.format(values[hover]!)}</strong>
            <span>{bucketLabel(buckets[hover]!, bucket, true)}</span>
          </p>
        )}
      </div>
      <div className="columns__axis small muted" aria-hidden="true">
        <span>{bucketLabel(buckets[0]!, bucket)}</span>
        {buckets.length > 1 && <span>{bucketLabel(buckets[buckets.length - 1]!, bucket)}</span>}
      </div>
    </figure>
  );
}
