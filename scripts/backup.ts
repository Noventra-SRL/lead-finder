import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { loadConfig } from '../server/config.ts';
import { DatabaseLockedError, lockDataDir } from '../server/db/client.ts';

/*
 * Copia e ripristino del database incorporato (PGlite). Mai distruttivo:
 *  - backup:  npm run db:backup [-- --out cartella]  → backups/pglite-AAAAMMGG-HHMMSS.tar.gz (server fermo: lock)
 *  - ripristino: npm run db:restore -- --from file.tar.gz --to cartella-nuova
 *    crea una cartella NUOVA (rifiuta una cartella esistente); per usarla impostare PGLITE_DATA_DIR e riavviare.
 * Con PostgreSQL (produzione) si usano gli strumenti standard: pg_dump / pg_restore (vedi docs/rilascio.md).
 */

const args = process.argv.slice(2);
const arg = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const command = args[0];
const config = loadConfig(process.env);

if (command === 'backup') {
  if (config.database.kind !== 'pglite') {
    console.error('Il database configurato è PostgreSQL: usa pg_dump (vedi docs/rilascio.md).');
    process.exit(2);
  }
  const dataDir = config.database.dataDir;
  let release: () => void;
  try {
    release = lockDataDir(dataDir); // fallisce se il server è in esecuzione: solo copie coerenti
  } catch (error) {
    if (!(error instanceof DatabaseLockedError)) throw error;
    console.error(`Backup non eseguito: ${error.message}`);
    process.exit(1);
  }
  try {
    const pg = await PGlite.create(dataDir);
    const { rows } = await pg.query<{ n: number }>('SELECT count(*)::int AS n FROM businesses');
    const dump = await pg.dumpDataDir('gzip');
    await pg.close();
    const outDir = resolve(arg('out') ?? 'backups');
    mkdirSync(outDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
    const file = resolve(outDir, `pglite-${stamp}.tar.gz`);
    writeFileSync(file, Buffer.from(await dump.arrayBuffer()), { flag: 'wx' });
    console.log(`Backup creato: ${file} (${Math.round(dump.size / 1024)} KB, ${rows[0]!.n} aziende).`);
  } finally {
    release();
  }
} else if (command === 'restore') {
  const from = arg('from');
  const to = arg('to');
  if (!from || !to) {
    console.error('Uso: npm run db:restore -- --from backups/file.tar.gz --to .data/ripristino');
    process.exit(2);
  }
  if (existsSync(to)) {
    console.error(`La cartella ${to} esiste già: il ripristino crea solo una cartella nuova, non sovrascrive nulla.`);
    process.exit(2);
  }
  mkdirSync(dirname(resolve(to)), { recursive: true });
  const blob = new Blob([readFileSync(from)]);
  const pg = await PGlite.create(to, { loadDataDir: blob });
  const { rows } = await pg.query<{ n: number }>('SELECT count(*)::int AS n FROM businesses');
  const { rows: m } = await pg.query<{ v: string }>('SELECT max(version)::text AS v FROM schema_migrations');
  await pg.close();
  console.log(`Ripristino completato in ${to}: ${rows[0]!.n} aziende, ultima migrazione ${m[0]!.v}.`);
  console.log(`Per usarlo: PGLITE_DATA_DIR=${to} (server fermo), poi npm run db:status e npm run start:api.`);
} else {
  console.error('Comandi: backup | restore');
  process.exit(2);
}
