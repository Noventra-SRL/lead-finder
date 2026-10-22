import { activeAiConfig } from './ai/config.ts';
import { stageLabel, toEuro } from './crm/model.ts';
import { dashboard, listFollowUps } from './crm/store.ts';
import type { Queryable } from './db/client.ts';
import { CONTACT_STATUS_SQL, HAS_EMAIL_SQL } from './crm/contactStatus.ts';
import { COMMERCIAL_SCORE, FROM_BUSINESSES, listBusinesses } from './discovery/businesses.ts';
import { listSavedFilters } from './workflow/savedFilters.ts';

/*
 * Dati della home in una sola richiesta: aziende, fasce del punteggio commerciale, CRM, stato dell'AI, attività
 * recenti. Stesse definizioni usate nel resto dell'applicazione (punteggio commerciale = valutazione AI, altrimenti
 * punteggio a regole; opportunità aperte = tutte tranne vinto, perso, non contattare). Nessuna chiamata al modello.
 */

export async function homeOverview(db: Queryable, userId: string) {
  const config = await activeAiConfig(db);
  const bands = config.config.bands;
  // le aziende escluse dalla prospezione e quelle valutate come cessate o da non contattare non entrano nelle fasce
  const base = `FROM ${FROM_BUSINESSES} WHERE b.merged_into IS NULL AND b.excluded_at IS NULL`;
  const { rows: totals } = await db.query<{ businesses: number; excluded: number }>(
    `SELECT count(*) FILTER (WHERE excluded_at IS NULL)::int AS businesses, count(*) FILTER (WHERE excluded_at IS NOT NULL)::int AS excluded
       FROM businesses WHERE merged_into IS NULL`,
  );
  const { rows: scores } = await db.query<{ score: number | null; ai: boolean }>(
    `SELECT (${COMMERCIAL_SCORE}) AS score, (aa.id IS NOT NULL AND aa.exclusion IS NULL) AS ai ${base}`,
  );
  const scored = scores.filter((s) => s.score !== null);
  const byBand = bands.map((b, i) => {
    const max = i === 0 ? 100 : bands[i - 1]!.min - 1;
    const count = scored.filter((s) => s.score! >= b.min && s.score! <= max).length;
    return { id: b.id, label: b.label, min: b.min, max, count };
  });
  const top = bands[0]!;
  const { rows: notInCrm } = await db.query<{ n: number }>(
    `SELECT count(*)::int AS n ${base} AND (${COMMERCIAL_SCORE}) >= $1
       AND NOT EXISTS (SELECT 1 FROM crm_opportunities o WHERE o.business_id = b.id)`,
    [top.min],
  );
  // i primi prospect prioritari non ancora nel CRM (stesso criterio del conteggio)
  const { rows: topNotInCrm } = await db.query<{
    id: string;
    name: string;
    municipality_name: string | null;
    score: number;
  }>(
    `SELECT b.id, b.name, b.municipality_name, (${COMMERCIAL_SCORE}) AS score ${base} AND (${COMMERCIAL_SCORE}) >= $1
       AND NOT EXISTS (SELECT 1 FROM crm_opportunities o WHERE o.business_id = b.id)
     ORDER BY score DESC, b.name LIMIT 5`,
    [top.min],
  );
  const crm = await dashboard(db);
  const overdue = await listFollowUps(db, { status: 'pending', due: 'overdue' }, { page: 1, pageSize: 5 });
  const soon = await listFollowUps(db, { status: 'pending', due: 'soon' }, { page: 1, pageSize: 5 });
  const oppSelect = `SELECT o.id, o.stage, o.updated_at, o.closed_at, o.estimated_value_cents, b.id AS business_id, b.name
       FROM crm_opportunities o JOIN businesses b ON b.id = o.business_id`;
  type OppRow = {
    id: string;
    stage: string;
    updated_at: Date;
    closed_at: Date | null;
    estimated_value_cents: string | null;
    business_id: string;
    name: string;
  };
  const { rows: updated } = await db.query<OppRow>(`${oppSelect} ORDER BY o.updated_at DESC LIMIT 5`);
  const { rows: closed } = await db.query<OppRow>(
    `${oppSelect} WHERE o.stage IN ('vinto', 'perso') AND o.closed_at IS NOT NULL ORDER BY o.closed_at DESC LIMIT 5`,
  );
  const oppOut = (o: OppRow) => ({
    id: o.id,
    stage: o.stage,
    stageLabel: stageLabel(o.stage),
    business: { id: o.business_id, name: o.name },
    updatedAt: new Date(o.updated_at).toISOString(),
    closedAt: o.closed_at ? new Date(o.closed_at).toISOString() : null,
    estimatedValue: toEuro(o.estimated_value_cents),
  });
  const saved = (await listSavedFilters(db, userId)).slice(0, 8);

  // le quattro domande della dashboard, dagli stessi dati e dalle stesse definizioni degli elenchi
  const { rows: sales } = await db.query<{ found: number; ready: number; sent: number; waiting: number }>(
    `SELECT count(*) FILTER (WHERE b.excluded_at IS NULL)::int AS found,
            count(*) FILTER (WHERE (${CONTACT_STATUS_SQL}) = 'da_contattare' AND ${HAS_EMAIL_SQL})::int AS ready,
            (SELECT count(*)::int FROM commercial_emails WHERE status = 'sent') AS sent,
            count(*) FILTER (WHERE (${CONTACT_STATUS_SQL}) = 'in_attesa')::int AS waiting
       FROM businesses b WHERE b.merged_into IS NULL`,
  );
  const best = await listBusinesses(db, {
    contactStatus: ['da_contattare'],
    email: 'yes',
    excluded: 'hide',
    sort: 'commercial',
    dir: 'desc',
    page: 1,
    pageSize: 8,
  });
  const { rows: ai } = await db.query<{ assessed: number; review: number }>(
    `SELECT count(*) FILTER (WHERE is_current)::int AS assessed,
            count(*) FILTER (WHERE is_current AND needs_review AND NOT EXISTS (
              SELECT 1 FROM ai_assessment_reviews r WHERE r.assessment_id = ai_assessments.id AND r.verdict = 'confirmed'))::int AS review
       FROM ai_assessments`,
  );
  const { rows: hunt } = await db.query<{ id: string; target: number; area_name: string; linked: number }>(
    `SELECT r.id, r.target, r.area_name, (SELECT count(*)::int FROM hunt_run_businesses hb WHERE hb.run_id = r.id) AS linked
       FROM hunt_runs r WHERE r.status IN ('pending', 'running', 'paused') ORDER BY r.created_at DESC LIMIT 1`,
  );

  // attività recenti: solo eventi registrati davvero (CRM, valutazioni AI, ricerche con aziende nuove)
  const { rows: recent } = await db.query<{
    kind: 'crm' | 'ai' | 'discovery';
    at: Date;
    text: string | null;
    sub: string | null;
    name: string | null;
    ref_id: string;
    business_id: string | null;
  }>(
    `SELECT * FROM (
       (SELECT 'crm' AS kind, a.occurred_at AS at, a.summary AS text, a.type AS sub, b.name, o.id AS ref_id, b.id AS business_id
          FROM crm_activities a JOIN crm_opportunities o ON o.id = a.opportunity_id JOIN businesses b ON b.id = o.business_id
         ORDER BY a.occurred_at DESC LIMIT 8)
       UNION ALL
       (SELECT 'ai', x.created_at, x.final_score::text, x.band, b.name, x.id, b.id
          FROM ai_assessments x JOIN businesses b ON b.id = x.business_id WHERE x.status = 'succeeded'
         ORDER BY x.created_at DESC LIMIT 8)
       UNION ALL
       (SELECT 'discovery', j.finished_at, j.inserted::text, j.status, j.area_name, j.id, NULL
          FROM discovery_jobs j WHERE j.finished_at IS NOT NULL AND j.inserted > 0
         ORDER BY j.finished_at DESC LIMIT 8)
     ) x ORDER BY at DESC LIMIT 8`,
  );
  const bandLabel = new Map(bands.map((b) => [b.id, b.label]));

  return {
    businesses: totals[0]!.businesses,
    excluded: totals[0]!.excluded,
    commercial: {
      bands: byBand,
      scored: scored.length,
      unscored: scores.length - scored.length,
      fromAi: scored.filter((s) => s.ai).length,
      fromRules: scored.filter((s) => !s.ai).length,
      highPriority: byBand[0]!.count,
      highPriorityNotInCrm: notInCrm[0]!.n,
      topBand: { id: top.id, label: top.label, min: top.min },
    },
    crm: {
      active: crm.active,
      readyToContact: crm.readyToContact,
      followUpsToday: crm.followUps.today,
      followUpsOverdue: crm.followUps.overdue,
    },
    ai: { assessed: ai[0]!.assessed, needsReview: ai[0]!.review },
    sales: {
      found: sales[0]!.found,
      readyToContact: sales[0]!.ready,
      emailsSent: sales[0]!.sent,
      awaitingReply: sales[0]!.waiting,
      bestProspects: best.items,
    },
    workflow: {
      overdue: { items: overdue.items, total: overdue.total },
      dueSoon: { items: soon.items, total: soon.total },
      priorityNotInCrm: topNotInCrm.map((b) => ({
        id: b.id,
        name: b.name,
        municipality: b.municipality_name,
        score: b.score,
      })),
      recentlyUpdated: updated.map(oppOut),
      recentlyClosed: closed.map(oppOut),
      savedFilters: saved.map((f) => ({ id: f.id, scope: f.scope, name: f.name, query: f.query })),
    },
    activeHunt: hunt[0]
      ? { id: hunt[0].id, target: hunt[0].target, area: hunt[0].area_name, linked: hunt[0].linked }
      : null,
    recent: recent.map((r) => ({
      kind: r.kind,
      at: new Date(r.at).toISOString(),
      ...(r.kind === 'crm'
        ? { text: r.text!, business: r.name, link: `/pipeline/${r.ref_id}`, activity: r.sub }
        : r.kind === 'ai'
          ? {
              text: `Punteggio commerciale ${r.text} — ${bandLabel.get(r.sub ?? '') ?? r.sub}`,
              business: r.name,
              link: `/aziende/${r.business_id}`,
              activity: null,
            }
          : {
              text: `${r.text} nuove aziende trovate`,
              business: r.name,
              link: `/scoperta/ricerche/${r.ref_id}`,
              activity: null,
            }),
    })),
  };
}
