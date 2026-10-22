import { activeAiConfig } from '../ai/config.ts';
import { CLOSED_SQL, STAGES, todayInRome, toEuro } from '../crm/model.ts';
import { DUE_SOON_DAYS } from '../crm/store.ts';
import type { Queryable } from '../db/client.ts';
import { COMMERCIAL_SCORE, FROM_BUSINESSES } from '../discovery/businesses.ts';
import { sectorById } from '../discovery/sectors.ts';
import { CATEGORIES, type CategoryId } from '../discovery/categories.ts';
import { geo } from '../geo/geo.ts';

/*
 * Report commerciali (Fase 8): solo conteggi sulle righe del database, regole deterministiche, nessuna AI.
 * Periodo in ora italiana: dall'inizio del primo giorno (incluso) all'inizio del giorno dopo l'ultimo (escluso).
 * Definizioni (anche nell'interfaccia e in docs/report.md):
 *  - tasso di vittoria = vinte / (vinte + perse) tra le opportunità chiuse nel periodo; le aperte non contano;
 *    senza chiusure non viene calcolato;
 *  - tempo medio di chiusura = media dei giorni tra creazione e chiusura delle opportunità vinte o perse nel periodo,
 *    mostrato solo con almeno MIN_CLOSED chiusure;
 *  - valori in euro = somma dei valori stimati inseriti a mano (null se nessuna opportunità ne ha uno).
 */

export const PERIODS = ['7d', '30d', '90d', 'month', 'prev_month', 'all'] as const;
export type Period = (typeof PERIODS)[number];
export const PERIOD_LABEL: Record<Period, string> = {
  '7d': 'Ultimi 7 giorni',
  '30d': 'Ultimi 30 giorni',
  '90d': 'Ultimi 90 giorni',
  month: 'Questo mese',
  prev_month: 'Mese precedente',
  all: 'Tutto il periodo',
};
const MIN_CLOSED = 3;

const addDays = (d: string, n: number) => {
  const t = new Date(`${d}T00:00:00Z`);
  t.setUTCDate(t.getUTCDate() + n);
  return t.toISOString().slice(0, 10);
};

/** Estremi del periodo (date italiane): da `from` incluso a `to` escluso; null = nessun limite. */
export function periodRange(
  period: Period,
  today = todayInRome(),
): { from: string | null; to: string | null; bucket: 'day' | 'week' | 'month' } {
  const first = `${today.slice(0, 7)}-01`;
  switch (period) {
    case '7d':
      return { from: addDays(today, -6), to: addDays(today, 1), bucket: 'day' };
    case '30d':
      return { from: addDays(today, -29), to: addDays(today, 1), bucket: 'day' };
    case '90d':
      return { from: addDays(today, -89), to: addDays(today, 1), bucket: 'week' };
    case 'month':
      return { from: first, to: addDays(today, 1), bucket: 'day' };
    case 'prev_month': {
      const d = new Date(`${first}T00:00:00Z`);
      d.setUTCMonth(d.getUTCMonth() - 1);
      return { from: d.toISOString().slice(0, 10), to: first, bucket: 'day' };
    }
    default:
      return { from: null, to: null, bucket: 'month' };
  }
}

/** Condizione SQL "dentro il periodo" su una colonna timestamptz, con i parametri da aggiungere. */
function within(col: string, r: { from: string | null; to: string | null }, params: unknown[]) {
  const parts: string[] = [];
  if (r.from) {
    params.push(r.from);
    parts.push(`${col} >= ($${params.length}::date)::timestamp AT TIME ZONE 'Europe/Rome'`);
  }
  if (r.to) {
    params.push(r.to);
    parts.push(`${col} < ($${params.length}::date)::timestamp AT TIME ZONE 'Europe/Rome'`);
  }
  return parts.length ? parts.join(' AND ') : 'true';
}

/** Serie completa (zeri compresi) per l'andamento nel periodo. */
function series(bucket: 'day' | 'week' | 'month', from: string, to: string): string[] {
  const out: string[] = [];
  if (bucket === 'month') {
    const d = new Date(`${from.slice(0, 7)}-01T00:00:00Z`);
    while (d.toISOString().slice(0, 10) < to) {
      out.push(d.toISOString().slice(0, 10));
      d.setUTCMonth(d.getUTCMonth() + 1);
    }
    return out;
  }
  let d = from;
  if (bucket === 'week') {
    // settimane da lunedì
    const wd = (new Date(`${d}T00:00:00Z`).getUTCDay() + 6) % 7;
    d = addDays(d, -wd);
  }
  for (; d < to; d = addDays(d, bucket === 'week' ? 7 : 1)) out.push(d);
  return out;
}

export async function commercialReport(db: Queryable, period: Period) {
  const today = todayInRome();
  const range = periodRange(period, today);
  const config = await activeAiConfig(db);
  const top = config.config.bands[0]!;

  // ---- prospezione ----
  const p1: unknown[] = [top.min];
  const discoveredCond = within('b.first_seen_at', range, p1);
  const { rows: pr } = await db.query<
    Record<
      'total' | 'excluded' | 'discovered' | 'website_assessed' | 'ai_assessed' | 'scored' | 'high_priority',
      number
    >
  >(
    `SELECT count(*)::int AS total,
            count(*) FILTER (WHERE b.excluded_at IS NOT NULL)::int AS excluded,
            count(*) FILTER (WHERE ${discoveredCond})::int AS discovered,
            count(*) FILTER (WHERE la.id IS NOT NULL AND la.run_status IN ('completed', 'partial'))::int AS website_assessed,
            count(*) FILTER (WHERE aa.id IS NOT NULL)::int AS ai_assessed,
            count(*) FILTER (WHERE b.excluded_at IS NULL AND (${COMMERCIAL_SCORE}) IS NOT NULL)::int AS scored,
            count(*) FILTER (WHERE b.excluded_at IS NULL AND (${COMMERCIAL_SCORE}) >= $1)::int AS high_priority
       FROM ${FROM_BUSINESSES} WHERE b.merged_into IS NULL`,
    p1,
  );
  const prospect = pr[0]!;
  const { rows: scores } = await db.query<{ score: number }>(
    `SELECT (${COMMERCIAL_SCORE}) AS score FROM ${FROM_BUSINESSES}
      WHERE b.merged_into IS NULL AND b.excluded_at IS NULL AND (${COMMERCIAL_SCORE}) IS NOT NULL`,
  );
  const bands = config.config.bands.map((b, i, all) => {
    const max = i === 0 ? 100 : all[i - 1]!.min - 1;
    return {
      id: b.id,
      label: b.label,
      min: b.min,
      max,
      count: scores.filter((s) => s.score >= b.min && s.score <= max).length,
    };
  });
  const { rows: sectors } = await db.query<{ sector: string | null; category: string; n: number }>(
    `SELECT b.sector, CASE WHEN b.sector IS NULL THEN b.category END AS category, count(*)::int AS n
       FROM businesses b WHERE b.merged_into IS NULL GROUP BY 1, 2 ORDER BY n DESC`,
  );
  const sectorRows = sectors.map((s) => ({
    key: s.sector ?? `cat:${s.category}`,
    label: s.sector
      ? (sectorById(s.sector)?.label ?? s.sector)
      : // aziende trovate con la ricerca manuale per categoria (Fase 2): nessun settore assegnato
        `${CATEGORIES[s.category as CategoryId]?.label ?? s.category} (solo categoria)`,
    count: s.n,
  }));
  const { rows: regions } = await db.query<{ region_code: string | null; n: number }>(
    'SELECT region_code, count(*)::int AS n FROM businesses WHERE merged_into IS NULL GROUP BY region_code ORDER BY n DESC',
  );

  // ---- CRM ----
  const { rows: stageRows } = await db.query<{ stage: string; n: number }>(
    'SELECT stage, count(*)::int AS n FROM crm_opportunities GROUP BY stage',
  );
  const byStage = STAGES.map((s) => ({
    id: s.id,
    label: s.label,
    closed: s.closed,
    count: stageRows.find((x) => x.stage === s.id)?.n ?? 0,
  }));
  const p2: unknown[] = [];
  const createdCond = within('created_at', range, p2);
  const closedCond = within('closed_at', range, p2);
  const { rows: cr } = await db.query<Record<string, string | number | null>>(
    `SELECT count(*) FILTER (WHERE stage NOT IN ${CLOSED_SQL})::int AS active,
            count(*) FILTER (WHERE ${createdCond})::int AS created,
            count(*) FILTER (WHERE stage = 'vinto' AND ${closedCond})::int AS won,
            count(*) FILTER (WHERE stage = 'perso' AND ${closedCond})::int AS lost,
            sum(estimated_value_cents) FILTER (WHERE stage = 'vinto' AND ${closedCond}) AS won_value,
            count(estimated_value_cents) FILTER (WHERE stage = 'vinto' AND ${closedCond})::int AS won_valued,
            sum(estimated_value_cents) FILTER (WHERE stage NOT IN ${CLOSED_SQL}) AS open_value,
            count(estimated_value_cents) FILTER (WHERE stage NOT IN ${CLOSED_SQL})::int AS open_valued,
            avg(extract(epoch FROM closed_at - created_at) / 86400) FILTER (WHERE stage IN ('vinto', 'perso') AND ${closedCond}) AS avg_days,
            count(*) FILTER (WHERE stage IN ('vinto', 'perso') AND ${closedCond} AND closed_at >= created_at)::int AS closed_timed
       FROM crm_opportunities`,
    p2,
  );
  const c = cr[0]!;
  const won = Number(c.won);
  const lost = Number(c.lost);
  const p3: unknown[] = [today];
  const completedCond = within('f.completed_at', range, p3);
  const { rows: fu } = await db.query<{ overdue: number; soon: number; completed: number }>(
    `SELECT count(*) FILTER (WHERE f.status = 'pending' AND f.due_date < $1::date AND o.stage NOT IN ${CLOSED_SQL})::int AS overdue,
            count(*) FILTER (WHERE f.status = 'pending' AND f.due_date >= $1::date AND f.due_date < $1::date + ${DUE_SOON_DAYS}
                             AND o.stage NOT IN ${CLOSED_SQL})::int AS soon,
            count(*) FILTER (WHERE f.status = 'completed' AND ${completedCond})::int AS completed
       FROM crm_followups f JOIN crm_opportunities o ON o.id = f.opportunity_id`,
    p3,
  );

  // ---- andamento ----
  let trend: {
    buckets: string[];
    bucket: 'day' | 'week' | 'month';
    discovered: number[];
    created: number[];
    won: number[];
    lost: number[];
  } | null = null;
  const { rows: firstRow } = await db.query<{ first: string | null }>(
    `SELECT to_char(min(b.first_seen_at) AT TIME ZONE 'Europe/Rome', 'YYYY-MM-DD') AS first FROM businesses b WHERE b.merged_into IS NULL`,
  );
  const from = range.from ?? firstRow[0]?.first ?? null;
  if (from) {
    const to = range.to ?? addDays(today, 1);
    const buckets = series(range.bucket, from, to);
    const unit = range.bucket;
    const count = async (sql: string) => {
      const params: unknown[] = [];
      const cond = within('t', { from, to }, params);
      const { rows } = await db.query<{ k: string; n: number }>(
        `SELECT to_char(date_trunc('${unit}', t AT TIME ZONE 'Europe/Rome'), 'YYYY-MM-DD') AS k, count(*)::int AS n
           FROM (${sql}) x WHERE ${cond} GROUP BY 1`,
        params,
      );
      const m = new Map(rows.map((r) => [r.k, r.n]));
      return buckets.map((b) => m.get(b) ?? 0);
    };
    trend = {
      buckets,
      bucket: unit,
      discovered: await count('SELECT first_seen_at AS t FROM businesses WHERE merged_into IS NULL'),
      created: await count('SELECT created_at AS t FROM crm_opportunities'),
      won: await count("SELECT closed_at AS t FROM crm_opportunities WHERE stage = 'vinto'"),
      lost: await count("SELECT closed_at AS t FROM crm_opportunities WHERE stage = 'perso'"),
    };
  }

  const result = {
    period,
    periodLabel: PERIOD_LABEL[period],
    range: { from: range.from, toExclusive: range.to },
    today,
    prospecting: {
      total: prospect.total,
      excluded: prospect.excluded,
      discovered: prospect.discovered,
      websiteAssessed: prospect.website_assessed,
      aiAssessed: prospect.ai_assessed,
      scored: prospect.scored,
      highPriority: prospect.high_priority,
      highPriorityShare: prospect.scored ? prospect.high_priority / prospect.scored : null,
      topBand: { label: top.label, min: top.min },
      bands,
      bySector: sectorRows,
      byRegion: regions.map((r) => ({
        key: r.region_code ?? 'nd',
        label: r.region_code ? (geo().region(r.region_code)?.name ?? r.region_code) : 'Non determinata',
        count: r.n,
      })),
    },
    crm: {
      active: Number(c.active),
      byStage,
      created: Number(c.created),
      won,
      lost,
      winRate: won + lost > 0 ? won / (won + lost) : null,
      wonValue: Number(c.won_valued) ? toEuro(c.won_value as string) : null,
      wonValued: Number(c.won_valued),
      openValue: Number(c.open_valued) ? toEuro(c.open_value as string) : null,
      openValued: Number(c.open_valued),
      avgDaysToClose:
        Number(c.closed_timed) >= MIN_CLOSED && c.avg_days !== null ? Math.round(Number(c.avg_days) * 10) / 10 : null,
      closedWithTimes: Number(c.closed_timed),
      minClosedForAverage: MIN_CLOSED,
      followUps: {
        overdue: fu[0]!.overdue,
        dueSoon: fu[0]!.soon,
        completed: fu[0]!.completed,
        soonDays: DUE_SOON_DAYS,
      },
    },
    trend,
    observations: [] as string[],
  };
  result.observations = observations(result);
  return result;
}

type Report = Awaited<ReturnType<typeof commercialReport>>;

const plural = (n: number, one: string, many: string) => `${n.toLocaleString('it-IT')} ${n === 1 ? one : many}`;

/** Osservazioni solo se sostenute dai numeri; nessuna deduzione di causa. */
export function observations(r: Omit<Report, 'observations'>): string[] {
  const out: string[] = [];
  const p = r.prospecting;
  const c = r.crm;
  if (c.followUps.overdue > 0)
    out.push(`Hai ${plural(c.followUps.overdue, 'follow-up scaduto', 'follow-up scaduti')}.`);
  if (p.discovered > 0)
    out.push(`${r.periodLabel}: ${plural(p.discovered, 'nuova azienda censita', 'nuove aziende censite')}.`);
  const topSector = p.bySector[0];
  if (topSector && topSector.count > 0)
    out.push(`Il settore con più aziende censite è «${topSector.label}» (${topSector.count.toLocaleString('it-IT')}).`);
  if (p.scored > 0 && p.highPriority > 0)
    out.push(
      `${plural(p.highPriority, 'azienda è', 'aziende sono')} in fascia «${p.topBand.label}» su ${p.scored.toLocaleString('it-IT')} con un punteggio commerciale.`,
    );
  if (p.total > 0 && p.aiAssessed === 0)
    out.push('Nessuna azienda ha ancora una valutazione AI: i punteggi commerciali sono quelli a regole.');
  if (c.won > 0)
    out.push(`Nel periodo selezionato ${plural(c.won, 'opportunità è stata vinta', 'opportunità sono state vinte')}.`);
  if (c.lost > 0)
    out.push(`Nel periodo selezionato ${plural(c.lost, 'opportunità è stata persa', 'opportunità sono state perse')}.`);
  if (c.winRate !== null)
    out.push(
      `Tasso di vittoria nel periodo: ${Math.round(c.winRate * 100)}% (${c.won} vinte su ${c.won + c.lost} chiuse).`,
    );
  return out;
}
