import { audit } from '../audit.ts';
import type { Db, Queryable } from '../db/client.ts';
import {
  applyExclusion,
  AUDIT_COLUMNS,
  COMMERCIAL_SCORE,
  listQuery,
  summary,
  type BusinessFilters,
  type BusinessRow,
} from '../discovery/businesses.ts';
import { JobError } from '../discovery/jobs.ts';
import { activeCatalog, primaryServices } from '../matching/store.ts';
import {
  ACTIVITY_TYPES,
  activityLabel,
  CLOSED_SQL,
  isClosed,
  PRIORITIES,
  stageLabel,
  STAGES,
  todayInRome,
  toCents,
  toEuro,
  type ActivityType,
  type PriorityId,
  type StageId,
} from './model.ts';

/*
 * CRM (Fase 7): opportunità commerciali collegate alle aziende esistenti, cronologia delle attività, follow-up.
 * Regole in model.ts. Ogni modifica avviene in una transazione con il blocco della riga dell'opportunità.
 * I dati dell'azienda, degli audit e dei punteggi sono solo letti: il CRM non li modifica (salvo l'esclusione
 * esplicita di "non contattare").
 */

const iso = (d: Date | string | null | undefined) => (d ? new Date(d).toISOString() : null);
// le colonne date e time si leggono come testo (::text): nessuna conversione di fuso orario
const dateOnly = (d: string | null) => (d === null ? null : d.slice(0, 10));
const timeOnly = (t: string | null) => (t ? t.slice(0, 5) : null);

const notFound = () => new JobError(404, 'NOT_FOUND', 'Opportunità non trovata.');

// ---------------------------------------------------------------- meta

export async function crmMeta(db: Queryable) {
  const { rows: owners } = await db.query<{ id: string; display_name: string }>(
    'SELECT id, display_name FROM users WHERE disabled_at IS NULL ORDER BY display_name',
  );
  const catalog = await activeCatalog(db);
  return {
    stages: STAGES,
    priorities: PRIORITIES,
    activityTypes: ACTIVITY_TYPES,
    owners: owners.map((u) => ({ id: u.id, name: u.display_name })),
    services: catalog.catalog.services.map((s) => ({ id: s.id, name: s.name, active: s.active })),
    catalogVersion: catalog.version,
    today: todayInRome(),
  };
}

// ---------------------------------------------------------------- creazione

export interface OpportunityInput {
  businessId: string;
  stage: StageId;
  priority: PriorityId;
  ownerId?: string | null;
  estimatedValue?: number | null;
  services?: string[];
  notes?: string | null;
}

async function validServices(db: Queryable, ids: string[] | undefined) {
  if (!ids?.length) return [];
  const known = new Set((await activeCatalog(db)).catalog.services.map((s) => s.id));
  const unknown = ids.filter((id) => !known.has(id));
  if (unknown.length)
    throw new JobError(
      400,
      'UNKNOWN_SERVICE',
      `Servizio non presente nel catalogo di Noventra: ${unknown.join(', ')}.`,
    );
  return [...new Set(ids)];
}

async function validOwner(db: Queryable, ownerId: string | null | undefined) {
  if (!ownerId) return null;
  const { rows } = await db.query('SELECT 1 FROM users WHERE id = $1 AND disabled_at IS NULL', [ownerId]);
  if (!rows[0]) throw new JobError(400, 'UNKNOWN_OWNER', 'Responsabile non valido o disattivato.');
  return ownerId;
}

export async function recordActivity(
  tx: Queryable,
  a: {
    opportunityId: string;
    type: ActivityType;
    summary: string;
    notes?: string | null;
    occurredAt?: Date;
    fromStage?: string | null;
    toStage?: string | null;
    userId: string | null;
  },
) {
  const at = a.occurredAt ?? new Date();
  const { rows } = await tx.query<{ id: string }>(
    `INSERT INTO crm_activities (opportunity_id, type, occurred_at, summary, notes, from_stage, to_stage, user_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
    [a.opportunityId, a.type, at, a.summary, a.notes ?? null, a.fromStage ?? null, a.toStage ?? null, a.userId],
  );
  await tx.query(
    'UPDATE crm_opportunities SET last_activity_at = GREATEST(last_activity_at, $2), updated_at = now() WHERE id = $1',
    [a.opportunityId, at],
  );
  return rows[0]!.id;
}

/** Controlla che l'azienda possa avere una nuova opportunità; restituisce il motivo se non può. */
export async function blockerFor(
  tx: Queryable,
  businessId: string,
): Promise<{ status: number; code: string; message: string; data?: Record<string, unknown> } | null> {
  const { rows } = await tx.query<{ merged_into: string | null; excluded_at: Date | null }>(
    'SELECT merged_into, excluded_at FROM businesses WHERE id = $1 FOR UPDATE',
    [businessId],
  );
  const b = rows[0];
  if (!b) return { status: 404, code: 'BUSINESS_NOT_FOUND', message: 'Azienda non trovata.' };
  if (b.merged_into)
    return {
      status: 409,
      code: 'BUSINESS_MERGED',
      message: 'L’azienda è stata unita a un’altra: crea l’opportunità sulla scheda mantenuta.',
      data: { mergedInto: b.merged_into },
    };
  if (b.excluded_at)
    return {
      status: 409,
      code: 'BUSINESS_EXCLUDED',
      message:
        'L’azienda è esclusa dalla prospezione (non contattare). Reincludila dalla scheda se è cambiato qualcosa.',
    };
  const { rows: open } = await tx.query<{ id: string }>(
    `SELECT id FROM crm_opportunities WHERE business_id = $1 AND stage NOT IN ${CLOSED_SQL}`,
    [businessId],
  );
  if (open[0])
    return {
      status: 409,
      code: 'OPPORTUNITY_EXISTS',
      message: 'Questa azienda ha già un’opportunità aperta.',
      data: { opportunityId: open[0].id },
    };
  return null;
}

export async function insertOpportunity(tx: Queryable, input: OpportunityInput, services: string[], userId: string) {
  const { rows } = await tx.query<{ id: string }>(
    `INSERT INTO crm_opportunities (business_id, stage, priority, owner_id, estimated_value_cents, notes, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
    [
      input.businessId,
      input.stage,
      input.priority,
      input.ownerId ?? userId,
      input.estimatedValue === null || input.estimatedValue === undefined ? null : toCents(input.estimatedValue),
      input.notes || null,
      userId,
    ],
  );
  const id = rows[0]!.id;
  for (const s of services)
    await tx.query('INSERT INTO crm_opportunity_services (opportunity_id, service_id) VALUES ($1, $2)', [id, s]);
  await recordActivity(tx, {
    opportunityId: id,
    type: 'stage_change',
    summary: `Opportunità creata in «${stageLabel(input.stage)}»`,
    toStage: input.stage,
    userId,
  });
  await audit(tx, {
    userId,
    action: 'crm.opportunity_created',
    entityType: 'crm_opportunity',
    entityId: id,
    details: { businessId: input.businessId, stage: input.stage },
  });
  return id;
}

export async function createOpportunity(db: Db, input: OpportunityInput, userId: string): Promise<string> {
  const services = await validServices(db, input.services);
  await validOwner(db, input.ownerId);
  return db.transaction(async (tx) => {
    const blocker = await blockerFor(tx, input.businessId);
    if (blocker) throw new JobError(blocker.status, blocker.code, blocker.message, undefined, blocker.data);
    return insertOpportunity(tx, input, services, userId);
  });
}

/**
 * Aggiunta in blocco delle aziende selezionate: una transazione per azienda, così un errore non annulla le altre.
 * Nessuna azienda viene aggiunta senza essere stata scelta da una persona.
 */
export async function bulkCreate(db: Db, businessIds: string[], userId: string) {
  const created: { businessId: string; opportunityId: string }[] = [];
  const skipped: { businessId: string; reason: string; message: string; opportunityId?: string }[] = [];
  const failed: { businessId: string; reason: string; message: string }[] = [];
  for (const businessId of [...new Set(businessIds)]) {
    try {
      const result = await db.transaction(async (tx) => {
        const blocker = await blockerFor(tx, businessId);
        if (blocker) return { blocker };
        return {
          id: await insertOpportunity(tx, { businessId, stage: 'da_qualificare', priority: 'media' }, [], userId),
        };
      });
      if ('id' in result) created.push({ businessId, opportunityId: result.id! });
      else if (result.blocker.status === 404)
        failed.push({ businessId, reason: result.blocker.code, message: result.blocker.message });
      else
        skipped.push({
          businessId,
          reason: result.blocker.code,
          message: result.blocker.message,
          ...(typeof result.blocker.data?.opportunityId === 'string'
            ? { opportunityId: result.blocker.data.opportunityId }
            : {}),
        });
    } catch (error) {
      // conflitto concorrente sull'indice "una sola aperta": già aggiunta da un'altra richiesta
      if ((error as { code?: string }).code === '23505')
        skipped.push({
          businessId,
          reason: 'OPPORTUNITY_EXISTS',
          message: 'Questa azienda ha già un’opportunità aperta.',
        });
      else throw error;
    }
  }
  return { created, skipped, failed };
}

// ---------------------------------------------------------------- lettura

export interface OppColumns {
  opp_id: string;
  opp_stage: StageId;
  opp_priority: PriorityId;
  opp_owner_id: string | null;
  opp_owner_name: string | null;
  opp_value_cents: string | null;
  opp_lost_reason: string | null;
  opp_closed_at: Date | null;
  opp_last_activity_at: Date;
  opp_created_at: Date;
  opp_updated_at: Date;
  opp_services: string[] | null;
  nf_id: string | null;
  nf_description: string | null;
  nf_due_date: string | null;
  nf_due_time: string | null;
  na_type: string | null;
  na_summary: string | null;
  na_occurred_at: Date | null;
}

const OPP_FROM = `
  JOIN crm_opportunities o ON o.business_id = b.id
  LEFT JOIN users ou ON ou.id = o.owner_id
  LEFT JOIN LATERAL (SELECT f.id, f.description, f.due_date, f.due_time FROM crm_followups f
     WHERE f.opportunity_id = o.id AND f.status = 'pending' ORDER BY f.due_date, f.due_time NULLS LAST LIMIT 1) nf ON true
  LEFT JOIN LATERAL (SELECT a.type, a.summary, a.occurred_at FROM crm_activities a
     WHERE a.opportunity_id = o.id ORDER BY a.occurred_at DESC, a.created_at DESC LIMIT 1) na ON true`;

export const OPP_COLUMNS = `, o.id AS opp_id, o.stage AS opp_stage, o.priority AS opp_priority, o.owner_id AS opp_owner_id,
  ou.display_name AS opp_owner_name, o.estimated_value_cents AS opp_value_cents, o.lost_reason AS opp_lost_reason,
  o.closed_at AS opp_closed_at, o.last_activity_at AS opp_last_activity_at, o.created_at AS opp_created_at,
  o.updated_at AS opp_updated_at,
  (SELECT array_agg(s.service_id ORDER BY s.service_id) FROM crm_opportunity_services s WHERE s.opportunity_id = o.id) AS opp_services,
  nf.id AS nf_id, nf.description AS nf_description, nf.due_date::text AS nf_due_date, nf.due_time::text AS nf_due_time,
  na.type AS na_type, na.summary AS na_summary, na.occurred_at AS na_occurred_at`;

function card(row: BusinessRow & OppColumns, today: string, serviceNames: Map<string, string>, recommended?: unknown) {
  const due = dateOnly(row.nf_due_date);
  return {
    id: row.opp_id,
    stage: row.opp_stage,
    stageLabel: stageLabel(row.opp_stage),
    open: !isClosed(row.opp_stage),
    priority: row.opp_priority,
    owner: row.opp_owner_id ? { id: row.opp_owner_id, name: row.opp_owner_name } : null,
    estimatedValue: toEuro(row.opp_value_cents),
    services: (row.opp_services ?? []).map((id) => ({ id, name: serviceNames.get(id) ?? id })),
    lostReason: row.opp_lost_reason,
    closedAt: iso(row.opp_closed_at),
    lastActivityAt: iso(row.opp_last_activity_at),
    createdAt: iso(row.opp_created_at),
    updatedAt: iso(row.opp_updated_at),
    nextFollowUp: row.nf_id
      ? {
          id: row.nf_id,
          description: row.nf_description!,
          dueDate: due!,
          dueTime: timeOnly(row.nf_due_time),
          overdue: due! < today,
          dueToday: due === today,
        }
      : null,
    lastActivity: row.na_type
      ? {
          type: row.na_type,
          typeLabel: activityLabel(row.na_type),
          summary: row.na_summary!,
          occurredAt: iso(row.na_occurred_at),
        }
      : null,
    business: { ...summary(row), mergedInto: row.merged_into },
    recommended: recommended ?? null,
  };
}

export const CRM_SORTS = {
  activity: 'o.last_activity_at',
  created: 'o.created_at',
  due: 'nf.due_date',
  // punteggio commerciale: valutazione AI, altrimenti punteggio a regole (stesso valore mostrato ovunque)
  score: `(${COMMERCIAL_SCORE})`,
  value: 'o.estimated_value_cents',
  name: 'b.search_name',
  stage: `array_position(ARRAY[${STAGES.map((s) => `'${s.id}'`).join(',')}]::text[], o.stage)`,
} as const;
export type CrmSort = keyof typeof CRM_SORTS;

export interface CrmFilters {
  business: Omit<BusinessFilters, 'sort' | 'dir' | 'page' | 'pageSize'>;
  stages?: StageId[];
  priorities?: PriorityId[];
  /** id di un utente, oppure 'none' (senza responsabile). */
  owner?: string;
  /** Follow-up in attesa: scaduti, in scadenza oggi, futuri, nessuno. */
  followUp?: 'overdue' | 'today' | 'upcoming' | 'none';
  /** Aperte (predefinito), chiuse o tutte. */
  state?: 'open' | 'closed' | 'all';
  sort: CrmSort;
  dir: 'asc' | 'desc';
  page: number;
  pageSize: number;
}

export function crmQuery(f: CrmFilters, today: string) {
  // filtri sull'azienda: gli stessi dell'elenco del database (Fase 2–6); le aziende escluse restano visibili
  const base = listQuery({
    excluded: 'include',
    ...f.business,
    includeMerged: true,
    sort: 'name',
    dir: 'asc',
    page: 1,
    pageSize: 1,
  });
  const params = [...base.params];
  const where = [base.whereSql];
  const add = (sql: (p: string) => string, value: unknown) => {
    params.push(value);
    where.push(sql(`$${params.length}`));
  };
  if (f.stages?.length) add((p) => `o.stage = ANY(${p})`, f.stages);
  if (f.priorities?.length) add((p) => `o.priority = ANY(${p})`, f.priorities);
  if (f.owner === 'none') where.push('o.owner_id IS NULL');
  else if (f.owner) add((p) => `o.owner_id = ${p}`, f.owner);
  if ((f.state ?? 'open') === 'open') where.push(`o.stage NOT IN ${CLOSED_SQL}`);
  if (f.state === 'closed') where.push(`o.stage IN ${CLOSED_SQL}`);
  if (f.followUp === 'none') where.push('nf.id IS NULL');
  if (f.followUp === 'overdue') add((p) => `nf.due_date < ${p}::date`, today);
  if (f.followUp === 'today') add((p) => `nf.due_date = ${p}::date`, today);
  if (f.followUp === 'upcoming') add((p) => `nf.due_date > ${p}::date`, today);
  const dir = f.dir === 'desc' ? 'DESC' : 'ASC';
  return {
    from: `${base.from}${OPP_FROM}`,
    whereSql: where.join(' AND '),
    params,
    order: `${CRM_SORTS[f.sort]} ${dir} NULLS LAST, o.created_at DESC, o.id`,
  };
}

export async function serviceNameMap(db: Queryable) {
  return new Map((await activeCatalog(db)).catalog.services.map((s) => [s.id, s.name]));
}

async function recommendedFor(db: Queryable, businessIds: string[]) {
  const primary = await primaryServices(db, businessIds);
  return (id: string) => primary.get(id)?.shortlist ?? [];
}

export async function listOpportunities(db: Queryable, f: CrmFilters) {
  const today = todayInRome();
  const q = crmQuery(f, today);
  const { rows: total } = await db.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM ${q.from} WHERE ${q.whereSql}`,
    q.params,
  );
  const { rows } = await db.query<BusinessRow & OppColumns>(
    `SELECT b.*${AUDIT_COLUMNS}${OPP_COLUMNS} FROM ${q.from} WHERE ${q.whereSql} ORDER BY ${q.order}
      LIMIT $${q.params.length + 1} OFFSET $${q.params.length + 2}`,
    [...q.params, f.pageSize, (f.page - 1) * f.pageSize],
  );
  const names = await serviceNameMap(db);
  const rec = await recommendedFor(
    db,
    rows.map((r) => r.id),
  );
  return {
    items: rows.map((r) => card(r, today, names, rec(r.id))),
    total: total[0]!.n,
    page: f.page,
    pageSize: f.pageSize,
    today,
  };
}

/**
 * Kanban: per ogni fase il totale e le prime `perStage` opportunità (follow-up scaduti per primi, poi scadenze
 * vicine, poi punteggio). Non carica tutte le aziende né la cronologia degli audit.
 */
export async function board(
  db: Queryable,
  f: Omit<CrmFilters, 'sort' | 'dir' | 'page' | 'pageSize'>,
  perStage: number,
) {
  const today = todayInRome();
  const q = crmQuery({ ...f, state: 'all', sort: 'activity', dir: 'desc', page: 1, pageSize: 1 }, today);
  q.params.push(today, perStage);
  const t = q.params.length - 1;
  const { rows } = await db.query<BusinessRow & OppColumns & { stage_total: number }>(
    `SELECT * FROM (
       SELECT b.*${AUDIT_COLUMNS}${OPP_COLUMNS},
              row_number() OVER (PARTITION BY o.stage ORDER BY (nf.due_date < $${t}::date) DESC NULLS LAST,
                                 nf.due_date NULLS LAST, (${COMMERCIAL_SCORE}) DESC NULLS LAST, o.last_activity_at DESC, o.id) AS rn,
              count(*) OVER (PARTITION BY o.stage)::int AS stage_total
         FROM ${q.from} WHERE ${q.whereSql}) x
      WHERE x.rn <= $${t + 1} ORDER BY x.rn`,
    q.params,
  );
  const names = await serviceNameMap(db);
  const rec = await recommendedFor(
    db,
    rows.map((r) => r.id),
  );
  return {
    today,
    perStage,
    stages: STAGES.map((s) => {
      const items = rows.filter((r) => r.opp_stage === s.id);
      return {
        ...s,
        total: items[0]?.stage_total ?? 0,
        items: items.map((r) => card(r, today, names, rec(r.id))),
      };
    }),
  };
}

export async function getOpportunity(db: Queryable, id: string) {
  const today = todayInRome();
  const { rows } = await db.query<BusinessRow & OppColumns & { opp_notes: string | null; opp_business_id: string }>(
    `SELECT b.*${AUDIT_COLUMNS}${OPP_COLUMNS}, o.notes AS opp_notes FROM businesses b
       LEFT JOIN business_websites bw ON bw.business_id = b.id
       LEFT JOIN websites w ON w.id = bw.website_id
       LEFT JOIN website_audits la ON la.id = w.last_audit_id
       LEFT JOIN lead_scores ls ON ls.business_id = b.id AND ls.is_current
       LEFT JOIN ai_assessments aa ON aa.business_id = b.id AND aa.is_current
       LEFT JOIN ai_business_states ast ON ast.business_id = b.id
       ${OPP_FROM}
      WHERE o.id = $1`,
    [id],
  );
  const row = rows[0];
  if (!row) throw notFound();
  const names = await serviceNameMap(db);
  const rec = await recommendedFor(db, [row.id]);
  const [activities, followUps, others] = await Promise.all([
    listActivities(db, id),
    listFollowUpsOf(db, id, today),
    db.query<{ id: string; stage: string; created_at: Date; closed_at: Date | null }>(
      'SELECT id, stage, created_at, closed_at FROM crm_opportunities WHERE business_id = $1 AND id <> $2 ORDER BY created_at DESC',
      [row.id, id],
    ),
  ]);
  return {
    opportunity: { ...card(row, today, names, rec(row.id)), notes: row.opp_notes },
    activities,
    followUps,
    // altre opportunità della stessa azienda (storico)
    otherOpportunities: others.rows.map((o) => ({
      id: o.id,
      stage: o.stage,
      stageLabel: stageLabel(o.stage),
      createdAt: iso(o.created_at),
      closedAt: iso(o.closed_at),
    })),
    today,
  };
}

async function listActivities(db: Queryable, opportunityId: string) {
  const { rows } = await db.query<{
    id: string;
    type: string;
    occurred_at: Date;
    summary: string;
    notes: string | null;
    from_stage: string | null;
    to_stage: string | null;
    user_id: string | null;
    user_name: string | null;
    created_at: Date;
    updated_at: Date;
    edited_by_name: string | null;
  }>(
    `SELECT a.*, u.display_name AS user_name, e.display_name AS edited_by_name FROM crm_activities a
       LEFT JOIN users u ON u.id = a.user_id LEFT JOIN users e ON e.id = a.edited_by
      WHERE a.opportunity_id = $1 ORDER BY a.occurred_at DESC, a.created_at DESC LIMIT 500`,
    [opportunityId],
  );
  return rows.map((a) => ({
    id: a.id,
    type: a.type,
    typeLabel: activityLabel(a.type),
    occurredAt: iso(a.occurred_at),
    summary: a.summary,
    notes: a.notes,
    fromStage: a.from_stage,
    toStage: a.to_stage,
    user: a.user_id ? { id: a.user_id, name: a.user_name } : null,
    createdAt: iso(a.created_at),
    edited: a.edited_by_name ? { by: a.edited_by_name, at: iso(a.updated_at) } : null,
  }));
}

interface FollowUpRow {
  id: string;
  opportunity_id: string;
  description: string;
  due_date: string;
  due_time: string | null;
  notes: string | null;
  priority: PriorityId;
  status: 'pending' | 'completed' | 'cancelled';
  cancel_reason: 'manual' | 'opportunity_closed' | null;
  completed_at: Date | null;
  completed_by_name: string | null;
  cancelled_at: Date | null;
  created_by_name: string | null;
  created_at: Date;
}

function followUpOut(f: FollowUpRow, today: string) {
  const due = dateOnly(f.due_date)!;
  return {
    id: f.id,
    opportunityId: f.opportunity_id,
    description: f.description,
    dueDate: due,
    dueTime: timeOnly(f.due_time),
    notes: f.notes,
    priority: f.priority,
    status: f.status,
    cancelReason: f.cancel_reason,
    overdue: f.status === 'pending' && due < today,
    dueToday: f.status === 'pending' && due === today,
    completedAt: iso(f.completed_at),
    completedBy: f.completed_by_name,
    cancelledAt: iso(f.cancelled_at),
    createdBy: f.created_by_name,
    createdAt: iso(f.created_at),
  };
}

const FOLLOWUP_COLUMNS = `f.id, f.opportunity_id, f.description, f.due_date::text AS due_date, f.due_time::text AS due_time,
  f.notes, f.priority, f.status, f.cancel_reason, f.completed_at, f.cancelled_at, f.created_at,
  cu.display_name AS completed_by_name, cr.display_name AS created_by_name`;
const FOLLOWUP_USERS = 'LEFT JOIN users cu ON cu.id = f.completed_by LEFT JOIN users cr ON cr.id = f.created_by';
const FOLLOWUP_SELECT = `SELECT ${FOLLOWUP_COLUMNS} FROM crm_followups f ${FOLLOWUP_USERS}`;

async function listFollowUpsOf(db: Queryable, opportunityId: string, today: string) {
  const { rows } = await db.query<FollowUpRow>(
    `${FOLLOWUP_SELECT} WHERE f.opportunity_id = $1
      ORDER BY (f.status = 'pending') DESC, f.due_date, f.due_time NULLS LAST, f.created_at DESC LIMIT 200`,
    [opportunityId],
  );
  return rows.map((f) => followUpOut(f, today));
}

/** Giorni considerati "in scadenza" (oggi compreso) per filtri, promemoria e report. */
export const DUE_SOON_DAYS = 7;

export interface FollowUpFilters {
  /** Stato: in attesa (predefinito), completati, annullati, tutti. */
  status?: 'pending' | 'completed' | 'cancelled' | 'all';
  /** Scadenza (solo in attesa): scaduti, oggi, prossimi 7 giorni (oggi compreso), oltre i 7 giorni, da domani in poi. */
  due?: 'overdue' | 'today' | 'soon' | 'later' | 'upcoming';
  priorities?: PriorityId[];
  stages?: StageId[];
  owner?: string;
  businessId?: string;
}

/** Filtri dei follow-up in SQL: stessi risultati per l'elenco e per l'esportazione. */
export function followUpQuery(f: FollowUpFilters, today: string) {
  const where: string[] = [];
  const params: unknown[] = [];
  const add = (sql: (p: string) => string, value: unknown) => {
    params.push(value);
    where.push(sql(`$${params.length}`));
  };
  const status = f.status ?? 'pending';
  if (status !== 'all') add((p) => `f.status = ${p}`, status);
  if (f.due) {
    where.push("f.status = 'pending'");
    if (f.due === 'overdue') add((p) => `f.due_date < ${p}::date`, today);
    if (f.due === 'today') add((p) => `f.due_date = ${p}::date`, today);
    if (f.due === 'soon') {
      add((p) => `f.due_date >= ${p}::date`, today);
      add((p) => `f.due_date < ${p}::date + ${DUE_SOON_DAYS}`, today);
    }
    if (f.due === 'later') add((p) => `f.due_date >= ${p}::date + ${DUE_SOON_DAYS}`, today);
    if (f.due === 'upcoming') add((p) => `f.due_date > ${p}::date`, today);
  }
  if (f.priorities?.length) add((p) => `f.priority = ANY(${p})`, f.priorities);
  if (f.stages?.length) add((p) => `o.stage = ANY(${p})`, f.stages);
  if (f.owner) add((p) => `o.owner_id = ${p}`, f.owner);
  if (f.businessId) add((p) => `o.business_id = ${p}`, f.businessId);
  const order =
    status === 'completed'
      ? 'f.completed_at DESC, f.id'
      : status === 'cancelled'
        ? 'f.cancelled_at DESC, f.id'
        : 'f.due_date, f.due_time NULLS LAST, f.created_at, f.id';
  return {
    from: `crm_followups f JOIN crm_opportunities o ON o.id = f.opportunity_id JOIN businesses b ON b.id = o.business_id
    ${FOLLOWUP_USERS} LEFT JOIN users ow ON ow.id = o.owner_id`,
    whereSql: where.length ? where.join(' AND ') : 'true',
    params,
    order,
  };
}

export type FollowUpListRow = FollowUpRow & {
  o_stage: string;
  o_owner_name: string | null;
  b_id: string;
  b_name: string;
  b_municipality: string | null;
  b_region: string | null;
};

export const FOLLOWUP_LIST_COLUMNS = `${FOLLOWUP_COLUMNS}, o.stage AS o_stage, ow.display_name AS o_owner_name,
  b.id AS b_id, b.name AS b_name, b.municipality_name AS b_municipality, b.region_code AS b_region`;

export const followUpListOut = (f: FollowUpListRow, today: string) => ({
  ...followUpOut(f, today),
  opportunity: { id: f.opportunity_id, stage: f.o_stage, stageLabel: stageLabel(f.o_stage), owner: f.o_owner_name },
  business: { id: f.b_id, name: f.b_name, municipality: f.b_municipality },
});

/** Follow-up con opportunità e azienda, filtrati e paginati. */
export async function listFollowUps(db: Queryable, f: FollowUpFilters, page: { page: number; pageSize: number }) {
  const today = todayInRome();
  const q = followUpQuery(f, today);
  const { rows: total } = await db.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM ${q.from} WHERE ${q.whereSql}`,
    q.params,
  );
  const { rows } = await db.query<FollowUpListRow>(
    `SELECT ${FOLLOWUP_LIST_COLUMNS} FROM ${q.from} WHERE ${q.whereSql}
      ORDER BY ${q.order} LIMIT $${q.params.length + 1} OFFSET $${q.params.length + 2}`,
    [...q.params, page.pageSize, (page.page - 1) * page.pageSize],
  );
  return {
    items: rows.map((r) => followUpListOut(r, today)),
    total: total[0]!.n,
    page: page.page,
    pageSize: page.pageSize,
    today,
  };
}

// ---------------------------------------------------------------- modifiche

async function lockOpportunity(tx: Queryable, id: string) {
  const { rows } = await tx.query<{
    id: string;
    business_id: string;
    stage: StageId;
    priority: PriorityId;
    owner_id: string | null;
    estimated_value_cents: string | null;
    notes: string | null;
  }>('SELECT * FROM crm_opportunities WHERE id = $1 FOR UPDATE', [id]);
  if (!rows[0]) throw notFound();
  return rows[0];
}

export interface OpportunityPatch {
  priority?: PriorityId;
  ownerId?: string | null;
  estimatedValue?: number | null;
  services?: string[];
  notes?: string | null;
}

/** Campi commerciali. Nessun effetto su fase, attività, azienda, audit o punteggio. */
export async function updateOpportunity(db: Db, id: string, patch: OpportunityPatch, userId: string) {
  const services = patch.services ? await validServices(db, patch.services) : undefined;
  if (patch.ownerId !== undefined) await validOwner(db, patch.ownerId);
  await db.transaction(async (tx) => {
    const current = await lockOpportunity(tx, id);
    const sets: string[] = [];
    const params: unknown[] = [id];
    const set = (col: string, value: unknown) => {
      params.push(value);
      sets.push(`${col} = $${params.length}`);
    };
    const changed: string[] = [];
    if (patch.priority !== undefined && patch.priority !== current.priority) {
      set('priority', patch.priority);
      changed.push('priority');
    }
    if (patch.ownerId !== undefined && patch.ownerId !== current.owner_id) {
      set('owner_id', patch.ownerId);
      changed.push('owner');
    }
    if (patch.estimatedValue !== undefined) {
      const cents = patch.estimatedValue === null ? null : toCents(patch.estimatedValue);
      if (String(cents) !== String(current.estimated_value_cents)) {
        set('estimated_value_cents', cents);
        changed.push('estimatedValue');
      }
    }
    if (patch.notes !== undefined && (patch.notes || null) !== current.notes) {
      set('notes', patch.notes || null);
      changed.push('notes');
    }
    if (services) {
      await tx.query('DELETE FROM crm_opportunity_services WHERE opportunity_id = $1 AND NOT (service_id = ANY($2))', [
        id,
        services,
      ]);
      for (const s of services)
        await tx.query(
          'INSERT INTO crm_opportunity_services (opportunity_id, service_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
          [id, s],
        );
      changed.push('services');
    }
    if (sets.length)
      await tx.query(`UPDATE crm_opportunities SET ${sets.join(', ')}, updated_at = now() WHERE id = $1`, params);
    if (changed.length)
      await audit(tx, {
        userId,
        action: 'crm.opportunity_updated',
        entityType: 'crm_opportunity',
        entityId: id,
        details: { changed },
      });
  });
}

/**
 * Cambio di fase esplicito, sempre registrato nella cronologia. Vedi le regole in model.ts.
 * Chiudere annulla i follow-up in attesa; "non contattare" esclude l'azienda dalla prospezione.
 */
export async function changeStage(
  db: Db,
  id: string,
  input: { stage: StageId; lostReason?: string; note?: string },
  userId: string,
) {
  return db.transaction(async (tx) => {
    const current = await lockOpportunity(tx, id);
    if (current.stage === input.stage) throw new JobError(409, 'SAME_STAGE', 'L’opportunità è già in questa fase.');
    const toClosed = isClosed(input.stage);
    const fromClosed = isClosed(current.stage);
    if (input.stage === 'perso' && !input.lostReason?.trim())
      throw new JobError(400, 'LOST_REASON_REQUIRED', 'Indica il motivo per cui l’opportunità è persa.', undefined, {
        field: 'lostReason',
      });
    if (fromClosed && !toClosed) {
      // riapertura
      const { rows: b } = await tx.query<{ excluded_at: Date | null; merged_into: string | null }>(
        'SELECT excluded_at, merged_into FROM businesses WHERE id = $1 FOR UPDATE',
        [current.business_id],
      );
      if (b[0]?.merged_into)
        throw new JobError(
          409,
          'BUSINESS_MERGED',
          'L’azienda è stata unita a un’altra: riapri l’opportunità sulla scheda mantenuta.',
        );
      if (b[0]?.excluded_at)
        throw new JobError(
          409,
          'BUSINESS_EXCLUDED',
          'L’azienda è esclusa dalla prospezione: reincludila dalla scheda dell’azienda prima di riaprire l’opportunità.',
        );
      const { rows: open } = await tx.query<{ id: string }>(
        `SELECT id FROM crm_opportunities WHERE business_id = $1 AND id <> $2 AND stage NOT IN ${CLOSED_SQL}`,
        [current.business_id, id],
      );
      if (open[0])
        throw new JobError(409, 'OPPORTUNITY_EXISTS', 'L’azienda ha già un’altra opportunità aperta.', undefined, {
          opportunityId: open[0].id,
        });
    }
    let cancelled = 0;
    if (toClosed) {
      const { rows } = await tx.query(
        "UPDATE crm_followups SET status = 'cancelled', cancel_reason = 'opportunity_closed', cancelled_at = now(), updated_at = now() WHERE opportunity_id = $1 AND status = 'pending' RETURNING id",
        [id],
      );
      cancelled = rows.length;
    }
    await tx.query(
      `UPDATE crm_opportunities SET stage = $2, lost_reason = $3,
              closed_at = CASE WHEN $4::boolean THEN COALESCE(CASE WHEN $5::boolean THEN NULL ELSE closed_at END, now()) ELSE NULL END,
              updated_at = now() WHERE id = $1`,
      [id, input.stage, input.stage === 'perso' ? input.lostReason!.trim() : null, toClosed, !fromClosed],
    );
    if (input.stage === 'non_contattare')
      // «non contattare» nel CRM è un rifiuto di contatto: esclusione e divieto su ogni canale (il più prudente)
      await applyExclusion(
        tx,
        current.business_id,
        {
          excluded: true,
          code: 'rifiuto_commerciale',
          note: `CRM: non contattare${input.note ? ` — ${input.note}` : ''}`.slice(0, 300),
          scope: 'tutti',
        },
        userId,
      );
    const notes = [
      input.stage === 'perso' ? `Motivo: ${input.lostReason!.trim()}` : null,
      input.note?.trim() || null,
      cancelled ? `${cancelled} follow-up in attesa annullati con la chiusura.` : null,
      input.stage === 'non_contattare' ? 'Azienda esclusa dalla prospezione.' : null,
    ].filter(Boolean);
    await recordActivity(tx, {
      opportunityId: id,
      type: 'stage_change',
      summary: `${stageLabel(current.stage)} → ${stageLabel(input.stage)}`,
      notes: notes.length ? notes.join('\n') : null,
      fromStage: current.stage,
      toStage: input.stage,
      userId,
    });
    await audit(tx, {
      userId,
      action: 'crm.stage_changed',
      entityType: 'crm_opportunity',
      entityId: id,
      details: { from: current.stage, to: input.stage, followUpsCancelled: cancelled },
    });
    return { cancelledFollowUps: cancelled };
  });
}

export async function addActivity(
  db: Db,
  opportunityId: string,
  input: { type: ActivityType; occurredAt: Date; summary: string; notes?: string | null },
  userId: string,
) {
  return db.transaction(async (tx) => {
    await lockOpportunity(tx, opportunityId);
    return recordActivity(tx, { opportunityId, ...input, userId });
  });
}

/** Modifica di un'attività registrata a mano: solo da chi l'ha registrata o da un amministratore. */
export async function updateActivity(
  db: Db,
  id: string,
  patch: { type?: ActivityType; occurredAt?: Date; summary?: string; notes?: string | null },
  user: { id: string; role: string },
) {
  await db.transaction(async (tx) => {
    const { rows } = await tx.query<{ opportunity_id: string; type: string; user_id: string | null }>(
      'SELECT opportunity_id, type, user_id FROM crm_activities WHERE id = $1 FOR UPDATE',
      [id],
    );
    const a = rows[0];
    if (!a) throw new JobError(404, 'NOT_FOUND', 'Attività non trovata.');
    if (a.type === 'stage_change' || a.type === 'email_sent')
      throw new JobError(
        409,
        'NOT_EDITABLE',
        'Cambi di fase ed email inviate sono registrati dal sistema e non si modificano.',
      );
    if (a.user_id !== user.id && user.role !== 'admin')
      throw new JobError(403, 'FORBIDDEN', 'Puoi modificare solo le attività che hai registrato tu.');
    await tx.query(
      `UPDATE crm_activities SET type = COALESCE($2, type), occurred_at = COALESCE($3, occurred_at),
              summary = COALESCE($4, summary), notes = CASE WHEN $5::boolean THEN $6 ELSE notes END,
              edited_by = $7, updated_at = now() WHERE id = $1`,
      [
        id,
        patch.type ?? null,
        patch.occurredAt ?? null,
        patch.summary ?? null,
        patch.notes !== undefined,
        patch.notes || null,
        user.id,
      ],
    );
    if (patch.occurredAt)
      await tx.query('UPDATE crm_opportunities SET last_activity_at = GREATEST(last_activity_at, $2) WHERE id = $1', [
        a.opportunity_id,
        patch.occurredAt,
      ]);
  });
}

export async function addFollowUp(
  db: Db,
  opportunityId: string,
  input: {
    description: string;
    dueDate: string;
    dueTime?: string | null;
    notes?: string | null;
    priority?: PriorityId;
  },
  userId: string,
) {
  if (input.dueDate < todayInRome())
    throw new JobError(400, 'DATE_IN_PAST', 'La scadenza non può essere nel passato.', undefined, { field: 'dueDate' });
  return db.transaction(async (tx) => {
    const o = await lockOpportunity(tx, opportunityId);
    if (isClosed(o.stage))
      throw new JobError(409, 'OPPORTUNITY_CLOSED', 'L’opportunità è chiusa: riaprila per pianificare un follow-up.');
    const { rows } = await tx.query<{ id: string }>(
      `INSERT INTO crm_followups (opportunity_id, description, due_date, due_time, notes, priority, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
      [
        opportunityId,
        input.description,
        input.dueDate,
        input.dueTime || null,
        input.notes || null,
        input.priority ?? 'media',
        userId,
      ],
    );
    await tx.query('UPDATE crm_opportunities SET updated_at = now() WHERE id = $1', [opportunityId]);
    return rows[0]!.id;
  });
}

/**
 * Follow-up dalla scheda di un'azienda. Un follow-up appartiene sempre a un'opportunità (nessun doppio registro per
 * la stessa attività): si usa quella aperta; se non c'è, la si crea in «Da qualificare» solo su richiesta esplicita.
 */
export async function addFollowUpForBusiness(
  db: Db,
  businessId: string,
  input: {
    description: string;
    dueDate: string;
    dueTime?: string | null;
    notes?: string | null;
    priority?: PriorityId;
  },
  opts: { createOpportunity: boolean },
  userId: string,
): Promise<{ opportunityId: string; followUpId: string; createdOpportunity: boolean }> {
  const { rows: open } = await db.query<{ id: string }>(
    `SELECT id FROM crm_opportunities WHERE business_id = $1 AND stage NOT IN ${CLOSED_SQL}`,
    [businessId],
  );
  if (open[0])
    return {
      opportunityId: open[0].id,
      followUpId: await addFollowUp(db, open[0].id, input, userId),
      createdOpportunity: false,
    };
  if (!opts.createOpportunity)
    throw new JobError(
      409,
      'NO_OPEN_OPPORTUNITY',
      'L’azienda non ha un’opportunità aperta nel CRM: conferma di aggiungerla per pianificare il follow-up.',
    );
  if (input.dueDate < todayInRome())
    throw new JobError(400, 'DATE_IN_PAST', 'La scadenza non può essere nel passato.', undefined, { field: 'dueDate' });
  const opportunityId = await createOpportunity(db, { businessId, stage: 'da_qualificare', priority: 'media' }, userId);
  return { opportunityId, followUpId: await addFollowUp(db, opportunityId, input, userId), createdOpportunity: true };
}

async function lockFollowUp(tx: Queryable, id: string) {
  const { rows } = await tx.query<{
    id: string;
    opportunity_id: string;
    status: string;
    description: string;
    due_date: string;
  }>(
    'SELECT id, opportunity_id, status, description, due_date::text AS due_date FROM crm_followups WHERE id = $1 FOR UPDATE',
    [id],
  );
  if (!rows[0]) throw new JobError(404, 'NOT_FOUND', 'Follow-up non trovato.');
  return rows[0];
}

export async function updateFollowUp(
  db: Db,
  id: string,
  patch: {
    description?: string;
    dueDate?: string;
    dueTime?: string | null;
    notes?: string | null;
    priority?: PriorityId;
  },
) {
  await db.transaction(async (tx) => {
    const f = await lockFollowUp(tx, id);
    if (f.status !== 'pending') throw new JobError(409, 'NOT_PENDING', 'Si modificano solo i follow-up in attesa.');
    // una data già scaduta può restare com'è; una nuova data non può essere nel passato
    if (patch.dueDate && patch.dueDate !== dateOnly(f.due_date) && patch.dueDate < todayInRome())
      throw new JobError(400, 'DATE_IN_PAST', 'La scadenza non può essere nel passato.', undefined, {
        field: 'dueDate',
      });
    await tx.query(
      `UPDATE crm_followups SET description = COALESCE($2, description), due_date = COALESCE($3::date, due_date),
              due_time = CASE WHEN $4::boolean THEN $5::time ELSE due_time END,
              notes = CASE WHEN $6::boolean THEN $7 ELSE notes END, priority = COALESCE($8, priority), updated_at = now() WHERE id = $1`,
      [
        id,
        patch.description ?? null,
        patch.dueDate ?? null,
        patch.dueTime !== undefined,
        patch.dueTime || null,
        patch.notes !== undefined,
        patch.notes || null,
        patch.priority ?? null,
      ],
    );
  });
}

/**
 * Completa un follow-up: data di completamento e un'attività "Follow-up" nella cronologia.
 * Non cambia la fase dell'opportunità.
 */
export async function completeFollowUp(db: Db, id: string, note: string | null, userId: string) {
  await db.transaction(async (tx) => {
    const f = await lockFollowUp(tx, id);
    if (f.status !== 'pending') throw new JobError(409, 'NOT_PENDING', 'Il follow-up non è più in attesa.');
    await tx.query(
      "UPDATE crm_followups SET status = 'completed', completed_at = now(), completed_by = $2, updated_at = now() WHERE id = $1",
      [id, userId],
    );
    await recordActivity(tx, {
      opportunityId: f.opportunity_id,
      type: 'follow_up',
      summary: `Follow-up completato: ${f.description}`.slice(0, 300),
      notes: note,
      userId,
    });
  });
}

export async function cancelFollowUp(db: Db, id: string) {
  await db.transaction(async (tx) => {
    const f = await lockFollowUp(tx, id);
    if (f.status !== 'pending') throw new JobError(409, 'NOT_PENDING', 'Il follow-up non è più in attesa.');
    await tx.query(
      "UPDATE crm_followups SET status = 'cancelled', cancel_reason = 'manual', cancelled_at = now(), updated_at = now() WHERE id = $1",
      [id],
    );
  });
}

// ---------------------------------------------------------------- dashboard

/**
 * Numeri della dashboard del CRM, tutti contati sulle righe del database (definizioni in docs/crm.md).
 * I valori in euro sono la somma dei valori stimati inseriti a mano: null se nessuna opportunità ne ha uno.
 */
export async function dashboard(db: Queryable) {
  const today = todayInRome();
  const { rows } = await db.query<Record<string, string | number | null>>(
    `SELECT count(*) FILTER (WHERE stage NOT IN ${CLOSED_SQL})::int AS active,
            count(*) FILTER (WHERE stage = 'da_qualificare')::int AS to_qualify,
            count(*) FILTER (WHERE stage = 'da_contattare')::int AS ready,
            count(*) FILTER (WHERE stage = 'appuntamento')::int AS meetings,
            count(*) FILTER (WHERE stage = 'preventivo')::int AS quotes,
            count(*) FILTER (WHERE stage = 'vinto')::int AS won,
            count(*) FILTER (WHERE stage = 'perso')::int AS lost,
            count(*) FILTER (WHERE stage = 'non_contattare')::int AS do_not_contact,
            sum(estimated_value_cents) FILTER (WHERE stage NOT IN ${CLOSED_SQL}) AS active_value,
            count(estimated_value_cents) FILTER (WHERE stage NOT IN ${CLOSED_SQL})::int AS active_valued,
            sum(estimated_value_cents) FILTER (WHERE stage = 'vinto') AS won_value,
            count(estimated_value_cents) FILTER (WHERE stage = 'vinto')::int AS won_valued,
            count(*)::int AS total
       FROM crm_opportunities`,
  );
  const { rows: f } = await db.query<{ today: number; overdue: number; upcoming: number }>(
    `SELECT count(*) FILTER (WHERE f.due_date = $1::date)::int AS today,
            count(*) FILTER (WHERE f.due_date < $1::date)::int AS overdue,
            count(*) FILTER (WHERE f.due_date > $1::date)::int AS upcoming
       FROM crm_followups f JOIN crm_opportunities o ON o.id = f.opportunity_id
      WHERE f.status = 'pending' AND o.stage NOT IN ${CLOSED_SQL}`,
    [today],
  );
  const { rows: byStage } = await db.query<{ stage: string; n: number }>(
    'SELECT stage, count(*)::int AS n FROM crm_opportunities GROUP BY stage',
  );
  const r = rows[0]!;
  const counts = new Map(byStage.map((x) => [x.stage, x.n]));
  return {
    today,
    total: Number(r.total),
    active: Number(r.active),
    toQualify: Number(r.to_qualify),
    readyToContact: Number(r.ready),
    meetings: Number(r.meetings),
    quotes: Number(r.quotes),
    won: Number(r.won),
    lost: Number(r.lost),
    doNotContact: Number(r.do_not_contact),
    followUps: f[0]!,
    activeValue: {
      euro: Number(r.active_valued) ? toEuro(r.active_value as string) : null,
      withValue: Number(r.active_valued),
    },
    wonValue: { euro: Number(r.won_valued) ? toEuro(r.won_value as string) : null, withValue: Number(r.won_valued) },
    byStage: STAGES.map((s) => ({ id: s.id, label: s.label, closed: s.closed, count: counts.get(s.id) ?? 0 })),
  };
}
