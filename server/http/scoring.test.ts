import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from '../db/client.ts';
import { DEFAULT_SCORING_CONFIG } from '../scoring/config.ts';
import { scoreBusinesses } from '../scoring/store.ts';
import { insertAudit, insertBusiness } from '../scoring/testData.ts';
import { client, createTestUser, startTestServer, testDatabase, type TestServer } from '../testing.ts';

/* API del punteggio dei lead: server HTTP reale, database reale, aziende e audit "di Prova". */

const PASSWORD = 'password-di-prova-lunga';
let db: Db;
let server: TestServer;
const ids: Record<string, string> = {};

beforeAll(async () => {
  db = await testDatabase();
  server = await startTestServer(db);
  await createTestUser(db, { email: 'sales@noventra.test', role: 'sales', password: PASSWORD });
  await createTestUser(db, { email: 'admin@noventra.test', role: 'admin', password: PASSWORD });
  ids.hotel = await insertBusiness(db, { name: 'Hotel di Prova Datato', category: 'hotel' });
  await insertAudit(db, ids.hotel, {
    hasViewport: false,
    signals: { booking: false, rooms: false, callToAction: false },
    findings: [
      { code: 'SEC_NO_HTTPS' },
      { code: 'MOBILE_NO_VIEWPORT' },
      { code: 'SEO_MISSING_TITLE' },
      { code: 'SEO_NO_STRUCTURED_DATA' },
    ],
  });
  ids.restaurant = await insertBusiness(db, {
    name: 'Trattoria di Prova',
    category: 'ristorazione',
    municipality: '032006',
  });
  await insertAudit(db, ids.restaurant, {
    signals: { menu: false },
    findings: [{ code: 'SEO_MISSING_META_DESCRIPTION' }, { code: 'PERF_LOW_SCORE', severity: 'medium' }],
  });
  ids.clean = await insertBusiness(db, { name: 'Farmacia di Prova Curata' });
  await insertAudit(db, ids.clean, {});
  ids.noSite = await insertBusiness(db, { name: 'Farmacia di Prova Senza Sito', website: null });
  ids.unscored = await insertBusiness(db, { name: 'Negozio di Prova Mai Valutato', category: 'negozi' });
  await scoreBusinesses(db, [ids.hotel, ids.restaurant, ids.clean, ids.noSite], { trigger: 'manual' });
});
afterAll(async () => {
  await server.close();
  await db.close();
});

async function login(email: string) {
  const c = client(server.url);
  expect((await c.request('POST', '/api/auth/login', { email, password: PASSWORD })).status).toBe(200);
  return c;
}

describe('accesso e autorizzazioni', () => {
  it('senza sessione: 401 su tutte le rotte del punteggio', async () => {
    const anon = client(server.url);
    for (const [m, p] of [
      ['GET', '/api/scoring/config'],
      ['GET', '/api/scoring/stats'],
      ['GET', `/api/businesses/${ids.hotel}/score`],
      ['POST', `/api/businesses/${ids.hotel}/score`],
      ['PUT', '/api/scoring/config'],
    ] as const)
      expect((await anon.request(m, p, m === 'GET' ? undefined : {})).status, p).toBe(401);
  });

  it('configurazione: lettura per tutti, modifica e verifica solo per gli amministratori', async () => {
    const sales = await login('sales@noventra.test');
    const read = await sales.request('GET', '/api/scoring/config');
    expect(read.status).toBe(200);
    expect(read.body).toMatchObject({ algorithmVersion: 1, active: { version: 1 } });
    expect((await sales.request('PUT', '/api/scoring/config', { config: DEFAULT_SCORING_CONFIG })).status).toBe(403);
    expect(
      (await sales.request('POST', '/api/scoring/config/validate', { config: DEFAULT_SCORING_CONFIG })).status,
    ).toBe(403);
    expect((await sales.request('POST', '/api/scoring/jobs', { scope: 'all' })).status).toBe(403);
  });

  it('amministratore: verifica, rifiuto di una configurazione non valida con errori per campo, nuova versione', async () => {
    const admin = await login('admin@noventra.test');
    const bad = { ...DEFAULT_SCORING_CONFIG, weights: { ...DEFAULT_SCORING_CONFIG.weights, technical: -3 } };
    expect((await admin.request('POST', '/api/scoring/config/validate', { config: bad })).body).toMatchObject({
      valid: false,
      errors: { 'weights.technical': expect.any(String) },
    });
    const rejected = await admin.request('PUT', '/api/scoring/config', { config: bad });
    expect(rejected.status).toBe(400);
    expect(rejected.body.error).toMatchObject({
      code: 'INVALID_CONFIG',
      fields: { 'weights.technical': expect.any(String) },
    });
    const unordered = await admin.request('PUT', '/api/scoring/config', {
      config: { ...DEFAULT_SCORING_CONFIG, bands: { A: 50, B: 60, C: 40 } },
    });
    expect(unordered.status).toBe(400);
    const saved = await admin.request('PUT', '/api/scoring/config', {
      config: DEFAULT_SCORING_CONFIG,
      note: 'Conferma dei valori iniziali',
    });
    expect(saved.status).toBe(200);
    expect(saved.body.version).toBe(2);
    const versions = (await admin.request('GET', '/api/scoring/config')).body.versions;
    expect(versions.map((v: { version: number }) => v.version)).toEqual([2, 1]);
  });
});

describe('punteggio di un’azienda', () => {
  it('dettaglio, spiegazione, storico; 404 se mai calcolato; ricalcolo esplicito', async () => {
    const c = await login('sales@noventra.test');
    expect((await c.request('GET', `/api/businesses/${ids.unscored}/score`)).body).toEqual({ score: null });
    expect((await c.request('GET', '/api/businesses/00000000-0000-4000-8000-000000000000/score')).status).toBe(404);
    const s = (await c.request('GET', `/api/businesses/${ids.hotel}/score`)).body.score;
    expect(s).toMatchObject({ status: 'ranked', configVersion: 1 });
    expect(s.outdated.join(' ')).toMatch(/configurazione v1; attiva: v2/);
    expect(s.breakdown.signals.positive.length).toBeGreaterThan(0);
    expect(s.breakdown.topFindings[0].auditId).toBeTruthy();

    const first = await c.request('POST', `/api/businesses/${ids.unscored}/score`, {});
    expect(first.body).toMatchObject({ created: true, score: { status: 'insufficient_data', score: null } });
    expect((await c.request('POST', `/api/businesses/${ids.unscored}/score`, {})).body.created).toBe(false);
    expect((await c.request('POST', `/api/businesses/${ids.unscored}/score`, { force: true })).body.created).toBe(true);
    const history = (await c.request('GET', `/api/businesses/${ids.unscored}/scores`)).body;
    expect(history.total).toBe(2);
    expect((await c.request('GET', `/api/scores/${history.items[1].id}`)).body.score).toMatchObject({
      isCurrent: false,
    });
    expect((await c.request('POST', `/api/businesses/${ids.unscored}/score`, { force: 'sì' })).status).toBe(400);
    expect((await c.request('POST', '/api/businesses/00000000-0000-4000-8000-000000000000/score', {})).status).toBe(
      404,
    );
  });
});

describe('elenco dei lead', () => {
  it('filtri per priorità, punteggio minimo, affidabilità, settore, territorio; da verificare', async () => {
    const c = await login('sales@noventra.test');
    const list = async (q: string) => (await c.request('GET', `/api/businesses?pageSize=100&${q}`)).body;
    const names = async (q: string) => (await list(q)).items.map((b: { name: string }) => b.name).sort();

    const hotel = (await list('q=hotel di prova datato')).items[0];
    expect(hotel.lead).toMatchObject({
      status: 'ranked',
      band: expect.stringMatching(/^[AB]$/),
      confidence: { level: 'high' },
      outdated: true,
    });

    expect(await names(`priority=${hotel.lead.band}`)).toContain('Hotel di Prova Datato');
    expect(await names('priority=insufficient_data')).toEqual([
      'Farmacia di Prova Senza Sito',
      'Negozio di Prova Mai Valutato',
    ]);
    expect(await names('priority=unscored')).not.toContain('Hotel di Prova Datato');
    expect(await names(`minScore=${hotel.lead.score}`)).toEqual(['Hotel di Prova Datato']);
    expect(await names('confidence=low')).not.toContain('Hotel di Prova Datato');
    expect(await names('category=ristorazione&priority=A,B,C,low')).toEqual(['Trattoria di Prova']);
    expect(await names('municipality=032006')).toEqual(['Trattoria di Prova']);
    expect(await names('audit=problems')).toContain('Hotel di Prova Datato');
    expect(await names('audit=problems')).not.toContain('Farmacia di Prova Curata');
    expect((await c.request('GET', '/api/businesses?priority=Z')).status).toBe(400);
    expect((await c.request('GET', '/api/businesses?minScore=101')).status).toBe(400);
  });

  it('ordinamento per punteggio e affidabilità (senza punteggio in fondo) e paginazione', async () => {
    const c = await login('sales@noventra.test');
    const desc = (await c.request('GET', '/api/businesses?sort=score&dir=desc&pageSize=100')).body.items;
    const scores = desc.map((b: { lead: { score: number | null } | null }) => b.lead?.score ?? null);
    const numeric = scores.filter((s: number | null) => s !== null);
    expect(numeric).toEqual([...numeric].sort((a: number, b: number) => b - a));
    expect(scores.indexOf(null)).toBeGreaterThanOrEqual(numeric.length);
    expect(desc[0].name).toBe('Hotel di Prova Datato');
    const conf = (await c.request('GET', '/api/businesses?sort=confidence&dir=desc&pageSize=100')).body.items;
    expect(conf[0].lead.confidence.value).toBeGreaterThanOrEqual(conf[1].lead.confidence.value);
    const p1 = (await c.request('GET', '/api/businesses?sort=score&dir=desc&pageSize=2&page=1')).body;
    const p2 = (await c.request('GET', '/api/businesses?sort=score&dir=desc&pageSize=2&page=2')).body;
    expect(p1).toMatchObject({ total: 5, page: 1, pageSize: 2 });
    expect(p1.items.map((x: { id: string }) => x.id)).not.toContain(p2.items[0].id);
    expect((await c.request('GET', '/api/businesses?pageSize=101')).status).toBe(400);
  });

  it('statistiche e ricalcolo in blocco di aziende selezionate', async () => {
    const c = await login('sales@noventra.test');
    const stats = (await c.request('GET', '/api/scoring/stats')).body;
    expect(stats).toMatchObject({ configVersion: 2, unscored: 0 });
    expect(stats.outdatedConfig).toBeGreaterThan(0);
    const job = await c.request('POST', '/api/scoring/jobs', {
      scope: 'businesses',
      businessIds: [ids.hotel, ids.clean],
    });
    expect(job.status).toBe(201);
    expect(job.body.job).toMatchObject({ status: 'pending', scope: 'businesses', progress: { total: 2 } });
    expect((await c.request('POST', '/api/scoring/jobs', { scope: 'businesses', businessIds: [] })).status).toBe(400);
    expect((await c.request('POST', `/api/scoring/jobs/${job.body.job.id}/cancel`, {})).body.job.status).toBe(
      'cancelled',
    );
  });
});
