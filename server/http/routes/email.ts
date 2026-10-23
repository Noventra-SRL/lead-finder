import { z } from 'zod';
import { RULES } from '../../auth/rateLimit.ts';
import { audit } from '../../audit.ts';
import {
  archiveEmail,
  createEmail,
  emailEvidence,
  generateEmail,
  getEmail,
  listEmails,
  precheck,
  recipientSchema,
  restoreEmail,
  reviewCount,
  sendEmail,
  SORTS,
  STATUS_LABEL,
  updateEmail,
} from '../../email/store.ts';
import {
  DEFAULT_SUBJECT,
  MODES,
  NOVENTRA,
  OBJECTIVE_IDS,
  OBJECTIVES,
  STANDARD_BODY,
  TEMPLATE_ID,
  TEMPLATE_NAME,
  EMAIL_TEMPLATES,
  TEMPLATE_IDS,
  TONE_IDS,
  TONES,
} from '../../email/template.ts';
import { created, HttpError, limit, ok, parseBody, parseQuery, sessionOf, type Context, type Route } from '../core.ts';

/*
 * Email commerciali (Fase 9). Tutte le rotte richiedono una sessione. Nessuna rotta invia un'email tranne
 * POST /api/emails/:id/send, che richiede la conferma esplicita (reviewed e lawful) e un requestId per conferma.
 *
 *  GET   /api/emails/meta                 modello ufficiale, obiettivi, toni, stati, configurazione dell'invio
 *  GET   /api/emails                      elenco con filtri (stato, ricerca, azienda, opportunità), ordinamento, conteggi
 *  POST  /api/emails                      nuova bozza dal modello standard { requestId, businessId, opportunityId? }
 *  GET   /api/emails/:id                  scheda: email, azienda, opportunità, storico, revisioni, tentativi
 *  GET   /api/emails/:id/evidence         prove disponibili per la personalizzazione (nessuna chiamata AI)
 *  PATCH /api/emails/:id                  salvataggio { version, recipient?, subject?, body?, …, status? }
 *  POST  /api/emails/:id/generate         modello standard o AI { version, mode, objective, tone, …, overwrite }
 *  POST  /api/emails/:id/archive | restore
 *  GET   /api/emails/:id/precheck         controlli prima dell'invio (blocchi e avvisi)
 *  POST  /api/emails/:id/send             invio confermato { requestId, version, reviewed, lawful, acceptUncertain? }
 *  GET   /api/email/status                stato della configurazione dell'invio (mai credenziali)
 *  POST  /api/email/verify                solo amministratori: verifica connessione e autenticazione SMTP (nessun invio)
 */

const UUID = '([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})';
const STATUSES = ['draft', 'review', 'ready', 'sending', 'sent', 'failed', 'archived'] as const;
const serviceId = z.string().regex(/^[a-z][a-z0-9_]{1,40}$/, 'Servizio non valido.');
const instructions = z.string().trim().max(1000, 'Usa al massimo 1000 caratteri.');

const writes = (ctx: Context) => {
  const session = sessionOf(ctx);
  limit(ctx, `email:${session.user.id}`, RULES.emailWritesByUser);
  return session;
};

const detail = (ctx: Context, id: string) => getEmail(ctx.db, id);

export const emailRoutes: Route[] = [
  {
    method: 'GET',
    pattern: /^\/api\/emails\/meta$/,
    async handle(ctx) {
      sessionOf(ctx);
      return ok({
        template: {
          id: TEMPLATE_ID,
          name: TEMPLATE_NAME,
          subject: DEFAULT_SUBJECT,
          body: STANDARD_BODY,
          contacts: NOVENTRA,
        },
        // modelli ufficiali (testo approvato, versione, categorie per cui sono predefiniti)
        templates: Object.values(EMAIL_TEMPLATES).map((t) => ({
          id: t.id,
          name: t.name,
          version: t.version,
          subject: t.subject,
          body: t.body,
          defaultFor: t.defaultFor,
        })),
        modes: MODES,
        objectives: OBJECTIVES.map((o) => ({ id: o.id, label: o.label })),
        tones: TONES,
        statuses: STATUSES.filter((s) => s !== 'sending').map((s) => ({ id: s, label: STATUS_LABEL[s] })),
        aiConfigured: ctx.state.ai.provider !== null,
        sending: ctx.state.email.status(),
        reviewCount: await reviewCount(ctx.db),
      });
    },
  },
  {
    method: 'GET',
    pattern: /^\/api\/email\/status$/,
    async handle(ctx) {
      sessionOf(ctx);
      return ok(ctx.state.email.status());
    },
  },
  {
    method: 'POST',
    pattern: /^\/api\/email\/verify$/,
    access: 'admin',
    async handle(ctx) {
      const session = writes(ctx);
      const result = await ctx.state.email.verify();
      await audit(ctx.db, { userId: session.user.id, action: 'email.verified', details: { ok: result.ok } });
      return ok({ ...result, status: ctx.state.email.status() });
    },
  },
  {
    // «Invia email di prova»: solo amministratori, solo all'indirizzo scritto e confermato; mai nel CRM
    method: 'POST',
    pattern: /^\/api\/email\/test$/,
    access: 'admin',
    async handle(ctx) {
      const session = writes(ctx);
      const body = parseBody(
        z
          .object({
            to: z.email('Indirizzo email non valido.').max(254),
            confirm: z.literal(true, { error: 'Conferma l’invio del messaggio di prova.' }),
          })
          .strict(),
        ctx.body,
      );
      limit(ctx, `email-test:${session.user.id}`, RULES.emailSendsByUser);
      const status = ctx.state.email.status();
      if (!ctx.state.email.sender || !status.from)
        throw new HttpError(503, 'EMAIL_NOT_CONFIGURED', `Configurazione mancante: ${status.explanation}`);
      const result = await ctx.state.email.sendTest(body.to.trim().toLowerCase());
      await audit(ctx.db, {
        userId: session.user.id,
        action: 'email.test_sent',
        details: { ok: result.ok, kind: result.kind },
      });
      return ok({ ...result, status: ctx.state.email.status() });
    },
  },
  {
    method: 'GET',
    pattern: /^\/api\/emails$/,
    async handle(ctx) {
      sessionOf(ctx);
      const q = parseQuery(
        z.object({
          status: z.enum([...STATUSES, 'all']).default('all'),
          q: z.string().trim().max(100).optional(),
          business: z.uuid().optional(),
          opportunity: z.uuid().optional(),
          sort: z.enum(Object.keys(SORTS) as [keyof typeof SORTS, ...(keyof typeof SORTS)[]]).default('updated'),
          dir: z.enum(['asc', 'desc']).default('desc'),
          page: z.coerce.number().int().min(1).max(10_000).default(1),
          pageSize: z.coerce.number().int().min(1).max(100).default(25),
        }),
        ctx.url.searchParams,
      );
      return ok(
        await listEmails(ctx.db, {
          status: q.status,
          q: q.q || undefined,
          businessId: q.business,
          opportunityId: q.opportunity,
          sort: q.sort,
          dir: q.dir,
          page: q.page,
          pageSize: q.pageSize,
        }),
      );
    },
  },
  {
    method: 'POST',
    pattern: /^\/api\/emails$/,
    async handle(ctx) {
      const session = writes(ctx);
      const body = parseBody(
        z
          .object({
            requestId: z.uuid('Richiesta non valida.'),
            businessId: z.uuid('Scegli un’azienda.'),
            opportunityId: z.uuid().nullable().optional(),
            // composer rapido: riprende la bozza non inviata dell'azienda, se c'è
            reuseOpen: z.boolean().default(false),
          })
          .strict(),
        ctx.body,
      );
      const r = await createEmail(ctx.db, body, session.user.id);
      const d = await detail(ctx, r.id);
      return r.created ? created(d) : ok(d);
    },
  },
  {
    method: 'GET',
    pattern: new RegExp(`^/api/emails/${UUID}$`),
    async handle(ctx) {
      sessionOf(ctx);
      return ok(await detail(ctx, ctx.match[1]!));
    },
  },
  {
    method: 'GET',
    pattern: new RegExp(`^/api/emails/${UUID}/evidence$`),
    async handle(ctx) {
      sessionOf(ctx);
      return ok(await emailEvidence(ctx.db, ctx.match[1]!));
    },
  },
  {
    method: 'PATCH',
    pattern: new RegExp(`^/api/emails/${UUID}$`),
    async handle(ctx) {
      const session = writes(ctx);
      const body = parseBody(
        z
          .object({
            version: z.number().int().min(1),
            recipient: z
              .union([recipientSchema, z.literal('')])
              .nullable()
              .optional(),
            subject: z
              .string()
              .max(200, 'Usa al massimo 200 caratteri.')
              .refine((s) => !/[\r\n]/.test(s), 'L’oggetto deve stare su una riga.')
              .optional(),
            body: z.string().max(20_000, 'Testo troppo lungo.').optional(),
            objective: z.enum(OBJECTIVE_IDS).optional(),
            tone: z.enum(TONE_IDS).optional(),
            serviceId: serviceId.nullable().optional(),
            instructions: instructions.nullable().optional(),
            status: z.enum(['draft', 'ready']).optional(),
          })
          .strict(),
        ctx.body,
      );
      await updateEmail(ctx.db, ctx.match[1]!, body, session.user.id);
      return ok(await detail(ctx, ctx.match[1]!));
    },
  },
  {
    method: 'POST',
    pattern: new RegExp(`^/api/emails/${UUID}/generate$`),
    async handle(ctx) {
      const session = writes(ctx);
      const body = parseBody(
        z
          .object({
            version: z.number().int().min(1),
            mode: z.enum(['standard', 'ai']),
            objective: z.enum(OBJECTIVE_IDS),
            tone: z.enum(TONE_IDS),
            serviceId: serviceId.nullable().optional(),
            instructions: instructions.nullable().optional(),
            overwrite: z.boolean().default(false),
            templateId: z.enum(TEMPLATE_IDS, { error: 'Modello sconosciuto.' }).optional(),
          })
          .strict(),
        ctx.body,
      );
      if (body.mode === 'ai') limit(ctx, `email-ai:${session.user.id}`, RULES.emailGenerationsByUser);
      await generateEmail(
        ctx.db,
        ctx.match[1]!,
        {
          ...body,
          serviceId: body.serviceId ?? null,
          instructions: body.instructions || null,
        },
        { provider: ctx.state.ai.provider },
        session.user.id,
      );
      return ok(await detail(ctx, ctx.match[1]!));
    },
  },
  {
    method: 'POST',
    pattern: new RegExp(`^/api/emails/${UUID}/archive$`),
    async handle(ctx) {
      const session = writes(ctx);
      const body = parseBody(z.object({ version: z.number().int().min(1) }).strict(), ctx.body);
      await archiveEmail(ctx.db, ctx.match[1]!, body.version, session.user.id);
      return ok(await detail(ctx, ctx.match[1]!));
    },
  },
  {
    method: 'POST',
    pattern: new RegExp(`^/api/emails/${UUID}/restore$`),
    async handle(ctx) {
      const session = writes(ctx);
      await restoreEmail(ctx.db, ctx.match[1]!, session.user.id);
      return ok(await detail(ctx, ctx.match[1]!));
    },
  },
  {
    method: 'GET',
    pattern: new RegExp(`^/api/emails/${UUID}/precheck$`),
    async handle(ctx) {
      sessionOf(ctx);
      return ok(await precheck(ctx.db, ctx.match[1]!, ctx.state.email));
    },
  },
  {
    method: 'POST',
    pattern: new RegExp(`^/api/emails/${UUID}/send$`),
    async handle(ctx) {
      const session = sessionOf(ctx);
      limit(ctx, `email-send:${session.user.id}`, RULES.emailSendsByUser);
      const body = parseBody(
        z
          .object({
            requestId: z.uuid('Richiesta non valida.'),
            version: z.number().int().min(1),
            // conferme esplicite della persona: testo riletto, contatto lecito
            reviewed: z.literal(true, 'Conferma di aver riletto l’email e verificato il destinatario.'),
            lawful: z.literal(true, 'Conferma che il contatto rispetta le norme su privacy e marketing.'),
            acceptUncertain: z.boolean().default(false),
          })
          .strict(),
        ctx.body,
      );
      const result = await sendEmail(
        ctx.db,
        ctx.match[1]!,
        { requestId: body.requestId, version: body.version, acceptUncertain: body.acceptUncertain },
        ctx.state.email,
        session.user.id,
      );
      return ok({ ...result, ...(await detail(ctx, ctx.match[1]!)) });
    },
  },
];
