import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import pg from 'pg';
import type { DatabaseConfig } from '../config.ts';

/*
 * Accesso al database: un'unica interfaccia minima, due modi di raggiungere lo stesso PostgreSQL.
 *  - 'postgres': driver `pg` con pool di connessioni (produzione, PostgreSQL gestito o installato);
 *  - 'pglite':   PostgreSQL incorporato (sviluppo e test), nessuna installazione richiesta.
 * Le query sono sempre parametrizzate ($1, $2, …): nessun valore esterno entra nel testo SQL.
 */

export type Row = Record<string, unknown>;

export interface Queryable {
  query<T extends object = Row>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
}

export interface Tx extends Queryable {
  exec(sql: string): Promise<void>;
}

export interface Db extends Tx {
  /** Transazione: COMMIT se `fn` termina, ROLLBACK se lancia un errore. */
  transaction<T>(fn: (tx: Tx) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

function fromPglite(pgl: PGlite): Db {
  return {
    async query<T extends object>(sql: string, params: unknown[] = []) {
      return { rows: (await pgl.query<T>(sql, params)).rows };
    },
    async exec(sql) {
      await pgl.exec(sql);
    },
    transaction(fn) {
      return pgl.transaction((tx) =>
        fn({
          async query<T extends object>(sql: string, params: unknown[] = []) {
            return { rows: (await tx.query<T>(sql, params)).rows };
          },
          async exec(sql: string) {
            await tx.exec(sql);
          },
        }),
      );
    },
    close: () => pgl.close(),
  };
}

function fromPool(pool: pg.Pool): Db {
  return {
    async query<T extends object>(sql: string, params: unknown[] = []) {
      return { rows: (await pool.query(sql, params)).rows as T[] };
    },
    async exec(sql) {
      await pool.query(sql);
    },
    async transaction(fn) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const result = await fn({
          async query<T extends object>(sql: string, params: unknown[] = []) {
            return { rows: (await client.query(sql, params)).rows as T[] };
          },
          async exec(sql: string) {
            await client.query(sql);
          },
        });
        await client.query('COMMIT');
        return result;
      } catch (error) {
        // il ROLLBACK può fallire solo se la connessione è già persa: l'errore originale resta quello da riportare
        await client.query('ROLLBACK').catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    },
    close: () => pool.end(),
  };
}

/*
 * Un solo processo alla volta per cartella di PGlite. PGlite non ha un blocco tra processi: due processi sulla stessa
 * cartella (es. l'API e un comando del database) si sovrascrivono il registro delle transazioni e il database non
 * riparte più. Il blocco è un file accanto alla cartella con il PID di chi la usa e l'ora di avvio di quel processo.
 * Un file lasciato da un processo terminato viene ripreso; uno di un processo ancora vivo blocca l'apertura con un
 * messaggio chiaro. Il sistema operativo (Windows in particolare) riassegna presto i PID: se il PID risulta vivo ma il
 * processo con quel PID è partito in un altro momento, è un altro programma e il blocco è orfano.
 */
export class DatabaseLockedError extends Error {}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: il processo esiste ma appartiene a un altro utente
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Ora di avvio (ms) del processo con questo PID secondo il sistema operativo; null se non determinabile. */
export function processStartedAt(pid: number): number | null {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  const r =
    process.platform === 'win32'
      ? spawnSync(
          'powershell.exe',
          [
            '-NoProfile',
            '-NonInteractive',
            '-Command',
            `$p = Get-Process -Id ${pid} -ErrorAction SilentlyContinue; if ($p) { $p.StartTime.ToUniversalTime().ToString('o') }`,
          ],
          { encoding: 'utf8', timeout: 15_000, windowsHide: true },
        )
      : spawnSync('ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8', timeout: 5_000 });
  const t = Date.parse((r.stdout ?? '').trim());
  return Number.isNaN(t) ? null : t;
}

/** Ora di avvio di questo processo, come la vedrebbe processStartedAt. */
const ownStartedAt = () => Math.round(Date.now() - process.uptime() * 1000);

/** Il proprietario registrato nel blocco è ancora in esecuzione (stesso PID e stessa ora di avvio). */
function ownerRunning(owner: { pid?: number; processStartedAt?: number }): boolean {
  if (typeof owner.pid !== 'number' || !processAlive(owner.pid)) return false;
  if (typeof owner.processStartedAt !== 'number') return true;
  const actual = processStartedAt(owner.pid);
  // ora non determinabile: per prudenza il blocco resta valido
  return actual === null || Math.abs(actual - owner.processStartedAt) < 5_000;
}

export function lockDataDir(dataDir: string): () => void {
  const lockPath = `${resolve(dataDir).replace(/[\\/]+$/, '')}.lock`;
  const content = JSON.stringify({
    pid: process.pid,
    processStartedAt: ownStartedAt(),
    started: new Date().toISOString(),
    command: process.argv.slice(1).join(' '),
  });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      writeFileSync(lockPath, content, { flag: 'wx' });
      let released = false;
      const release = () => {
        if (released) return;
        released = true;
        process.off('exit', release);
        try {
          if (JSON.parse(readFileSync(lockPath, 'utf8')).pid === process.pid) unlinkSync(lockPath);
        } catch {
          // file già rimosso o illeggibile: non c'è nulla da rilasciare
        }
      };
      process.on('exit', release);
      return release;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      let owner: { pid?: number; processStartedAt?: number; command?: string } = {};
      try {
        owner = JSON.parse(readFileSync(lockPath, 'utf8'));
      } catch {
        // file illeggibile: trattato come lasciato da un processo terminato
      }
      if (typeof owner.pid === 'number' && owner.pid !== process.pid && !ownerRunning(owner)) {
        unlinkSync(lockPath);
        continue;
      }
      throw new DatabaseLockedError(
        `Il database in ${dataDir} è già aperto dal processo ${owner.pid ?? 'sconosciuto'}` +
          `${owner.command ? ` (${owner.command})` : ''}. PGlite accetta un solo processo alla volta: ferma prima l'altro ` +
          `(ad esempio l'API con Ctrl+C) e riprova.`,
      );
    }
  }
  throw new DatabaseLockedError(`Impossibile bloccare il database in ${dataDir}: riprova.`);
}

export async function openDatabase(config: DatabaseConfig): Promise<Db> {
  if (config.kind === 'postgres') {
    const pool = new pg.Pool({
      connectionString: config.url,
      ssl: config.ssl ? { rejectUnauthorized: true } : undefined,
      max: 10,
      // una query bloccata non deve occupare la richiesta all'infinito
      statement_timeout: 15_000,
      connectionTimeoutMillis: 5_000,
    });
    // errori dei client inattivi (es. connessione chiusa dal server): il pool li gestisce, qui si evita il crash
    pool.on('error', () => undefined);
    return fromPool(pool);
  }
  if (config.kind === 'pglite') {
    mkdirSync(dirname(resolve(config.dataDir)), { recursive: true });
    const release = lockDataDir(config.dataDir);
    let pgl: PGlite;
    try {
      pgl = await PGlite.create(config.dataDir);
    } catch (error) {
      release();
      throw error;
    }
    const db = fromPglite(pgl);
    return { ...db, close: () => db.close().finally(release) };
  }
  return fromPglite(await PGlite.create());
}

/** Errori di connessione o disponibilità del database (classi SQLSTATE 08, 53, 57 e codici di rete). */
export function isDatabaseUnavailable(error: unknown): boolean {
  const code = (error as { code?: unknown })?.code;
  return (
    typeof code === 'string' &&
    (/^(08|53|57)/.test(code) || ['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN'].includes(code))
  );
}
