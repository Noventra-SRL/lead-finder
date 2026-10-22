import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from '../db/client.ts';
import { createLogger } from '../logger.ts';
import { client, createTestUser, startTestServer, testDatabase, type TestServer } from '../testing.ts';
import { routes } from './app.ts';

type ErrorBody = { error: { code: string; message: string }; requestId: string };

let db: Db;
let server: TestServer;
const logLines: string[] = [];

beforeAll(async () => {
  db = await testDatabase();
  server = await startTestServer(db, {
    log: createLogger({ level: 'debug', format: 'json', sink: (l) => logLines.push(l) }),
  });
  await createTestUser(db, { email: 'admin@noventra.test', role: 'admin', password: 'password-di-prova-lunga' });
});
afterAll(async () => {
  await server.close();
  await db.close();
});

describe('salute', () => {
  it('vivacità e prontezza senza autenticazione e senza dettagli interni', async () => {
    const live = await fetch(server.url + '/api/health');
    expect(live.status).toBe(200);
    expect(await live.json()).toEqual({ status: 'ok' });
    const ready = await fetch(server.url + '/api/health/ready');
    expect(ready.status).toBe(200);
    expect(await ready.json()).toEqual({ status: 'ready' });
  });

  it('prontezza: 503 se il database non risponde', async () => {
    const broken: Db = {
      ...db,
      query: () => Promise.reject(Object.assign(new Error('connessione rifiutata'), { code: 'ECONNREFUSED' })),
    };
    const s = await startTestServer(broken);
    try {
      const res = await fetch(s.url + '/api/health/ready');
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ status: 'not_ready', reason: 'database_unavailable' });
    } finally {
      await s.close();
    }
  });

  it('prontezza: 503 con migrazioni da applicare, senza modificare il database', async () => {
    const empty = await testDatabase({ migrate: false });
    const s = await startTestServer(empty);
    try {
      const res = await fetch(s.url + '/api/health/ready');
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ status: 'not_ready', reason: 'migrations_pending' });
      const { rows } = await empty.query<{ missing: boolean }>(
        "SELECT to_regclass('schema_migrations') IS NULL AS missing",
      );
      expect(rows[0]!.missing).toBe(true);
    } finally {
      await s.close();
      await empty.close();
    }
  });
});

describe('stato del sistema', () => {
  it('riporta database, migrazioni e conteggi reali', async () => {
    const c = client(server.url);
    await c.request('POST', '/api/auth/login', { email: 'admin@noventra.test', password: 'password-di-prova-lunga' });
    const res = await c.request('GET', '/api/system/status');
    expect(res.status).toBe(200);
    expect(res.body.database.migrationsPending).toEqual([]);
    expect(res.body.database.migrationsApplied[0].version).toBe('0001');
    expect(res.body.counts.activeUsers).toBe(1);
    expect(res.body.counts.activeSessions).toBe(1);
  });
});

describe('errori uniformi', () => {
  it('404 e 405 con codice e messaggio in italiano', async () => {
    const missing = await fetch(server.url + '/api/inesistente');
    expect(missing.status).toBe(404);
    expect(((await missing.json()) as ErrorBody).error.code).toBe('NOT_FOUND');
    const wrong = await fetch(server.url + '/api/health', { method: 'DELETE', headers: { Origin: server.url } });
    expect(wrong.status).toBe(405);
    expect(wrong.headers.get('allow')).toBe('GET');
  });

  it('500 senza dettagli interni al client, con id della richiesta nel registro', async () => {
    const failing: Db = { ...db, query: () => Promise.reject(new Error('relation "segreta" does not exist')) };
    const s = await startTestServer(failing, {
      log: createLogger({ level: 'debug', format: 'json', sink: (l) => logLines.push(l) }),
    });
    try {
      const res = await fetch(s.url + '/api/system/status', { headers: { Cookie: 'nlf_session=' + 'a'.repeat(43) } });
      expect(res.status).toBe(500);
      const body = (await res.json()) as ErrorBody;
      expect(body.error).toEqual({ code: 'INTERNAL_ERROR', message: 'Si è verificato un errore imprevisto.' });
      expect(JSON.stringify(body)).not.toContain('segreta');
      expect(logLines.some((l) => l.includes(body.requestId) && l.includes('segreta'))).toBe(true);
    } finally {
      await s.close();
    }
  });

  it('intestazioni di sicurezza e nessuna cache su ogni risposta', async () => {
    const res = await fetch(server.url + '/api/health');
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('x-frame-options')).toBe('DENY');
    expect(res.headers.get('x-request-id')).toMatch(/^[0-9a-f]{8}$/);
    // in sviluppo (http) niente HSTS: imposterebbe HTTPS obbligatorio su localhost
    expect(res.headers.get('strict-transport-security')).toBeNull();
  });

  it('in produzione: HSTS e cookie Secure', async () => {
    const s = await startTestServer(db, {
      security: { appOrigin: 'https://leads.esempio.it', secureCookies: true, trustProxy: false },
    });
    try {
      const health = await fetch(s.url + '/api/health');
      expect(health.headers.get('strict-transport-security')).toBe('max-age=31536000');
      const login = await fetch(s.url + '/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: 'https://leads.esempio.it' },
        body: JSON.stringify({ email: 'admin@noventra.test', password: 'password-di-prova-lunga' }),
      });
      expect(login.status).toBe(200);
      expect(login.headers.getSetCookie()[0]).toMatch(/; Secure$/);
      // con APP_ORIGIN configurata, l'origine della richiesta stessa non basta più
      const sameHost = await fetch(s.url + '/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: s.url },
        body: JSON.stringify({ email: 'admin@noventra.test', password: 'password-di-prova-lunga' }),
      });
      expect(sameHost.status).toBe(403);
    } finally {
      await s.close();
    }
  });

  it('il registro non contiene password né cookie', async () => {
    const c = client(server.url);
    await c.request('POST', '/api/auth/login', { email: 'admin@noventra.test', password: 'password-di-prova-lunga' });
    await c.request('GET', '/api/auth/me');
    const all = logLines.join('\n');
    expect(all).not.toContain('password-di-prova-lunga');
    expect(all).not.toContain(c.cookie.split('=')[1]);
  });
});

describe('definizione delle rotte', () => {
  it('ogni rotta pubblica è dichiarata esplicitamente e sono solo quelle attese', () => {
    const publicRoutes = routes.filter((r) => r.access === 'public').map((r) => `${r.method} ${r.pattern.source}`);
    expect(publicRoutes).toEqual([
      'GET ^\\/api\\/health$',
      'GET ^\\/api\\/health\\/ready$',
      'GET ^\\/api\\/auth\\/session$',
      'POST ^\\/api\\/auth\\/login$',
    ]);
  });
});
