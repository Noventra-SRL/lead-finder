import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startFakeSite, type FakeSite } from '../../audit/fakeSite.ts';
import { createAuditJob, policyFor } from '../../audit/jobs.ts';
import { AuditWorker } from '../../audit/worker.ts';
import { classifyBusiness } from '../../categories/classify.ts';
import { defaultAudit, defaultDiscovery, loadConfig, type AuditConfig } from '../../config.ts';
import type { Db } from '../../db/client.ts';
import { geo } from '../../geo/geo.ts';
import { createHuntRun, getHuntRun } from '../../hunter/runs.ts';
import { HuntWorker } from '../../hunter/worker.ts';
import { silentLogger } from '../../logger.ts';
import { client, createTestUser, startTestServer, testDatabase, type TestServer } from '../../testing.ts';
import { listBusinesses, type BusinessFilters } from '../businesses.ts';
import { OverpassProvider } from '../osm/overpass.ts';
import { saveRecord } from '../store.ts';
import { ProviderError, type ProviderRecord } from '../types.ts';
import { DiscoveryWorker } from '../worker.ts';
import { FAKE_GOOGLE_KEY, startFakePlaces } from './fakePlaces.ts';
import { GooglePlacesProvider, municipalityOf, placeToRecord } from './places.ts';
import { GOOGLE_QUERIES } from './queries.ts';
import { dbUsageBudget, usageToday } from './usage.ts';

/*
 * Google Places e arricchimento email dall'inizio alla fine: database reale, worker reali (scoperta, ricerche di lead,
 * audit), server Google Places FINTO e siti FINTI locali. Nessuna richiesta verso Google o verso siti reali, nessuna
 * email inviata. DATI DI TEST: attività «di Prova».
 */

const PASSWORD = 'password-di-prova-lunga';
const noSleep = { now: () => Date.now(), sleep: async () => undefined };

let db: Db;
let fake: Awaited<ReturnType<typeof startFakePlaces>>;
let site: FakeSite;
let bare: FakeSite;
let google: GooglePlacesProvider;
let discovery: DiscoveryWorker;
let hunter: HuntWorker;
let audit: AuditWorker;
let auditConfig: AuditConfig;
let server: TestServer;
let userId: string;
const narni = () =>
  geo()
    .search('Narni')
    .find((a) => a.type === 'municipality')!;

const provider = (over: { apiKey?: string | null; maxPages?: number; budget?: number } = {}) =>
  new GooglePlacesProvider(
    {
      apiKey: over.apiKey === undefined ? FAKE_GOOGLE_KEY : over.apiKey,
      baseUrl: fake.url,
      maxPages: over.maxPages ?? 3,
      timeoutMs: 5000,
      maxRetries: 2,
      minIntervalMs: 0,
    },
    { clock: noSleep, budget: over.budget === undefined ? null : dbUsageBudget(db, over.budget) },
  );

beforeAll(async () => {
  db = await testDatabase();
  fake = await startFakePlaces();
  // sito di un'attività: email nella pagina dei contatti e nel piè di pagina, più indirizzi da non usare
  site = await startFakeSite({
    '/robots.txt': { headers: { 'Content-Type': 'text/plain' }, body: 'User-agent: *\nAllow: /\n' },
    '/': {
      body: `<!doctype html><html lang="it"><head><title>Farmacia di Prova</title></head><body>
        <nav><a href="/contatti">Contatti</a> <a href="/chi-siamo">Chi siamo</a></nav><main><h1>Benvenuti</h1></main>
        <footer>Farmacia di Prova · <a href="mailto:info.prova@gmail.com">info.prova@gmail.com</a> ·
        sito realizzato da info@agenzia-web-prova.example.it</footer></body></html>`,
    },
    '/contatti': {
      body: `<!doctype html><html lang="it"><head><title>Contatti</title></head><body><h1>Contatti</h1>
        <p>Prenotazioni: prenotazioni.prova@gmail.com · Titolare: mario.rossi@gmail.com · PEC: prova@pec.it</p></body></html>`,
    },
  });
  // sito senza alcuna email scritta
  bare = await startFakeSite({
    '/': { body: '<html lang="it"><body><h1>Benvenuti</h1><p>Chiamaci.</p></body></html>' },
  });
  fake.control.websiteFor = (slug, i) => (i === 0 ? (slug.includes('farmacia') ? site.url : bare.url) : null);
  google = provider();
  const osm = new OverpassProvider({
    endpoint: null,
    userAgent: 'NoventraLeadFinder/test',
    minIntervalMs: 0,
    timeoutSeconds: 30,
    maxsizeBytes: 1 << 28,
    maxRetries: 0,
    maxResponseBytes: 1 << 22,
    cacheTtlMs: 0,
  });
  discovery = new DiscoveryWorker(db, [osm, google], { log: silentLogger });
  hunter = new HuntWorker(db, {
    log: silentLogger,
    discovery: {
      config: { ...defaultDiscovery, municipalitiesPerRequest: 50 },
      providerId: 'osm',
      configured: () => false,
      configuredFor: (id) => id === 'google',
      wake: () => undefined,
    },
    audit: { config: defaultAudit, policy: policyFor(defaultAudit, 'test'), wake: () => undefined },
  });
  auditConfig = {
    ...defaultAudit,
    hostIntervalMs: 0,
    requestTimeoutMs: 3000,
    connectTimeoutMs: 1500,
    testLoopbackPorts: [site.port, bare.port],
  };
  audit = new AuditWorker(db, {
    log: silentLogger,
    config: auditConfig,
    policy: policyFor(auditConfig, 'test'),
    performance: null,
    sleep: async () => undefined,
  });
  server = await startTestServer(db, {
    discovery: {
      provider: osm,
      extraProviders: [google],
      config: defaultDiscovery,
    },
    hunter: { workerActive: true },
    audit: { config: auditConfig, policy: policyFor(auditConfig, 'test') },
  });
  userId = (await createTestUser(db, { email: 'google@noventra.test', role: 'admin', password: PASSWORD })).id;
});
afterAll(async () => {
  await server.close();
  await site.close();
  await bare.close();
  await fake.close();
  await db.close();
});

async function login() {
  const c = client(server.url);
  expect(
    (await c.request('POST', '/api/auth/login', { email: 'google@noventra.test', password: PASSWORD })).status,
  ).toBe(200);
  return c;
}

const filters = (over: Partial<BusinessFilters> = {}): BusinessFilters => ({
  sort: 'name',
  dir: 'asc',
  page: 1,
  pageSize: 50,
  ...over,
});

describe('Google Places: conversione dei luoghi', () => {
  it('ogni settore del catalogo ha una ricerca in italiano', () => {
    expect(GOOGLE_QUERIES.farmacie).toEqual({ text: 'farmacia', includedType: 'pharmacy' });
    expect(GOOGLE_QUERIES.bed_and_breakfast?.includedType).toBe('bed_and_breakfast');
  });

  it('luogo → record: nome, indirizzo, comune ISTAT, sito, telefono, tipi; nessuna email; chiuse scartate', () => {
    const m = geo().municipality(narni().code)!;
    const place = {
      id: 'ChIJ-prova-1',
      displayName: { text: 'Farmacia di Prova Narni' },
      addressComponents: [
        { longText: '12', types: ['street_number'] },
        { longText: 'Via di Prova', types: ['route'] },
        { longText: 'Narni', types: ['locality', 'political'] },
        { longText: 'Narni', types: ['administrative_area_level_3', 'political'] },
        { longText: '05035', types: ['postal_code'] },
      ],
      location: { latitude: 42.51, longitude: 12.51 },
      websiteUri: 'https://www.farmacia-prova.example.it/',
      nationalPhoneNumber: '0744 000000',
      types: ['pharmacy', 'health', 'store'],
      primaryType: 'pharmacy',
      businessStatus: 'OPERATIONAL',
    };
    const r = placeToRecord(place, 'farmacie', m)!;
    expect(r).toMatchObject({
      provider: 'google',
      ref: 'ChIJ-prova-1',
      name: 'Farmacia di Prova Narni',
      sector: 'farmacie',
      category: 'farmacie',
      websiteDomain: 'farmacia-prova.example.it',
      municipalityCode: m.code,
      address: { street: 'Via di Prova', housenumber: '12', postcode: '05035', city: 'Narni' },
      contacts: { phone: '0744 000000', email: null, emailKind: null },
      sourceTags: { google_primary_type: 'pharmacy' },
    });
    expect(placeToRecord({ ...place, businessStatus: 'CLOSED_PERMANENTLY' }, 'farmacie', m)).toBeNull();
    expect(placeToRecord({ ...place, displayName: undefined }, 'farmacie', m)).toBeNull();
    // comune non riconoscibile: non determinato, mai indovinato
    expect(
      municipalityOf({ addressComponents: [{ longText: 'Località Inesistente', types: ['locality'] }] }, m),
    ).toBeNull();
    // categoria dai tipi di Google, con la prova
    expect(
      classifyBusiness({ name: r.name, tags: r.sourceTags, sector: r.sector, category: r.category }),
    ).toMatchObject({
      category: 'farmacie',
      evidence: 'Google Maps: tipo pharmacy',
    });
    expect(
      classifyBusiness({
        name: 'B&B di Prova',
        tags: { google_primary_type: 'hotel', google_types: 'hotel;lodging' },
        sector: null,
        category: null,
      }).category,
    ).toBe('bnb_case_vacanza');
    expect(
      classifyBusiness({
        name: 'Da Mario',
        tags: { google_primary_type: 'pizza_restaurant' },
        sector: null,
        category: null,
      }).category,
    ).toBe('pizzerie');
  });
});

describe('Google Places: richieste, paginazione ed errori', () => {
  const unit = () => ({ municipalities: [geo().municipality(narni().code)!] });

  it('senza chiave: «non configurato», nessuna richiesta', async () => {
    const before = fake.control.requests.length;
    await expect(
      provider({ apiKey: null }).fetchUnit(unit(), [], 20, new AbortController().signal, undefined, {
        sectors: ['farmacie'],
      }),
    ).rejects.toMatchObject({ kind: 'not_configured', message: expect.stringMatching(/GOOGLE_PLACES_API_KEY/) });
    expect(fake.control.requests.length).toBe(before);
    expect(provider({ apiKey: null }).info()).toMatchObject({ id: 'google', configured: false });
  });

  it('paginazione con nextPageToken, campi richiesti, tipo di luogo, limite per area', async () => {
    fake.control.requests.length = 0;
    fake.control.fieldMasks.length = 0;
    const r = await provider().fetchUnit(unit(), [], 20, new AbortController().signal, undefined, {
      sectors: ['farmacie'],
    });
    // 3 luoghi su 2 pagine (2 + 1); il terzo è chiuso definitivamente
    expect(r.requests).toBe(2);
    expect(r.records.map((x) => x.name)).toEqual([
      'Farmacia di Prova Google Narni 1',
      'Farmacia di Prova Google Narni 2',
    ]);
    expect(fake.control.requests[0]).toMatchObject({
      textQuery: 'farmacia a Narni (TR)',
      languageCode: 'it',
      regionCode: 'IT',
      includedType: 'pharmacy',
    });
    expect(fake.control.requests[1]).toMatchObject({ pageToken: '2' });
    expect(fake.control.fieldMasks[0]).toContain('places.websiteUri');
    expect(fake.control.fieldMasks[0]).not.toContain('reviews');
    // limite per area: una sola pagina
    const one = await provider().fetchUnit(unit(), [], 1, new AbortController().signal, undefined, {
      sectors: ['farmacie'],
    });
    expect(one.records).toHaveLength(1);
    expect(one.requests).toBe(1);
  });

  it('429 e 503 ritentati con attesa; chiave rifiutata: messaggio chiaro; tipo non accettato: ripetuta senza tipo', async () => {
    fake.control.failures.push(429, 503);
    const retries: number[] = [];
    const r = await provider().fetchUnit(unit(), [], 1, new AbortController().signal, (i) => retries.push(i.attempt), {
      sectors: ['farmacie'],
    });
    expect(retries).toEqual([1, 2]);
    expect(r.records).toHaveLength(1);
    // quota esaurita oltre i tentativi
    fake.control.failures.push(429, 429, 429);
    await expect(
      provider().fetchUnit(unit(), [], 1, new AbortController().signal, undefined, { sectors: ['farmacie'] }),
    ).rejects.toMatchObject({ kind: 'rate_limited', attempts: 3 });
    // chiave non valida
    await expect(
      provider({ apiKey: 'chiave-sbagliata-di-prova-000000000' }).fetchUnit(
        unit(),
        [],
        1,
        new AbortController().signal,
        undefined,
        { sectors: ['farmacie'] },
      ),
    ).rejects.toMatchObject({ kind: 'not_configured', message: expect.stringMatching(/rifiutato la chiave/) });
    // tipo di luogo non accettato: la stessa ricerca solo con il testo
    fake.control.rejectTypes.add('pharmacy');
    fake.control.requests.length = 0;
    const noType = await provider().fetchUnit(unit(), [], 1, new AbortController().signal, undefined, {
      sectors: ['farmacie'],
    });
    expect(noType.records).toHaveLength(1);
    // la prima richiesta (con il tipo) è rifiutata, la seconda è la stessa ricerca senza tipo
    expect(fake.control.requests.map((x) => x.includedType ?? null)).toEqual(['pharmacy', null]);
    fake.control.rejectTypes.clear();
  });

  it('limite giornaliero di richieste contato nel database: oltre, la ricerca si ferma e lo dichiara', async () => {
    const p = provider({ budget: 3 });
    await p.fetchUnit(unit(), [], 20, new AbortController().signal, undefined, { sectors: ['farmacie'] });
    expect(await usageToday(db, 'google')).toBe(2);
    const error = await p
      .fetchUnit(unit(), [], 20, new AbortController().signal, undefined, { sectors: ['farmacie'] })
      .catch((e: ProviderError) => e);
    expect(error).toBeInstanceOf(ProviderError);
    expect((error as ProviderError).message).toMatch(/limite giornaliero di 3 richieste/);
    expect(await usageToday(db, 'google')).toBe(3);
  });

  it('configurazione: nei test solo il server finto, mai Google reale', () => {
    expect(() =>
      loadConfig({
        NODE_ENV: 'test',
        DATABASE_URL: 'postgres://u:p@127.0.0.1/db',
        GOOGLE_PLACES_API_KEY: 'chiave-di-prova-lunga-0000000000',
      }),
    ).toThrow(/GOOGLE_PLACES_TEST_BASE_URL/);
    expect(() =>
      loadConfig({
        NODE_ENV: 'production',
        DATABASE_URL: 'postgres://u:p@127.0.0.1/db',
        APP_ORIGIN: 'https://lead.noventra.example.it',
        GOOGLE_PLACES_TEST_BASE_URL: 'http://127.0.0.1:9999',
      }),
    ).toThrow(/solo con NODE_ENV=test/);
  });
});

/** Fa avanzare coordinatore e scoperta finché la ricerca non termina. */
async function drive(runId: string) {
  for (let i = 0; i < 200; i++) {
    await hunter.tick();
    const { rows } = await db.query<{ status: string }>('SELECT status FROM hunt_runs WHERE id = $1', [runId]);
    if (!['pending', 'running'].includes(rows[0]!.status)) return rows[0]!.status;
    while (await discovery.runOnce());
  }
  throw new Error('la ricerca non è terminata');
}
const count = async (table: string) =>
  (await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${table}`)).rows[0]!.n;

describe('ricerca per categoria con Google e dati esistenti preservati', () => {
  let existingId = '';
  let opportunityId = '';

  it('un’azienda già nota (con trattativa ed email) viene arricchita, mai duplicata né sovrascritta', async () => {
    // azienda già nel database da OpenStreetMap, con lo stesso nome e a pochi metri del luogo Google n. 2, senza sito
    const r: ProviderRecord = {
      provider: 'osm',
      ref: 'node/9800000001',
      sourceUrl: 'https://www.openstreetmap.org/node/9800000001',
      name: 'Farmacia di Prova Google Narni 2',
      category: 'farmacie',
      sector: 'farmacie',
      contacts: { phone: null, email: 'info@farmacia-osm-prova.example.it', emailKind: 'generic' },
      websiteUrl: null,
      websiteDomain: null,
      websiteShared: false,
      address: { street: null, housenumber: null, postcode: null, city: null },
      municipalityCode: narni().code,
      latitude: 40.0105,
      longitude: 9 + 'farmacia-di-prova-google-narni-2'.length * 0.001,
      has: { website: false, address: false, phone: false, email: true, openingHours: false },
      sourceTags: { name: 'Farmacia di Prova Google Narni 2', amenity: 'pharmacy' },
    };
    existingId = (
      await db.transaction((tx) =>
        saveRecord(tx, r, {
          jobId: null,
          fetchedAt: new Date(),
          sourceDataAt: null,
          minCompleteness: 0,
          requireWebsite: false,
          seen: new Set(),
        }),
      )
    ).businessId!;
    await db.query("UPDATE businesses SET email_source = 'osm', email_status = 'da_verificare' WHERE id = $1", [
      existingId,
    ]);
    const c = await login();
    const opp = await c.request('POST', '/api/crm/opportunities', { businessId: existingId });
    expect(opp.status).toBe(201);
    opportunityId = opp.body.opportunity.id;

    const before = { businesses: await count('businesses'), opportunities: await count('crm_opportunities') };
    const res = await c.request('POST', '/api/hunter/runs', {
      target: 10,
      area: { type: 'municipality', code: narni().code },
      category: 'farmacie',
      provider: 'google',
      options: { audit: false },
    });
    expect(res.status).toBe(201);
    expect(res.body.run.provider).toEqual({ id: 'google', label: 'Google Maps' });
    expect(await drive(res.body.run.id)).toMatch(/^completed/);
    const run = await getHuntRun(db, res.body.run.id);
    // due luoghi aperti: uno nuovo, l'altro è l'azienda già nota (collegata, non duplicata)
    expect(run.progress.linked).toBe(2);
    expect(run.progress.linkedNew).toBe(1);
    expect(await count('businesses')).toBe(before.businesses + 1);
    expect(await count('crm_opportunities')).toBe(before.opportunities);
    const { rows } = await db.query<{
      provider: string;
      email: string;
      email_source: string;
      website_url: string | null;
    }>(
      `SELECT s.provider, b.email, b.email_source, b.website_url FROM business_sources s JOIN businesses b ON b.id = s.business_id
        WHERE s.business_id = $1 ORDER BY s.provider`,
      [existingId],
    );
    expect(rows.map((x) => x.provider)).toEqual(['google', 'osm']);
    // l'email esistente resta (non sostituita da nulla), la trattativa resta
    expect(rows[0]).toMatchObject({ email: 'info@farmacia-osm-prova.example.it', email_source: 'osm' });
    const o = await c.request('GET', `/api/crm/opportunities/${opportunityId}`);
    expect(o.body.opportunity.business.id).toBe(existingId);
    // la categoria dell'azienda nuova viene dai tipi di Google
    const fresh = await listBusinesses(db, filters({ q: 'Farmacia di Prova Google Narni 1' }));
    expect(fresh.items[0]!.businessCategory).toMatchObject({ id: 'farmacie', evidence: 'Google Maps: tipo pharmacy' });
  });

  it('ripetere la ricerca: nessun doppione, nessun dato perso', async () => {
    const before = await count('businesses');
    const sources = await count('business_sources');
    const id = await createHuntRun(
      db,
      {
        target: 10,
        area: { type: 'municipality', code: narni().code },
        sectors: [],
        category: 'farmacie',
        provider: 'google',
        options: { minScore: null, websitePreference: 'any', excludeKnown: false, audit: false },
      },
      { userId, providerConfigured: true },
    );
    await drive(id);
    expect(await count('businesses')).toBe(before);
    expect(await count('business_sources')).toBe(sources);
    expect((await getHuntRun(db, id)).progress.linkedNew).toBe(0);
  });

  it('API: Google non configurato → avvio rifiutato con un messaggio chiaro; fonti elencate senza chiavi', async () => {
    const c = await login();
    const meta = await c.request('GET', '/api/hunter/meta');
    expect(meta.body.providers.map((p: { id: string; configured: boolean }) => [p.id, p.configured])).toEqual([
      ['osm', false],
      ['google', true],
    ]);
    expect(JSON.stringify(meta.body)).not.toContain(FAKE_GOOGLE_KEY);
  });
});

describe('arricchimento email dai siti', () => {
  let farmacia = '';
  let senzaEmail = '';

  it('stato iniziale: siti da controllare; l’arricchimento è un job in sottofondo (API)', async () => {
    const all = await listBusinesses(db, filters({ q: 'di prova google narni' }));
    farmacia = all.items.find((b) => b.name === 'Farmacia di Prova Google Narni 1')!.id;
    // i siti finti sono su 127.0.0.1, che la normalizzazione dei siti delle fonti giustamente rifiuta: si collega il
    // sito finto all'azienda trovata con Google, come fanno i test dell'audit (l'arricchimento non dipende dalla fonte)
    const other = all.items.find((b) => b.name === 'Farmacia di Prova Google Narni 2')!.id;
    await db.query(
      "UPDATE businesses SET website_url = $2, website_domain = '127.0.0.1', has_website = true, website_shared = false WHERE id = $1",
      [farmacia, site.url],
    );
    await db.query(
      "UPDATE businesses SET website_url = $2, website_domain = '127.0.0.1', has_website = true, website_shared = false WHERE id = $1",
      [other, bare.url],
    );
    const f = await listBusinesses(db, filters({ ids: [farmacia] }));
    expect(f.items[0]!.emailInfo).toMatchObject({ status: 'da_arricchire' });
    const c = await login();
    const res = await c.request('POST', '/api/enrichment/start', {
      scope: 'pending',
      filters: `q=${encodeURIComponent('Farmacia di Prova Google Narni 1')}`,
    });
    expect(res.status).toBe(201);
    expect(res.body.queued).toBe(1);
    while (await audit.runOnce());
  });

  it('email pubblicate: provenienza salvata, recapito scelto con le regole, personali e di altri domini esclusi', async () => {
    const { rows } = await db.query<{ email: string; relation: string; page_url: string }>(
      `SELECT we.email, we.relation, we.page_url FROM website_emails we JOIN business_websites bw ON bw.website_id = we.website_id
        WHERE bw.business_id = $1 ORDER BY we.email`,
      [farmacia],
    );
    expect(rows.map((r) => [r.email, r.relation])).toEqual([
      ['info.prova@gmail.com', 'free_provider'],
      ['info@agenzia-web-prova.example.it', 'other_domain'],
      ['prenotazioni.prova@gmail.com', 'free_provider'],
    ]);
    // nome.cognome@ non conservato; PEC non è un recapito commerciale (non generica: non conservata)
    expect(rows.find((r) => r.email.startsWith('mario.rossi'))).toBeUndefined();
    expect(rows.find((r) => r.email === 'prenotazioni.prova@gmail.com')!.page_url).toMatch(/\/contatti$/);
    const b = (await listBusinesses(db, filters({ ids: [farmacia] }))).items[0]!;
    expect(b.contacts.email).toBe('info.prova@gmail.com');
    expect(b.emailInfo).toMatchObject({ status: 'pubblicata', source: 'website', sourceUrl: site.url });
    // la disponibilità dell'email non cambia il punteggio né gli indicatori della fonte
    const { rows: flags } = await db.query<{ has_email: boolean }>('SELECT has_email FROM businesses WHERE id = $1', [
      farmacia,
    ]);
    expect(flags[0]!.has_email).toBe(false);
  });

  it('sito senza email: «nessuna email trovata»; un nuovo controllo non perde nulla né sostituisce il recapito', async () => {
    // l'azienda già nota ha un'email dalla fonte: il suo sito senza email non la cancella né la cambia
    const known = (await listBusinesses(db, filters({ q: 'Farmacia di Prova Google Narni 2' }))).items[0]!;
    expect(known.emailInfo?.status).toBe('da_verificare');
    // un'azienda senza email con lo stesso sito senza indirizzi
    const saved = await db.transaction((tx) =>
      saveRecord(
        tx,
        {
          provider: 'osm',
          ref: 'node/9800000002',
          sourceUrl: 'https://www.openstreetmap.org/node/9800000002',
          name: 'Bar di Prova Senza Email',
          category: 'ristorazione',
          sector: 'bar_caffe',
          contacts: { phone: null, email: null, emailKind: null },
          websiteUrl: bare.url,
          websiteDomain: '127.0.0.1',
          websiteShared: false,
          address: { street: null, housenumber: null, postcode: null, city: null },
          municipalityCode: narni().code,
          latitude: 42.6,
          longitude: 12.6,
          has: { website: true, address: false, phone: false, email: false, openingHours: false },
          sourceTags: { name: 'Bar di Prova Senza Email', amenity: 'bar' },
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
    senzaEmail = saved.businessId!;
    expect((await listBusinesses(db, filters({ ids: [senzaEmail] }))).items[0]!.emailInfo?.status).toBe(
      'da_arricchire',
    );
    await createAuditJob(
      db,
      { businessIds: [senzaEmail, known.id] },
      { userId, config: auditConfig, policy: policyFor(auditConfig, 'test') },
    );
    while (await audit.runOnce());
    expect((await listBusinesses(db, filters({ ids: [senzaEmail] }))).items[0]!.emailInfo?.status).toBe(
      'nessuna_email',
    );
    const after = (await listBusinesses(db, filters({ ids: [known.id] }))).items[0]!;
    expect(after.contacts.email).toBe('info@farmacia-osm-prova.example.it');
    expect(after.emailInfo?.status).toBe('da_verificare');
    // il sito della farmacia cambia: l'indirizzo scelto sparisce e ne compare un altro
    site.routes.set('/', {
      body: '<html lang="it"><body><footer>Scrivici: ordini.prova@gmail.com</footer></body></html>',
    });
    await createAuditJob(
      db,
      { businessIds: [farmacia], force: true },
      { userId, config: auditConfig, policy: policyFor(auditConfig, 'test') },
    );
    while (await audit.runOnce());
    const b = (await listBusinesses(db, filters({ ids: [farmacia] }))).items[0]!;
    expect(b.contacts.email).toBe('info.prova@gmail.com');
    const { rows } = await db.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM website_emails we JOIN business_websites bw ON bw.website_id = we.website_id WHERE bw.business_id = $1',
      [farmacia],
    );
    expect(rows[0]!.n).toBe(4);
  });

  it('filtri e priorità: aziende con email prima; conteggi per categoria', async () => {
    const byPriority = await listBusinesses(db, filters({ q: 'di prova google narni', sort: 'priority', dir: 'asc' }));
    expect(byPriority.items[0]!.emailInfo?.status).toMatch(/pubblicata|da_verificare/);
    const statuses = byPriority.items.map((b) => b.emailInfo!.status);
    const rank = (s: string) => (['pubblicata', 'verificata', 'da_verificare'].includes(s) ? 0 : 1);
    expect(statuses.map(rank)).toEqual([...statuses.map(rank)].sort());
    const published = await listBusinesses(db, filters({ contactability: ['pubblicata'] }));
    expect(published.items.map((b) => b.id)).toContain(farmacia);
    const c = await login();
    const cats = await c.request('GET', `/api/businesses/categories?q=${encodeURIComponent('di prova google narni')}`);
    const farmacie = cats.body.categories.find((x: { id: string }) => x.id === 'farmacie');
    expect(farmacie.counts.published).toBeGreaterThanOrEqual(1);
    const scheda = await c.request('GET', `/api/businesses/${farmacia}`);
    expect(
      scheda.body.business.websiteEmails.map((e: { email: string; current: boolean }) => [e.email, e.current]),
    ).toEqual(
      expect.arrayContaining([
        ['info.prova@gmail.com', false],
        ['ordini.prova@gmail.com', true],
      ]),
    );
  });
});
