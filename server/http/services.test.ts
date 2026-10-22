import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from '../db/client.ts';
import { silentLogger } from '../logger.ts';
import { DEFAULT_CATALOG } from '../matching/catalog.ts';
import { createScoringJob, getScoringJob, ScoringWorker } from '../scoring/jobs.ts';
import { scoreBusinesses } from '../scoring/store.ts';
import { insertAudit, insertBusiness } from '../scoring/testData.ts';
import { client, createTestUser, startTestServer, testDatabase, type TestServer } from '../testing.ts';

/* Abbinamento ai servizi: server HTTP reale, database reale, aziende e audit "di Prova" (DATI DI TEST). */

const PASSWORD = 'password-di-prova-lunga';
let db: Db;
let server: TestServer;
let adminId: string;
const ids = {} as { weak: string; clean: string; shop: string; noSite: string };

beforeAll(async () => {
  db = await testDatabase();
  server = await startTestServer(db);
  await createTestUser(db, { email: 'sales@noventra.test', role: 'sales', password: PASSWORD });
  adminId = (await createTestUser(db, { email: 'admin@noventra.test', role: 'admin', password: PASSWORD })).id;
  // sito con problemi di indicizzazione, HTTPS e mobile
  ids.weak = await insertBusiness(db, { name: 'Farmacia di Prova Trascurata', category: 'farmacie' });
  await insertAudit(db, ids.weak, {
    hasViewport: false,
    signals: { ecommerce: false },
    findings: [
      { code: 'SEO_NOINDEX' },
      { code: 'SEC_NO_HTTPS' },
      { code: 'MOBILE_NO_VIEWPORT' },
      { code: 'SEO_NO_STRUCTURED_DATA' },
      { code: 'IND_NO_ECOMMERCE' },
    ],
  });
  // sito curato
  ids.clean = await insertBusiness(db, { name: 'Farmacia di Prova Curata' });
  await insertAudit(db, ids.clean, {});
  // negozio con catalogo ma senza vendita online
  ids.shop = await insertBusiness(db, { name: 'Negozio di Prova', category: 'negozi', municipality: '032006' });
  await insertAudit(db, ids.shop, { signals: { ecommerce: false }, findings: [{ code: 'IND_NO_ECOMMERCE' }] });
  ids.noSite = await insertBusiness(db, { name: 'Bar di Prova Senza Sito', category: 'ristorazione', website: null });
  await scoreBusinesses(db, Object.values(ids), { trigger: 'manual' });
});
afterAll(async () => {
  await server.close();
  await db.close();
});

async function login(email = 'sales@noventra.test') {
  const c = client(server.url);
  expect((await c.request('POST', '/api/auth/login', { email, password: PASSWORD })).status).toBe(200);
  return c;
}

describe('accesso e catalogo', () => {
  it('senza sessione: 401', async () => {
    const anon = client(server.url);
    for (const [m, p] of [
      ['GET', '/api/services'],
      ['GET', '/api/service-catalog'],
      ['GET', `/api/businesses/${ids.weak}/services`],
      ['POST', `/api/businesses/${ids.weak}/services/seo/review`],
      ['PUT', '/api/service-catalog'],
    ] as const)
      expect((await anon.request(m, p, m === 'GET' ? undefined : {})).status, p).toBe(401);
  });

  it('catalogo: solo servizi verificati su noventra.it, con conteggi reali; modifiche solo da amministratore', async () => {
    const c = await login();
    const list = (await c.request('GET', '/api/services')).body;
    expect(list.version).toBe(1);
    expect(
      list.services.every(
        (s: { verified: boolean; source: string }) => s.verified && s.source.startsWith('https://www.noventra.it/'),
      ),
    ).toBe(true);
    expect(list.services.find((s: { id: string }) => s.id === 'seo').counts.recommended).toBeGreaterThanOrEqual(1);
    expect((await c.request('GET', '/api/services/inventato')).status).toBe(404);
    expect((await c.request('GET', '/api/services/seo')).body.service.name).toBe('SEO Optimization');
    expect((await c.request('PUT', '/api/service-catalog', { catalog: DEFAULT_CATALOG })).status).toBe(403);
    expect((await c.request('POST', '/api/service-catalog/validate', { catalog: DEFAULT_CATALOG })).status).toBe(403);
  });
});

describe('servizi consigliati per un’azienda', () => {
  it('lista breve con prove, problema e verifica; separata dal punteggio del lead', async () => {
    const c = await login();
    const r = (await c.request('GET', `/api/businesses/${ids.weak}/services`)).body;
    expect(r.shortlist.length).toBeGreaterThan(0);
    expect(r.shortlist.length).toBeLessThanOrEqual(3);
    const first = r.matches.find((m: { serviceId: string }) => m.serviceId === r.shortlist[0]);
    expect(first).toMatchObject({
      status: expect.stringMatching(/recommended|possible|needs_review/),
      problem: expect.any(String),
      nextStep: expect.any(String),
    });
    expect(first.evidence.auditId).toBeTruthy();
    expect(first.explanation).toMatch(/corrispondenza \d+\/100/);
    // un solo servizio per problema di fondo (SEO e GEO, e-commerce)
    const groups = r.shortlist.map(
      (id: string) => r.matches.find((m: { serviceId: string }) => m.serviceId === id).dedupeGroup,
    );
    expect(new Set(groups).size).toBe(groups.length);
    expect(r.manualServices.map((s: { service: { id: string } }) => s.service.id)).toContain('app_mobile');
    expect(r.run).toMatchObject({ catalogVersion: 1, algorithmVersion: 1, outdated: [] });
  });

  it('sito curato: nessun servizio proposto; senza sito: prove insufficienti, nessuna proposta', async () => {
    const c = await login();
    expect((await c.request('GET', `/api/businesses/${ids.clean}/services`)).body.shortlist).toEqual([]);
    const none = (await c.request('GET', `/api/businesses/${ids.noSite}/services`)).body;
    expect(none.shortlist).toEqual([]);
    expect(none.matches.find((m: { serviceId: string }) => m.serviceId === 'sviluppo_siti_web')).toMatchObject({
      status: 'insufficient_evidence',
      score: null,
    });
  });

  it('revisioni: archiviazione con motivo, conservata dopo un ricalcolo; riapertura; accettazione in testa; note', async () => {
    const c = await login();
    const before = (await c.request('GET', `/api/businesses/${ids.weak}/services`)).body;
    const top = before.shortlist[0];
    const dismissed = (
      await c.request('POST', `/api/businesses/${ids.weak}/services/${top}/review`, {
        action: 'dismissed',
        note: 'Ha già un fornitore (prova)',
      })
    ).body;
    expect(dismissed.shortlist).not.toContain(top);
    const after = (await c.request('POST', `/api/businesses/${ids.weak}/services/recalculate`, { force: true })).body;
    expect(after.created).toBe(true);
    const m = after.matches.find((x: { serviceId: string }) => x.serviceId === top);
    expect(m.review.status).toBe('dismissed');
    expect(m.review.history[0]).toMatchObject({ action: 'dismissed', note: 'Ha già un fornitore (prova)' });
    expect(after.shortlist).not.toContain(top);
    const reopened = (
      await c.request('POST', `/api/businesses/${ids.weak}/services/${top}/review`, { action: 'reopened' })
    ).body;
    expect(reopened.shortlist).toContain(top);
    const last = reopened.shortlist.at(-1);
    const accepted = (
      await c.request('POST', `/api/businesses/${ids.weak}/services/${last}/review`, { action: 'accepted_for_review' })
    ).body;
    expect(accepted.shortlist[0]).toBe(last);
    // nota senza cambiare stato; nota vuota rifiutata; servizio inesistente; azione non valida
    const noted = (
      await c.request('POST', `/api/businesses/${ids.weak}/services/${last}/review`, {
        action: 'note',
        note: 'Chiamare dopo le 15 (prova)',
      })
    ).body;
    expect(noted.matches.find((x: { serviceId: string }) => x.serviceId === last).review.status).toBe(
      'accepted_for_review',
    );
    expect(
      (await c.request('POST', `/api/businesses/${ids.weak}/services/${last}/review`, { action: 'note' })).status,
    ).toBe(400);
    expect(
      (await c.request('POST', `/api/businesses/${ids.weak}/services/inventato/review`, { action: 'dismissed' }))
        .status,
    ).toBe(404);
    expect(
      (await c.request('POST', `/api/businesses/${ids.weak}/services/seo/review`, { action: 'cancellato' })).status,
    ).toBe(400);
    // le revisioni non si cancellano mai
    const { rows } = await db.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM service_match_reviews WHERE business_id = $1',
      [ids.weak],
    );
    expect(rows[0]!.n).toBe(4);
  });

  it('ricalcolo: nessuna esecuzione nuova a prove invariate; nuova dopo un audit, storico conservato', async () => {
    const c = await login();
    const runs = async () => (await c.request('GET', `/api/businesses/${ids.shop}/services/history`)).body.total;
    const n = await runs();
    expect((await c.request('POST', `/api/businesses/${ids.shop}/services/recalculate`, {})).body.created).toBe(false);
    expect(await runs()).toBe(n);
    await insertAudit(db, ids.shop, { findings: [] });
    expect((await c.request('GET', `/api/businesses/${ids.shop}/services`)).body.run.outdated.join(' ')).toMatch(
      /audit più recente/,
    );
    expect((await c.request('POST', `/api/businesses/${ids.shop}/services/recalculate`, {})).body.created).toBe(true);
    const h = (await c.request('GET', `/api/businesses/${ids.shop}/services/history`)).body;
    expect(h.total).toBe(n + 1);
    expect(h.items.filter((x: { isCurrent: boolean }) => x.isCurrent)).toHaveLength(1);
    // il negozio ora vende online (signals.ecommerce del nuovo audit): l'e-commerce non è più proposto, il vecchio resta nello storico
    expect(h.items[1].proposed.map((p: { serviceId: string }) => p.serviceId)).toContain('ecommerce_shopify');
    expect(h.items[0].proposed.map((p: { serviceId: string }) => p.serviceId)).not.toContain('ecommerce_shopify');
  });

  it('calcoli contemporanei: un solo abbinamento attuale per azienda e servizio', async () => {
    await Promise.all(
      Array.from({ length: 4 }, () => scoreBusinesses(db, [ids.weak], { trigger: 'manual', force: true })),
    );
    const { rows } = await db.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM service_matches WHERE business_id = $1 AND is_current GROUP BY service_id ORDER BY n DESC LIMIT 1',
      [ids.weak],
    );
    expect(rows[0]!.n).toBe(1);
  });
});

describe('elenco per servizio', () => {
  it('filtri per servizio, corrispondenza minima, stato e revisione; ordinamento separato dal punteggio del lead', async () => {
    const c = await login();
    const names = async (q: string) =>
      (await c.request('GET', `/api/businesses?pageSize=100&${q}`)).body.items
        .map((b: { name: string }) => b.name)
        .sort();
    expect(await names('service=seo')).toEqual(['Farmacia di Prova Trascurata']);
    expect(await names('service=farmacube')).toEqual(['Farmacia di Prova Trascurata']);
    expect(await names('service=seo&minMatch=100')).toEqual([]);
    expect(await names('matchStatus=insufficient_evidence')).toContain('Bar di Prova Senza Sito');
    expect(await names('matchStatus=accepted_for_review')).toEqual(['Farmacia di Prova Trascurata']);
    const sorted = (await c.request('GET', '/api/businesses?sort=match&dir=desc&pageSize=100')).body.items;
    expect(sorted[0].name).toBe('Farmacia di Prova Trascurata');
    expect(sorted[0].services.primary).toMatchObject({ name: expect.any(String), score: expect.any(Number) });
    expect(sorted.at(-1).services.matchScore).toBeNull();
    const viaService = (await c.request('GET', '/api/services/seo/businesses?pageSize=1&page=1')).body;
    expect(viaService).toMatchObject({ total: 1, page: 1, pageSize: 1 });
    expect((await c.request('GET', '/api/services/inventato/businesses')).status).toBe(404);
    expect((await c.request('GET', '/api/businesses?service=SEO!')).status).toBe(400);
    expect((await c.request('GET', '/api/businesses?matchStatus=forse')).status).toBe(400);
  });
});

describe('modifiche del catalogo e ricalcoli in blocco', () => {
  it('amministratore: servizio disattivato non più proposto dopo il ricalcolo; versioni conservate', async () => {
    const admin = await login('admin@noventra.test');
    const cat = structuredClone(DEFAULT_CATALOG);
    cat.services.find((s) => s.id === 'seo')!.active = false;
    const bad = structuredClone(cat);
    bad.services[0]!.verified = false;
    const rejected = await admin.request('PUT', '/api/service-catalog', { catalog: bad });
    expect(rejected.status).toBe(400);
    expect(rejected.body.error.fields['services.0.active']).toBeTruthy();
    expect(
      (await admin.request('PUT', '/api/service-catalog', { catalog: cat, note: 'SEO sospeso (prova)' })).body.version,
    ).toBe(2);
    expect((await admin.request('GET', `/api/businesses/${ids.weak}/services`)).body.run.outdated.join(' ')).toMatch(
      /catalogo v\d; attivo: v2/,
    );
    const job = await createScoringJob(db, { scope: { kind: 'all' }, trigger: 'bulk' }, adminId);
    await new ScoringWorker(db, { log: silentLogger }).runOnce();
    expect((await getScoringJob(db, job)).progress.matchesCreated).toBe(4);
    const r = (await admin.request('GET', `/api/businesses/${ids.weak}/services`)).body;
    expect(r.matches.map((m: { serviceId: string }) => m.serviceId)).not.toContain('seo');
    expect(r.run.catalogVersion).toBe(2);
    const old = await db.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM service_matches WHERE service_id = 'seo'",
    );
    expect(old.rows[0]!.n).toBeGreaterThan(0);
  });

  it('ricalcolo in blocco non riuscito: stato "failed" con un messaggio, nessun dato parziale incoerente', async () => {
    // catalogo salvato fuori dall'applicazione e non più valido: il job si ferma con un errore chiaro
    await db.query(
      "INSERT INTO service_catalog_versions (version, catalog, note) VALUES (99, '{\"weights\":{}}', 'non valido (prova)')",
    );
    const job = await createScoringJob(
      db,
      { scope: { kind: 'businesses', ids: [ids.weak] }, trigger: 'manual', force: true },
      adminId,
    );
    await new ScoringWorker(db, { log: silentLogger }).runOnce();
    expect(await getScoringJob(db, job)).toMatchObject({
      status: 'failed',
      error: expect.stringMatching(/Errore interno/),
    });
    const { rows } = await db.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM service_match_runs WHERE business_id = $1 AND is_current',
      [ids.weak],
    );
    expect(rows[0]!.n).toBe(1);
    await db.query('DELETE FROM service_catalog_versions WHERE version = 99');
  });
});
