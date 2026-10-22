import type { Queryable } from '../db/client.ts';
import { addRevision } from './store.ts';
import { FOLLOW_UP_DELAY_DAYS, followUpEmail } from './template.ts';

/*
 * Sequenze di follow-up (da Harvey, writer.py e sender.py): all'invio accettato del passo 1 o 2 si crea la bozza del
 * passo successivo con una data prevista. Nessun invio automatico: ogni passo si invia con la stessa conferma.
 *
 * La sequenza si ferma da sola (stato calcolato, mai salvato) quando l'azienda risponde o rimbalza, viene esclusa,
 * avanza nel CRM oltre «In attesa di risposta» o ha un contatto diretto registrato dopo il primo messaggio.
 */

/** Fasi del CRM in cui ha senso un follow-up: oltre, la trattativa è già partita (o chiusa). */
const WAITING_STAGES = ['da_qualificare', 'da_contattare', 'primo_contatto', 'in_attesa'];

/** Motivo per cui la sequenza è ferma, o null se il follow-up può partire. */
export async function sequenceStop(db: Queryable, rootId: string): Promise<string | null> {
  const { rows } = await db.query<{
    excluded: boolean;
    sent_at: Date | null;
    replied: string | null;
    bounced: boolean;
    stage: string | null;
    contact: Date | null;
  }>(
    `SELECT b.excluded_at IS NOT NULL AS excluded, r.sent_at,
            (SELECT x.kind FROM commercial_email_replies x WHERE x.business_id = r.business_id
               AND x.received_at >= r.sent_at AND x.kind IN ('reply', 'bounce') ORDER BY x.received_at DESC LIMIT 1) AS replied,
            EXISTS (SELECT 1 FROM commercial_emails s WHERE (s.id = r.id OR s.sequence_root_id = r.id)
                     AND s.bounced_at IS NOT NULL) AS bounced,
            (SELECT o.stage FROM crm_opportunities o WHERE o.business_id = r.business_id
               ORDER BY (o.stage NOT IN ('vinto', 'perso', 'non_contattare')) DESC, o.updated_at DESC LIMIT 1) AS stage,
            (SELECT max(a.occurred_at) FROM crm_activities a JOIN crm_opportunities o ON o.id = a.opportunity_id
               WHERE o.business_id = r.business_id AND a.type IN ('call', 'conversation', 'meeting')
                 AND a.occurred_at >= r.sent_at) AS contact
       FROM commercial_emails r JOIN businesses b ON b.id = r.business_id WHERE r.id = $1`,
    [rootId],
  );
  const s = rows[0];
  if (!s) return 'Messaggio iniziale non trovato.';
  if (!s.sent_at) return 'Il primo messaggio non è stato inviato.';
  if (s.excluded) return 'L’azienda è contrassegnata «non contattare».';
  if (s.replied === 'reply') return 'L’azienda ha risposto.';
  if (s.replied === 'bounce' || s.bounced) return 'Un messaggio della sequenza è tornato indietro (rimbalzo).';
  if (s.stage && !WAITING_STAGES.includes(s.stage)) return 'La trattativa nel CRM è già avanzata o chiusa.';
  if (s.contact) return 'Dopo il primo messaggio è stato registrato un contatto diretto nel CRM.';
  return null;
}

/** Bozza del passo successivo, dopo l'invio accettato di `emailId` (nella stessa transazione dell'esito). */
export async function createNextStep(tx: Queryable, emailId: string, userId: string): Promise<string | null> {
  const { rows } = await tx.query<{ step: number; root_id: string; root_subject: string; sent_at: Date }>(
    `SELECT e.sequence_step AS step, COALESCE(e.sequence_root_id, e.id) AS root_id, r.subject AS root_subject, e.sent_at
       FROM commercial_emails e JOIN commercial_emails r ON r.id = COALESCE(e.sequence_root_id, e.id)
      WHERE e.id = $1`,
    [emailId],
  );
  const e = rows[0];
  if (!e || e.step >= 3) return null;
  const step = (e.step + 1) as 2 | 3;
  const content = followUpEmail(step, e.root_subject);
  const { rows: created } = await tx.query<{ id: string }>(
    `INSERT INTO commercial_emails (business_id, opportunity_id, recipient, recipient_source, subject, body, template_id,
       mode, objective, tone, status, created_by, updated_by, sequence_root_id, sequence_step, due_at)
     SELECT business_id, opportunity_id, recipient, recipient_source, $2, $3, template_id, 'standard', 'follow_up', tone,
            'draft', $4, $4, $5, $6, sent_at + ($7 || ' days')::interval
       FROM commercial_emails WHERE id = $1
     ON CONFLICT (sequence_root_id, sequence_step) WHERE sequence_root_id IS NOT NULL DO NOTHING
     RETURNING id`,
    [emailId, content.subject, content.body, userId, e.root_id, step, String(FOLLOW_UP_DELAY_DAYS[step])],
  );
  if (!created[0]) return null;
  await addRevision(tx, created[0].id, 1, content, 'template', userId);
  return created[0].id;
}

/** Intestazioni del thread: il follow-up risponde ai messaggi già inviati della stessa sequenza. */
export async function threadHeaders(
  db: Queryable,
  emailId: string,
): Promise<{ inReplyTo: string | null; references: string[] }> {
  // risposta a un messaggio ricevuto: stesso thread della risposta dell'azienda
  const { rows: reply } = await db.query<{ reply_to_message_id: string | null }>(
    'SELECT reply_to_message_id FROM commercial_emails WHERE id = $1',
    [emailId],
  );
  const to = reply[0]?.reply_to_message_id;
  if (to) return { inReplyTo: to, references: [to] };
  const { rows } = await db.query<{ provider_message_id: string }>(
    `SELECT s.provider_message_id FROM commercial_emails e
       JOIN commercial_emails s ON (s.id = e.sequence_root_id OR s.sequence_root_id = e.sequence_root_id)
      WHERE e.id = $1 AND e.sequence_root_id IS NOT NULL AND s.id <> e.id AND s.status = 'sent'
        AND s.provider_message_id IS NOT NULL
      ORDER BY s.sequence_step`,
    [emailId],
  );
  const ids = rows.map((r) => r.provider_message_id);
  return { inReplyTo: ids.at(-1) ?? null, references: ids };
}

/** Follow-up non ancora inviati, con lo stato della sequenza (per la vista «Follow-up»). */
export async function listFollowUps(db: Queryable) {
  const { rows } = await db.query<{
    id: string;
    business_id: string;
    b_name: string;
    recipient: string | null;
    subject: string;
    sequence_step: number;
    sequence_root_id: string;
    due_at: Date | null;
    status: string;
    root_sent_at: Date | null;
  }>(
    `SELECT e.id, e.business_id, b.name AS b_name, e.recipient, e.subject, e.sequence_step, e.sequence_root_id, e.due_at,
            e.status, r.sent_at AS root_sent_at
       FROM commercial_emails e JOIN businesses b ON b.id = e.business_id
       JOIN commercial_emails r ON r.id = e.sequence_root_id
      WHERE e.sequence_root_id IS NOT NULL AND e.status IN ('draft', 'review', 'ready', 'failed')
      ORDER BY e.due_at NULLS LAST LIMIT 200`,
  );
  const now = Date.now();
  return Promise.all(
    rows.map(async (r) => {
      const stopped = await sequenceStop(db, r.sequence_root_id);
      return {
        id: r.id,
        businessId: r.business_id,
        businessName: r.b_name,
        recipient: r.recipient,
        subject: r.subject,
        step: r.sequence_step,
        dueAt: r.due_at ? new Date(r.due_at).toISOString() : null,
        due: !stopped && (!r.due_at || new Date(r.due_at).getTime() <= now),
        firstSentAt: r.root_sent_at ? new Date(r.root_sent_at).toISOString() : null,
        stopped,
      };
    }),
  );
}
