import type { Queryable } from './db/client.ts';

/*
 * Registro delle attività (tabella audit_log, solo aggiunte).
 * Le azioni hanno nomi stabili "area.evento"; i dettagli non contengono mai password, token o segreti.
 */

export type AuditAction =
  | 'auth.login'
  | 'auth.login_failed'
  | 'auth.logout'
  | 'auth.password_changed'
  | 'auth.sessions_revoked'
  | 'user.created'
  | 'user.password_reset'
  | 'user.disabled'
  | 'user.enabled'
  | 'user.role_changed'
  | 'business.created'
  | 'business.edited'
  | 'business.updated'
  | 'business.source_linked'
  | 'business.merged'
  | 'duplicate.marked_distinct'
  | 'discovery.job_created'
  | 'discovery.job_cancelled'
  | 'discovery.job_paused'
  | 'discovery.job_resumed'
  | 'audit.job_created'
  | 'audit.job_cancelled'
  | 'audit.job_paused'
  | 'audit.job_resumed'
  | 'scoring.config_updated'
  | 'scoring.job_created'
  | 'scoring.job_cancelled'
  | 'services.catalog_updated'
  | 'services.match_reviewed'
  | 'hunt.created'
  | 'hunt.paused'
  | 'hunt.resumed'
  | 'hunt.cancelled'
  | 'business.excluded'
  | 'business.category_set'
  | 'business.category_automatic'
  | 'business.email_found'
  | 'business.email_confirmed'
  | 'business.do_not_contact_revoked'
  | 'business.included'
  | 'leads.exported'
  | 'crm.opportunity_created'
  | 'crm.opportunity_updated'
  | 'crm.stage_changed'
  | 'ai.config_updated'
  | 'ai.assessment_requested'
  | 'ai.job_created'
  | 'ai.job_paused'
  | 'ai.job_resumed'
  | 'ai.job_cancelled'
  | 'ai.assessment_reviewed'
  | 'email.created'
  | 'email.generated'
  | 'email.sent'
  | 'email.send_failed'
  | 'email.verified'
  | 'email.test_sent';

export async function audit(
  db: Queryable,
  entry: {
    userId: string | null;
    action: AuditAction;
    entityType?: string;
    entityId?: string;
    details?: Record<string, unknown>;
  },
): Promise<void> {
  await db.query(
    'INSERT INTO audit_log (user_id, action, entity_type, entity_id, details) VALUES ($1, $2, $3, $4, $5)',
    [entry.userId, entry.action, entry.entityType ?? null, entry.entityId ?? null, JSON.stringify(entry.details ?? {})],
  );
}
