import { describeDatabase, loadConfig } from '../config.ts';
import { openDatabase } from './client.ts';
import { migrate, migrationStatus } from './migrate.ts';

/*
 * Comandi del database:
 *   npm run db:status   migrazioni applicate e da applicare
 *   npm run db:migrate  applica le migrazioni mancanti
 * Con PGlite, l'API deve essere ferma (un solo processo per cartella dei dati).
 */

const command = process.argv[2];
if (command !== 'status' && command !== 'migrate') {
  console.error('Uso: node server/db/cli.ts status|migrate');
  process.exit(2);
}

try {
  const config = loadConfig();
  console.log(`Database: ${describeDatabase(config.database)}`);
  const db = await openDatabase(config.database);
  try {
    if (command === 'migrate') {
      const done = await migrate(db);
      console.log(done.length ? `Migrazioni applicate: ${done.join(', ')}` : 'Nessuna migrazione da applicare.');
    }
    const status = await migrationStatus(db);
    for (const a of status.applied) console.log(`  ✓ ${a.version}_${a.name}  (${a.appliedAt})`);
    for (const p of status.pending) console.log(`  · ${p}  (da applicare)`);
  } finally {
    await db.close();
  }
} catch (error) {
  console.error(`Errore: ${(error as Error).message}`);
  process.exitCode = 1;
}
