import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { DatabaseLockedError, lockDataDir, openDatabase, processStartedAt } from './client.ts';
import { migrate } from './migrate.ts';

/* Comportamenti specifici di PGlite su disco (sviluppo): persistenza e blocco tra processi. */

const tmp = mkdtempSync(join(tmpdir(), 'nlf-pglite-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

// aprire e migrare un database su disco è lento (PGlite in WebAssembly), soprattutto con i test in parallelo
describe('PGlite su disco', { timeout: 60_000 }, () => {
  it('i dati restano dopo la chiusura e la riapertura', async () => {
    const dataDir = join(tmp, 'persist');
    const first = await openDatabase({ kind: 'pglite', dataDir });
    await migrate(first);
    await first.query(
      "INSERT INTO users (email, display_name, role, password_hash) VALUES ('p@esempio.it', 'P', 'admin', 'x')",
    );
    await first.close();
    const second = await openDatabase({ kind: 'pglite', dataDir });
    const { rows } = await second.query<{ email: string }>('SELECT email FROM users');
    expect(rows.map((r) => r.email)).toEqual(['p@esempio.it']);
    await second.close();
  });

  it('rifiuta un secondo apritore mentre il primo è attivo e riprende un blocco orfano', () => {
    const dataDir = join(tmp, 'locked');
    const release = lockDataDir(dataDir);
    // stesso PID: un blocco del processo corrente è comunque "vivo"
    expect(() => lockDataDir(dataDir)).toThrow(DatabaseLockedError);
    release();
    writeFileSync(`${dataDir}.lock`, JSON.stringify({ pid: 999_999_99 }));
    const again = lockDataDir(dataDir);
    again();
  });

  it('PID riassegnato a un altro programma: il blocco orfano viene ripreso', () => {
    const dataDir = join(tmp, 'reused');
    // un processo vivo (il processo padre), ma registrato con un'ora di avvio diversa: è un PID riassegnato
    writeFileSync(`${dataDir}.lock`, JSON.stringify({ pid: process.ppid, processStartedAt: 1_000_000 }));
    lockDataDir(dataDir)();
    // stesso processo vivo con la sua vera ora di avvio: il blocco è valido
    const started = processStartedAt(process.ppid);
    expect(started).not.toBeNull();
    writeFileSync(`${dataDir}.lock`, JSON.stringify({ pid: process.ppid, processStartedAt: started }));
    expect(() => lockDataDir(dataDir)).toThrow(DatabaseLockedError);
  });

  it('il blocco si rilascia alla chiusura del database', async () => {
    const dataDir = join(tmp, 'release');
    const db = await openDatabase({ kind: 'pglite', dataDir });
    await expect(openDatabase({ kind: 'pglite', dataDir })).rejects.toBeInstanceOf(DatabaseLockedError);
    await db.close();
    const again = await openDatabase({ kind: 'pglite', dataDir });
    await again.close();
  });
});
