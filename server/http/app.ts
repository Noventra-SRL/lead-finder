import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { RateLimiter } from '../auth/rateLimit.ts';
import { clearedSessionCookie, readCookie, SESSION_COOKIE, validateSession } from '../auth/sessions.ts';
import { isDatabaseUnavailable, type Db } from '../db/client.ts';
import type { Logger } from '../logger.ts';
import { HttpError, type AppState, type Context, type Reply, type Route } from './core.ts';
import { JobError } from '../discovery/jobs.ts';
import { auditRoutes } from './routes/audits.ts';
import { aiRoutes } from './routes/ai.ts';
import { authRoutes } from './routes/auth.ts';
import { crmRoutes } from './routes/crm.ts';
import { homeRoutes } from './routes/home.ts';
import { emailRoutes } from './routes/email.ts';
import { workflowRoutes } from './routes/workflow.ts';
import { hunterRoutes } from './routes/hunter.ts';
import { scoringRoutes } from './routes/scoring.ts';
import { serviceRoutes } from './routes/services.ts';
import { businessRoutes, discoveryRoutes, geoRoutes } from './routes/discovery.ts';
import { STRICT_TRANSPORT_SECURITY } from './static.ts';
import { systemRoutes } from './routes/system.ts';

/*
 * Gestore delle richieste /api. Protezioni comuni a tutte le rotte:
 *  - richieste che modificano dati: accettate solo dall'origine dell'app (intestazione Origin o
 *    Sec-Fetch-Site: same-origin) e solo con corpo JSON (max 64 KB). Con il cookie SameSite=Strict bloccano il CSRF;
 *  - nessuna intestazione CORS: un altro sito non può leggere le risposte;
 *  - ogni rotta è protetta per impostazione predefinita (sessione richiesta); le pubbliche lo dichiarano;
 *  - password temporanea: finché non viene cambiata, sono raggiungibili solo profilo, cambio password e uscita;
 *  - risposte mai in cache (dati interni) ed errori uniformi: al client non arrivano stack, SQL o dettagli
 *    dell'infrastruttura, che restano nel registro senza corpo della richiesta, cookie o password.
 */

const MAX_URL_LENGTH = 2048;
const MAX_BODY_BYTES = 64 * 1024;

export const routes: Route[] = [
  ...systemRoutes,
  ...authRoutes,
  ...geoRoutes,
  ...discoveryRoutes,
  ...businessRoutes,
  ...auditRoutes,
  ...scoringRoutes,
  ...serviceRoutes,
  ...hunterRoutes,
  ...crmRoutes,
  ...aiRoutes,
  ...homeRoutes,
  ...emailRoutes,
  ...workflowRoutes,
];

export interface AppOptions {
  log: Logger;
  state: AppState;
  limiter?: RateLimiter;
}

function clientIp(req: IncomingMessage, trustProxy: boolean): string {
  if (trustProxy) {
    const forwarded = req.headers['x-forwarded-for'];
    const first = (Array.isArray(forwarded) ? forwarded[0] : forwarded)?.split(',')[0]?.trim();
    if (first) return first;
  }
  return req.socket.remoteAddress ?? 'sconosciuto';
}

function checkOrigin(req: IncomingMessage, appOrigin: string | null, secure: boolean) {
  const expected = appOrigin ?? `${secure ? 'https' : 'http'}://${req.headers.host ?? ''}`;
  const origin = req.headers.origin;
  if (origin ? origin === expected : req.headers['sec-fetch-site'] === 'same-origin') return;
  throw new HttpError(403, 'FORBIDDEN_ORIGIN', 'Richiesta non consentita.');
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  if (Number(req.headers['content-length'] ?? 0) > MAX_BODY_BYTES)
    throw new HttpError(413, 'PAYLOAD_TOO_LARGE', 'Richiesta troppo grande.');
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new HttpError(413, 'PAYLOAD_TOO_LARGE', 'Richiesta troppo grande.');
    chunks.push(chunk as Buffer);
  }
  if (size === 0) return null;
  if (!/^application\/json(;|$)/i.test(req.headers['content-type'] ?? ''))
    throw new HttpError(415, 'UNSUPPORTED_MEDIA_TYPE', 'Formato della richiesta non supportato.');
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, 'INVALID_JSON', 'Richiesta non valida.');
  }
}

function send(
  res: ServerResponse,
  status: number,
  body: unknown,
  head: boolean,
  cookies: string[],
  extra: Record<string, string> = {},
) {
  const json = body === undefined ? '' : JSON.stringify(body);
  res.writeHead(status, {
    ...(json ? { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(json) } : {}),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    ...(cookies.length ? { 'Set-Cookie': cookies } : {}),
    ...extra,
  });
  res.end(head || !json ? undefined : json);
}

/** File da scaricare: tipo dichiarato, nome ASCII sicuro, stesse intestazioni di sicurezza delle risposte JSON. */
function sendFile(
  res: ServerResponse,
  status: number,
  file: NonNullable<Reply['file']>,
  head: boolean,
  cookies: string[],
) {
  const name = file.filename.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 100);
  res.writeHead(status, {
    'Content-Type': file.contentType,
    'Content-Length': Buffer.byteLength(file.content),
    'Content-Disposition': `attachment; filename="${name}"`,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    ...file.headers,
    ...(cookies.length ? { 'Set-Cookie': cookies } : {}),
  });
  res.end(head ? undefined : file.content);
}

const isReply = (v: unknown): v is Reply =>
  typeof v === 'object' &&
  v !== null &&
  typeof (v as Reply).status === 'number' &&
  Object.keys(v).every((k) => k === 'status' || k === 'body' || k === 'file');

/** Gestore indipendente dalla porta: i test lo usano senza avviare il processo del server. */
export function createApp(db: Db, options: AppOptions) {
  const { state } = options;
  const limiter = options.limiter ?? new RateLimiter();
  const { security, sessions: sessionConfig } = state.config;

  return async function handle(req: IncomingMessage, res: ServerResponse) {
    const started = performance.now();
    const requestId = randomUUID().slice(0, 8);
    res.setHeader('X-Request-Id', requestId);
    if (security.secureCookies) res.setHeader('Strict-Transport-Security', STRICT_TRANSPORT_SECURITY);
    const method = req.method ?? 'GET';
    const head = method === 'HEAD';
    const path = (req.url ?? '').split('?')[0] ?? '';
    const cookies: string[] = [];
    let log = options.log.child({ requestId });
    let level: 'debug' | 'info' = 'info';
    let status = 500;

    try {
      if ((req.url ?? '').length > MAX_URL_LENGTH) throw new HttpError(414, 'URI_TOO_LONG', 'Indirizzo troppo lungo.');
      const url = new URL(req.url ?? '/', 'http://localhost');
      const effective = head ? 'GET' : method;
      const candidates = routes.filter((r) => r.pattern.test(url.pathname));
      if (!candidates.length) throw new HttpError(404, 'NOT_FOUND', 'Risorsa non trovata.');
      const route = candidates.find((r) => r.method === effective);
      if (!route) {
        const allowed = [...new Set(candidates.map((r) => r.method))];
        throw new HttpError(405, 'METHOD_NOT_ALLOWED', 'Metodo non consentito.', undefined, {
          Allow: allowed.join(', '),
        });
      }
      level = route.logLevel ?? 'info';
      const access = route.access ?? 'user';

      let body: unknown = null;
      if (effective !== 'GET') {
        checkOrigin(req, security.appOrigin, security.secureCookies);
        body = await readJsonBody(req);
      }

      let session = null;
      if (access !== 'public') {
        const token = readCookie(req.headers.cookie, SESSION_COOKIE);
        session = token ? await validateSession(db, token, sessionConfig) : null;
        if (!session) {
          if (token) {
            cookies.push(clearedSessionCookie(security.secureCookies));
            throw new HttpError(401, 'SESSION_EXPIRED', 'La sessione è scaduta: accedi di nuovo.');
          }
          throw new HttpError(401, 'UNAUTHENTICATED', 'Accedi per continuare.');
        }
        log = log.child({ userId: session.user.id });
        if (session.user.mustChangePassword && !route.allowPendingPassword)
          throw new HttpError(403, 'PASSWORD_CHANGE_REQUIRED', 'Cambia la password temporanea per continuare.');
        if (access === 'admin' && session.user.role !== 'admin')
          throw new HttpError(403, 'FORBIDDEN', 'Il tuo account non ha accesso a questa funzione.');
      }

      const ctx: Context = {
        req,
        res,
        db,
        url,
        match: url.pathname.match(route.pattern)!,
        body,
        session,
        ip: clientIp(req, security.trustProxy),
        userAgent: String(req.headers['user-agent'] ?? '').slice(0, 200),
        state,
        limiter,
        cookies,
        log,
      };
      const result = await route.handle(ctx);
      const reply: Reply = isReply(result) ? result : { status: 200, body: result };
      status = reply.status;
      if (reply.file) sendFile(res, reply.status, reply.file, head, cookies);
      else send(res, reply.status, reply.body, head, cookies);
    } catch (error) {
      let e: HttpError;
      if (error instanceof HttpError) e = error;
      else if (error instanceof JobError)
        e = new HttpError(
          error.status,
          error.code,
          error.message,
          undefined,
          undefined,
          error.jobId || error.data ? { ...(error.jobId ? { jobId: error.jobId } : {}), ...error.data } : undefined,
        );
      else if (error instanceof URIError) e = new HttpError(400, 'INVALID_PATH', 'Indirizzo non valido.');
      else if (isDatabaseUnavailable(error)) {
        e = new HttpError(
          503,
          'DATABASE_UNAVAILABLE',
          'Il database non è raggiungibile in questo momento. Riprova tra poco.',
        );
        log.error('database non raggiungibile', { method, path, code: (error as { code?: string }).code });
      } else {
        e = new HttpError(500, 'INTERNAL_ERROR', 'Si è verificato un errore imprevisto.');
        // solo metodo, percorso ed errore: mai corpo della richiesta, cookie o password
        log.error('errore imprevisto', {
          method,
          path,
          error,
          stack: (error as Error)?.stack?.split('\n').slice(0, 6).join(' | '),
        });
      }
      status = e.status;
      send(
        res,
        e.status,
        {
          error: {
            code: e.code,
            message: e.message,
            ...(e.fields ? { fields: e.fields } : {}),
            ...(e.data ? { data: e.data } : {}),
          },
          requestId,
        },
        head,
        cookies,
        e.headers,
      );
    } finally {
      log[status >= 500 ? 'error' : level === 'debug' ? 'debug' : 'info']('richiesta', {
        method,
        path,
        status,
        ms: Math.round(performance.now() - started),
      });
    }
  };
}
