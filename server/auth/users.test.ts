import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from '../db/client.ts';
import { testDatabase } from '../testing.ts';
import { passwordProblems, temporaryPassword, verifyPassword } from './passwords.ts';
import { createUser, listUsers, resetPassword, setDisabled, setRole, UserError } from './users.ts';

let db: Db;
beforeAll(async () => {
  db = await testDatabase();
});
afterAll(() => db.close());

describe('utenti', () => {
  it('crea un utente con password temporanea Argon2id da cambiare', async () => {
    const created = await createUser(db, { email: ' Capo@Noventra.TEST ', displayName: 'Capo', role: 'admin' });
    const { rows } = await db.query<{ email: string; password_hash: string; must_change_password: boolean }>(
      'SELECT email, password_hash, must_change_password FROM users WHERE id = $1',
      [created.id],
    );
    expect(rows[0]!.email).toBe('capo@noventra.test');
    expect(rows[0]!.password_hash).toMatch(/^\$argon2id\$/);
    expect(rows[0]!.must_change_password).toBe(true);
    expect(await verifyPassword(rows[0]!.password_hash, created.temporaryPassword)).toBe(true);
  });

  it('rifiuta email duplicate e non valide', async () => {
    await expect(
      createUser(db, { email: 'capo@noventra.test', displayName: 'X', role: 'sales' }),
    ).rejects.toBeInstanceOf(UserError);
    await expect(createUser(db, { email: 'non-una-email', displayName: 'X', role: 'sales' })).rejects.toThrow();
  });

  it("non disattiva né declassa l'ultimo amministratore attivo", async () => {
    await expect(setDisabled(db, 'capo@noventra.test', true)).rejects.toThrow(/ultimo amministratore/);
    await expect(setRole(db, 'capo@noventra.test', 'sales')).rejects.toThrow(/almeno un amministratore/);
    await createUser(db, { email: 'vice@noventra.test', displayName: 'Vice', role: 'admin' });
    await setDisabled(db, 'capo@noventra.test', true);
    const users = await listUsers(db);
    expect(users.find((u) => u.email === 'capo@noventra.test')?.disabled).toBe(true);
    await setDisabled(db, 'capo@noventra.test', false);
  });

  it('la reimpostazione cambia la password e la rende di nuovo temporanea', async () => {
    const before = await db.query<{ password_hash: string }>(
      "SELECT password_hash FROM users WHERE email = 'vice@noventra.test'",
    );
    const password = await resetPassword(db, 'vice@noventra.test');
    const after = await db.query<{ password_hash: string; must_change_password: boolean }>(
      "SELECT password_hash, must_change_password FROM users WHERE email = 'vice@noventra.test'",
    );
    expect(after.rows[0]!.password_hash).not.toBe(before.rows[0]!.password_hash);
    expect(after.rows[0]!.must_change_password).toBe(true);
    expect(await verifyPassword(after.rows[0]!.password_hash, password)).toBe(true);
  });
});

describe('password', () => {
  it('password temporanee lunghe, diverse e senza caratteri ambigui', () => {
    const set = new Set(Array.from({ length: 50 }, temporaryPassword));
    expect(set.size).toBe(50);
    for (const p of set) expect(p).toMatch(/^[a-zA-HJ-NP-Z2-9]{5}(-[a-zA-HJ-NP-Z2-9]{5}){3}$/);
  });

  it('regole minime per le nuove password', () => {
    expect(passwordProblems('corta')).not.toEqual([]);
    expect(passwordProblems('aaaaaaaaaaaaaa')).not.toEqual([]);
    expect(passwordProblems('mario.rossi-2026!', { email: 'mario.rossi@noventra.it' })).not.toEqual([]);
    expect(passwordProblems('una-frase-lunga-e-sicura')).toEqual([]);
  });
});
