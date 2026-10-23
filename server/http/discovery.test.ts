import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RateLimiter } from '../auth/rateLimit.ts';
import { defaultDiscovery } from '../config.ts';
import type { Db } from '../db/client.ts';
import { dbCache } from '../discovery/cache.ts';
import { startFakeOverpass } from '../discovery/osm/fakeOverpass.ts';
import { OverpassProvider } from '../discovery/osm/overpass.ts';
import { DiscoveryWorker } from '../discovery/worker.ts';
import { silentLogger } from '../logger.ts';
import { client, createTestUser, startTestServer, testDatabase, type TestServer } from '../testing.ts';

/*
 * API della scoperta, dall'inizio alla fine: fornitore Overpass reale contro un server Overpass FINTO (dati di
 * test inventati), worker reale, database reale. Nessuna richiesta verso Internet.
 */

const PASSWORD = 'password-di-prova-lunga';
let db: Db;
let fake: Awaited<ReturnType<typeof startFakeOverpass>>;
let server: TestServer;
let unconfigured: TestServer;
let worker: DiscoveryWorker;
let limiter: RateLimiter;

beforeAll(async () => {
  db = await testDatabase();
  fake = await startFakeOverpass();
  const provider = new OverpassProvider(
    {
      endpoint: fake.url,
      userAgent: 'NoventraLeadFinder/test (+test)',
      minIntervalMs: 0,
      timeoutSeconds: 30,
      maxsizeBytes: 1 << 28,
      maxRetries: 0,
      maxResponseBytes: 1 << 22,
      cacheTtlMs: 0,
    },
    { cache: dbCache(db) },
  );
  worker = new DiscoveryWorker(db, provider, { log: silentLogger });
  limiter = new RateLimiter();
  server = await startTestServer(db, {
    limiter,
    discovery: { provider, config: { ...defaultDiscovery, municipalitiesPerRequest: 10 }, workerActive: true },
  });
  unconfigured = await startTestServer(db);
  await createTestUser(db, { email: 'sales@noventra.test', role: 'sales', password: PASSWORD });
});
afterAll(async () => {
  await server.close();
  await unconfigured.close();
  await fake.close();
  await db.close();
});

async function login(base = server.url) {
  const c = client(base);
  expect(
    (await c.request('POST', '/api/auth/login', { email: 'sales@noventra.test', password: PASSWORD })).status,
  ).toBe(200);
  return c;
}

const ALBANO = { type: 'municipality', code: '058003' };
const jobBody = (over: Record<string, unknown> = {}) => ({
  area: ALBANO,
  categories: ['farmacie', 'parafarmacie', 'ristorazione', 'hotel'],
  maxResults: 200,
  ...over,
});

describe('autorizzazione e validazione', () => {
  it('tutte le rotte della scoperta richiedono una sessione', async () => {
    const anon = client(server.url);
    for (const path of [
      '/api/geo/regions',
      '/api/geo/search?q=roma',
      '/api/discovery/meta',
      '/api/discovery/jobs',
      '/api/businesses',
      '/api/duplicates',
      '/api/discovery/stats',
    ])
      expect((await anon.request('GET', path)).status, path).toBe(401);
    expect((await anon.request('POST', '/api/discovery/jobs', jobBody())).status).toBe(401);
  });

  it('parametri non validi: 400 con errori per campo, nessun job creato', async () => {
    const c = await login();
    const bad = await c.request('POST', '/api/discovery/jobs', {
      area: { type: 'municipality', code: 'roma' },
      categories: ['farmacie', 'inventata'],
      maxResults: 0,
      extra: true,
    });
    expect(bad.status).toBe(400);
    expect(Object.keys(bad.body.error.fields)).toEqual(
      expect.arrayContaining(['area.code', 'categories.1', 'maxResults']),
    );
    expect(
      (await c.request('POST', '/api/discovery/jobs', jobBody({ area: { type: 'municipality', code: '999999' } }))).body
        .error.code,
    ).toBe('UNKNOWN_AREA');
    expect((await c.request('GET', '/api/businesses?sort=password')).status).toBe(400);
    expect((await c.request('GET', '/api/businesses?pageSize=1000')).status).toBe(400);
  });
});

describe('fornitore non configurato', () => {
  it('lo dichiara con le istruzioni e rifiuta le ricerche: nessun dato finto', async () => {
    const c = await login(unconfigured.url);
    const meta = await c.request('GET', '/api/discovery/meta');
    expect(meta.body.provider).toMatchObject({
      configured: false,
      setupHint: expect.stringContaining('DISCOVERY_OVERPASS_URL'),
    });
    expect(meta.body.provider.attribution.license).toBe('ODbL 1.0');
    const res = await c.request('POST', '/api/discovery/jobs', jobBody());
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('PROVIDER_NOT_CONFIGURED');
  });
});

describe('geografia', () => {
  it('regioni, province, comuni e ricerca per nome con codici ISTAT', async () => {
    const c = await login();
    expect((await c.request('GET', '/api/geo/regions')).body.regions).toHaveLength(20);
    const provinces = (await c.request('GET', '/api/geo/regions/12/provinces')).body.provinces;
    expect(provinces.map((p: { code: string }) => p.code)).toContain('258');
    const munis = (await c.request('GET', '/api/geo/provinces/258/municipalities')).body.municipalities;
    expect(munis.find((m: { code: string }) => m.code === '058003')?.name).toBe('Albano Laziale');
    expect((await c.request('GET', '/api/geo/search?q=albano%20laziale')).body.areas[0]).toMatchObject({
      type: 'municipality',
      code: '058003',
    });
    expect((await c.request('GET', '/api/geo/regions/99/provinces')).status).toBe(404);
  });
});

describe('ricerca completa', () => {
  let jobId = '';

  it('avvio, avanzamento reale, salvataggio normalizzato e attribuzione della fonte', async () => {
    const c = await login();
    const res = await c.request('POST', '/api/discovery/jobs', jobBody());
    expect(res.status).toBe(201);
    jobId = res.body.job.id;
    expect(res.body.job).toMatchObject({
      status: 'pending',
      area: { name: 'Albano Laziale' },
      progress: { unitsTotal: 1, unitsDone: 0 },
    });

    // una ricerca identica già attiva non si duplica
    const dup = await c.request('POST', '/api/discovery/jobs', jobBody());
    expect(dup.status).toBe(409);
    expect(dup.body.error).toMatchObject({ code: 'DUPLICATE_JOB', data: { jobId } });

    expect(await worker.runOnce()).toBe(true);
    const job = (await c.request('GET', `/api/discovery/jobs/${jobId}`)).body;
    expect(job.job).toMatchObject({
      status: 'completed',
      progress: { unitsTotal: 1, unitsDone: 1 },
      counts: {
        discovered: 6,
        inserted: 6,
        duplicatesSkipped: 0,
        flaggedForReview: 1,
        failedRequests: 0,
        requestsSent: 1,
      },
    });
    expect(job.units[0]).toMatchObject({
      status: 'done',
      recordsFound: 6,
      missing: [],
      municipalities: [{ code: '058003', name: 'Albano Laziale' }],
    });
    // la query reale è arrivata al server con il codice ISTAT, non con un nome
    expect(fake.control.queries.at(-1)).toContain('["ref:ISTAT"="058003"]');

    const list = (await c.request('GET', '/api/businesses?municipality=058003&sort=name&dir=asc&pageSize=50')).body;
    expect(list.total).toBe(6);
    expect(list.items.map((b: { name: string }) => b.name)).toEqual([
      'Bar di Prova Albano Laziale',
      'Bar di Prova Albano Laziale',
      'Farmacia di Prova Albano Laziale',
      'Hotel di Prova Albano Laziale',
      'Parafarmacia di Prova Albano Laziale',
      'Trattoria di Prova Albano Laziale',
    ]);
    const farmacia = list.items.find((b: { name: string }) => b.name.startsWith('Farmacia'));
    expect(farmacia).toMatchObject({
      categoryLabel: 'Farmacie',
      website: { domain: 'farmacia-albanolaziale.example.it', shared: false },
      place: { municipality: 'Albano Laziale', province: 'Roma', provinceSigla: 'RM', region: 'Lazio' },
      completeness: 4,
      has: { phone: true, email: false },
    });

    const detail = (await c.request('GET', `/api/businesses/${farmacia.id}`)).body.business;
    expect(detail.sources).toEqual([
      expect.objectContaining({
        provider: 'osm',
        ref: 'node/9005800301',
        url: 'https://www.openstreetmap.org/node/9005800301',
        license: expect.stringContaining('OpenStreetMap contributors'),
        primary: true,
        lastJobId: jobId,
      }),
    ]);
    // Fase 6: il telefono pubblico dell'attività è nei recapiti, mai nei tag di provenienza
    expect(detail.contacts).toEqual({
      phone: '+39 000 0000000',
      email: null,
      emailKind: null,
      fax: null,
      phonesExtra: [],
    });
    expect(JSON.stringify(detail.sources)).not.toContain('0000000');
    expect(detail.history[0]).toMatchObject({ action: 'business.created' });
  });

  it('ripetere la stessa ricerca aggiorna senza creare doppioni', async () => {
    const c = await login();
    const again = await c.request('POST', '/api/discovery/jobs', jobBody());
    expect(again.status).toBe(201);
    await worker.runOnce();
    const job = (await c.request('GET', `/api/discovery/jobs/${again.body.job.id}`)).body.job;
    expect(job).toMatchObject({
      status: 'completed',
      counts: { discovered: 6, inserted: 0, unchanged: 6, flaggedForReview: 0 },
    });
    expect((await c.request('GET', '/api/businesses?municipality=058003')).body.total).toBe(6);
  });

  it('filtri, ordinamento e paginazione', async () => {
    const c = await login();
    const page1 = (await c.request('GET', '/api/businesses?municipality=058003&sort=name&dir=asc&pageSize=4&page=1'))
      .body;
    const page2 = (await c.request('GET', '/api/businesses?municipality=058003&sort=name&dir=asc&pageSize=4&page=2'))
      .body;
    expect([page1.items.length, page2.items.length, page1.total]).toEqual([4, 2, 6]);
    expect(new Set([...page1.items, ...page2.items].map((b: { id: string }) => b.id)).size).toBe(6);
    const own = (await c.request('GET', '/api/businesses?municipality=058003&website=own')).body;
    expect(own.items.map((b: { name: string }) => b.name).sort()).toEqual([
      'Farmacia di Prova Albano Laziale',
      'Hotel di Prova Albano Laziale',
    ]);
    expect((await c.request('GET', '/api/businesses?municipality=058003&website=yes')).body.total).toBe(3);
    expect((await c.request('GET', '/api/businesses?category=parafarmacie')).body.total).toBe(1);
    expect((await c.request('GET', '/api/businesses?q=TRATTORIA%20di%20prova')).body.total).toBe(1);
    // i caratteri jolly di LIKE non hanno effetto: dopo la normalizzazione la ricerca è vuota e non filtra
    const all = (await c.request('GET', '/api/businesses')).body.total;
    expect((await c.request('GET', '/api/businesses?q=%25_%25')).body.total).toBe(all);
    expect((await c.request('GET', '/api/businesses?province=258&minCompleteness=3')).body.total).toBe(1);
    expect((await c.request('GET', '/api/businesses?review=1')).body.total).toBe(2);
    const lastJob = (await c.request('GET', '/api/discovery/jobs?status=finished')).body.items[0].id;
    expect((await c.request('GET', `/api/businesses?job=${lastJob}`)).body.total).toBe(6);
    expect((await c.request('GET', '/api/businesses?job=non-un-id')).status).toBe(400);
    const desc = (await c.request('GET', '/api/businesses?municipality=058003&sort=completeness&dir=desc')).body.items;
    expect(desc[0].completeness).toBeGreaterThanOrEqual(desc.at(-1).completeness);
  });

  it('revisione dei duplicati: unione confermata a mano, con cronologia', async () => {
    const c = await login();
    const pending = (await c.request('GET', '/api/duplicates')).body;
    expect(pending.total).toBe(1);
    const cand = pending.items[0];
    expect(cand).toMatchObject({ reason: 'Stesso nome a breve distanza', distanceM: 80 });
    expect(cand.a.name).toBe(cand.b.name);

    const wrongKeep = await c.request('POST', `/api/duplicates/${cand.id}/merge`, {
      keep: '00000000-0000-4000-8000-000000000000',
    });
    expect(wrongKeep.status).toBe(400);
    const merged = await c.request('POST', `/api/duplicates/${cand.id}/merge`, { keep: cand.a.id });
    expect(merged.status).toBe(200);
    expect((await c.request('POST', `/api/duplicates/${cand.id}/merge`, { keep: cand.a.id })).body.error.code).toBe(
      'ALREADY_RESOLVED',
    );

    expect((await c.request('GET', '/api/businesses?municipality=058003')).body.total).toBe(5);
    const kept = (await c.request('GET', `/api/businesses/${cand.a.id}`)).body.business;
    expect(kept.sources).toHaveLength(2);
    expect(kept.has.openingHours).toBe(true);
    expect(kept.history[0]).toMatchObject({ action: 'business.merged', user: 'Utente di prova' });
    const gone = (await c.request('GET', `/api/businesses/${cand.b.id}`)).body.business;
    expect(gone.mergedInto).toBe(cand.a.id);
    expect((await c.request('GET', '/api/duplicates?status=resolved')).body.items[0]).toMatchObject({
      id: cand.id,
      status: 'merged',
    });

    // una nuova ricerca non ricrea l'azienda unita: le sue fonti appartengono ora a quella mantenuta
    const again = await c.request('POST', '/api/discovery/jobs', jobBody({ maxResults: 199 }));
    await worker.runOnce();
    const job = (await c.request('GET', `/api/discovery/jobs/${again.body.job.id}`)).body.job;
    expect(job.counts.inserted).toBe(0);
    expect((await c.request('GET', '/api/businesses?municipality=058003')).body.total).toBe(5);
    expect((await c.request('GET', '/api/duplicates')).body.total).toBe(0);
  });

  it('"attività distinte": la coppia non viene più proposta', async () => {
    const c = await login();
    const job = await c.request(
      'POST',
      '/api/discovery/jobs',
      jobBody({ area: { type: 'municipality', code: '058004' } }),
    );
    await worker.runOnce();
    expect((await c.request('GET', `/api/discovery/jobs/${job.body.job.id}`)).body.job.counts.flaggedForReview).toBe(1);
    const cand = (await c.request('GET', '/api/duplicates')).body.items[0];
    expect((await c.request('POST', `/api/duplicates/${cand.id}/distinct`)).status).toBe(200);
    const again = await c.request(
      'POST',
      '/api/discovery/jobs',
      jobBody({ area: { type: 'municipality', code: '058004' }, maxResults: 198 }),
    );
    await worker.runOnce();
    expect((await c.request('GET', `/api/discovery/jobs/${again.body.job.id}`)).body.job.counts.flaggedForReview).toBe(
      0,
    );
    expect((await c.request('GET', '/api/duplicates')).body.total).toBe(0);
  });
});

describe('errori e limiti del fornitore visibili', () => {
  it('server occupato: ricerca fallita con il motivo, nessun dato inventato, poi ripresa', async () => {
    const c = await login();
    const before = (await c.request('GET', '/api/businesses')).body.total;
    fake.control.failures = [503];
    const res = await c.request(
      'POST',
      '/api/discovery/jobs',
      jobBody({ area: { type: 'municipality', code: '058005' } }),
    );
    await worker.runOnce();
    const failed = (await c.request('GET', `/api/discovery/jobs/${res.body.job.id}`)).body;
    expect(failed.job).toMatchObject({ status: 'failed', counts: { failedRequests: 1, inserted: 0 } });
    expect(failed.job.messages.at(-1).message).toContain('HTTP 503');
    expect(failed.units[0]).toMatchObject({ status: 'failed', error: expect.stringContaining('503') });
    expect((await c.request('GET', '/api/businesses')).body.total).toBe(before);

    const resumed = await c.request('POST', `/api/discovery/jobs/${res.body.job.id}/resume`);
    expect(resumed.body.job.status).toBe('pending');
    await worker.runOnce();
    expect((await c.request('GET', `/api/discovery/jobs/${res.body.job.id}`)).body.job).toMatchObject({
      status: 'completed',
      counts: { inserted: 6 },
    });
  });

  it('comune assente in OSM: avviso esplicito', async () => {
    const c = await login();
    fake.control.missing.add('058006');
    const res = await c.request(
      'POST',
      '/api/discovery/jobs',
      jobBody({ area: { type: 'municipality', code: '058006' } }),
    );
    await worker.runOnce();
    const job = (await c.request('GET', `/api/discovery/jobs/${res.body.job.id}`)).body.job;
    expect(job).toMatchObject({ status: 'completed_with_warnings', counts: { discovered: 0 } });
    expect(job.messages.at(-1).message).toContain('non trovato su OpenStreetMap');
  });

  it('annullamento e pausa via API, con stati non validi rifiutati', async () => {
    const c = await login();
    const res = await c.request(
      'POST',
      '/api/discovery/jobs',
      jobBody({ area: { type: 'municipality', code: '058007' } }),
    );
    const id = res.body.job.id;
    expect((await c.request('POST', `/api/discovery/jobs/${id}/pause`)).body.job).toMatchObject({
      status: 'paused',
      pauseReason: 'manual',
    });
    expect((await c.request('POST', `/api/discovery/jobs/${id}/cancel`)).body.job.status).toBe('cancelled');
    expect((await c.request('POST', `/api/discovery/jobs/${id}/resume`)).body.error.code).toBe('INVALID_STATE');
    expect((await c.request('POST', `/api/discovery/jobs/00000000-0000-4000-8000-000000000000/cancel`)).status).toBe(
      404,
    );
    const list = (await c.request('GET', '/api/discovery/jobs?status=finished&pageSize=100')).body;
    expect(list.items.some((j: { id: string; status: string }) => j.id === id && j.status === 'cancelled')).toBe(true);
  });

  it('limite di frequenza sulla creazione delle ricerche', async () => {
    const c = await login();
    const u = (await db.query<{ id: string }>("SELECT id FROM users WHERE email = 'sales@noventra.test'")).rows[0]!.id;
    for (let i = 0; i < 20; i++) limiter.hit(`discovery:${u}`, { limit: 20, windowMs: 3_600_000 });
    const res = await c.request(
      'POST',
      '/api/discovery/jobs',
      jobBody({ area: { type: 'municipality', code: '058008' } }),
    );
    expect(res.status).toBe(429);
    limiter.reset(`discovery:${u}`);
  });
});

describe('statistiche', () => {
  it('riflettono i dati salvati', async () => {
    const c = await login();
    const stats = (await c.request('GET', '/api/discovery/stats')).body;
    const total = (await c.request('GET', '/api/businesses')).body.total;
    expect(stats.businesses).toBe(total);
    expect(stats.byCategory.reduce((s: number, x: { count: number }) => s + x.count, 0)).toBe(total);
    expect(stats.byRegion).toEqual([{ regionCode: '12', region: 'Lazio', count: total }]);
  });
});
