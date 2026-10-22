import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { testDatabase } from '../testing.ts';
import { MigrationChangedError, migrate, migrationStatus, readMigrations } from './migrate.ts';

/* Migrazioni: valgono per PGlite (npm test) e per PostgreSQL tramite `pg` (npm run test:postgres). */

const tmp = mkdtempSync(join(tmpdir(), 'nlf-mig-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

function migrationsDir(name: string, files: Record<string, string>) {
  const dir = join(tmp, name);
  mkdirSync(dir, { recursive: true });
  for (const [file, sql] of Object.entries(files)) writeFileSync(join(dir, file), sql);
  return dir;
}

describe('migrazioni', () => {
  // applica tutte le migrazioni da zero mentre gli altri file di test girano in parallelo: tempo massimo più ampio
  it('le migrazioni del progetto si applicano in ordine e una sola volta', { timeout: 60_000 }, async () => {
    const db = await testDatabase({ migrate: false });
    try {
      const all = readMigrations();
      expect(all.length).toBeGreaterThan(0);
      expect(all.map((m) => m.version)).toEqual([...all.map((m) => m.version)].sort());
      expect(await migrate(db)).toEqual(all.map((m) => `${m.version}_${m.name}`));
      expect(await migrate(db)).toEqual([]);
      const status = await migrationStatus(db);
      expect(status.pending).toEqual([]);
      expect(status.applied).toHaveLength(all.length);
    } finally {
      await db.close();
    }
  });

  it('lo stato su un database vuoto è in sola lettura: non crea tabelle', async () => {
    const db = await testDatabase({ migrate: false });
    try {
      const status = await migrationStatus(db);
      expect(status.applied).toEqual([]);
      expect(status.pending.length).toBeGreaterThan(0);
      const { rows } = await db.query<{ ok: boolean }>("SELECT to_regclass('schema_migrations') IS NULL AS ok");
      expect(rows[0]!.ok).toBe(true);
    } finally {
      await db.close();
    }
  });

  it('si ferma se una migrazione applicata è stata modificata', async () => {
    const dir = migrationsDir('modificata', { '0001_t.sql': 'CREATE TABLE t (id int);' });
    const db = await testDatabase({ migrate: false });
    try {
      await migrate(db, readMigrations(dir));
      writeFileSync(join(dir, '0001_t.sql'), 'CREATE TABLE t (id bigint);');
      await expect(migrate(db, readMigrations(dir))).rejects.toBeInstanceOf(MigrationChangedError);
    } finally {
      await db.close();
    }
  });

  it('una migrazione che fallisce non lascia modifiche parziali', async () => {
    const dir = migrationsDir('rotta', {
      '0001_ok.sql': 'CREATE TABLE a (id int);',
      '0002_rotta.sql': 'CREATE TABLE b (id int); SELECT colonna_inesistente FROM a;',
    });
    const db = await testDatabase({ migrate: false });
    try {
      await expect(migrate(db, readMigrations(dir))).rejects.toThrow();
      const { rows } = await db.query<{ missing: boolean }>("SELECT to_regclass('b') IS NULL AS missing");
      expect(rows[0]!.missing).toBe(true);
      expect((await migrationStatus(db, readMigrations(dir))).pending).toEqual(['0002_rotta']);
    } finally {
      await db.close();
    }
  });

  it('due migrazioni contemporanee non applicano due volte lo stesso file', async () => {
    const db = await testDatabase({ migrate: false });
    try {
      const results = await Promise.all([migrate(db), migrate(db)]);
      expect(results.flat()).toEqual(readMigrations().map((m) => `${m.version}_${m.name}`));
    } finally {
      await db.close();
    }
  });

  it('nessuna migrazione elimina tabelle o colonne', () => {
    for (const m of readMigrations()) expect(m.sql, `${m.version}_${m.name}`).not.toMatch(/\bDROP\s+(TABLE|COLUMN)\b/i);
  });
});

describe('vincoli dello schema', () => {
  it('rifiuta email non minuscole, ruoli sconosciuti ed email duplicate', async () => {
    const db = await testDatabase();
    try {
      const insert = (email: string, role = 'sales') =>
        db.query("INSERT INTO users (email, display_name, role, password_hash) VALUES ($1, 'X', $2, 'h')", [
          email,
          role,
        ]);
      await insert('a@esempio.it');
      await expect(insert('B@esempio.it')).rejects.toThrow();
      await expect(insert('c@esempio.it', 'superuser')).rejects.toThrow();
      await expect(insert('a@esempio.it')).rejects.toThrow();
    } finally {
      await db.close();
    }
  });

  it('eliminare un utente elimina le sue sessioni e conserva il registro senza riferimento', async () => {
    const db = await testDatabase();
    try {
      const { rows } = await db.query<{ id: string }>(
        "INSERT INTO users (email, display_name, role, password_hash) VALUES ('d@esempio.it', 'D', 'sales', 'h') RETURNING id",
      );
      const id = rows[0]!.id;
      await db.query(
        "INSERT INTO sessions (id, user_id, expires_at, absolute_expires_at) VALUES (repeat('a', 64), $1, now() + interval '1 hour', now() + interval '1 day')",
        [id],
      );
      await db.query("INSERT INTO audit_log (user_id, action) VALUES ($1, 'auth.login')", [id]);
      await db.query('DELETE FROM users WHERE id = $1', [id]);
      expect((await db.query('SELECT 1 FROM sessions WHERE user_id = $1', [id])).rows).toHaveLength(0);
      const log = await db.query<{ user_id: string | null }>(
        "SELECT user_id FROM audit_log WHERE action = 'auth.login'",
      );
      expect(log.rows).toEqual([{ user_id: null }]);
    } finally {
      await db.close();
    }
  });
});
