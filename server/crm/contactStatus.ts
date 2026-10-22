/*
 * Stato di contatto di un'azienda: una sola definizione in SQL (alias b = businesses), calcolata dai dati salvati,
 * mai dallo stato dell'interfaccia. Una bozza generata o aperta NON rende un'azienda «contattata»: contano solo le
 * email accettate dal server di posta e le attività di contatto registrate nel CRM.
 *
 *  non_contattare  esclusa dalla prospezione («non contattare»)
 *  cliente         ultima opportunità vinta
 *  in_trattativa   opportunità aperta in una fase avanzata (interessato, appuntamento, preventivo, negoziazione)
 *  perso           ultima opportunità persa
 *  in_attesa       contattata (email inviata o contatto registrato), in attesa di risposta
 *  da_contattare   nessun contatto registrato
 */

export const CONTACT_STATUSES = [
  'da_contattare',
  'in_attesa',
  'in_trattativa',
  'cliente',
  'perso',
  'non_contattare',
] as const;
export type ContactStatus = (typeof CONTACT_STATUSES)[number];

export const CONTACT_STATUS_LABEL: Record<ContactStatus, string> = {
  da_contattare: 'Da contattare',
  in_attesa: 'In attesa di risposta',
  in_trattativa: 'In trattativa',
  cliente: 'Cliente',
  perso: 'Perso',
  non_contattare: 'Non contattare',
};

/** Tipi di attività del CRM che contano come contatto con l'azienda. */
export const CONTACT_ACTIVITY_SQL = `('call', 'contact_attempt', 'conversation', 'meeting', 'email_sent')`;

/** Ultimo contatto: email accettata dal server di posta o attività di contatto nel CRM. */
export const LAST_CONTACT_SQL = `GREATEST(
  (SELECT max(e.sent_at) FROM commercial_emails e WHERE e.business_id = b.id AND e.status = 'sent'),
  (SELECT max(a.occurred_at) FROM crm_activities a JOIN crm_opportunities o ON o.id = a.opportunity_id
    WHERE o.business_id = b.id AND a.type IN ${CONTACT_ACTIVITY_SQL}))`;

/** Fase dell'opportunità di riferimento: quella aperta, altrimenti la più recente. */
const STAGE_SQL = `(SELECT o.stage FROM crm_opportunities o WHERE o.business_id = b.id
  ORDER BY (o.stage NOT IN ('vinto', 'perso', 'non_contattare')) DESC, o.created_at DESC LIMIT 1)`;

export const CONTACT_STATUS_SQL = `CASE
  WHEN b.excluded_at IS NOT NULL THEN 'non_contattare'
  WHEN ${STAGE_SQL} = 'vinto' THEN 'cliente'
  WHEN ${STAGE_SQL} IN ('interessato', 'appuntamento', 'preventivo', 'negoziazione') THEN 'in_trattativa'
  WHEN ${STAGE_SQL} = 'perso' THEN 'perso'
  WHEN ${LAST_CONTACT_SQL} IS NOT NULL THEN 'in_attesa'
  ELSE 'da_contattare' END`;

/** Email generica pubblica utilizzabile (mai un indirizzo personale). */
export const HAS_EMAIL_SQL = `(b.email IS NOT NULL AND b.email_kind IS DISTINCT FROM 'personal')`;
