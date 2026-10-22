import type { AiServices } from '../ai/services.ts';
import type { EmailServices } from '../email/sender.ts';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { z } from 'zod';
import type { FetchPolicy } from '../audit/net/safeFetch.ts';
import type { PerformanceProvider } from '../audit/performance/pagespeed.ts';
import type { AuditConfig, DiscoveryConfig, ServerConfig } from '../config.ts';
import type { DiscoveryProvider } from '../discovery/types.ts';
import type { Db } from '../db/client.ts';
import type { Logger } from '../logger.ts';
import type { RateLimiter } from '../auth/rateLimit.ts';
import type { ValidSession } from '../auth/sessions.ts';

/*
 * Elementi comuni delle rotte HTTP: contesto, definizione delle rotte, errori, validazione.
 * Formato degli errori: { "error": { "code", "message", "fields"? } } con messaggi in italiano.
 */

export class HttpError extends Error {
  readonly status: number;
  readonly code: string;
  readonly fields?: Record<string, string>;
  readonly headers?: Record<string, string>;
  /** Dati aggiuntivi sicuri da mostrare (es. l'id della ricerca identica già attiva). */
  readonly data?: Record<string, unknown>;
  constructor(
    status: number,
    code: string,
    message: string,
    fields?: Record<string, string>,
    headers?: Record<string, string>,
    data?: Record<string, unknown>,
  ) {
    super(message);
    this.status = status;
    this.code = code;
    this.fields = fields;
    this.headers = headers;
    this.data = data;
  }
}

export type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

/** Servizi della scoperta di aziende disponibili alle rotte. */
export interface DiscoveryServices {
  provider: DiscoveryProvider;
  config: DiscoveryConfig;
  /** Avvisa l'esecutore che c'è una ricerca da eseguire (no-op se l'esecutore è disattivato). */
  wake(): void;
  /** L'esecutore delle ricerche è attivo in questo processo. */
  workerActive: boolean;
}

/** Servizi dell'audit dei siti disponibili alle rotte. */
export interface AuditServices {
  config: AuditConfig;
  policy: FetchPolicy;
  /** Fornitore delle misure di prestazione (null se non configurato). La chiave non è mai esposta. */
  performance: PerformanceProvider | null;
  wake(): void;
  workerActive: boolean;
}

/** Ricalcoli in background dei punteggi dei lead. */
export interface ScoringServices {
  wake(): void;
  workerActive: boolean;
}

/** Coordinatore delle ricerche di lead (Lead Hunter). */
export interface HunterServices {
  wake(): void;
  workerActive: boolean;
}

/** Stato del processo condiviso con le rotte (salute, stato del sistema). */
export interface AppState {
  startedAt: Date;
  version: string;
  config: Pick<ServerConfig, 'env' | 'database' | 'security' | 'sessions'>;
  discovery: DiscoveryServices;
  audit: AuditServices;
  scoring: ScoringServices;
  hunter: HunterServices;
  /** Valutazione commerciale con AI. */
  ai: AiServices;
  /** Invio delle email commerciali (Fase 9). */
  email: EmailServices;
}

export interface Context {
  req: IncomingMessage;
  res: ServerResponse;
  db: Db;
  url: URL;
  match: RegExpMatchArray;
  /** Corpo JSON già letto e analizzato (solo POST/PUT/PATCH/DELETE); null se vuoto. */
  body: unknown;
  /** Sessione valida: mai null nelle rotte con `auth` (default). */
  session: ValidSession | null;
  ip: string;
  userAgent: string;
  state: AppState;
  limiter: RateLimiter;
  /** Intestazioni Set-Cookie da aggiungere alla risposta. */
  cookies: string[];
  log: Logger;
}

export interface Reply {
  status: number;
  body?: unknown;
  /** Risposta come file da scaricare (es. esportazione CSV) invece di JSON. */
  file?: { content: string | Buffer; contentType: string; filename: string; headers?: Record<`X-${string}`, string> };
}

export const ok = (body: unknown): Reply => ({ status: 200, body });
export const created = (body: unknown): Reply => ({ status: 201, body });
export const noContent = (): Reply => ({ status: 204 });

export interface Route {
  method: Method;
  pattern: RegExp;
  /**
   * Accesso: 'public' senza sessione; 'user' (predefinito) qualsiasi utente con sessione valida;
   * 'admin' solo amministratori.
   */
  access?: 'public' | 'user' | 'admin';
  /** Rotta raggiungibile anche con password temporanea da cambiare (profilo, cambio password, uscita). */
  allowPendingPassword?: boolean;
  /** Livello del registro per le richieste a questa rotta (le sonde di salute sono frequenti: debug). */
  logLevel?: 'debug' | 'info';
  handle: (ctx: Context) => Promise<Reply | unknown>;
}

/** Sessione presente: nelle rotte protette non è mai null. */
export function sessionOf(ctx: Context): ValidSession {
  if (!ctx.session) throw new HttpError(401, 'UNAUTHENTICATED', 'Accedi per continuare.');
  return ctx.session;
}

/** Valida il corpo con uno schema zod: 400 con un messaggio per campo, in italiano. */
export function parseBody<T extends z.ZodType>(schema: T, body: unknown): z.infer<T> {
  const result = schema.safeParse(body ?? {});
  if (result.success) return result.data;
  const fields: Record<string, string> = {};
  for (const issue of result.error.issues) {
    const key = issue.path.join('.') || '_';
    fields[key] ??= issue.message;
  }
  throw new HttpError(400, 'VALIDATION_ERROR', 'Controlla i campi evidenziati.', fields);
}

/** Valida i parametri della query string (stesso formato di errore del corpo). */
export function parseQuery<T extends z.ZodType>(schema: T, params: URLSearchParams): z.infer<T> {
  return parseBody(schema, Object.fromEntries(params));
}

/** Applica un limite di tentativi: 429 con Retry-After se superato. */
export function limit(ctx: Context, key: string, rule: { limit: number; windowMs: number }) {
  const wait = ctx.limiter.hit(key, rule);
  if (wait > 0) throw tooManyAttempts(wait);
}

export const tooManyAttempts = (wait: number) =>
  new HttpError(429, 'RATE_LIMITED', 'Troppi tentativi in poco tempo. Riprova tra qualche minuto.', undefined, {
    'Retry-After': String(wait),
  });

/** Messaggi di zod in italiano per gli errori più comuni dei moduli. */
export const msg = {
  required: 'Campo obbligatorio.',
  tooLong: (n: number) => `Usa al massimo ${n} caratteri.`,
};
