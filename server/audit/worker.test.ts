import { createServer, type AddressInfo, type Server } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { defaultAudit, type AuditConfig } from '../config.ts';
import type { Db } from '../db/client.ts';
import { saveRecord } from '../discovery/store.ts';
import type { ProviderRecord } from '../discovery/types.ts';
import { silentLogger } from '../logger.ts';
import { createTestUser, testDatabase } from '../testing.ts';
import { goodPharmacyHome, poorRestaurantHome, startFakeSite, type FakeSite } from './fakeSite.ts';
import {
  cancelAuditJob,
  createAuditJob,
  pauseAuditJob,
  policyFor,
  recoverInterruptedAudits,
  resumeAuditJob,
} from './jobs.ts';
import type { PerformanceOutcome, PerformanceProvider } from './performance/pagespeed.ts';
import { auditDetail, auditHistory } from './store.ts';
import { AuditWorker } from './worker.ts';

/*
 * Job di audit dall'inizio alla fine: database reale, worker reale, siti FINTI locali (DATI DI TEST "di Prova").
 * Nessuna richiesta verso Internet.
 */

let db: Db;
let good: FakeSite;
let poor: FakeSite;
let closedPort: number;
let refuse: Server;
let userId: string;
let config: AuditConfig;
const failingHosts = new Set<string>();

/** Fornitore di prestazioni di prova: risultato fisso, oppure un guasto interno per gli host indicati. */
const performance: PerformanceProvider = {
  id: 'pagespeed',
  configured: true,
  async analyze(url, strategy): Promise<PerformanceOutcome> {
    if (failingHosts.has(new URL(url).host)) throw new Error('guasto interno di prova');
    return {
      status: 'ok',
      provider: 'pagespeed',
      strategy,
      url,
      analyzedAt: new Date().toISOString(),
      lighthouseVersion: 'test',
      lab: { performanceScore: 91, lcpMs: 1200, cls: 0.01, tbtMs: 50, fcpMs: 800, speedIndexMs: 1500 },
      field: null,
      fromCache: false,
    };
  },
};

let n = 0;
async function business(website: string | null, category: ProviderRecord['category'] = 'farmacie') {
  n++;
  const r: ProviderRecord = {
    provider: 'osm',
    ref: `node/${9_100_000_000 + n}`,
    sourceUrl: `https://www.openstreetmap.org/node/${9_100_000_000 + n}`,
    name: `Attività di Prova Audit ${n}`,
    category,
    websiteUrl: website,
    websiteDomain: null,
    websiteShared: false,
    sector: null,
    contacts: { phone: null, email: null, emailKind: null },
    address: { street: null, housenumber: null, postcode: null, city: null },
    municipalityCode: '058091',
    latitude: 41.5 + n * 0.05,
    longitude: 12.5,
    has: { website: Boolean(website), address: false, phone: false, email: false, openingHours: false },
    sourceTags: {},
  };
  const res = await db.transaction((tx) =>
    saveRecord(tx, r, {
      jobId: null,
      fetchedAt: new Date(),
      sourceDataAt: null,
      minCompleteness: 0,
      requireWebsite: false,
      seen: new Set(),
    }),
  );
  return res.businessId!;
}

function newWorker(over: Partial<AuditConfig> = {}) {
  const c = { ...config, ...over };
  return new AuditWorker(db, {
    log: silentLogger,
    config: c,
    policy: policyFor(c, 'test'),
    performance,
    sleep: async () => undefined,
  });
}
const create = (businessIds: string[], over: { force?: boolean; maxPages?: number; performance?: boolean } = {}) =>
  createAuditJob(db, { businessIds, ...over }, { userId, config, policy: policyFor(config, 'test') });
const job = async (id: string) =>
  (
    await db.query<{
      status: string;
      items_done: number;
      items_failed: number;
      items_skipped: number;
      pause_reason: string | null;
    }>('SELECT * FROM audit_jobs WHERE id = $1', [id])
  ).rows[0]!;
const items = async (id: string) =>
  (
    await db.query<{ business_id: string; status: string; outcome: string | null; audit_id: string | null }>(
      'SELECT * FROM audit_job_items WHERE job_id = $1 ORDER BY seq',
      [id],
    )
  ).rows;

beforeAll(async () => {
  db = await testDatabase();
  good = await startFakeSite({
    '/': { body: goodPharmacyHome() },
    '/robots.txt': { headers: { 'Content-Type': 'text/plain' }, body: 'User-agent: *\nAllow: /\n' },
  });
  poor = await startFakeSite({ '/': { body: poorRestaurantHome() } });
  // sito "irraggiungibile": porta tenuta occupata da un server che chiude ogni connessione (nessun altro può prenderla)
  refuse = createServer((socket) => socket.resetAndDestroy());
  await new Promise<void>((resolve) => refuse.listen(0, '127.0.0.1', resolve));
  closedPort = (refuse.address() as AddressInfo).port;
  config = {
    ...defaultAudit,
    hostIntervalMs: 0,
    requestTimeoutMs: 3000,
    connectTimeoutMs: 1500,
    pagespeedEnabled: true,
    testLoopbackPorts: [good.port, poor.port, closedPort],
  };
  userId = (await createTestUser(db, { email: 'audit@noventra.test' })).id;
});
afterAll(async () => {
  await good.close();
  await poor.close();
  await new Promise((resolve) => refuse.close(resolve));
  await db.close();
});

describe('esecuzione delle verifiche', () => {
  let ids: Record<string, string>;
  let first: string;

  it('audit di più aziende: sito condiviso analizzato una volta, aziende senza sito, sito irraggiungibile', async () => {
    ids = {
      a: await business(good.url),
      sameSite: await business(`${good.url}/`),
      poor: await business(poor.url, 'ristorazione'),
      none: await business(null),
      social: await business('https://www.facebook.com/attivita.di.prova'),
      down: await business(`http://127.0.0.1:${closedPort}/`),
    };
    const created = await create(Object.values(ids));
    first = created.jobId;
    expect(created).toMatchObject({ queued: 6, alreadyQueued: 0 });
    expect(await newWorker().runOnce()).toBe(true);

    expect(await job(first)).toMatchObject({ status: 'completed', items_done: 6, items_failed: 0 });
    const byBusiness = Object.fromEntries((await items(first)).map((i) => [i.business_id, i]));
    expect(byBusiness[ids.none!]).toMatchObject({ status: 'done', outcome: 'not_found', audit_id: null });
    expect(byBusiness[ids.social!]).toMatchObject({ status: 'done', outcome: 'not_found' });
    expect(byBusiness[ids.down!]).toMatchObject({ status: 'done', outcome: 'unreachable' });
    // le due aziende con lo stesso sito condividono lo stesso audit
    expect(byBusiness[ids.a!]!.audit_id).toBeTruthy();
    expect(byBusiness[ids.sameSite!]!.audit_id).toBe(byBusiness[ids.a!]!.audit_id);
    const { rows } = await db.query<{ n: number }>('SELECT count(*)::int AS n FROM websites WHERE site_key LIKE $1', [
      `127.0.0.1:${good.port}%`,
    ]);
    expect(rows[0]!.n).toBe(1);

    const detail = await auditDetail(db, byBusiness[ids.poor!]!.audit_id!);
    expect(detail.audit.runStatus).toBe('completed');
    expect(detail.findings.length).toBeGreaterThan(3);
    expect(detail.performance).toHaveLength(1);
    // rilievi unici per codice e pagina
    const { rows: dupes } = await db.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM (SELECT audit_id, code, page_url FROM audit_findings GROUP BY 1, 2, 3 HAVING count(*) > 1) d',
    );
    expect(dupes[0]!.n).toBe(0);
    // filtri sui rilievi
    const high = await auditDetail(db, byBusiness[ids.poor!]!.audit_id!, { severity: ['high'] });
    expect(high.findings.every((f) => f.severity === 'high')).toBe(true);
    const seo = await auditDetail(db, byBusiness[ids.poor!]!.audit_id!, { category: ['seo'] });
    expect(seo.findings.length).toBeGreaterThan(0);
    expect(seo.findings.every((f) => f.category === 'seo')).toBe(true);
  });

  it('audit recente con la stessa configurazione: riusato; con "forza": ripetuto e aggiunto allo storico', async () => {
    const again = await create([ids.a!]);
    await newWorker().runOnce();
    expect((await items(again.jobId))[0]).toMatchObject({ status: 'skipped', outcome: 'recent' });
    expect((await auditHistory(db, ids.a!, 1, 10)).total).toBe(1);

    const forced = await create([ids.a!], { force: true });
    await newWorker().runOnce();
    expect((await items(forced.jobId))[0]).toMatchObject({ status: 'done', outcome: 'valid' });
    const history = await auditHistory(db, ids.a!, 1, 10);
    expect(history.total).toBe(2);
    expect(history.website?.lastAuditId).toBe(history.items[0]!.id);
    // un'altra configurazione (più pagine) non riusa l'audit precedente
    const more = await create([ids.a!], { maxPages: 1 });
    await newWorker().runOnce();
    expect((await items(more.jobId))[0]).toMatchObject({ status: 'done' });
  });

  it("errore interno su un'azienda: il job continua, l'azienda risulta non riuscita e si può ripetere", async () => {
    failingHosts.add(new URL(poor.url).host);
    const created = await create([ids.poor!, ids.none!], { force: true });
    await newWorker().runOnce();
    expect(await job(created.jobId)).toMatchObject({ status: 'completed_with_warnings', items_failed: 1 });
    const failed = (await items(created.jobId)).find((i) => i.business_id === ids.poor);
    expect(failed).toMatchObject({ status: 'failed', outcome: 'audit_failed' });
    // il sito conserva l'ultimo esito valido
    const { rows } = await db.query<{ status: string }>(
      'SELECT w.status FROM websites w JOIN business_websites bw ON bw.website_id = w.id WHERE bw.business_id = $1',
      [ids.poor],
    );
    expect(rows[0]!.status).toBe('valid');

    failingHosts.clear();
    await resumeAuditJob(db, created.jobId, userId);
    await newWorker().runOnce();
    expect(await job(created.jobId)).toMatchObject({ status: 'completed', items_failed: 0 });
  });

  it('niente doppioni in coda; annullamento e pausa di un job in attesa; ripresa', async () => {
    const queued = await create([ids.poor!], { force: true });
    await expect(create([ids.poor!], { force: true })).rejects.toMatchObject({ status: 409, code: 'DUPLICATE_JOB' });
    // un job con aziende in parte già in coda accoda solo le altre
    const partial = await create([ids.poor!, ids.down!], { force: true });
    expect(partial).toMatchObject({ queued: 1, alreadyQueued: 1 });

    await pauseAuditJob(db, queued.jobId, userId);
    expect(await job(queued.jobId)).toMatchObject({ status: 'paused', pause_reason: 'manual' });
    await resumeAuditJob(db, queued.jobId, userId);
    expect((await job(queued.jobId)).status).toBe('pending');

    await cancelAuditJob(db, queued.jobId, userId);
    await cancelAuditJob(db, partial.jobId, userId);
    expect((await job(queued.jobId)).status).toBe('cancelled');
    expect((await items(queued.jobId))[0]!.status).toBe('cancelled');
    await expect(cancelAuditJob(db, queued.jobId, userId)).rejects.toMatchObject({ status: 409 });
    // le aziende annullate possono essere accodate di nuovo
    const requeued = await create([ids.poor!], { force: true });
    await cancelAuditJob(db, requeued.jobId, userId);
  });

  it('limite di verifiche attive per utente e di aziende per verifica', async () => {
    const jobs = [
      await create([ids.a!], { force: true }),
      await create([ids.poor!], { force: true }),
      await create([ids.down!], { force: true }),
    ];
    await expect(create([ids.sameSite!], { force: true })).rejects.toMatchObject({
      status: 429,
      code: 'TOO_MANY_ACTIVE_JOBS',
    });
    for (const j of jobs) await cancelAuditJob(db, j.jobId, userId);
    await expect(
      createAuditJob(
        db,
        { businessIds: [ids.a!, ids.poor!] },
        { userId, config: { ...config, maxBusinessesPerJob: 1 }, policy: policyFor(config, 'test') },
      ),
    ).rejects.toMatchObject({ code: 'TOO_MANY_BUSINESSES' });
    await expect(create(['00000000-0000-4000-8000-000000000000'])).rejects.toMatchObject({
      status: 404,
      code: 'UNKNOWN_BUSINESS',
    });
  });

  it('verifica "in corso" di un processo terminato: in pausa per interruzione, riprendibile', async () => {
    const created = await create([ids.poor!], { force: true });
    await db.query(
      "UPDATE audit_jobs SET status = 'running', worker_id = 'processo-morto', heartbeat_at = now() - interval '10 minutes' WHERE id = $1",
      [created.jobId],
    );
    await db.query("UPDATE audit_job_items SET status = 'running' WHERE job_id = $1", [created.jobId]);
    expect(await recoverInterruptedAudits(db, 60_000, 'altro')).toEqual([created.jobId]);
    expect(await job(created.jobId)).toMatchObject({ status: 'paused', pause_reason: 'interrupted' });
    expect((await items(created.jobId))[0]!.status).toBe('pending');
    await resumeAuditJob(db, created.jobId, userId);
    await newWorker().runOnce();
    expect((await job(created.jobId)).status).toBe('completed');
  });

  it("annullamento durante l'esecuzione: gli audit completati restano, le altre aziende escono dalla coda", async () => {
    const slow = await startFakeSite({ '/': { body: goodPharmacyHome(), delayMs: 600 } });
    try {
      const c = { ...config, concurrency: 1, testLoopbackPorts: [...config.testLoopbackPorts, slow.port] };
      const created = await createAuditJob(
        db,
        { businessIds: [await business(slow.url), ids.poor!], force: true },
        { userId, config: c, policy: policyFor(c, 'test') },
      );
      const worker = new AuditWorker(db, {
        log: silentLogger,
        config: c,
        policy: policyFor(c, 'test'),
        performance,
        heartbeatMs: 50,
        sleep: async () => undefined,
      });
      const run = worker.runOnce();
      await new Promise((r) => setTimeout(r, 100));
      await cancelAuditJob(db, created.jobId, userId);
      await run;
      expect((await job(created.jobId)).status).toBe('cancelled');
      expect((await items(created.jobId)).every((i) => i.status === 'cancelled' || i.status === 'done')).toBe(true);
    } finally {
      await slow.close();
    }
  });
});
