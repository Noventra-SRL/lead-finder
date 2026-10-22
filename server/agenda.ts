import type { Queryable } from './db/client.ts';
import { categoryLabel } from './email/replies.ts';
import { sequenceStop } from './email/sequence.ts';

/*
 * Agenda della settimana (dashboard): eventi reali giorno per giorno, nel fuso di Roma.
 *  - sent: email commerciali accettate dal server di posta;
 *  - reply: risposte lette dalla casella (rimbalzi e risposte automatiche compresi, con il loro stato);
 *  - email_followup: follow-up delle sequenze ancora da inviare (quelli fermati sono esclusi);
 *  - crm_followup: follow-up del CRM in sospeso.
 * Solo letture; nessun dato dimostrativo.
 */

export type AgendaKind = 'sent' | 'reply' | 'email_followup' | 'crm_followup';
export interface AgendaEvent {
  kind: AgendaKind;
  date: string;
  title: string;
  business: string;
  link: string;
  /** Tono dello stato: positivo, follow-up, inviata, da controllare, bloccato. */
  tone: 'positive' | 'followup' | 'sent' | 'attention' | 'blocked';
}

const POSITIVE = ['interessato', 'domanda'];
const BLOCKED = ['disiscrizione', 'rimbalzo', 'non_interessato'];

/** Lunedì (YYYY-MM-DD) della settimana di `day`. */
export function mondayOf(day: string): string {
  const d = new Date(`${day}T12:00:00Z`);
  const dow = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - dow);
  return d.toISOString().slice(0, 10);
}

export async function weekAgenda(db: Queryable, monday: string) {
  const range = [monday];
  const { rows: today } = await db.query<{ d: string }>("SELECT (now() AT TIME ZONE 'Europe/Rome')::date::text AS d");
  const local = (col: string) => `(${col} AT TIME ZONE 'Europe/Rome')::date`;
  const inWeek = (expr: string) => `${expr} >= $1::date AND ${expr} < $1::date + 7`;

  const [sent, replies, followups, crm] = await Promise.all([
    db.query<{ id: string; d: string; b: string; subject: string; step: number }>(
      `SELECT e.id, ${local('e.sent_at')}::text AS d, b.name AS b, e.subject, e.sequence_step AS step
         FROM commercial_emails e JOIN businesses b ON b.id = e.business_id
        WHERE e.status = 'sent' AND ${inWeek(local('e.sent_at'))} ORDER BY e.sent_at LIMIT 300`,
      range,
    ),
    db.query<{ d: string; b: string; category: string; kind: string }>(
      `SELECT ${local('r.received_at')}::text AS d, b.name AS b, r.category, r.kind
         FROM commercial_email_replies r JOIN businesses b ON b.id = r.business_id
        WHERE ${inWeek(local('r.received_at'))} ORDER BY r.received_at LIMIT 300`,
      range,
    ),
    db.query<{ id: string; d: string; b: string; step: number; root: string }>(
      `SELECT e.id, ${local('e.due_at')}::text AS d, b.name AS b, e.sequence_step AS step, e.sequence_root_id AS root
         FROM commercial_emails e JOIN businesses b ON b.id = e.business_id
        WHERE e.sequence_root_id IS NOT NULL AND e.status IN ('draft', 'review', 'ready', 'failed')
          AND ${inWeek(local('e.due_at'))} ORDER BY e.due_at LIMIT 300`,
      range,
    ),
    db.query<{ d: string; b: string; description: string; opp: string }>(
      `SELECT f.due_date::text AS d, b.name AS b, f.description, o.id AS opp
         FROM crm_followups f JOIN crm_opportunities o ON o.id = f.opportunity_id
         JOIN businesses b ON b.id = o.business_id
        WHERE f.status = 'pending' AND ${inWeek('f.due_date')} ORDER BY f.due_date, f.due_time NULLS LAST LIMIT 300`,
      range,
    ),
  ]);

  const events: AgendaEvent[] = [
    ...sent.rows.map((r) => ({
      kind: 'sent' as const,
      date: r.d,
      title: r.step > 1 ? `Follow-up ${r.step} inviato` : 'Email inviata',
      business: r.b,
      link: `/email/${r.id}`,
      tone: 'sent' as const,
    })),
    ...replies.rows.map((r) => ({
      kind: 'reply' as const,
      date: r.d,
      title: r.kind === 'bounce' ? 'Rimbalzo' : `Risposta: ${categoryLabel(r.category).toLowerCase()}`,
      business: r.b,
      link: '/email?vista=risposte',
      tone: POSITIVE.includes(r.category)
        ? ('positive' as const)
        : BLOCKED.includes(r.category)
          ? ('blocked' as const)
          : ('attention' as const),
    })),
    ...(
      await Promise.all(
        followups.rows.map(async (r) =>
          (await sequenceStop(db, r.root))
            ? null
            : {
                kind: 'email_followup' as const,
                date: r.d,
                title: r.step === 2 ? 'Follow-up da inviare' : 'Ultimo follow-up',
                business: r.b,
                link: `/email/${r.id}`,
                tone: 'followup' as const,
              },
        ),
      )
    ).filter((e) => e !== null),
    ...crm.rows.map((r) => ({
      kind: 'crm_followup' as const,
      date: r.d,
      title: r.description,
      business: r.b,
      link: `/pipeline/${r.opp}`,
      tone: 'attention' as const,
    })),
  ];

  const days = Array.from({ length: 7 }, (_, i) => {
    const d = new Date(`${monday}T12:00:00Z`);
    d.setUTCDate(d.getUTCDate() + i);
    const date = d.toISOString().slice(0, 10);
    return { date, events: events.filter((e) => e.date === date) };
  });
  return { monday, today: today[0]!.d, days };
}
