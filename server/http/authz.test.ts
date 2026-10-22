import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from '../db/client.ts';
import { client, createTestUser, startTestServer, testDatabase, type TestServer } from '../testing.ts';
import { routes } from './app.ts';

/*
 * Autorizzazione su TUTTE le rotte registrate (non un campione): senza sessione 401, con un commerciale sulle rotte
 * riservate agli amministratori 403. Una rotta nuova che dimentica la protezione fa fallire questo test.
 */

const PASSWORD = 'password-di-prova-lunga';
let db: Db;
let server: TestServer;

/** Un indirizzo concreto che soddisfa il pattern della rotta (uuid, prima alternativa, niente ancore). */
function samplePath(pattern: RegExp): string {
  let s = pattern.source.replace(/^\^/, '').replace(/\$$/, '');
  s = s.replace(/\(\[0-9a-f\]\{8\}-\[0-9a-f\]\{4\}-\[0-9a-f\]\{4\}-\[0-9a-f\]\{4\}-\[0-9a-f\]\{12\}\)/g, randomUUID());
  s = s.replace(/\(\\d\{(\d+)\}\)/g, (_, n: string) => '1'.repeat(Number(n)));
  s = s.replace(/\(\[a-z\]\[a-z0-9_\]\{1,40\}\)/g, 'servizio_prova');
  s = s.replace(/\(([^()|]+)(\|[^()]*)?\)/g, '$1');
  s = s.replace(/\\\//g, '/').replace(/\\-/g, '-').replace(/\\\./g, '.');
  return s;
}

beforeAll(async () => {
  db = await testDatabase();
  server = await startTestServer(db);
  await createTestUser(db, { email: 'authz.sales@noventra.test', role: 'sales', password: PASSWORD });
});
afterAll(async () => {
  await server.close();
  await db.close();
});

describe('autorizzazione di ogni rotta', () => {
  const protectedRoutes = routes.filter((r) => r.access !== 'public');

  it('il generatore produce indirizzi validi per ogni rotta', () => {
    for (const r of routes) expect(r.pattern.test(samplePath(r.pattern)), r.pattern.source).toBe(true);
    expect(protectedRoutes.length).toBeGreaterThan(80);
  });

  it('senza sessione: 401 su ogni rotta protetta (nessun dato, nessuna azione)', async () => {
    const anon = client(server.url);
    const failures: string[] = [];
    for (const r of protectedRoutes) {
      const path = samplePath(r.pattern);
      const res = await anon.request(r.method, path, r.method === 'GET' ? undefined : {});
      if (res.status !== 401) failures.push(`${r.method} ${path} → ${res.status}`);
    }
    expect(failures).toEqual([]);
  });

  it('commerciale: 403 su ogni rotta riservata agli amministratori', async () => {
    const sales = client(server.url);
    expect(
      (await sales.request('POST', '/api/auth/login', { email: 'authz.sales@noventra.test', password: PASSWORD }))
        .status,
    ).toBe(200);
    const admin = routes.filter((r) => r.access === 'admin');
    expect(admin.length).toBeGreaterThan(5);
    const failures: string[] = [];
    for (const r of admin) {
      const path = samplePath(r.pattern);
      const res = await sales.request(r.method, path, r.method === 'GET' ? undefined : {});
      if (res.status !== 403) failures.push(`${r.method} ${path} → ${res.status}`);
    }
    expect(failures).toEqual([]);
  });

  it('scrittura da un’altra origine rifiutata anche con una sessione valida (CSRF)', async () => {
    const sales = client(server.url);
    await sales.request('POST', '/api/auth/login', { email: 'authz.sales@noventra.test', password: PASSWORD });
    const res = await sales.request(
      'POST',
      '/api/saved-filters',
      { scope: 'businesses', name: 'x', query: 'q=a' },
      {
        Origin: 'https://sito-malevolo.example',
      },
    );
    expect(res.status).toBe(403);
    const { rows } = await db.query('SELECT 1 FROM saved_filters');
    expect(rows).toHaveLength(0);
  });
});
