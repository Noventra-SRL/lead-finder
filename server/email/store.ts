import { randomUUID } from 'node:crypto';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { AiError, type AiProvider } from '../ai/provider.ts';
import { audit } from '../audit.ts';
import { CLOSED_SQL, stageLabel } from '../crm/model.ts';
import { blockerFor, insertOpportunity, recordActivity } from '../crm/store.ts';
import type { Db, Queryable } from '../db/client.ts';
import { JobError } from '../discovery/jobs.ts';
import { sectorById } from '../discovery/sectors.ts';
import { availableObjectives, buildEmailContext, composeWithAi, standardEmail } from './compose.ts';
import { kindOfError, textToHtml, toSendError, type EmailServices } from './sender.ts';
import {
  FARMACUBE_TEMPLATE_ID,
  templateForCategory,
  templateOf,
  type ModeId,
  type ObjectiveId,
  type TemplateId,
  type ToneId,
} from './template.ts';

/*
 * Email commerciali (Fase 9): bozze, revisioni, generazione, invio.
 *
 * Regole:
 *  - ogni email appartiene a un'azienda e, se esiste, all'opportunità aperta;
 *  - aprire, salvare o generare non invia mai nulla; l'invio parte solo da una conferma esplicita (una per invio);
 *  - rigenerare non sovrascrive modifiche salvate senza `overwrite: true`; ogni testo resta nelle revisioni;
 *  - «inviata» solo quando il server SMTP accetta il messaggio; un errore lascia la bozza intatta e ritentabile;
 *  - una conferma ha un request_id: ripeterla restituisce l'esito già noto e non invia due volte; due invii
 *    contemporanei della stessa email si escludono (stato «sending» impostato in modo atomico);
 *  - aziende «non contattare» (escluse dalla prospezione) o opportunità «Non contattare»: invio bloccato;
 *  - l'attività «Email commerciale inviata» nel CRM si registra solo dopo l'accettazione del server; la fase
 *    dell'opportunità non cambia mai in automatico.
 */

export type EmailStatus = 'draft' | 'review' | 'ready' | 'sending' | 'sent' | 'failed' | 'archived';
export const STATUS_LABEL: Record<EmailStatus, string> = {
  draft: 'Bozza',
  review: 'Da revisionare',
  ready: 'Pronta per l’invio',
  sending: 'Invio in corso',
  sent: 'Inviata',
  failed: 'Invio non riuscito',
  archived: 'Archiviata',
};
const EDITABLE: EmailStatus[] = ['draft', 'review', 'ready', 'failed'];
const SENDABLE: EmailStatus[] = ['draft', 'review', 'ready', 'failed'];
/** Oltre questo tempo un invio rimasto «in corso» (processo interrotto) diventa «esito incerto». */
const STALE_SENDING_MS = 5 * 60_000;
const RECENT_EMAIL_DAYS = 90;
const RECENT_CONTACT_DAYS = 30;

export const recipientSchema = z
  .string()
  .trim()
  .max(254, 'Indirizzo troppo lungo.')
  .pipe(z.email('Indirizzo email non valido.'))
  .refine((v) => !/[\r\n<>,;"]/.test(v), 'Indirizzo email non valido.');

interface Row {
  id: string;
  business_id: string;
  opportunity_id: string | null;
  recipient: string | null;
  recipient_source: 'public_source' | 'manual' | null;
  subject: string;
  body: string;
  template_id: string;
  template_version: number;
  mode: ModeId;
  objective: ObjectiveId;
  tone: ToneId;
  service_id: string | null;
  instructions: string | null;
  evidence: { id: string; kind: string; text: string; usedFor: string }[];
  internal_notes: {
    verifiedFacts: { text: string; refs: string[] }[];
    inferences: { text: string; refs: string[] }[];
    unknowns: string[];
    // dalla versione 2 del prompt (assenti nelle bozze precedenti)
    summary?: string;
    primaryService?: string | null;
    evidenceQuality?: 'alta' | 'media' | 'bassa';
    warnings?: string[];
    promptVersion?: number;
    /** Impronta delle prove usate per generare la bozza: dice su quale versione dei dati è stata scritta. */
    evidenceHash?: string;
  } | null;
  ai_model: string | null;
  generated_at: Date | null;
  edited_after_generation: boolean;
  status: EmailStatus;
  archived_from: EmailStatus | null;
  version: number;
  created_by: string;
  created_at: Date;
  updated_at: Date;
  sent_at: Date | null;
  sent_from: string | null;
  provider_message_id: string | null;
  last_error: string | null;
  failure_uncertain: boolean;
  b_name: string;
  created_by_name: string | null;
  sent_by_name: string | null;
}

const SELECT = `SELECT e.*, b.name AS b_name, cu.display_name AS created_by_name, su.display_name AS sent_by_name
  FROM commercial_emails e JOIN businesses b ON b.id = e.business_id
  LEFT JOIN users cu ON cu.id = e.created_by LEFT JOIN users su ON su.id = e.sent_by`;

const iso = (d: Date | null) => (d ? new Date(d).toISOString() : null);

function emailOut(r: Row) {
  return {
    id: r.id,
    businessId: r.business_id,
    businessName: r.b_name,
    opportunityId: r.opportunity_id,
    recipient: r.recipient,
    recipientSource: r.recipient_source,
    subject: r.subject,
    body: r.body,
    templateId: r.template_id,
    templateName: templateOf(r.template_id).name,
    templateVersion: r.template_version,
    mode: r.mode,
    objective: r.objective,
    tone: r.tone,
    serviceId: r.service_id,
    instructions: r.instructions,
    evidence: r.evidence,
    internalNotes: r.internal_notes,
    aiModel: r.ai_model,
    generatedAt: iso(r.generated_at),
    editedAfterGeneration: r.edited_after_generation,
    status: r.status,
    statusLabel: STATUS_LABEL[r.status],
    version: r.version,
    createdBy: r.created_by_name,
    createdAt: iso(r.created_at)!,
    updatedAt: iso(r.updated_at)!,
    sentAt: iso(r.sent_at),
    sentBy: r.sent_by_name,
    sentFrom: r.sent_from,
    providerMessageId: r.provider_message_id,
    lastError: r.last_error,
    failureUncertain: r.failure_uncertain,
  };
}
export type EmailOut = ReturnType<typeof emailOut>;

async function load(db: Queryable, id: string, lock = false): Promise<Row> {
  const { rows } = await db.query<Row>(
    lock ? `SELECT * FROM commercial_emails WHERE id = $1 FOR UPDATE` : `${SELECT} WHERE e.id = $1`,
    [id],
  );
  if (!rows[0]) throw new JobError(404, 'NOT_FOUND', 'Email non trovata.');
  return rows[0];
}

interface BusinessInfo {
  id: string;
  name: string;
  email: string | null;
  email_kind: string | null;
  excluded_at: Date | null;
  excluded_reason: string | null;
  /** Divieto di contatto che riguarda l'email (rifiuto commerciale su tutti i canali o sull'email, o CRM «non contattare»). */
  email_forbidden: boolean;
  merged_into: string | null;
  website_url: string | null;
  municipality_name: string | null;
  sector: string | null;
  primary_category: string | null;
}

async function business(db: Queryable, id: string): Promise<BusinessInfo> {
  const { rows } = await db.query<BusinessInfo>(
    `SELECT b.id, b.name, b.email, b.email_kind, b.excluded_at, b.excluded_reason, b.merged_into, b.website_url,
            b.municipality_name, b.sector, b.primary_category,
            ((b.do_not_contact_at IS NOT NULL AND b.do_not_contact_scope IN ('tutti', 'email'))
              OR EXISTS (SELECT 1 FROM crm_opportunities o WHERE o.business_id = b.id AND o.stage = 'non_contattare')) AS email_forbidden
       FROM businesses b WHERE b.id = $1`,
    [id],
  );
  if (!rows[0]) throw new JobError(404, 'BUSINESS_NOT_FOUND', 'Azienda non trovata.');
  return rows[0];
}

async function openOpportunity(db: Queryable, businessId: string) {
  const { rows } = await db.query<{ id: string; stage: string; owner_name: string | null }>(
    `SELECT o.id, o.stage, u.display_name AS owner_name FROM crm_opportunities o LEFT JOIN users u ON u.id = o.owner_id
      WHERE o.business_id = $1 AND o.stage NOT IN ${CLOSED_SQL}`,
    [businessId],
  );
  return rows[0] ?? null;
}

async function addRevision(
  tx: Queryable,
  emailId: string,
  version: number,
  content: { subject: string; body: string },
  source: 'template' | 'ai' | 'user',
  userId: string,
) {
  await tx.query(
    `INSERT INTO commercial_email_revisions (email_id, version, subject, body, source, created_by)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [emailId, version, content.subject, content.body, source, userId],
  );
}

// ---------------------------------------------------------------- creazione e lettura

/**
 * Nuova bozza dal modello standard (nessuna chiamata AI). `requestId` scelto dall'interfaccia: ripetere la richiesta
 * restituisce la stessa bozza (nessun doppione con una ricarica o un doppio clic).
 */
export async function createEmail(
  db: Db,
  input: { requestId: string; businessId: string; opportunityId?: string | null; reuseOpen?: boolean },
  userId: string,
): Promise<{ id: string; created: boolean }> {
  const { rows: existing } = await db.query<{ id: string; created_by: string }>(
    'SELECT id, created_by FROM commercial_emails WHERE create_request_id = $1',
    [input.requestId],
  );
  if (existing[0]) return { id: existing[0].id, created: false };
  // composer rapido: si riprende la bozza non inviata dell'azienda invece di crearne un'altra
  if (input.reuseOpen) {
    const { rows: open } = await db.query<{ id: string }>(
      `SELECT id FROM commercial_emails WHERE business_id = $1 AND status IN ('draft', 'review', 'ready', 'failed')
        ORDER BY updated_at DESC LIMIT 1`,
      [input.businessId],
    );
    if (open[0]) return { id: open[0].id, created: false };
  }
  const b = await business(db, input.businessId);
  if (b.merged_into)
    throw new JobError(
      409,
      'BUSINESS_MERGED',
      'L’azienda è stata unita a un’altra: scrivi dalla scheda mantenuta.',
      undefined,
      {
        mergedInto: b.merged_into,
      },
    );
  // divieto di contatto ed esclusione: nessuna email, nemmeno in bozza, anche chiamando l'API direttamente
  if (b.email_forbidden)
    throw new JobError(
      409,
      'DO_NOT_CONTACT',
      'L’azienda ha rifiutato le comunicazioni commerciali: il contatto via email è vietato.',
    );
  if (b.excluded_at)
    throw new JobError(
      409,
      'BUSINESS_EXCLUDED',
      'L’azienda è esclusa dalla prospezione: riportala tra i potenziali clienti per scriverle.',
    );
  let opportunityId: string | null = null;
  if (input.opportunityId) {
    const { rows } = await db.query<{ business_id: string }>(
      'SELECT business_id FROM crm_opportunities WHERE id = $1',
      [input.opportunityId],
    );
    if (rows[0]?.business_id !== b.id)
      throw new JobError(400, 'VALIDATION_ERROR', 'L’opportunità non appartiene a questa azienda.', undefined, {
        fields: { opportunityId: 'Opportunità non valida.' },
      });
    opportunityId = input.opportunityId;
  } else opportunityId = (await openOpportunity(db, b.id))?.id ?? null;
  // modello ufficiale della categoria: Farmacube per le farmacie, il modello standard per tutte le altre
  const template = templateForCategory(b.primary_category);
  const content = standardEmail(template.id);
  // indirizzo proposto: solo l'email generica pubblica della fonte (mai un indirizzo personale)
  const recipient = b.email && b.email_kind !== 'personal' ? b.email : null;
  return db.transaction(async (tx) => {
    const { rows } = await tx.query<{ id: string }>(
      `INSERT INTO commercial_emails (business_id, opportunity_id, create_request_id, recipient, recipient_source, subject, body,
         template_id, template_version, mode, objective, tone, generated_at, status, created_by, updated_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $10, 'standard', 'presentazione', 'consulenziale', now(), 'draft', $9, $9)
       ON CONFLICT (create_request_id) DO NOTHING RETURNING id`,
      [
        b.id,
        opportunityId,
        input.requestId,
        recipient,
        recipient ? 'public_source' : null,
        content.subject,
        content.body,
        template.id,
        userId,
        template.version,
      ],
    );
    if (!rows[0]) {
      const { rows: again } = await tx.query<{ id: string }>(
        'SELECT id FROM commercial_emails WHERE create_request_id = $1',
        [input.requestId],
      );
      return { id: again[0]!.id, created: false };
    }
    await addRevision(tx, rows[0].id, 1, content, 'template', userId);
    await audit(tx, { userId, action: 'email.created', entityType: 'commercial_email', entityId: rows[0].id });
    return { id: rows[0].id, created: true };
  });
}

/** Scheda completa: email, azienda, opportunità, storico dell'azienda, revisioni, tentativi, obiettivi disponibili. */
export async function getEmail(db: Queryable, id: string) {
  const r = await load(db, id);
  const b = await business(db, r.business_id);
  const opp = await openOpportunity(db, b.id);
  const ctx = await buildEmailContext(db, b.id);
  const { rows: history } = await db.query<Row>(
    `${SELECT} WHERE e.business_id = $1 AND e.id <> $2 ORDER BY e.updated_at DESC LIMIT 20`,
    [b.id, id],
  );
  const { rows: revisions } = await db.query<{
    version: number;
    source: string;
    created_at: Date;
    name: string | null;
  }>(
    `SELECT r.version, r.source, r.created_at, u.display_name AS name FROM commercial_email_revisions r
       LEFT JOIN users u ON u.id = r.created_by WHERE r.email_id = $1 ORDER BY r.version DESC LIMIT 20`,
    [id],
  );
  const { rows: attempts } = await db.query<{
    started_at: Date;
    outcome: string;
    error: string | null;
    recipient: string;
    name: string | null;
  }>(
    `SELECT a.started_at, a.outcome, a.error, a.recipient, u.display_name AS name FROM commercial_email_attempts a
       LEFT JOIN users u ON u.id = a.user_id WHERE a.email_id = $1 ORDER BY a.started_at DESC LIMIT 20`,
    [id],
  );
  return {
    email: emailOut(r),
    business: {
      id: b.id,
      name: b.name,
      sector: b.sector ? (sectorById(b.sector)?.label ?? b.sector) : null,
      municipality: b.municipality_name,
      website: b.website_url,
      publicEmail: b.email && b.email_kind !== 'personal' ? b.email : null,
      doNotContact: Boolean(b.excluded_at) || b.email_forbidden,
      doNotContactReason: b.excluded_reason,
      merged: Boolean(b.merged_into),
    },
    opportunity: opp
      ? { id: opp.id, stage: opp.stage, stageLabel: stageLabel(opp.stage), owner: opp.owner_name }
      : null,
    objectives: ctx ? availableObjectives(ctx) : [],
    catalog: ctx?.catalog.map((s) => ({ id: s.id, name: s.name })) ?? [],
    history: history.map(emailOut).map((h) => ({
      id: h.id,
      subject: h.subject,
      status: h.status,
      statusLabel: h.statusLabel,
      updatedAt: h.updatedAt,
      sentAt: h.sentAt,
      recipient: h.recipient,
    })),
    revisions: revisions.map((v) => ({
      version: v.version,
      source: v.source,
      at: iso(v.created_at)!,
      by: v.name,
    })),
    attempts: attempts.map((a) => ({
      at: iso(a.started_at)!,
      outcome: a.outcome,
      error: a.error,
      recipient: a.recipient,
      by: a.name,
    })),
  };
}

/** Prove disponibili per la personalizzazione (anteprima, nessuna chiamata AI). */
export async function emailEvidence(db: Queryable, id: string) {
  const r = await load(db, id);
  const ctx = await buildEmailContext(db, r.business_id);
  return { evidence: ctx?.evidence ?? [], hasPriorContact: ctx?.hasPriorContact ?? false };
}

export const SORTS = {
  updated: 'e.updated_at',
  created: 'e.created_at',
  business: 'lower(b.name)',
  status: `CASE e.status WHEN 'review' THEN 0 WHEN 'ready' THEN 1 WHEN 'draft' THEN 2 WHEN 'failed' THEN 3 WHEN 'sending' THEN 4 WHEN 'sent' THEN 5 ELSE 6 END`,
  sent: 'e.sent_at',
} as const;

export async function listEmails(
  db: Queryable,
  f: {
    status?: EmailStatus | 'all';
    q?: string;
    businessId?: string;
    opportunityId?: string;
    sort: keyof typeof SORTS;
    dir: 'asc' | 'desc';
    page: number;
    pageSize: number;
  },
) {
  const where: string[] = [];
  const params: unknown[] = [];
  const add = (sql: (p: string) => string, v: unknown) => {
    params.push(v);
    where.push(sql(`$${params.length}`));
  };
  if (f.businessId) add((p) => `e.business_id = ${p}`, f.businessId);
  if (f.opportunityId) add((p) => `e.opportunity_id = ${p}`, f.opportunityId);
  if (f.q) {
    const like = `%${f.q.toLowerCase().replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    add(
      (p) => `(lower(b.name) LIKE ${p} OR lower(e.subject) LIKE ${p} OR lower(coalesce(e.recipient, '')) LIKE ${p})`,
      like,
    );
  }
  const base = where.length ? where.join(' AND ') : 'true';
  // conteggi per stato con gli stessi filtri (tranne lo stato)
  const { rows: counts } = await db.query<{ status: EmailStatus; n: number }>(
    `SELECT e.status, count(*)::int AS n FROM commercial_emails e JOIN businesses b ON b.id = e.business_id
      WHERE ${base} GROUP BY e.status`,
    params,
  );
  const statusWhere =
    !f.status || f.status === 'all'
      ? `${base} AND e.status <> 'archived'`
      : `${base} AND e.status = $${params.length + 1}`;
  const statusParams = !f.status || f.status === 'all' ? params : [...params, f.status];
  const { rows: total } = await db.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM commercial_emails e JOIN businesses b ON b.id = e.business_id WHERE ${statusWhere}`,
    statusParams,
  );
  const { rows } = await db.query<Row>(
    `${SELECT} WHERE ${statusWhere}
      ORDER BY ${SORTS[f.sort]} ${f.dir === 'asc' ? 'ASC' : 'DESC'} NULLS LAST, e.id
      LIMIT $${statusParams.length + 1} OFFSET $${statusParams.length + 2}`,
    [...statusParams, f.pageSize, (f.page - 1) * f.pageSize],
  );
  const byStatus = Object.fromEntries(counts.map((c) => [c.status, c.n])) as Partial<Record<EmailStatus, number>>;
  return {
    items: rows.map(emailOut).map(({ body: _body, evidence: _e, internalNotes: _n, ...rest }) => rest),
    total: total[0]!.n,
    page: f.page,
    pageSize: f.pageSize,
    counts: {
      all: counts.filter((c) => c.status !== 'archived').reduce((a, c) => a + c.n, 0),
      ...byStatus,
    },
  };
}

/** Bozze generate dall'AI in attesa di revisione (numero accanto alla voce del menu). */
export async function reviewCount(db: Queryable): Promise<number> {
  const { rows } = await db.query<{ n: number }>(
    "SELECT count(*)::int AS n FROM commercial_emails WHERE status = 'review'",
  );
  return rows[0]!.n;
}

// ---------------------------------------------------------------- modifiche

function assertVersion(r: Pick<Row, 'version'>, version: number) {
  if (r.version !== version)
    throw new JobError(
      409,
      'STALE_VERSION',
      'L’email è stata modificata nel frattempo (un’altra scheda o un altro utente). Ricarica per vedere la versione attuale.',
    );
}

export async function updateEmail(
  db: Db,
  id: string,
  patch: {
    version: number;
    recipient?: string | null;
    subject?: string;
    body?: string;
    objective?: ObjectiveId;
    tone?: ToneId;
    serviceId?: string | null;
    instructions?: string | null;
    status?: 'draft' | 'ready';
  },
  userId: string,
) {
  await db.transaction(async (tx) => {
    const r = await load(tx, id, true);
    if (!EDITABLE.includes(r.status))
      throw new JobError(409, 'NOT_EDITABLE', 'Un’email inviata, in invio o archiviata non si modifica.');
    assertVersion(r, patch.version);
    const subject = patch.subject ?? r.subject;
    const body = patch.body ?? r.body;
    const contentChanged = subject !== r.subject || body !== r.body;
    const recipient = patch.recipient === undefined ? r.recipient : patch.recipient || null;
    const recipientSource = recipient === r.recipient ? r.recipient_source : recipient ? 'manual' : null;
    // modificare il testo riporta a «Bozza»; «Pronta per l'invio» si sceglie esplicitamente
    const status: EmailStatus =
      patch.status ??
      (contentChanged || recipient !== r.recipient ? 'draft' : r.status === 'failed' ? 'failed' : r.status);
    const version = r.version + 1;
    await tx.query(
      `UPDATE commercial_emails SET recipient = $2, recipient_source = $3, subject = $4, body = $5,
              objective = COALESCE($6, objective), tone = COALESCE($7, tone),
              service_id = CASE WHEN $8::boolean THEN $9 ELSE service_id END,
              instructions = CASE WHEN $10::boolean THEN $11 ELSE instructions END,
              edited_after_generation = edited_after_generation OR $12, status = $13, version = $14,
              updated_by = $15, updated_at = now()
        WHERE id = $1`,
      [
        id,
        recipient,
        recipientSource,
        subject,
        body,
        patch.objective ?? null,
        patch.tone ?? null,
        patch.serviceId !== undefined,
        patch.serviceId ?? null,
        patch.instructions !== undefined,
        patch.instructions || null,
        contentChanged,
        status,
        version,
        userId,
      ],
    );
    if (contentChanged) await addRevision(tx, id, version, { subject, body }, 'user', userId);
  });
}

/**
 * Genera il testo (modello standard o AI) e lo salva come nuova revisione. Con modifiche salvate dopo l'ultima
 * generazione serve `overwrite: true` (conferma esplicita): la versione precedente resta comunque nelle revisioni.
 */
/** Bozze con una generazione AI in corso in questo processo. */
const generating = new Set<string>();

export async function generateEmail(
  db: Db,
  id: string,
  input: {
    version: number;
    mode: ModeId;
    objective: ObjectiveId;
    tone: ToneId;
    serviceId: string | null;
    instructions: string | null;
    overwrite: boolean;
    /** Modello da usare (cambio manuale o «Ripristina modello ufficiale»); predefinito: quello della bozza. */
    templateId?: TemplateId;
  },
  deps: { provider: AiProvider | null },
  userId: string,
) {
  const r = await load(db, id);
  if (!EDITABLE.includes(r.status))
    throw new JobError(409, 'NOT_EDITABLE', 'Un’email inviata, in invio o archiviata non si rigenera.');
  assertVersion(r, input.version);
  if (r.edited_after_generation && !input.overwrite)
    throw new JobError(
      409,
      'EDITS_WOULD_BE_LOST',
      'Il testo contiene modifiche salvate: conferma per sostituirlo (la versione attuale resta nelle revisioni).',
    );
  const ctx = await buildEmailContext(db, r.business_id);
  if (!ctx) throw new JobError(404, 'BUSINESS_NOT_FOUND', 'Azienda non trovata.');
  const objective = availableObjectives(ctx).find((o) => o.id === input.objective);
  if (!objective?.available)
    throw new JobError(400, 'OBJECTIVE_NOT_AVAILABLE', objective?.reason ?? 'Obiettivo non disponibile.', undefined, {
      fields: { objective: objective?.reason ?? 'Obiettivo non disponibile.' },
    });
  if (input.objective === 'servizio' && (!input.serviceId || !ctx.catalog.some((s) => s.id === input.serviceId)))
    throw new JobError(400, 'VALIDATION_ERROR', 'Scegli un servizio del catalogo.', undefined, {
      fields: { serviceId: 'Scegli un servizio del catalogo.' },
    });

  const template = templateOf(input.templateId ?? r.template_id);
  let content: { subject: string; body: string };
  let evidence: Row['evidence'] = [];
  let notes: Row['internal_notes'] = null;
  let model: string | null = null;
  if (input.mode === 'standard') content = standardEmail(template.id);
  // Farmacube: senza un sito verificato non c'è nulla di vero da personalizzare; resta il testo ufficiale e il
  // fornitore AI non viene chiamato (nessun costo)
  else if (template.id === FARMACUBE_TEMPLATE_ID && !ctx.websiteVerified)
    throw new JobError(
      422,
      'INSUFFICIENT_EVIDENCE',
      'Informazioni insufficienti per una personalizzazione utile (sito della farmacia non verificato): resta il modello ufficiale Farmacube, invariato.',
    );
  else {
    if (!deps.provider)
      throw new JobError(
        503,
        'AI_NOT_CONFIGURED',
        'Personalizzazione AI non configurata sul server: l’amministratore deve impostare AI_API_KEY nel file .env e riavviare il server. Intanto puoi usare il modello standard.',
      );
    // una sola generazione per bozza alla volta: un doppio clic non paga due chiamate al modello
    if (generating.has(id))
      throw new JobError(
        409,
        'GENERATION_IN_PROGRESS',
        'Generazione già in corso per questa email: attendi il risultato.',
      );
    generating.add(id);
    try {
      const out = await composeWithAi(deps.provider, ctx, {
        objective: input.objective,
        tone: input.tone,
        instructions: input.instructions,
        serviceId: input.objective === 'servizio' ? input.serviceId : null,
        templateId: template.id,
      });
      content = { subject: out.subject, body: out.body };
      evidence = out.evidence;
      notes = {
        ...out.notes,
        evidenceHash: createHash('sha256')
          .update(JSON.stringify(ctx.evidence.map((e) => [e.id, e.text])))
          .digest('hex')
          .slice(0, 16),
      };
      model = out.model;
    } catch (error) {
      if (error instanceof AiError)
        throw new JobError(
          error.code === 'rate_limited' ? 429 : error.code === 'invalid_output' ? 422 : 502,
          'AI_FAILED',
          `${error.message} Il testo attuale non è stato modificato.`,
        );
      throw error;
    } finally {
      generating.delete(id);
    }
  }
  await db.transaction(async (tx) => {
    const cur = await load(tx, id, true);
    // nel frattempo qualcuno ha salvato: non si sovrascrive
    assertVersion(cur, input.version);
    const version = cur.version + 1;
    await tx.query(
      `UPDATE commercial_emails SET subject = $2, body = $3, mode = $4, objective = $5, tone = $6, service_id = $7,
              instructions = $8, evidence = $9, internal_notes = $10, ai_model = $11, generated_at = now(),
              edited_after_generation = false, status = $12, version = $13, updated_by = $14, updated_at = now(),
              template_id = $15, template_version = $16
        WHERE id = $1`,
      [
        id,
        content.subject,
        content.body,
        input.mode,
        input.objective,
        input.tone,
        input.objective === 'servizio' ? input.serviceId : null,
        input.instructions,
        JSON.stringify(evidence),
        notes ? JSON.stringify(notes) : null,
        model,
        // il testo dell'AI va riletto da una persona prima dell'invio
        input.mode === 'ai' ? 'review' : 'draft',
        version,
        userId,
        template.id,
        template.version,
      ],
    );
    await addRevision(tx, id, version, content, input.mode === 'ai' ? 'ai' : 'template', userId);
    await audit(tx, {
      userId,
      action: 'email.generated',
      entityType: 'commercial_email',
      entityId: id,
      details: { mode: input.mode, objective: input.objective, model, template: template.id },
    });
  });
}

export async function archiveEmail(db: Db, id: string, version: number, userId: string) {
  await db.transaction(async (tx) => {
    const r = await load(tx, id, true);
    if (r.status === 'archived') return;
    if (r.status === 'sending') throw new JobError(409, 'SENDING', 'Invio in corso: attendi l’esito.');
    assertVersion(r, version);
    await tx.query(
      `UPDATE commercial_emails SET status = 'archived', archived_from = status, version = version + 1, updated_by = $2,
              updated_at = now() WHERE id = $1`,
      [id, userId],
    );
  });
}

export async function restoreEmail(db: Db, id: string, userId: string) {
  await db.transaction(async (tx) => {
    const r = await load(tx, id, true);
    if (r.status !== 'archived') return;
    await tx.query(
      `UPDATE commercial_emails SET status = archived_from, archived_from = NULL, version = version + 1, updated_by = $2,
              updated_at = now() WHERE id = $1`,
      [id, userId],
    );
  });
}

// ---------------------------------------------------------------- invio

/** Invii rimasti «in corso» (processo interrotto): diventano «non riuscito, esito incerto», mai «inviata». */
export async function recoverStaleSends(db: Queryable) {
  const { rows } = await db.query<{ id: string }>(
    `UPDATE commercial_emails SET status = 'failed', failure_uncertain = true, updated_at = now(),
            last_error = 'Invio interrotto (riavvio del server): il messaggio potrebbe essere partito. Controlla la posta inviata prima di ritentare.'
      WHERE status = 'sending' AND sending_started_at < now() - ($1 || ' milliseconds')::interval RETURNING id`,
    [String(STALE_SENDING_MS)],
  );
  if (rows.length)
    await db.query(
      `UPDATE commercial_email_attempts SET outcome = 'uncertain', finished_at = now(),
              error = 'Invio interrotto (riavvio del server).'
        WHERE outcome = 'pending' AND email_id = ANY($1)`,
      [rows.map((r) => r.id)],
    );
  return rows.length;
}

export interface Precheck {
  canSend: boolean;
  blockers: string[];
  warnings: string[];
  recipient: string | null;
  recipientState: 'missing' | 'invalid' | 'public_source' | 'manual';
  needsOpportunity: boolean;
  from: { name: string; address: string } | null;
}

/** Controlli prima dell'invio (mostrati nella conferma e ripetuti dal server all'invio). */
export async function precheck(db: Queryable, id: string, email: EmailServices): Promise<Precheck> {
  await recoverStaleSends(db);
  const r = await load(db, id);
  const b = await business(db, r.business_id);
  const opp = await openOpportunity(db, b.id);
  const blockers: string[] = [];
  const warnings: string[] = [];
  const status = email.status();
  if (!status.canSend) blockers.push(`${status.label}: ${status.explanation}`);
  if (!SENDABLE.includes(r.status))
    blockers.push(
      r.status === 'sent'
        ? 'Questa email è già stata inviata.'
        : `Stato «${STATUS_LABEL[r.status]}»: non si può inviare.`,
    );
  if (b.merged_into) blockers.push('L’azienda è stata unita a un’altra scheda.');
  if (b.email_forbidden)
    blockers.push('L’azienda ha rifiutato le comunicazioni commerciali: il contatto via email è vietato.');
  else if (b.excluded_at)
    blockers.push(`L’azienda è esclusa dalla prospezione${b.excluded_reason ? ` (${b.excluded_reason})` : ''}.`);
  const valid = r.recipient ? recipientSchema.safeParse(r.recipient).success : false;
  const recipientState: Precheck['recipientState'] = !r.recipient
    ? 'missing'
    : !valid
      ? 'invalid'
      : (r.recipient_source ?? 'manual');
  if (recipientState === 'missing') blockers.push('Manca l’indirizzo del destinatario.');
  if (recipientState === 'invalid') blockers.push('L’indirizzo del destinatario non è valido.');
  if (!r.subject.trim()) blockers.push('Manca l’oggetto.');
  if (!r.body.trim()) blockers.push('Il testo è vuoto.');
  if (recipientState === 'public_source')
    warnings.push(
      'Indirizzo pubblico indicato dalla fonte (OpenStreetMap): non verificato. Controlla che sia ancora attivo e dell’azienda.',
    );
  if (recipientState === 'manual') warnings.push('Indirizzo inserito a mano: non verificato.');
  if (r.status === 'review') warnings.push('Testo generato dall’AI non ancora rivisto: rileggilo prima di inviare.');
  if (r.failure_uncertain)
    warnings.push(
      'L’ultimo tentativo ha avuto un esito incerto: il messaggio potrebbe essere già partito. Controlla la posta inviata del mittente prima di ritentare.',
    );
  const { rows: recentEmails } = await db.query<{ sent_at: Date; recipient: string }>(
    `SELECT sent_at, recipient FROM commercial_emails WHERE business_id = $1 AND status = 'sent' AND id <> $2
        AND sent_at > now() - ($3 || ' days')::interval ORDER BY sent_at DESC LIMIT 3`,
    [b.id, id, String(RECENT_EMAIL_DAYS)],
  );
  for (const e of recentEmails)
    warnings.push(
      `Un’altra email commerciale è già stata inviata a questa azienda il ${new Date(e.sent_at).toLocaleDateString('it-IT', { timeZone: 'Europe/Rome' })} (${e.recipient}).`,
    );
  const { rows: recentContacts } = await db.query<{ type: string; occurred_at: Date }>(
    `SELECT a.type, a.occurred_at FROM crm_activities a JOIN crm_opportunities o ON o.id = a.opportunity_id
      WHERE o.business_id = $1 AND a.type IN ('call', 'contact_attempt', 'conversation', 'meeting')
        AND a.occurred_at > now() - ($2 || ' days')::interval ORDER BY a.occurred_at DESC LIMIT 3`,
    [b.id, String(RECENT_CONTACT_DAYS)],
  );
  for (const c of recentContacts)
    warnings.push(
      `Contatto recente registrato nel CRM: ${c.type === 'call' ? 'telefonata' : c.type === 'meeting' ? 'incontro' : c.type === 'conversation' ? 'conversazione' : 'tentativo di contatto'} del ${new Date(c.occurred_at).toLocaleDateString('it-IT', { timeZone: 'Europe/Rome' })}.`,
    );
  return {
    canSend: blockers.length === 0,
    blockers,
    warnings,
    recipient: r.recipient,
    recipientState,
    needsOpportunity: !opp,
    from: status.from,
  };
}

/**
 * Invio dopo la conferma esplicita. Ordine: controlli → stato «sending» atomico → SMTP → esito.
 * Solo con l'accettazione del server: stato «sent», attività nel CRM (e opportunità «Da qualificare» se mancava,
 * come indicato nella conferma). In caso di errore la bozza resta com'era, con l'errore e lo stato «non riuscito».
 */
export async function sendEmail(
  db: Db,
  id: string,
  input: { requestId: string; version: number; acceptUncertain: boolean },
  email: EmailServices,
  userId: string,
) {
  // stessa conferma ripetuta (doppio clic, rete instabile): si restituisce l'esito già registrato
  const { rows: prior } = await db.query<{ email_id: string; outcome: string; error: string | null }>(
    'SELECT email_id, outcome, error FROM commercial_email_attempts WHERE request_id = $1',
    [input.requestId],
  );
  if (prior[0]) {
    if (prior[0].email_id !== id) throw new JobError(409, 'REQUEST_REUSED', 'Richiesta di invio non valida: riprova.');
    return { outcome: prior[0].outcome as 'accepted' | 'failed' | 'uncertain' | 'pending', repeated: true };
  }
  const check = await precheck(db, id, email);
  if (!check.canSend)
    throw new JobError(409, 'CANNOT_SEND', check.blockers.join(' '), undefined, { blockers: check.blockers });
  if (!email.sender || !check.from) throw new JobError(503, 'EMAIL_NOT_CONFIGURED', 'Invio non configurato.');
  const current = await load(db, id);
  if (current.failure_uncertain && !input.acceptUncertain)
    throw new JobError(
      409,
      'UNCERTAIN_PREVIOUS',
      'L’ultimo tentativo potrebbe essere già partito: conferma di voler inviare di nuovo dopo aver controllato la posta inviata.',
    );
  // connessione verificata prima del primo invio (nessun messaggio inviato dalla verifica)
  if (!email.lastCheck) {
    const v = await email.verify();
    if (!v.ok) throw new JobError(502, 'PROVIDER_ERROR', `Server di posta non disponibile: ${v.message}`);
  }

  // stato «sending» in modo atomico: un secondo invio contemporaneo della stessa email non passa
  const attemptId = randomUUID();
  const locked = await db.transaction(async (tx) => {
    const { rows } = await tx.query<{
      recipient: string;
      subject: string;
      body: string;
      business_id: string;
      template_id: string;
      template_version: number;
      mode: ModeId;
    }>(
      `UPDATE commercial_emails SET status = 'sending', sending_started_at = now(), updated_at = now()
        WHERE id = $1 AND version = $2 AND status IN ('draft', 'review', 'ready', 'failed')
        RETURNING recipient, subject, body, business_id, template_id, template_version, mode`,
      [id, input.version],
    );
    if (!rows[0]) return null;
    await tx.query(
      `INSERT INTO commercial_email_attempts (id, email_id, request_id, user_id, recipient) VALUES ($1, $2, $3, $4, $5)`,
      [attemptId, id, input.requestId, userId, rows[0].recipient],
    );
    return rows[0];
  });
  if (!locked)
    throw new JobError(
      409,
      'SEND_CONFLICT',
      'L’email è cambiata o è già in invio: ricarica la pagina e controlla lo stato prima di riprovare.',
    );

  const domain = check.from.address.split('@')[1] ?? 'noventra.it';
  const messageId = `<${attemptId}@${domain}>`;
  try {
    const result = await email.sender.send({
      from: check.from,
      replyTo: email.config.replyTo,
      to: locked.recipient,
      subject: locked.subject.replace(/[\r\n]+/g, ' '),
      text: locked.body,
      html: textToHtml(locked.body),
      messageId,
    });
    email.record(true, 'Ultimo invio accettato dal server di posta.');
    await db.transaction(async (tx) => {
      // opportunità: quella aperta, altrimenti una nuova «Da qualificare» (annunciata nella conferma)
      let opportunityId = (await openOpportunity(tx, locked.business_id))?.id ?? null;
      if (!opportunityId) {
        const blocker = await blockerFor(tx, locked.business_id);
        if (!blocker)
          opportunityId = await insertOpportunity(
            tx,
            { businessId: locked.business_id, stage: 'da_qualificare', priority: 'media' },
            [],
            userId,
          );
      }
      const { rows: sentRow } = await tx.query<{ sent_at: Date }>(
        `UPDATE commercial_emails SET status = 'sent', sent_at = now(), sent_by = $2, sent_from = $3,
                provider_message_id = $4, last_error = NULL, failure_uncertain = false, opportunity_id = COALESCE($5, opportunity_id),
                version = version + 1, updated_by = $2, updated_at = now()
          WHERE id = $1 RETURNING sent_at`,
        [id, userId, check.from!.address, result.messageId.slice(0, 500), opportunityId],
      );
      await tx.query(
        `UPDATE commercial_email_attempts SET outcome = 'accepted', finished_at = now(), provider_message_id = $2 WHERE id = $1`,
        [attemptId, result.messageId.slice(0, 500)],
      );
      // contatto avvenuto: un'opportunità ancora «da qualificare» o «da contattare» passa a «in attesa di risposta»
      // (mai a vinto o perso; le fasi più avanzate non cambiano)
      if (opportunityId) {
        const { rows: st } = await tx.query<{ stage: string }>(
          'SELECT stage FROM crm_opportunities WHERE id = $1 FOR UPDATE',
          [opportunityId],
        );
        const from = st[0]?.stage;
        if (from === 'da_qualificare' || from === 'da_contattare') {
          await tx.query("UPDATE crm_opportunities SET stage = 'in_attesa', updated_at = now() WHERE id = $1", [
            opportunityId,
          ]);
          await recordActivity(tx, {
            opportunityId,
            type: 'stage_change',
            summary: `${stageLabel(from)} → ${stageLabel('in_attesa')}`,
            notes: 'Aggiornata automaticamente dopo l’invio dell’email commerciale.',
            fromStage: from,
            toStage: 'in_attesa',
            userId,
          });
        }
      }
      if (opportunityId) {
        const activityId = await recordActivity(tx, {
          opportunityId,
          type: 'email_sent',
          // stesso istante dell'email: «ultimo contatto» coincide con l'invio
          occurredAt: new Date(sentRow[0]!.sent_at),
          summary: `Email commerciale inviata a ${locked.recipient}: ${locked.subject}`.slice(0, 300),
          notes: `Modello: ${templateOf(locked.template_id).name} (versione ${locked.template_version}${locked.mode === 'ai' ? ', personalizzata con AI' : ''}). Accettata dal server di posta (${result.response}). La consegna nella casella del destinatario non è confermata.`,
          userId,
        });
        await tx.query('UPDATE crm_activities SET email_id = $2 WHERE id = $1', [activityId, id]);
      }
      await audit(tx, {
        userId,
        action: 'email.sent',
        entityType: 'commercial_email',
        entityId: id,
        details: { attemptId, provider: email.sender!.name },
      });
    });
    return { outcome: 'accepted' as const, repeated: false };
  } catch (error) {
    const e = toSendError(error);
    if (e.providerProblem) email.record(false, e.message, kindOfError(e));
    await db.transaction(async (tx) => {
      await tx.query(
        `UPDATE commercial_emails SET status = 'failed', last_error = $2, failure_uncertain = $3, updated_at = now()
          WHERE id = $1 AND status = 'sending'`,
        [id, e.message.slice(0, 500), e.uncertain],
      );
      await tx.query(
        `UPDATE commercial_email_attempts SET outcome = $2, finished_at = now(), error = $3 WHERE id = $1`,
        [attemptId, e.uncertain ? 'uncertain' : 'failed', e.message.slice(0, 500)],
      );
      await audit(tx, {
        userId,
        action: 'email.send_failed',
        entityType: 'commercial_email',
        entityId: id,
        details: { attemptId, uncertain: e.uncertain },
      });
    });
    return { outcome: e.uncertain ? ('uncertain' as const) : ('failed' as const), repeated: false, message: e.message };
  }
}
