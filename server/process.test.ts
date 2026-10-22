import { spawn, type ChildProcess } from 'node:child_process';
import { listenOnFetchablePort } from './testing.ts';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { scratchPostgresDatabase, testingPostgres } from './testing.ts';

/*
 * Il programma reale, avviato come lo avviano gli script npm: CLI del database e degli utenti, server HTTP.
 *  - npm test:          PostgreSQL incorporato su disco (PGlite) in una cartella temporanea, modalità sviluppo;
 *  - npm run test:postgres: un database dedicato su PostgreSQL e il server in MODALITÀ PRODUZIONE
 *                       (DATABASE_URL, APP_ORIGIN https, cookie Secure, registro JSON).
 */

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const tmp = mkdtempSync(join(tmpdir(), 'nlf-proc-'));
const postgres = testingPostgres();
const APP_ORIGIN = 'https://leads.esempio.it';
let env: NodeJS.ProcessEnv;
let dropDatabase: (() => Promise<void>) | null = null;

interface Run {
  code: number | null;
  output: string;
}

/** Processi avviati dai test: alla fine (anche dopo un test fallito o scaduto) nessuno resta in esecuzione. */
const children = new Set<ChildProcess>();
function track<T extends ChildProcess>(child: T): T {
  children.add(child);
  child.once('exit', () => children.delete(child));
  return child;
}

function run(script: string, args: string[] = [], extraEnv: NodeJS.ProcessEnv = {}): Promise<Run> {
  return new Promise((resolve, reject) => {
    const child = track(spawn(process.execPath, [script, ...args], { cwd: ROOT, env: { ...env, ...extraEnv } }));
    let output = '';
    child.stdout.on('data', (d) => (output += d));
    child.stderr.on('data', (d) => (output += d));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, output }));
  });
}

async function freePort(): Promise<number> {
  const s = createServer();
  const port = await listenOnFetchablePort(s);
  await new Promise<void>((resolve) => s.close(() => resolve()));
  return port;
}

/** Avvia il server reale e attende la riga "server avviato" (o la sua uscita con errore). */
function startServer(port: number): Promise<{ child: ChildProcess; output: () => string }> {
  return new Promise((resolve, reject) => {
    const child = track(
      spawn(process.execPath, ['server/index.ts'], { cwd: ROOT, env: { ...env, API_PORT: String(port) } }),
    );
    let output = '';
    const onData = (d: Buffer) => {
      output += d;
      if (output.includes('server avviato')) resolve({ child, output: () => output });
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('exit', (code) => reject(new Error(`il server è uscito (${code}): ${output}`)));
  });
}

function stop(child: ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    // già terminato (con un codice o da un segnale)
    if (child.exitCode !== null || child.signalCode !== null) return resolve();
    child.removeAllListeners('exit');
    child.once('exit', () => resolve());
    child.kill();
  });
}

beforeAll(async () => {
  const base: NodeJS.ProcessEnv = { PATH: process.env.PATH, SYSTEMROOT: process.env.SYSTEMROOT, LOG_LEVEL: 'info' };
  if (postgres) {
    const scratch = await scratchPostgresDatabase(process.env.TEST_DATABASE_URL!);
    dropDatabase = scratch.drop;
    env = { ...base, NODE_ENV: 'production', DATABASE_URL: scratch.url, APP_ORIGIN };
  } else {
    env = { ...base, PGLITE_DATA_DIR: join(tmp, 'pglite') };
  }
});
afterAll(async () => {
  for (const child of children) await stop(child);
  await dropDatabase?.();
  rmSync(tmp, { recursive: true, force: true });
});

// avviare Node e PGlite (WebAssembly) in un processo nuovo è lento quando gira l'intera suite in parallelo
describe(`programma reale (${postgres ? 'PostgreSQL, produzione' : 'PGlite, sviluppo'})`, { timeout: 90_000 }, () => {
  let temporaryPassword = '';

  it('configurazione non valida: il server non parte e nomina la variabile', async () => {
    const r = await run('server/index.ts', [], { API_PORT: 'abc' });
    expect(r.code).toBe(1);
    expect(r.output).toContain('API_PORT');
  });

  if (postgres) {
    it('produzione senza APP_ORIGIN: il server non parte', async () => {
      const r = await run('server/index.ts', [], { APP_ORIGIN: '' });
      expect(r.code).toBe(1);
      expect(r.output).toContain('APP_ORIGIN');
      expect(r.output).not.toContain(env.DATABASE_URL!.split('@')[0]!.split(':').pop()!);
    });
  }

  it('database non migrato: il server si rifiuta di partire', async () => {
    const r = await run('server/index.ts');
    expect(r.code).toBe(1);
    expect(r.output).toContain('Migrazioni da applicare: 0001_foundation');
  });

  it('db:status e db:migrate', async () => {
    const before = await run('server/db/cli.ts', ['status']);
    expect(before.code).toBe(0);
    expect(before.output).toContain('0001_foundation  (da applicare)');
    const migrated = await run('server/db/cli.ts', ['migrate']);
    expect(migrated.code).toBe(0);
    expect(migrated.output).toContain('Migrazioni applicate: 0001_foundation');
    const again = await run('server/db/cli.ts', ['migrate']);
    expect(again.output).toContain('Nessuna migrazione da applicare.');
  });

  it('CLI degli utenti: crea, rifiuta dati non validi, elenca', async () => {
    const created = await run('server/auth/cli.ts', [
      'crea',
      '--email',
      'Capo@Noventra.test',
      '--nome',
      'Capo Prova',
      '--ruolo',
      'admin',
    ]);
    expect(created.code).toBe(0);
    temporaryPassword = created.output.match(/\n\s{4}(\S{23})\n/)?.[1] ?? '';
    expect(temporaryPassword).toMatch(/^\w{5}-\w{5}-\w{5}-\w{5}$/);

    const invalid = await run('server/auth/cli.ts', ['crea', '--email', 'non-valida', '--nome', 'X']);
    expect(invalid.code).toBe(1);
    expect(invalid.output).toContain('Indirizzo email non valido');
    const duplicate = await run('server/auth/cli.ts', ['crea', '--email', 'capo@noventra.test', '--nome', 'X']);
    expect(duplicate.code).toBe(1);
    expect(duplicate.output).toContain('Esiste già');
    const lastAdmin = await run('server/auth/cli.ts', ['disattiva', '--email', 'capo@noventra.test']);
    expect(lastAdmin.code).toBe(1);
    expect(lastAdmin.output).toContain('ultimo amministratore');

    const list = await run('server/auth/cli.ts', ['elenco']);
    expect(list.code).toBe(0);
    expect(list.output).toMatch(/capo@noventra\.test\s+admin\s+Capo Prova\s+\(password temporanea\)/);
  });

  it('il server parte, è pronto, autentica e (con PGlite) blocca un secondo processo', async () => {
    const port = await freePort();
    const { child, output } = await startServer(port);
    try {
      const url = `http://127.0.0.1:${port}`;
      expect((await fetch(`${url}/api/health/ready`)).status).toBe(200);
      const login = await fetch(`${url}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: postgres ? APP_ORIGIN : url },
        body: JSON.stringify({ email: 'capo@noventra.test', password: temporaryPassword }),
      });
      expect(login.status).toBe(200);
      expect(((await login.json()) as { user: { mustChangePassword: boolean } }).user.mustChangePassword).toBe(true);
      const cookie = login.headers.getSetCookie()[0]!;
      if (postgres) {
        expect(cookie).toContain('Secure');
        expect(login.headers.get('strict-transport-security')).toBe('max-age=31536000');
        // registro di produzione: JSON su una riga, senza password né token
        const lines = output().trim().split('\n');
        for (const line of lines) expect(() => JSON.parse(line)).not.toThrow();
      }
      expect(output()).not.toContain(temporaryPassword);
      expect(output()).not.toContain(cookie.split(';')[0]!.split('=')[1]!);

      if (!postgres) {
        const second = await run('server/db/cli.ts', ['status']);
        expect(second.code).toBe(1);
        expect(second.output).toContain('PGlite accetta un solo processo alla volta');
      }
    } finally {
      await stop(child);
    }
  });

  it('dopo l’arresto i dati restano e il server riparte', async () => {
    const list = await run('server/auth/cli.ts', ['elenco']);
    expect(list.output).toContain('capo@noventra.test');
    const port = await freePort();
    const { child } = await startServer(port);
    try {
      expect((await fetch(`http://127.0.0.1:${port}/api/health/ready`)).status).toBe(200);
    } finally {
      await stop(child);
    }
  });
});
