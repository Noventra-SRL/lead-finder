import { z } from 'zod';
import { audit } from '../audit.ts';
import type { Db } from '../db/client.ts';
import { hashPassword, passwordProblems, temporaryPassword } from './passwords.ts';
import { deleteOtherSessions } from './sessions.ts';

/*
 * Utenti interni. Nessuna registrazione dall'interfaccia: gli account nascono dalla CLI (npm run user -- crea …)
 * con una password temporanea mostrata una sola volta, da cambiare al primo accesso.
 */

export type Role = 'admin' | 'sales';
export const ROLES: readonly Role[] = ['admin', 'sales'];

export const emailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .max(254)
  .pipe(z.email({ message: 'Indirizzo email non valido.' }));

export interface UserSummary {
  id: string;
  email: string;
  displayName: string;
  role: Role;
  mustChangePassword: boolean;
  disabled: boolean;
  lastLoginAt: string | null;
  createdAt: string;
}

export class UserError extends Error {}

const iso = (d: Date | null) => (d ? new Date(d).toISOString() : null);

export async function listUsers(db: Db): Promise<UserSummary[]> {
  const { rows } = await db.query<{
    id: string;
    email: string;
    display_name: string;
    role: Role;
    must_change_password: boolean;
    disabled_at: Date | null;
    last_login_at: Date | null;
    created_at: Date;
  }>(
    `SELECT id, email, display_name, role, must_change_password, disabled_at, last_login_at, created_at
       FROM users ORDER BY disabled_at NULLS FIRST, display_name`,
  );
  return rows.map((r) => ({
    id: r.id,
    email: r.email,
    displayName: r.display_name,
    role: r.role,
    mustChangePassword: r.must_change_password,
    disabled: r.disabled_at !== null,
    lastLoginAt: iso(r.last_login_at),
    createdAt: iso(r.created_at)!,
  }));
}

async function userIdByEmail(db: Db, email: string): Promise<string> {
  const { rows } = await db.query<{ id: string }>('SELECT id FROM users WHERE email = $1', [email]);
  if (!rows[0]) throw new UserError(`Nessun utente con email ${email}.`);
  return rows[0].id;
}

/** Crea un utente con password temporanea; restituisce la password da comunicare (mostrata una sola volta). */
export async function createUser(
  db: Db,
  input: { email: string; displayName: string; role: Role },
): Promise<{ id: string; temporaryPassword: string }> {
  const email = emailSchema.parse(input.email);
  const displayName = input.displayName.trim();
  if (!displayName || displayName.length > 120) throw new UserError('Il nome deve avere tra 1 e 120 caratteri.');
  if (!ROLES.includes(input.role)) throw new UserError(`Ruolo non valido: usa ${ROLES.join(' o ')}.`);
  const password = temporaryPassword();
  const hash = await hashPassword(password);
  return db.transaction(async (tx) => {
    const exists = await tx.query('SELECT 1 FROM users WHERE email = $1', [email]);
    if (exists.rows.length) throw new UserError(`Esiste già un utente con email ${email}.`);
    const { rows } = await tx.query<{ id: string }>(
      `INSERT INTO users (email, display_name, role, password_hash, must_change_password)
       VALUES ($1, $2, $3, $4, true) RETURNING id`,
      [email, displayName, input.role, hash],
    );
    const id = rows[0]!.id;
    await audit(tx, {
      userId: null,
      action: 'user.created',
      entityType: 'user',
      entityId: id,
      details: { role: input.role, via: 'cli' },
    });
    return { id, temporaryPassword: password };
  });
}

/** Nuova password temporanea; chiude tutte le sessioni dell'utente. */
export async function resetPassword(db: Db, rawEmail: string): Promise<string> {
  const email = emailSchema.parse(rawEmail);
  const id = await userIdByEmail(db, email);
  const password = temporaryPassword();
  const hash = await hashPassword(password);
  await db.transaction(async (tx) => {
    await tx.query(
      `UPDATE users SET password_hash = $2, must_change_password = true, password_changed_at = now(), updated_at = now()
        WHERE id = $1`,
      [id, hash],
    );
    await deleteOtherSessions(tx, id);
    await audit(tx, {
      userId: null,
      action: 'user.password_reset',
      entityType: 'user',
      entityId: id,
      details: { via: 'cli' },
    });
  });
  return password;
}

/** Disattiva (chiudendo le sessioni) o riattiva un utente. Non si disattiva l'ultimo amministratore attivo. */
export async function setDisabled(db: Db, rawEmail: string, disabled: boolean): Promise<void> {
  const email = emailSchema.parse(rawEmail);
  const id = await userIdByEmail(db, email);
  await db.transaction(async (tx) => {
    if (disabled) {
      const { rows } = await tx.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM users WHERE role = 'admin' AND disabled_at IS NULL AND id <> $1`,
        [id],
      );
      const target = await tx.query<{ role: Role }>('SELECT role FROM users WHERE id = $1', [id]);
      if (target.rows[0]?.role === 'admin' && rows[0]!.n === 0)
        throw new UserError("Non puoi disattivare l'ultimo amministratore attivo.");
    }
    await tx.query(
      `UPDATE users SET disabled_at = ${disabled ? 'coalesce(disabled_at, now())' : 'NULL'}, updated_at = now() WHERE id = $1`,
      [id],
    );
    if (disabled) await deleteOtherSessions(tx, id);
    await audit(tx, {
      userId: null,
      action: disabled ? 'user.disabled' : 'user.enabled',
      entityType: 'user',
      entityId: id,
      details: { via: 'cli' },
    });
  });
}

export async function setRole(db: Db, rawEmail: string, role: Role): Promise<void> {
  if (!ROLES.includes(role)) throw new UserError(`Ruolo non valido: usa ${ROLES.join(' o ')}.`);
  const email = emailSchema.parse(rawEmail);
  const id = await userIdByEmail(db, email);
  await db.transaction(async (tx) => {
    if (role !== 'admin') {
      const { rows } = await tx.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM users WHERE role = 'admin' AND disabled_at IS NULL AND id <> $1`,
        [id],
      );
      if (rows[0]!.n === 0) throw new UserError('Deve restare almeno un amministratore attivo.');
    }
    await tx.query('UPDATE users SET role = $2, updated_at = now() WHERE id = $1', [id, role]);
    await audit(tx, {
      userId: null,
      action: 'user.role_changed',
      entityType: 'user',
      entityId: id,
      details: { role, via: 'cli' },
    });
  });
}

/** Cambio password dell'utente stesso (password attuale già verificata dal chiamante). */
export async function changeOwnPassword(
  db: Db,
  user: { id: string; email: string },
  newPassword: string,
  keepSessionId: string,
): Promise<{ closedSessions: number }> {
  const problems = passwordProblems(newPassword, { email: user.email });
  if (problems.length) throw new UserError(problems.join(' '));
  const hash = await hashPassword(newPassword);
  return db.transaction(async (tx) => {
    await tx.query(
      `UPDATE users SET password_hash = $2, must_change_password = false, password_changed_at = now(), updated_at = now()
        WHERE id = $1`,
      [user.id, hash],
    );
    const closedSessions = await deleteOtherSessions(tx, user.id, keepSessionId);
    await audit(tx, {
      userId: user.id,
      action: 'auth.password_changed',
      entityType: 'user',
      entityId: user.id,
      details: { closedSessions },
    });
    return { closedSessions };
  });
}
