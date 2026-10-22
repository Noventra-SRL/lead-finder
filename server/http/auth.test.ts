import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { RateLimiter } from '../auth/rateLimit.ts';
import { sessionIdOf } from '../auth/sessions.ts';
import { resetPassword, setDisabled } from '../auth/users.ts';
import type { Db } from '../db/client.ts';
import { client, createTestUser, startTestServer, testDatabase, type TestServer } from '../testing.ts';

const PASSWORD = 'corretta-cavallo-batteria';
let db: Db;
let server: TestServer;

beforeAll(async () => {
  db = await testDatabase();
  server = await startTestServer(db);
  await createTestUser(db, { email: 'admin@noventra.test', role: 'admin', password: PASSWORD });
  await createTestUser(db, { email: 'sales@noventra.test', role: 'sales', password: PASSWORD });
});
afterAll(async () => {
  await server.close();
  await db.close();
});
beforeEach(() => {
  // limiti di tentativi azzerati: ogni test parte pulito
  (server.limiter as unknown as { hits: Map<string, unknown> }).hits.clear();
});

async function login(email: string, password = PASSWORD) {
  const c = client(server.url);
  const res = await c.request('POST', '/api/auth/login', { email, password });
  return { c, res };
}

describe('accesso', () => {
  it('accede, imposta un cookie sicuro e restituisce l’utente', async () => {
    const { c, res } = await login('Admin@Noventra.test ');
    expect(res.status).toBe(200);
    expect(res.body.user).toMatchObject({ email: 'admin@noventra.test', role: 'admin', mustChangePassword: false });
    const cookie = res.setCookie[0]!;
    expect(cookie).toMatch(/^nlf_session=[A-Za-z0-9_-]{43};/);
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Strict');
    expect(cookie).toContain('Path=/api');
    const me = await c.request('GET', '/api/auth/me');
    expect(me.status).toBe(200);
    expect(me.body.user.email).toBe('admin@noventra.test');
  });

  it('salva solo l’hash del token, mai il token', async () => {
    const { c } = await login('admin@noventra.test');
    const token = c.cookie.split('=')[1]!;
    const { rows } = await db.query<{ id: string }>('SELECT id FROM sessions');
    expect(rows.map((r) => r.id)).toContain(sessionIdOf(token));
    expect(rows.map((r) => r.id)).not.toContain(token);
  });

  it('stesso errore per password sbagliata ed email inesistente', async () => {
    const wrong = (await login('admin@noventra.test', 'password-sbagliata')).res;
    const unknown = (await login('nessuno@noventra.test', 'password-sbagliata')).res;
    expect(wrong.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(wrong.body.error).toEqual(unknown.body.error);
    expect(wrong.setCookie).toEqual([]);
  });

  it('valida il corpo con errori per campo', async () => {
    const res = await client(server.url).request('POST', '/api/auth/login', { email: 'x' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(res.body.error.fields.password).toBeTruthy();
  });

  it('blocca un account dopo troppi tentativi falliti, anche con la password giusta', async () => {
    for (let i = 0; i < 6; i++) expect((await login('sales@noventra.test', 'sbagliata-000')).res.status).toBe(401);
    const blocked = (await login('sales@noventra.test')).res;
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get('retry-after')).toMatch(/^\d+$/);
  });

  it('registra accessi e tentativi falliti senza password', async () => {
    await login('admin@noventra.test', 'tentativo-sbagliato-123');
    const { rows } = await db.query<{ action: string; details: unknown }>(
      "SELECT action, details FROM audit_log WHERE action LIKE 'auth.%' ORDER BY id",
    );
    expect(rows.some((r) => r.action === 'auth.login')).toBe(true);
    expect(rows.some((r) => r.action === 'auth.login_failed')).toBe(true);
    expect(JSON.stringify(rows)).not.toContain('tentativo-sbagliato-123');
  });
});

describe('stato della sessione (apertura dell’app)', () => {
  it('senza cookie: 200 con utente nullo, nessun errore', async () => {
    const res = await client(server.url).request('GET', '/api/auth/session');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ user: null });
  });

  it('con sessione valida: l’utente', async () => {
    const { c } = await login('admin@noventra.test');
    const res = await c.request('GET', '/api/auth/session');
    expect(res.status).toBe(200);
    expect(res.body.user).toMatchObject({ email: 'admin@noventra.test', role: 'admin' });
  });

  it('con cookie scaduto o falso: utente nullo, "expired" e cookie cancellato', async () => {
    const res = await client(server.url).request('GET', '/api/auth/session', undefined, {
      Cookie: 'nlf_session=' + 'b'.repeat(43),
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ user: null, expired: true });
    expect(res.setCookie[0]).toContain('Max-Age=0');
  });
});

describe('protezione delle rotte', () => {
  it('senza sessione: 401', async () => {
    const res = await client(server.url).request('GET', '/api/system/status');
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHENTICATED');
  });

  it('cookie non valido: 401 e cookie cancellato', async () => {
    const res = await client(server.url).request('GET', '/api/auth/me', undefined, {
      Cookie: 'nlf_session=' + 'a'.repeat(43),
    });
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('SESSION_EXPIRED');
    expect(res.setCookie[0]).toContain('Max-Age=0');
  });

  it('rotte di amministrazione: 403 per il commerciale, 200 per l’amministratore', async () => {
    const sales = (await login('sales@noventra.test')).c;
    expect((await sales.request('GET', '/api/users')).status).toBe(403);
    const admin = (await login('admin@noventra.test')).c;
    const res = await admin.request('GET', '/api/users');
    expect(res.status).toBe(200);
    expect(res.body.users.map((u: { email: string }) => u.email)).toContain('sales@noventra.test');
    expect(JSON.stringify(res.body)).not.toContain('argon2');
  });

  it('richieste che modificano dati da un’altra origine: 403', async () => {
    const res = await fetch(server.url + '/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'https://attaccante.esempio' },
      body: JSON.stringify({ email: 'admin@noventra.test', password: PASSWORD }),
    });
    expect(res.status).toBe(403);
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('richieste senza Origin né Sec-Fetch-Site: 403', async () => {
    const res = await fetch(server.url + '/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'admin@noventra.test', password: PASSWORD }),
    });
    expect(res.status).toBe(403);
  });

  it('corpo non JSON: 415; JSON non valido: 400; troppo grande: 413', async () => {
    const base = { method: 'POST', headers: { Origin: server.url } };
    expect((await fetch(server.url + '/api/auth/login', { ...base, body: 'email=x' })).status).toBe(415);
    expect(
      (
        await fetch(server.url + '/api/auth/login', {
          ...base,
          headers: { ...base.headers, 'Content-Type': 'application/json' },
          body: '{',
        })
      ).status,
    ).toBe(400);
    const big = JSON.stringify({ email: 'x'.repeat(70_000), password: 'y' });
    expect(
      (
        await fetch(server.url + '/api/auth/login', {
          ...base,
          headers: { ...base.headers, 'Content-Type': 'application/json' },
          body: big,
        })
      ).status,
    ).toBe(413);
  });
});

describe('sessioni', () => {
  it('l’uscita invalida la sessione sul server', async () => {
    const { c } = await login('admin@noventra.test');
    const saved = c.cookie;
    expect((await c.request('POST', '/api/auth/logout')).status).toBe(204);
    const replay = await client(server.url).request('GET', '/api/auth/me', undefined, { Cookie: saved });
    expect(replay.status).toBe(401);
  });

  it('una sessione scaduta per inattività non è più valida', async () => {
    const { c } = await login('admin@noventra.test');
    const token = c.cookie.split('=')[1]!;
    await db.query("UPDATE sessions SET expires_at = now() - interval '1 second' WHERE id = $1", [sessionIdOf(token)]);
    expect((await c.request('GET', '/api/auth/me')).status).toBe(401);
    const { rows } = await db.query('SELECT 1 FROM sessions WHERE id = $1', [sessionIdOf(token)]);
    expect(rows).toHaveLength(0);
  });

  it('il rinnovo per attività non supera mai il limite assoluto', async () => {
    const { c } = await login('admin@noventra.test');
    const id = sessionIdOf(c.cookie.split('=')[1]!);
    await db.query(
      "UPDATE sessions SET last_seen_at = now() - interval '2 minutes', absolute_expires_at = now() + interval '5 minutes' WHERE id = $1",
      [id],
    );
    expect((await c.request('GET', '/api/auth/me')).status).toBe(200);
    const { rows } = await db.query<{ ok: boolean }>(
      'SELECT expires_at <= absolute_expires_at AS ok FROM sessions WHERE id = $1',
      [id],
    );
    expect(rows[0]!.ok).toBe(true);
  });

  it('elenca le sessioni e chiude le altre', async () => {
    const a = (await login('admin@noventra.test')).c;
    const b = (await login('admin@noventra.test')).c;
    const list = await a.request('GET', '/api/auth/sessions');
    expect(list.body.sessions.filter((s: { current: boolean }) => s.current)).toHaveLength(1);
    expect(JSON.stringify(list.body)).not.toMatch(/[0-9a-f]{64}/);
    const revoked = await a.request('POST', '/api/auth/sessions/revoke-others');
    expect(revoked.body.closed).toBeGreaterThanOrEqual(1);
    expect((await b.request('GET', '/api/auth/me')).status).toBe(401);
    expect((await a.request('GET', '/api/auth/me')).status).toBe(200);
  });

  it('un utente disattivato perde subito l’accesso', async () => {
    await createTestUser(db, { email: 'temp@noventra.test', password: PASSWORD });
    const { c } = await login('temp@noventra.test');
    await setDisabled(db, 'temp@noventra.test', true);
    expect((await c.request('GET', '/api/auth/me')).status).toBe(401);
    expect((await login('temp@noventra.test')).res.status).toBe(401);
  });
});

describe('password temporanea e cambio password', () => {
  it('con password temporanea sono raggiungibili solo profilo, cambio password e uscita', async () => {
    await createTestUser(db, { email: 'nuovo@noventra.test' });
    const temporary = await resetPassword(db, 'nuovo@noventra.test');
    const { c, res } = await login('nuovo@noventra.test', temporary);
    expect(res.body.user.mustChangePassword).toBe(true);
    expect((await c.request('GET', '/api/auth/me')).status).toBe(200);
    const blocked = await c.request('GET', '/api/system/status');
    expect(blocked.status).toBe(403);
    expect(blocked.body.error.code).toBe('PASSWORD_CHANGE_REQUIRED');

    const weak = await c.request('POST', '/api/auth/password', { currentPassword: temporary, newPassword: 'corta' });
    expect(weak.status).toBe(400);
    expect(weak.body.error.fields.newPassword).toMatch(/12 caratteri/);

    const wrongCurrent = await c.request('POST', '/api/auth/password', {
      currentPassword: 'sbagliata',
      newPassword: 'una-password-nuova-lunga',
    });
    expect(wrongCurrent.body.error.fields.currentPassword).toBeTruthy();

    const other = (await login('nuovo@noventra.test', temporary)).c;
    const changed = await c.request('POST', '/api/auth/password', {
      currentPassword: temporary,
      newPassword: 'una-password-nuova-lunga',
    });
    expect(changed.status).toBe(200);
    expect(changed.body.closedSessions).toBe(1);
    expect((await other.request('GET', '/api/auth/me')).status).toBe(401);
    expect((await c.request('GET', '/api/system/status')).status).toBe(200);
    expect((await login('nuovo@noventra.test', temporary)).res.status).toBe(401);
    expect((await login('nuovo@noventra.test', 'una-password-nuova-lunga')).res.status).toBe(200);
  });
});

describe('limite per IP', () => {
  it('troppe richieste di accesso dallo stesso IP: 429', async () => {
    const limited = await startTestServer(db, { limiter: new RateLimiter() });
    try {
      const c = client(limited.url);
      let last = 0;
      for (let i = 0; i < 31; i++)
        last = (await c.request('POST', '/api/auth/login', { email: `x${i}@esempio.it`, password: 'p' })).status;
      expect(last).toBe(429);
    } finally {
      await limited.close();
    }
  });
});
