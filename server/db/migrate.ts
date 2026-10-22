import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Db } from './client.ts';

/*
 * Migrazioni versionate: file SQL in server/db/migrations, nominati NNNN_descrizione.sql, applicati in ordine.
 * Ogni migrazione gira in una transazione con un lock consultivo (due avvii contemporanei non la applicano due volte)
 * e viene registrata in schema_migrations con il suo checksum.
 * Una migrazione già applicata non si modifica: se il file cambia, il comando si ferma invece di proseguire.
 * Non esistono migrazioni "down" né reset automatici del database.
 */

export const MIGRATIONS_DIR = fileURLToPath(new URL('./migrations/', import.meta.url));
const LOCK_KEY = 7_310_442; // numero arbitrario, riservato alle migrazioni di Lead Finder

export interface Migration {
  version: string;
  name: string;
  sql: string;
  checksum: string;
}

export function readMigrations(dir = MIGRATIONS_DIR): Migration[] {
  return readdirSync(dir)
    .filter((f) => /^\d{4}_[a-z0-9_]+\.sql$/.test(f))
    .sort()
    .map((file) => {
      // fine riga normalizzata: lo stesso file ha lo stesso checksum su Windows e su Linux
      const sql = readFileSync(`${dir}/${file}`, 'utf8').replace(/\r\n/g, '\n');
      return {
        version: file.slice(0, 4),
        name: file.slice(5, -4),
        sql,
        checksum: createHash('sha256').update(sql).digest('hex'),
      };
    });
}

/** Migrazioni del progetto, lette una volta per processo (i file non cambiano mentre il server è attivo). */
let cached: Migration[] | null = null;
export const projectMigrations = () => (cached ??= readMigrations());

export interface MigrationStatus {
  applied: { version: string; name: string; appliedAt: string }[];
  pending: string[];
}

export class MigrationChangedError extends Error {}

/**
 * Stato delle migrazioni. Sola lettura: non crea nulla (la usano anche la sonda di prontezza e la dashboard),
 * un database vuoto risulta con tutte le migrazioni da applicare.
 */
export async function migrationStatus(db: Db, migrations = projectMigrations()): Promise<MigrationStatus> {
  const exists = await db.query<{ ok: boolean }>("SELECT to_regclass('schema_migrations') IS NOT NULL AS ok");
  const { rows } = exists.rows[0]?.ok
    ? await db.query<{ version: string; name: string; checksum: string; applied_at: Date }>(
        'SELECT version, name, checksum, applied_at FROM schema_migrations ORDER BY version',
      )
    : { rows: [] };
  const applied = new Map(rows.map((r) => [r.version, r]));
  for (const m of migrations) {
    const row = applied.get(m.version);
    if (row && row.checksum !== m.checksum) {
      throw new MigrationChangedError(
        `La migrazione ${m.version}_${m.name} è stata modificata dopo essere stata applicata. Ripristina il file e crea una nuova migrazione.`,
      );
    }
  }
  return {
    applied: rows.map((r) => ({ version: r.version, name: r.name, appliedAt: new Date(r.applied_at).toISOString() })),
    pending: migrations.filter((m) => !applied.has(m.version)).map((m) => `${m.version}_${m.name}`),
  };
}

/** Applica le migrazioni mancanti, in ordine; restituisce quelle applicate ora. */
export async function migrate(db: Db, migrations = projectMigrations()): Promise<string[]> {
  // la tabella di servizio si crea sotto lo stesso lock: due avvii contemporanei non entrano in conflitto
  await db.transaction(async (tx) => {
    await tx.query('SELECT pg_advisory_xact_lock($1)', [LOCK_KEY]);
    await tx.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
      version    text PRIMARY KEY,
      name       text NOT NULL,
      checksum   text NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now()
    )`);
  });
  const status = await migrationStatus(db, migrations);
  const appliedVersions = new Set(status.applied.map((a) => a.version));
  const done: string[] = [];
  for (const m of migrations) {
    if (appliedVersions.has(m.version)) continue;
    const applied = await db.transaction(async (tx) => {
      await tx.query('SELECT pg_advisory_xact_lock($1)', [LOCK_KEY]);
      // ricontrollo dentro il lock: un altro processo potrebbe averla appena applicata
      const { rows } = await tx.query('SELECT 1 FROM schema_migrations WHERE version = $1', [m.version]);
      if (rows.length) return false;
      await tx.exec(m.sql);
      await tx.query('INSERT INTO schema_migrations (version, name, checksum) VALUES ($1, $2, $3)', [
        m.version,
        m.name,
        m.checksum,
      ]);
      return true;
    });
    if (applied) done.push(`${m.version}_${m.name}`);
  }
  return done;
}

/** Errore se il database non è aggiornato: il server non parte su uno schema vecchio. */
export async function assertMigrated(db: Db): Promise<void> {
  const { pending } = await migrationStatus(db);
  if (pending.length) throw new Error(`Migrazioni da applicare: ${pending.join(', ')}. Esegui "npm run db:migrate".`);
}
