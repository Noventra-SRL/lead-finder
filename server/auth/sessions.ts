import { createHash, randomBytes } from 'node:crypto';
import type { SessionConfig } from '../config.ts';
import type { Queryable } from '../db/client.ts';

/*
 * Sessioni salvate nel database:
 *  - il browser riceve un token casuale di 256 bit in un cookie HttpOnly;
 *  - il database conserva solo lo SHA-256 del token (chi legge le tabelle non può impersonare nessuno);
 *  - scadenza per inattività che scorre con l'uso (aggiornata al più una volta al minuto) e limite assoluto fisso;
 *  - "Esci" elimina la sessione sul server; cambiare password chiude tutte le altre sessioni.
 */

export const SESSION_COOKIE = 'nlf_session';
const TOUCH_EVERY_MS = 60_000;

export const newSessionToken = () => randomBytes(32).toString('base64url');
export const sessionIdOf = (token: string) => createHash('sha256').update(token).digest('hex');

export interface SessionUser {
  id: string;
  email: string;
  displayName: string;
  role: 'admin' | 'sales';
  mustChangePassword: boolean;
}

export interface ValidSession {
  sessionId: string;
  user: SessionUser;
  expiresAt: Date;
}

export async function createSession(
  db: Queryable,
  userId: string,
  config: SessionConfig,
  userAgent = '',
  now = new Date(),
): Promise<{ token: string; expiresAt: Date }> {
  const token = newSessionToken();
  const absolute = new Date(now.getTime() + config.maxMs);
  const expiresAt = new Date(Math.min(now.getTime() + config.idleMs, absolute.getTime()));
  await db.query(
    `INSERT INTO sessions (id, user_id, created_at, last_seen_at, expires_at, absolute_expires_at, user_agent)
     VALUES ($1, $2, $3, $3, $4, $5, $6)`,
    [sessionIdOf(token), userId, now, expiresAt, absolute, userAgent.slice(0, 200)],
  );
  return { token, expiresAt };
}

/** Sessione valida per il token, con l'utente; null se inesistente, scaduta o se l'utente è disattivato. */
export async function validateSession(
  db: Queryable,
  token: string,
  config: SessionConfig,
  now = new Date(),
): Promise<ValidSession | null> {
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
  const sessionId = sessionIdOf(token);
  const { rows } = await db.query<{
    expires_at: Date;
    absolute_expires_at: Date;
    last_seen_at: Date;
    id: string;
    email: string;
    display_name: string;
    role: 'admin' | 'sales';
    must_change_password: boolean;
    disabled_at: Date | null;
  }>(
    `SELECT s.expires_at, s.absolute_expires_at, s.last_seen_at,
            u.id, u.email, u.display_name, u.role, u.must_change_password, u.disabled_at
       FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.id = $1`,
    [sessionId],
  );
  const row = rows[0];
  if (!row) return null;
  if (new Date(row.expires_at).getTime() <= now.getTime() || row.disabled_at) {
    await db.query('DELETE FROM sessions WHERE id = $1', [sessionId]);
    return null;
  }
  let expiresAt = new Date(row.expires_at);
  if (now.getTime() - new Date(row.last_seen_at).getTime() >= TOUCH_EVERY_MS) {
    expiresAt = new Date(Math.min(now.getTime() + config.idleMs, new Date(row.absolute_expires_at).getTime()));
    await db.query('UPDATE sessions SET last_seen_at = $2, expires_at = $3 WHERE id = $1', [sessionId, now, expiresAt]);
  }
  return {
    sessionId,
    expiresAt,
    user: {
      id: row.id,
      email: row.email,
      displayName: row.display_name,
      role: row.role,
      mustChangePassword: row.must_change_password,
    },
  };
}

export async function deleteSession(db: Queryable, sessionId: string): Promise<void> {
  await db.query('DELETE FROM sessions WHERE id = $1', [sessionId]);
}

/** Chiude tutte le sessioni di un utente tranne, se indicata, quella corrente. Restituisce quante ne ha chiuse. */
export async function deleteOtherSessions(db: Queryable, userId: string, keepSessionId?: string): Promise<number> {
  const { rows } = await db.query<{ n: number }>(
    `WITH d AS (DELETE FROM sessions WHERE user_id = $1 AND id <> coalesce($2, '') RETURNING 1)
     SELECT count(*)::int AS n FROM d`,
    [userId, keepSessionId ?? null],
  );
  return rows[0]?.n ?? 0;
}

export async function deleteExpiredSessions(db: Queryable, now = new Date()): Promise<number> {
  const { rows } = await db.query<{ n: number }>(
    'WITH d AS (DELETE FROM sessions WHERE expires_at <= $1 RETURNING 1) SELECT count(*)::int AS n FROM d',
    [now],
  );
  return rows[0]?.n ?? 0;
}

export function sessionCookie(token: string, expiresAt: Date, secure: boolean): string {
  // SameSite=Strict: il cookie non parte mai da richieste originate su altri siti; Path=/api: solo verso il server
  return [
    `${SESSION_COOKIE}=${token}`,
    'Path=/api',
    'HttpOnly',
    'SameSite=Strict',
    `Expires=${expiresAt.toUTCString()}`,
    ...(secure ? ['Secure'] : []),
  ].join('; ');
}

export function clearedSessionCookie(secure: boolean): string {
  return [
    `${SESSION_COOKIE}=`,
    'Path=/api',
    'HttpOnly',
    'SameSite=Strict',
    'Max-Age=0',
    ...(secure ? ['Secure'] : []),
  ].join('; ');
}

export function readCookie(header: string | undefined, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq !== -1 && part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return null;
}
