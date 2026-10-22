import type { Db, Queryable } from '../db/client.ts';
import { stageLabel, todayInRome } from '../crm/model.ts';
import { JobError } from '../discovery/jobs.ts';
import type { Logger } from '../logger.ts';

/*
 * Promemoria nell'applicazione (Fase 8) per i follow-up del CRM. Regole deterministiche, nessuna AI:
 *  - "in scadenza": follow-up in attesa con scadenza oggi o domani (ora italiana);
 *  - "scaduto": follow-up in attesa con scadenza prima di oggi;
 *  - destinatario: il responsabile dell'opportunità, altrimenti chi ha creato il follow-up (utenti attivi);
 *  - un promemoria per (utente, tipo, follow-up, scadenza): lo stesso evento non si ripete; spostare la scadenza crea
 *    un evento nuovo e chiude quello vecchio; riportarla a una data già avuta riapre quel promemoria (di nuovo da leggere);
 *  - un promemoria si chiude da solo quando il follow-up è completato, annullato o spostato, e "in scadenza" si
 *    chiude quando diventa "scaduto".
 * La sincronizzazione gira nel server ogni pochi minuti (ReminderWorker) e, al più una volta al minuto, quando un
 * utente apre i promemoria. Nessuna email, SMS o notifica fuori dall'applicazione: a browser chiuso non arriva nulla.
 */

const DUE_SOON = 1; // domani compreso

export async function syncReminders(db: Db): Promise<{ created: number; resolved: number }> {
  const today = todayInRome();
  return db.transaction(async (tx) => {
    // chiusi: follow-up non più in attesa, spostati a un'altra data, oppure "in scadenza" ormai scaduti
    const { rows: resolved } = await tx.query(
      `UPDATE notifications n SET resolved_at = now()
         FROM crm_followups f
        WHERE f.id = n.followup_id AND n.resolved_at IS NULL
          AND (f.status <> 'pending' OR f.due_date <> n.due_date
               OR (n.kind = 'followup_due_soon' AND f.due_date < $1::date))
        RETURNING n.id`,
      [today],
    );
    const recipient = `COALESCE(o.owner_id, f.created_by)`;
    const base = `FROM crm_followups f JOIN crm_opportunities o ON o.id = f.opportunity_id
      JOIN users u ON u.id = ${recipient} AND u.disabled_at IS NULL
     WHERE f.status = 'pending'`;
    const { rows: overdue } = await tx.query(
      `INSERT INTO notifications (user_id, kind, followup_id, opportunity_id, due_date)
       SELECT ${recipient}, 'followup_overdue', f.id, o.id, f.due_date ${base} AND f.due_date < $1::date
       ON CONFLICT (user_id, kind, followup_id, due_date) DO UPDATE SET resolved_at = NULL, read_at = NULL, created_at = now()
         WHERE notifications.resolved_at IS NOT NULL
       RETURNING id`,
      [today],
    );
    const { rows: soon } = await tx.query(
      `INSERT INTO notifications (user_id, kind, followup_id, opportunity_id, due_date)
       SELECT ${recipient}, 'followup_due_soon', f.id, o.id, f.due_date ${base}
          AND f.due_date >= $1::date AND f.due_date <= $1::date + ${DUE_SOON}
       ON CONFLICT (user_id, kind, followup_id, due_date) DO UPDATE SET resolved_at = NULL, read_at = NULL, created_at = now()
         WHERE notifications.resolved_at IS NOT NULL
       RETURNING id`,
      [today],
    );
    return { created: overdue.length + soon.length, resolved: resolved.length };
  });
}

/**
 * Sincronizzazione al più una volta al minuto per processo, quando qualcuno apre i promemoria; dopo una modifica del
 * CRM (follow-up creato, spostato, completato, fase cambiata) la lettura successiva sincronizza subito.
 */
let lastSync = 0;
export function markRemindersStale() {
  lastSync = 0;
}
export async function syncIfStale(db: Db, minIntervalMs = 60_000) {
  if (Date.now() - lastSync < minIntervalMs) return;
  lastSync = Date.now();
  await syncReminders(db);
}

export async function listNotifications(db: Queryable, userId: string, opts: { unreadOnly: boolean; limit: number }) {
  const today = todayInRome();
  const { rows } = await db.query<{
    id: string;
    kind: 'followup_due_soon' | 'followup_overdue';
    created_at: Date;
    read_at: Date | null;
    f_id: string;
    f_description: string;
    f_due_date: string;
    f_due_time: string | null;
    f_priority: string;
    o_id: string;
    o_stage: string;
    b_id: string;
    b_name: string;
  }>(
    `SELECT n.id, n.kind, n.created_at, n.read_at, f.id AS f_id, f.description AS f_description, f.due_date::text AS f_due_date,
            f.due_time::text AS f_due_time, f.priority AS f_priority, o.id AS o_id, o.stage AS o_stage, b.id AS b_id, b.name AS b_name
       FROM notifications n JOIN crm_followups f ON f.id = n.followup_id
       JOIN crm_opportunities o ON o.id = n.opportunity_id JOIN businesses b ON b.id = o.business_id
      WHERE n.user_id = $1 AND n.resolved_at IS NULL ${opts.unreadOnly ? 'AND n.read_at IS NULL' : ''}
      ORDER BY (n.kind = 'followup_overdue') DESC, f.due_date, n.created_at DESC LIMIT $2`,
    [userId, opts.limit],
  );
  const { rows: counts } = await db.query<{ unread: number; overdue: number }>(
    `SELECT count(*) FILTER (WHERE read_at IS NULL)::int AS unread,
            count(*) FILTER (WHERE read_at IS NULL AND kind = 'followup_overdue')::int AS overdue
       FROM notifications WHERE user_id = $1 AND resolved_at IS NULL`,
    [userId],
  );
  return {
    items: rows.map((n) => ({
      id: n.id,
      kind: n.kind,
      createdAt: new Date(n.created_at).toISOString(),
      read: n.read_at !== null,
      followUp: {
        id: n.f_id,
        description: n.f_description,
        dueDate: n.f_due_date,
        dueTime: n.f_due_time ? n.f_due_time.slice(0, 5) : null,
        priority: n.f_priority,
        overdue: n.f_due_date < today,
      },
      opportunity: { id: n.o_id, stage: n.o_stage, stageLabel: stageLabel(n.o_stage) },
      business: { id: n.b_id, name: n.b_name },
    })),
    unread: counts[0]!.unread,
    unreadOverdue: counts[0]!.overdue,
    today,
  };
}

export async function markRead(db: Queryable, userId: string, id: string | 'all') {
  if (id === 'all') {
    const { rows } = await db.query(
      'UPDATE notifications SET read_at = now() WHERE user_id = $1 AND read_at IS NULL AND resolved_at IS NULL RETURNING id',
      [userId],
    );
    return rows.length;
  }
  // solo i propri promemoria: un id di un altro utente risulta inesistente
  const { rows } = await db.query(
    'UPDATE notifications SET read_at = COALESCE(read_at, now()) WHERE id = $1 AND user_id = $2 RETURNING id',
    [id, userId],
  );
  if (!rows[0]) throw new JobError(404, 'NOT_FOUND', 'Promemoria non trovato.');
  return 1;
}

/** Esecutore periodico nel processo del server (REMINDERS_WORKER=on). */
export class ReminderWorker {
  private readonly db: Db;
  private readonly log: Logger;
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<void> | null = null;

  constructor(db: Db, log: Logger) {
    this.db = db;
    this.log = log.child({ component: 'reminders' });
  }

  start(intervalMs = 5 * 60_000) {
    this.tick();
    this.timer = setInterval(() => this.tick(), intervalMs);
    this.timer.unref();
  }

  tick() {
    if (this.running) return;
    this.running = syncReminders(this.db)
      .then((r) => {
        if (r.created || r.resolved) this.log.debug('promemoria aggiornati', r);
      })
      .catch((error) => this.log.warn('promemoria non aggiornati', { error }))
      .finally(() => {
        this.running = null;
      });
  }

  async stop() {
    if (this.timer) clearInterval(this.timer);
    await this.running;
  }
}
