import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { goodPharmacyHome, poorRestaurantHome, startFakeSite, type FakeSite } from '../audit/fakeSite.ts';
import { policyFor } from '../audit/jobs.ts';
import { PageSpeedProvider } from '../audit/performance/pagespeed.ts';
import { AuditWorker } from '../audit/worker.ts';
import { defaultAudit, loadConfig, type AuditConfig } from '../config.ts';
import type { Db } from '../db/client.ts';
import { saveRecord } from '../discovery/store.ts';
import { silentLogger } from '../logger.ts';
import { client, createTestUser, startTestServer, testDatabase, type TestServer } from '../testing.ts';

/*
 * API dell'audit dei siti: server HTTP reale, database reale, worker reale contro siti FINTI locali
 * (DATI DI TEST "di Prova"). Nessuna richiesta verso Internet: PageSpeed è configurato con una chiave finta
 * solo per verificare che non venga mai esposta, e le misure sono disattivate nelle verifiche.
 */

const PASSWORD = 'password-di-prova-lunga';
const FAKE_KEY = 'CHIAVE-FINTA-NON-ESPORRE-123';
let db: Db;
let server: TestServer;
let good: FakeSite;
let poor: FakeSite;
let config: AuditConfig;
let worker: AuditWorker;
const biz: Record<string, string> = {};

let n = 0;
async function business(name: string, website: string | null, category: 'farmacie' | 'ristorazione' = 'farmacie') {
  n++;
  const res = await db.transaction((tx) =>
    saveRecord(
      tx,
      {
        provider: 'osm',
        ref: `node/${9_200_000_000 + n}`,
        sourceUrl: `https://www.openstreetmap.org/node/${9_200_000_000 + n}`,
        name,
        category,
        websiteUrl: website,
        websiteDomain: null,
        websiteShared: false,
        sector: null,
        contacts: { phone: null, email: null, emailKind: null },
        address: { street: null, housenumber: null, postcode: null, city: null },
        municipalityCode: '058091',
        latitude: 41 + n * 0.05,
        longitude: 12.5,
        has: { website: Boolean(website), address: false, phone: false, email: false, openingHours: false },
        sourceTags: {},
      },
      {
        jobId: null,
        fetchedAt: new Date(),
        sourceDataAt: null,
        minCompleteness: 0,
        requireWebsite: false,
        seen: new Set(),
      },
    ),
  );
  return res.businessId!;
}

beforeAll(async () => {
  db = await testDatabase();
  good = await startFakeSite({ '/': { body: goodPharmacyHome() } });
  poor = await startFakeSite({ '/': { body: poorRestaurantHome() } });
  config = {
    ...defaultAudit,
    hostIntervalMs: 0,
    requestTimeoutMs: 3000,
    connectTimeoutMs: 1500,
    testLoopbackPorts: [good.port, poor.port],
  };
  const policy = policyFor(config, 'test');
  const performance = new PageSpeedProvider(
    {
      apiKey: FAKE_KEY,
      enabled: true,
      endpoint: 'http://127.0.0.1:9/mai-usato',
      timeoutMs: 1000,
      maxRetries: 0,
      minIntervalMs: 0,
      cacheTtlMs: 0,
    },
    {
      fetch: async () => {
        throw new Error('nessuna richiesta di rete nei test');
      },
    },
  );
  worker = new AuditWorker(db, { log: silentLogger, config, policy, performance: null, sleep: async () => undefined });
  server = await startTestServer(db, { audit: { config, policy, performance, workerActive: true } });
  await createTestUser(db, { email: 'sales@noventra.test', role: 'sales', password: PASSWORD });
  biz.good = await business('Farmacia di Prova Curata', good.url);
  biz.poor = await business('Trattoria di Prova', poor.url, 'ristorazione');
  biz.none = await business('Farmacia di Prova Senza Sito', null);
});
afterAll(async () => {
  await server.close();
  await good.close();
  await poor.close();
  await db.close();
});

async function login() {
  const c = client(server.url);
  expect(
    (await c.request('POST', '/api/auth/login', { email: 'sales@noventra.test', password: PASSWORD })).status,
  ).toBe(200);
  return c;
}

describe('API audit', () => {
  it("richiede l'accesso", async () => {
    const anon = client(server.url);
    for (const [method, path] of [
      ['GET', '/api/audits/meta'],
      ['GET', '/api/audits/jobs'],
      ['POST', '/api/audits/jobs'],
      ['GET', `/api/businesses/${biz.good}/audits`],
    ] as const)
      expect((await anon.request(method, path, method === 'POST' ? {} : undefined)).status, path).toBe(401);
  });

  it('meta: limiti e stato delle prestazioni, mai la chiave', async () => {
    const c = await login();
    const res = await c.request('GET', '/api/audits/meta');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      limits: { defaultPages: 3, maxPages: 10, allowedPorts: [80, 443] },
      performance: { configured: true },
    });
    expect(Object.keys(res.body.findings).length).toBeGreaterThan(20);
    expect(JSON.stringify(res.body)).not.toContain(FAKE_KEY);
  });

  it('valida le richieste', async () => {
    const c = await login();
    expect((await c.request('POST', '/api/audits/jobs', { businessIds: [] })).status).toBe(400);
    expect((await c.request('POST', '/api/audits/jobs', { businessIds: ['non-un-uuid'] })).status).toBe(400);
    expect((await c.request('POST', '/api/audits/jobs', { businessIds: [biz.good], maxPages: 50 })).status).toBe(400);
    expect((await c.request('POST', '/api/audits/jobs', { businessIds: [biz.good], extra: 1 })).status).toBe(400);
    expect((await c.request('GET', `/api/audits/${biz.good}?severity=critica`)).status).toBe(400);
    expect((await c.request('GET', `/api/businesses/${biz.good}/audits/latest`)).body.error.code).toBe('NO_AUDIT');
    expect((await c.request('GET', '/api/businesses?audit=boh')).status).toBe(400);
  });

  it('flusso completo: avvio, stato, ultimo audit, rilievi filtrati, storico, elenco aziende', async () => {
    const c = await login();
    const started = await c.request('POST', '/api/audits/jobs', {
      businessIds: [biz.good, biz.poor, biz.none],
      performance: false,
    });
    expect(started.status).toBe(201);
    expect(started.body).toMatchObject({ queued: 3, job: { status: 'pending', progress: { total: 3, done: 0 } } });
    const jobId = started.body.job.id;
    // stessa richiesta mentre è in coda: rifiutata, con l'id del job attivo
    const dup = await c.request('POST', '/api/audits/jobs', { businessIds: [biz.good], performance: false });
    expect(dup.status).toBe(409);
    expect(dup.body.error).toMatchObject({ code: 'DUPLICATE_JOB', data: { jobId } });

    await worker.runOnce();
    const status = await c.request('GET', `/api/audits/jobs/${jobId}`);
    expect(status.body.job).toMatchObject({ status: 'completed', progress: { total: 3, done: 3, failed: 0 } });
    expect(status.body.items.map((i: { outcome: string }) => i.outcome).sort()).toEqual([
      'not_found',
      'valid',
      'valid',
    ]);

    const latest = await c.request('GET', `/api/businesses/${biz.poor}/audits/latest`);
    expect(latest.status).toBe(200);
    expect(latest.body.audit).toMatchObject({ runStatus: 'completed', websiteStatus: 'valid' });
    expect(latest.body.website).toMatchObject({ status: 'valid' });
    expect(latest.body.findings.length).toBeGreaterThan(3);
    for (const f of latest.body.findings) {
      expect(f).toHaveProperty('evidence');
      expect(f).toHaveProperty('remediation');
      expect(['info', 'low', 'medium', 'high']).toContain(f.severity);
    }
    expect(latest.body.audit.limitations.join(' ')).toMatch(/Prestazioni/);

    const auditId = latest.body.audit.id;
    const filtered = await c.request('GET', `/api/audits/${auditId}?severity=medium,high&category=seo`);
    expect(filtered.body.findings.length).toBeGreaterThan(0);
    expect(
      filtered.body.findings.every(
        (f: { severity: string; category: string }) => ['medium', 'high'].includes(f.severity) && f.category === 'seo',
      ),
    ).toBe(true);
    const actionable = await c.request('GET', `/api/audits/${auditId}?actionable=1`);
    expect(actionable.body.findings.every((f: { actionable: boolean }) => f.actionable)).toBe(true);

    const history = await c.request('GET', `/api/businesses/${biz.poor}/audits`);
    expect(history.body).toMatchObject({ total: 1, items: [{ id: auditId }] });
    const noSite = await c.request('GET', `/api/businesses/${biz.none}/audits`);
    expect(noSite.body).toMatchObject({ total: 0, website: { status: 'not_found' } });

    // elenco aziende: colonne e filtri dell'audit
    const audited = await c.request('GET', '/api/businesses?audit=audited&sort=audited');
    expect(audited.body.items.map((b: { id: string }) => b.id).sort()).toEqual([biz.good, biz.poor].sort());
    const row = audited.body.items.find((b: { id: string }) => b.id === biz.poor);
    expect(row.audit).toMatchObject({ websiteStatus: 'valid', lastAuditId: auditId });
    expect(row.audit.actionableFindings).toBeGreaterThan(0);
    expect(
      (await c.request('GET', '/api/businesses?audit=no_website')).body.items.map((b: { id: string }) => b.id),
    ).toEqual([biz.none]);
    const detail = await c.request('GET', `/api/businesses/${biz.good}`);
    expect(detail.body.business?.audit ?? detail.body.audit).toBeTruthy();

    // ripetizione per una sola azienda, forzata
    const single = await c.request('POST', `/api/businesses/${biz.poor}/audit`, {
      force: true,
      performance: false,
      maxPages: 1,
    });
    expect(single.status).toBe(201);
    await worker.runOnce();
    expect((await c.request('GET', `/api/businesses/${biz.poor}/audits`)).body.total).toBe(2);

    const jobs = await c.request('GET', '/api/audits/jobs?status=finished');
    expect(jobs.body.total).toBe(2);
  });

  it('annullamento, pausa e ripresa via API', async () => {
    const c = await login();
    const started = await c.request('POST', '/api/audits/jobs', {
      businessIds: [biz.good],
      force: true,
      performance: false,
    });
    const id = started.body.job.id;
    expect((await c.request('POST', `/api/audits/jobs/${id}/pause`)).body.job).toMatchObject({ status: 'paused' });
    expect((await c.request('POST', `/api/audits/jobs/${id}/resume`)).body.job).toMatchObject({ status: 'pending' });
    expect((await c.request('POST', `/api/audits/jobs/${id}/cancel`)).body.job).toMatchObject({ status: 'cancelled' });
    expect((await c.request('POST', `/api/audits/jobs/${id}/cancel`)).status).toBe(409);
    expect((await c.request('POST', '/api/audits/jobs/00000000-0000-4000-8000-000000000000/cancel')).status).toBe(404);
  });
});

describe('configurazione', () => {
  it("l'eccezione per i siti finti dei test è rifiutata fuori dai test", () => {
    expect(() => loadConfig({ AUDIT_TEST_LOOPBACK_PORTS: '8813' })).toThrow(/AUDIT_TEST_LOOPBACK_PORTS/);
    expect(() =>
      loadConfig({
        NODE_ENV: 'production',
        DATABASE_URL: 'postgres://h/db',
        APP_ORIGIN: 'https://x.it',
        AUDIT_TEST_LOOPBACK_PORTS: '8813',
      }),
    ).toThrow(/AUDIT_TEST_LOOPBACK_PORTS/);
    expect(loadConfig({ NODE_ENV: 'test', AUDIT_TEST_LOOPBACK_PORTS: '8813' }).audit.testLoopbackPorts).toEqual([8813]);
    // la chiave PageSpeed non abilita nulla se le misure sono spente, e senza chiave restano spente
    expect(loadConfig({}).audit.pagespeedEnabled).toBe(false);
    expect(
      loadConfig({ PAGESPEED_API_KEY: 'chiave-finta-di-prova', AUDIT_PAGESPEED: 'off' }).audit.pagespeedEnabled,
    ).toBe(false);
  });
});
