import { bandOf, DEFAULT_AI_CONFIG } from '../ai/config.ts';
import { COMMERCIAL_SCORE } from '../discovery/businesses.ts';
import { audit } from '../audit.ts';
import type { Db, Queryable } from '../db/client.ts';
import { CATEGORIES, type CategoryId } from '../discovery/categories.ts';
import { JobError } from '../discovery/jobs.ts';
import { SECTORS, sectorById, sectorsInOrder } from '../discovery/sectors.ts';
import { geo, type AreaType } from '../geo/geo.ts';
import { appendMessages, jobMessage, type JobMessage } from '../jobs/messages.ts';

/*
 * Lead Hunter (Fase 6): ricerche di lead per obiettivo (es. 1.000 aziende) su tutta Italia o su un'area.
 * Una ricerca non è un nuovo motore: coordina i componenti esistenti.
 *  - scoperta: un job della Fase 2 per provincia (province alternate tra le regioni, per distribuire i risultati),
 *    per settori, con un limite per settore e per comune (nessun settore facile prevale);
 *  - audit: un job della Fase 3 alla volta per i siti ancora da verificare;
 *  - punteggio e abbinamento: aggiornati in automatico dopo ogni ricerca e ogni audit (Fasi 4 e 5).
 * I conteggi sono SEMPRE letti dal database (mai stimati): l'obiettivo risulta raggiunto solo quando i record ci sono.
 */

export const HUNT_ACTIVE = ['pending', 'running', 'paused'] as const;
export type WebsitePreference = 'any' | 'no_website' | 'website_issues';

export interface HuntOptions {
  /** Punteggio minimo del lead (Fase 4) per contare verso l'obiettivo; null = qualsiasi. */
  minScore: number | null;
  /** Solo aziende senza sito proprio indicato, oppure con problemi documentati dall'audit. */
  websitePreference: WebsitePreference;
  /** Solo aziende non presenti nel database prima della ricerca. */
  excludeKnown: boolean;
  /** Verifica automatica dei siti trovati (audit della Fase 3). */
  audit: boolean;
}

export interface HuntRequest {
  target: number;
  area: { type: AreaType; code: string };
  sectors: string[];
  options: HuntOptions;
}

export interface PlanArea {
  type: AreaType;
  code: string;
  name: string;
  municipalities: number;
}

/**
 * Aree da cercare, una alla volta. Italia o regione: le province, prese a turno da ogni regione (Nord, Centro, Sud
 * si alternano dall'inizio), così una ricerca che si ferma all'obiettivo non resta concentrata in poche regioni.
 */
export function planAreas(type: AreaType, code: string): PlanArea[] {
  const g = geo();
  const province = (p: { code: string; name: string }) => ({
    type: 'province' as const,
    code: p.code,
    name: p.name,
    municipalities: g.municipalitiesOf(p.code).length,
  });
  if (type === 'municipality') {
    const m = g.municipality(code);
    return m ? [{ type, code, name: m.name, municipalities: 1 }] : [];
  }
  if (type === 'province') {
    const p = g.province(code);
    return p ? [province(p)] : [];
  }
  const regions = type === 'italy' ? g.regions : g.region(code) ? [g.region(code)!] : [];
  const lists = regions.map((r) => g.provincesOf(r.code).map(province));
  const out: PlanArea[] = [];
  for (let i = 0; lists.some((l) => i < l.length); i++) for (const l of lists) if (l[i]) out.push(l[i]!);
  return out;
}

/** Sezione SQL comune: aziende collegate alla ricerca con il loro sito, l'ultimo audit e il punteggio attuale. */
const LINKED = `hunt_run_businesses hb
  JOIN businesses b ON b.id = hb.business_id AND b.merged_into IS NULL
  LEFT JOIN business_websites bw ON bw.business_id = b.id
  LEFT JOIN websites w ON w.id = bw.website_id
  LEFT JOIN website_audits la ON la.id = w.last_audit_id
  LEFT JOIN lead_scores ls ON ls.business_id = b.id AND ls.is_current
  LEFT JOIN ai_assessments aa ON aa.business_id = b.id AND aa.is_current
  LEFT JOIN ai_business_states ast ON ast.business_id = b.id`;
const OWN_SITE = 'b.website_url IS NOT NULL AND NOT b.website_shared';
/** Problemi documentati dall'audit: almeno un rilievo grave, o almeno tre rilievi utili. */
const SITE_ISSUES = `w.status IN ('valid', 'redirected') AND (COALESCE((la.summary->'findings'->'bySeverity'->>'high')::int, 0) > 0 OR la.actionable_count >= 3)`;

/** Condizioni per contare un'azienda verso l'obiettivo (candidata: senza i requisiti che richiedono l'audit). */
export function qualification(options: HuntOptions, params: unknown[], level: 'candidate' | 'qualified'): string {
  const parts = ['b.excluded_at IS NULL'];
  if (options.excludeKnown) parts.push('hb.is_new');
  if (options.websitePreference === 'no_website') parts.push(`NOT (${OWN_SITE})`);
  if (level === 'qualified') {
    if (options.websitePreference === 'website_issues') parts.push(`(${SITE_ISSUES})`);
    if (options.minScore !== null) {
      params.push(options.minScore);
      // punteggio commerciale (valutazione AI, altrimenti punteggio a regole): lo stesso dell'elenco e del CRM
      parts.push(`(${COMMERCIAL_SCORE}) >= $${params.length}`);
    }
  } else if (options.websitePreference === 'website_issues') parts.push(OWN_SITE);
  return parts.join(' AND ');
}

export async function countLinked(
  db: Queryable,
  runId: string,
  options: HuntOptions,
  level: 'candidate' | 'qualified',
) {
  const params: unknown[] = [runId];
  const cond = qualification(options, params, level);
  const { rows } = await db.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM ${LINKED} WHERE hb.run_id = $1 AND ${cond}`,
    params,
  );
  return rows[0]!.n;
}

export async function createHuntRun(
  db: Db,
  req: HuntRequest,
  ctx: { userId: string; providerConfigured: boolean },
): Promise<string> {
  if (!ctx.providerConfigured)
    throw new JobError(
      503,
      'PROVIDER_NOT_CONFIGURED',
      'La ricerca non è disponibile: nessun server OpenStreetMap configurato (DISCOVERY_OVERPASS_URL).',
    );
  const area = geo().area(req.area.type, req.area.code);
  if (!area) throw new JobError(400, 'UNKNOWN_AREA', 'Area geografica sconosciuta.');
  const sectors = sectorsInOrder(req.sectors);
  if (!sectors.length || sectors.length !== new Set(req.sectors).size)
    throw new JobError(400, 'UNKNOWN_SECTOR', 'Settore non presente nel catalogo.');
  const plan = planAreas(area.type, area.code);
  if (!plan.length) throw new JobError(400, 'UNKNOWN_AREA', 'Area geografica senza comuni.');
  return db.transaction(async (tx) => {
    // una ricerca di lead alla volta: i server pubblici di OpenStreetMap vanno usati con moderazione
    const { rows: active } = await tx.query<{ id: string }>('SELECT id FROM hunt_runs WHERE status = ANY($1) LIMIT 1', [
      HUNT_ACTIVE,
    ]);
    if (active[0])
      throw new JobError(
        409,
        'HUNT_ACTIVE',
        'Una ricerca di lead è già attiva: mettila in pausa o annullala prima di avviarne un’altra.',
        active[0].id,
      );
    const { rows } = await tx.query<{ id: string }>(
      `INSERT INTO hunt_runs (created_by, target, area_type, area_code, area_name, sectors, options, plan, messages)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
      [
        ctx.userId,
        req.target,
        area.type,
        area.code,
        area.name,
        sectors.map((x) => x.id),
        JSON.stringify(req.options),
        JSON.stringify(plan),
        JSON.stringify([
          jobMessage(
            'info',
            `Obiettivo: ${req.target} aziende in ${area.name}, ${sectors.length} ${sectors.length === 1 ? 'settore' : 'settori'}; ${plan.length} ${plan.length === 1 ? 'area' : 'aree'} da cercare una alla volta.`,
          ),
        ]),
      ],
    );
    await audit(tx, {
      userId: ctx.userId,
      action: 'hunt.created',
      entityType: 'hunt_run',
      entityId: rows[0]!.id,
      details: { target: req.target, area: [area.type, area.code], sectors: sectors.length, options: req.options },
    });
    return rows[0]!.id;
  });
}

async function lockRun(tx: Queryable, id: string) {
  const { rows } = await tx.query<{ status: string }>('SELECT status FROM hunt_runs WHERE id = $1 FOR UPDATE', [id]);
  if (!rows[0]) throw new JobError(404, 'NOT_FOUND', 'Ricerca di lead non trovata.');
  return rows[0].status;
}

/** Pausa e annullamento sono richieste: il coordinatore le applica ai job in corso entro pochi secondi. */
export async function controlHuntRun(db: Db, id: string, action: 'pause' | 'resume' | 'cancel', userId: string) {
  await db.transaction(async (tx) => {
    const status = await lockRun(tx, id);
    if (action === 'pause') {
      if (status !== 'running' && status !== 'pending')
        throw new JobError(409, 'INVALID_STATE', 'Si può mettere in pausa solo una ricerca in corso.');
      await tx.query('UPDATE hunt_runs SET pause_requested = true, updated_at = now() WHERE id = $1', [id]);
    } else if (action === 'resume') {
      if (status !== 'paused') throw new JobError(409, 'INVALID_STATE', 'Si può riprendere solo una ricerca in pausa.');
      await tx.query(
        "UPDATE hunt_runs SET status = 'running', pause_requested = false, pause_reason = NULL, updated_at = now() WHERE id = $1",
        [id],
      );
      await appendMessages(tx, 'hunt_runs', id, [jobMessage('info', 'Ricerca ripresa.')]);
    } else {
      if (!(HUNT_ACTIVE as readonly string[]).includes(status))
        throw new JobError(409, 'INVALID_STATE', 'La ricerca è già terminata.');
      await tx.query('UPDATE hunt_runs SET cancel_requested = true, updated_at = now() WHERE id = $1', [id]);
    }
    await audit(tx, {
      userId,
      action: `hunt.${action === 'pause' ? 'paused' : action === 'resume' ? 'resumed' : 'cancelled'}`,
      entityType: 'hunt_run',
      entityId: id,
    });
  });
}

// ---------- letture ----------

interface RunRow {
  id: string;
  status: string;
  target: number;
  area_type: AreaType;
  area_code: string;
  area_name: string;
  sectors: string[];
  options: HuntOptions;
  plan: PlanArea[];
  cursor: number;
  phase: string;
  current_job_id: string | null;
  current_audit_job_id: string | null;
  messages: JobMessage[];
  pause_requested: boolean;
  cancel_requested: boolean;
  pause_reason: string | null;
  created_at: Date;
  started_at: Date | null;
  finished_at: Date | null;
  created_by_name: string | null;
}

const iso = (d: Date | null) => (d ? new Date(d).toISOString() : null);
const RUN_SELECT =
  'SELECT r.*, u.display_name AS created_by_name FROM hunt_runs r LEFT JOIN users u ON u.id = r.created_by';

const runDto = (r: RunRow) => ({
  id: r.id,
  status: r.status,
  phase: r.phase,
  target: r.target,
  area: { type: r.area_type, code: r.area_code, name: r.area_name },
  sectors: r.sectors.map((id) => ({ id, label: sectorById(id)?.label ?? id })),
  options: r.options,
  plan: {
    total: r.plan.length,
    done: r.cursor,
    current: r.cursor > 0 && r.current_job_id ? r.plan[r.cursor - 1]!.name : null,
  },
  currentJobId: r.current_job_id,
  currentAuditJobId: r.current_audit_job_id,
  messages: r.messages,
  pauseRequested: r.pause_requested,
  cancelRequested: r.cancel_requested,
  pauseReason: r.pause_reason,
  createdAt: iso(r.created_at),
  startedAt: iso(r.started_at),
  finishedAt: iso(r.finished_at),
  createdBy: r.created_by_name,
});

export async function listHuntRuns(db: Queryable, page: number, pageSize: number) {
  const { rows: total } = await db.query<{ n: number }>('SELECT count(*)::int AS n FROM hunt_runs');
  const { rows } = await db.query<RunRow>(`${RUN_SELECT} ORDER BY r.created_at DESC, r.id LIMIT $1 OFFSET $2`, [
    pageSize,
    (page - 1) * pageSize,
  ]);
  const items = [];
  for (const r of rows) items.push({ ...runDto(r), progress: await progressOf(db, r) });
  return { items, total: total[0]!.n, page, pageSize };
}

/** Avanzamento letto dal database: scoperta (dai job), aziende collegate, siti, audit, punteggi, obiettivo. */
async function progressOf(db: Queryable, r: RunRow) {
  const { rows: d } = await db.query<Record<string, number>>(
    `SELECT COALESCE(sum(discovered), 0)::int AS discovered, COALESCE(sum(inserted), 0)::int AS inserted,
            COALESCE(sum(updated + unchanged), 0)::int AS known, COALESCE(sum(merged + duplicates_skipped), 0)::int AS duplicates,
            COALESCE(sum(failed_requests), 0)::int AS failed_requests, COALESCE(sum(requests_sent), 0)::int AS requests,
            count(*) FILTER (WHERE status = 'failed')::int AS failed_areas
       FROM discovery_jobs WHERE hunt_run_id = $1`,
    [r.id],
  );
  const { rows: l } = await db.query<Record<string, number>>(
    `SELECT count(*)::int AS linked,
            count(*) FILTER (WHERE hb.is_new)::int AS new,
            count(*) FILTER (WHERE b.excluded_at IS NOT NULL)::int AS excluded,
            count(*) FILTER (WHERE ${OWN_SITE})::int AS with_site,
            count(*) FILTER (WHERE NOT (${OWN_SITE}))::int AS without_site,
            count(*) FILTER (WHERE w.status IN ('valid', 'redirected'))::int AS verified,
            count(*) FILTER (WHERE ${OWN_SITE} AND COALESCE(w.status, 'not_checked') = 'not_checked')::int AS unverified,
            count(*) FILTER (WHERE w.status IN ('unreachable', 'timeout', 'blocked'))::int AS unreachable,
            count(*) FILTER (WHERE w.status = 'invalid_url' OR bw.status = 'invalid_url')::int AS invalid,
            count(*) FILTER (WHERE w.status = 'audit_failed')::int AS audit_failed,
            count(*) FILTER (WHERE w.last_audit_id IS NOT NULL)::int AS audited,
            count(*) FILTER (WHERE ls.id IS NOT NULL)::int AS scored,
            count(*) FILTER (WHERE ls.status IN ('ranked', 'needs_review'))::int AS ranked
       FROM ${LINKED} WHERE hb.run_id = $1`,
    [r.id],
  );
  const { rows: a } = await db.query<Record<string, number>>(
    `SELECT count(*) FILTER (WHERE i.status IN ('pending', 'running'))::int AS pending,
            count(*) FILTER (WHERE i.status = 'failed')::int AS failed
       FROM audit_job_items i JOIN audit_jobs j ON j.id = i.job_id WHERE j.hunt_run_id = $1`,
    [r.id],
  );
  const qualified = await countLinked(db, r.id, r.options, 'qualified');
  return {
    discovered: d[0]!.discovered!,
    newBusinesses: d[0]!.inserted!,
    alreadyKnown: d[0]!.known!,
    duplicatesAvoided: d[0]!.duplicates!,
    requests: d[0]!.requests!,
    failedRequests: d[0]!.failed_requests!,
    failedAreas: d[0]!.failed_areas!,
    linked: l[0]!.linked!,
    linkedNew: l[0]!.new!,
    excluded: l[0]!.excluded!,
    websites: {
      found: l[0]!.with_site!,
      missing: l[0]!.without_site!,
      verified: l[0]!.verified!,
      unverified: l[0]!.unverified!,
      unreachable: l[0]!.unreachable!,
      invalid: l[0]!.invalid!,
    },
    audits: { completed: l[0]!.audited!, pending: a[0]!.pending!, failed: a[0]!.failed! + l[0]!.audit_failed! },
    scored: l[0]!.scored!,
    ranked: l[0]!.ranked!,
    qualified,
    remaining: Math.max(0, r.target - qualified),
    targetReached: qualified >= r.target,
  };
}

export async function getHuntRun(db: Queryable, id: string) {
  const { rows } = await db.query<RunRow>(`${RUN_SELECT} WHERE r.id = $1`, [id]);
  const r = rows[0];
  if (!r) throw new JobError(404, 'NOT_FOUND', 'Ricerca di lead non trovata.');
  const { rows: bySector } = await db.query<{ sector: string | null; n: number }>(
    `SELECT b.sector, count(*)::int AS n FROM hunt_run_businesses hb JOIN businesses b ON b.id = hb.business_id
      WHERE hb.run_id = $1 AND b.merged_into IS NULL GROUP BY b.sector ORDER BY n DESC, b.sector`,
    [id],
  );
  const { rows: byRegion } = await db.query<{ region_code: string | null; n: number }>(
    `SELECT b.region_code, count(*)::int AS n FROM hunt_run_businesses hb JOIN businesses b ON b.id = hb.business_id
      WHERE hb.run_id = $1 AND b.merged_into IS NULL GROUP BY b.region_code ORDER BY n DESC, b.region_code`,
    [id],
  );
  // le migliori opportunità, con al massimo 2 aziende per settore (varietà; il punteggio non cambia)
  const params: unknown[] = [id];
  const cond = qualification(r.options, params, 'qualified');
  const { rows: top } = await db.query<{
    id: string;
    name: string;
    sector: string | null;
    category: string;
    municipality_name: string | null;
    score: number;
    ai: boolean;
  }>(
    `SELECT id, name, sector, category, municipality_name, score, ai FROM (
       SELECT b.id, b.name, b.sector, b.category, b.municipality_name, (${COMMERCIAL_SCORE}) AS score, aa.id IS NOT NULL AS ai,
              row_number() OVER (PARTITION BY COALESCE(b.sector, b.category) ORDER BY (${COMMERCIAL_SCORE}) DESC, b.id) AS rn
         FROM ${LINKED}
        WHERE hb.run_id = $1 AND ${cond} AND (${COMMERCIAL_SCORE}) IS NOT NULL) x
      WHERE rn <= 2 ORDER BY score DESC, id LIMIT 10`,
    params,
  );
  let currentJob = null;
  if (r.current_job_id) {
    const { rows: j } = await db.query<{
      id: string;
      status: string;
      area_name: string;
      units_done: number;
      units_total: number;
      messages: JobMessage[];
    }>('SELECT id, status, area_name, units_done, units_total, messages FROM discovery_jobs WHERE id = $1', [
      r.current_job_id,
    ]);
    if (j[0])
      currentJob = {
        id: j[0].id,
        status: j[0].status,
        area: j[0].area_name,
        unitsDone: j[0].units_done,
        unitsTotal: j[0].units_total,
        messages: j[0].messages.slice(-3),
      };
  }
  return {
    run: runDto(r),
    progress: await progressOf(db, r),
    currentJob,
    distribution: {
      sectors: bySector.map((x) => ({
        sector: x.sector,
        label: x.sector ? (sectorById(x.sector)?.label ?? x.sector) : 'Senza settore',
        count: x.n,
      })),
      regions: byRegion.map((x) => ({
        regionCode: x.region_code,
        region: x.region_code ? (geo().region(x.region_code)?.name ?? x.region_code) : 'Non determinata',
        count: x.n,
      })),
    },
    top: top.map((t) => ({
      id: t.id,
      name: t.name,
      sector: t.sector
        ? (sectorById(t.sector)?.label ?? t.sector)
        : (CATEGORIES[t.category as CategoryId]?.label ?? t.category),
      municipality: t.municipality_name,
      score: t.score,
      source: t.ai ? ('ai' as const) : ('rules' as const),
      band: bandOf(DEFAULT_AI_CONFIG, t.score).label,
    })),
  };
}

/** Catalogo dei settori per l'interfaccia, raggruppati, con la copertura dichiarata. */
export function sectorCatalog() {
  return SECTORS.map((s) => ({
    id: s.id,
    label: s.label,
    group: s.group,
    category: s.category,
    coverage: s.coverage,
    note: s.note ?? null,
  }));
}
