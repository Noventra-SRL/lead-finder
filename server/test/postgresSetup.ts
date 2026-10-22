import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/*
 * Configurazione globale di "npm run test:postgres": tutta la suite di integrazione gira su un vero PostgreSQL
 * attraverso il driver `pg` usato in produzione (non PGlite).
 *  - Con TEST_DATABASE_URL impostata si usa quel server (un utente che può creare database). Ogni file di test
 *    crea il proprio database e lo elimina alla fine.
 *  - Altrimenti si crea un cluster PostgreSQL temporaneo con i binari ufficiali del pacchetto
 *    @embedded-postgres/<piattaforma> (initdb + pg_ctl), in una cartella temporanea, solo su 127.0.0.1,
 *    con una password casuale; alla fine si arresta in modo pulito e la cartella viene eliminata.
 */

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address() as { port: number };
      s.close(() => resolve(port));
    });
  });
}

/**
 * Esegue un binario di PostgreSQL. Uscita su "ignore": "pg_ctl start" lascia PostgreSQL in esecuzione e quel processo
 * erediterebbe i flussi di uscita, tenendo spawnSync in attesa per sempre (il registro va comunque nel file -l).
 */
function exec(bin: string, args: string[], logFile: string) {
  const r = spawnSync(bin, args, { stdio: 'ignore', timeout: 60_000 });
  if (r.status !== 0) {
    let log = '';
    try {
      log = readFileSync(logFile, 'utf8').slice(-2000);
    } catch {
      // registro non ancora creato (es. initdb fallito prima dell'avvio)
    }
    throw new Error(`${bin} ${args[0]} non riuscito (uscita ${r.status ?? r.error?.message}). ${log}`);
  }
}

export default async function setup() {
  if (process.env.TEST_DATABASE_URL) return;
  const platform = process.platform === 'win32' ? 'windows' : process.platform;
  const binaries = `@embedded-postgres/${platform}-${process.arch}`;
  let pkg: { initdb: string; pg_ctl: string };
  try {
    pkg = (await import(binaries)) as typeof pkg;
  } catch {
    throw new Error(
      `Binari di PostgreSQL non installati per questa piattaforma (${binaries}). ` +
        `Installali con "npm install --no-save ${binaries}" oppure imposta TEST_DATABASE_URL verso un PostgreSQL di prova.`,
    );
  }
  const { initdb, pg_ctl: pgCtl } = pkg;
  const dir = mkdtempSync(join(tmpdir(), 'nlf-pg-'));
  const data = join(dir, 'data');
  const port = await freePort();
  const password = randomBytes(18).toString('base64url');
  writeFileSync(join(dir, 'pw'), password);

  const log = join(dir, 'postgres.log');
  exec(
    initdb,
    [
      '-D',
      data,
      '-U',
      'postgres',
      '--pwfile',
      join(dir, 'pw'),
      '--auth=scram-sha-256',
      '--encoding=UTF8',
      '--locale=C',
    ],
    log,
  );
  exec(pgCtl, ['start', '-D', data, '-w', '-l', log, '-o', `-p ${port} -c listen_addresses=127.0.0.1`], log);
  process.env.TEST_DATABASE_URL = `postgres://postgres:${password}@127.0.0.1:${port}/postgres`;
  process.stdout.write(`PostgreSQL di prova avviato su 127.0.0.1:${port}\n`);

  return () => {
    exec(pgCtl, ['stop', '-D', data, '-m', 'fast', '-w'], log);
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  };
}
