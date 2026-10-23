import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { policyFor } from '../audit/jobs.ts';
import { defaultAudit, defaultDiscovery } from '../config.ts';
import type { Db } from '../db/client.ts';
import { listBusinesses, type BusinessFilters } from '../discovery/businesses.ts';
import { startFakeOverpass } from '../discovery/osm/fakeOverpass.ts';
import { OverpassProvider } from '../discovery/osm/overpass.ts';
import { SECTORS } from '../discovery/sectors.ts';
import { saveRecord, type SaveContext } from '../discovery/store.ts';
import type { ProviderRecord } from '../discovery/types.ts';
import { DiscoveryWorker } from '../discovery/worker.ts';
import { geo } from '../geo/geo.ts';
import { createHuntRun, getHuntRun } from '../hunter/runs.ts';
import { HuntWorker } from '../hunter/worker.ts';
import { silentLogger } from '../logger.ts';
import { client, createTestUser, startTestServer, testDatabase, type TestServer } from '../testing.ts';
import { BUSINESS_CATEGORIES, BUSINESS_CATEGORY_IDS, validateCatalog } from './catalog.ts';
import { classifyBusiness, CLASSIFIER_VERSION, fromTags } from './classify.ts';
import { categoryCounts } from './counts.ts';
import { BUSINESS_CATEGORY_OPTIONS } from '../../src/lib/categories.ts';
import { classifyOne, classifyPending, pendingClassification, setManualCategory } from './store.ts';

/*
 * Categorie commerciali: regole di classificazione, salvataggio con la scoperta, classificazione delle aziende
 * esistenti (riprendibile), scelta manuale, filtri, conteggi, paginazione e ricerca per categoria con la pipeline
 * reale (worker di scoperta e coordinatore) verso un server Overpass FINTO. DATI DI TEST: attività "di Prova".
 */

const PASSWORD = 'password-di-prova-lunga';
const TERNI = { type: 'province' as const, code: '055' };

let db: Db;
let fake: Awaited<ReturnType<typeof startFakeOverpass>>;
let discovery: DiscoveryWorker;
let hunter: HuntWorker;
let server: TestServer;
let userId: string;

beforeAll(async () => {
  db = await testDatabase();
  fake = await startFakeOverpass();
  const provider = new OverpassProvider({
    endpoint: fake.url,
    userAgent: 'NoventraLeadFinder/test',
    minIntervalMs: 0,
    timeoutSeconds: 30,
    maxsizeBytes: 1 << 28,
    maxRetries: 0,
    maxResponseBytes: 1 << 22,
    cacheTtlMs: 0,
  });
  discovery = new DiscoveryWorker(db, provider, { log: silentLogger });
  hunter = new HuntWorker(db, {
    log: silentLogger,
    discovery: {
      config: { ...defaultDiscovery, municipalitiesPerRequest: 50 },
      providerId: 'osm',
      configured: () => true,
      wake: () => undefined,
    },
    audit: { config: defaultAudit, policy: policyFor(defaultAudit, 'test'), wake: () => undefined },
  });
  server = await startTestServer(db, {
    discovery: { provider, config: defaultDiscovery },
    hunter: { workerActive: true },
  });
  userId = (await createTestUser(db, { email: 'categorie@noventra.test', role: 'admin', password: PASSWORD })).id;
});
afterAll(async () => {
  await server.close();
  await fake.close();
  await db.close();
});

async function login() {
  const c = client(server.url);
  expect(
    (await c.request('POST', '/api/auth/login', { email: 'categorie@noventra.test', password: PASSWORD })).status,
  ).toBe(200);
  return c;
}

const t = (tags: Record<string, string>, name = 'Attività di Prova') => fromTags(tags, name);

describe('regole di classificazione', () => {
  it('catalogo: 16 categorie canoniche più «Tutte», ogni settore del Lead Hunter cercabile da una categoria', () => {
    expect(BUSINESS_CATEGORY_IDS).toHaveLength(16);
    expect(BUSINESS_CATEGORIES.map((c) => c.label)).toEqual([
      'Farmacie',
      'Parafarmacie',
      'B&B e case vacanza',
      'Hotel e strutture ricettive',
      'Ristoranti',
      'Bar e caffetterie',
      'Pizzerie',
      'Parrucchieri e barbieri',
      'Centri estetici',
      'Palestre e centri fitness',
      'Studi medici e dentistici',
      'Studi professionali',
      'Negozi e attività commerciali',
      'Agenzie immobiliari',
      'Officine e autofficine',
      'Altre attività',
    ]);
    for (const s of SECTORS)
      expect(
        BUSINESS_CATEGORIES.some((c) => c.sectors.includes(s.id)),
        s.id,
      ).toBe(true);
    expect(() => validateCatalog([...BUSINESS_CATEGORIES.slice(1)])).toThrow(/identificativi canonici/);
    expect(() =>
      validateCatalog(BUSINESS_CATEGORIES.map((c) => (c.id === 'farmacie' ? { ...c, sectors: ['inesistente'] } : c))),
    ).toThrow(/Settore inesistente/);
    // le etichette usate dall'interfaccia (scheda dell'azienda) sono quelle del catalogo
    expect(BUSINESS_CATEGORY_OPTIONS).toEqual(BUSINESS_CATEGORIES.map((c) => ({ id: c.id, label: c.label })));
  });

  it('farmacie e parafarmacie', () => {
    expect(t({ amenity: 'pharmacy' })).toMatchObject({ category: 'farmacie', status: 'classificata' });
    expect(t({ healthcare: 'pharmacy' })?.category).toBe('farmacie');
    expect(t({ amenity: 'pharmacy', dispensing: 'no' })?.category).toBe('parafarmacie');
    expect(t({ amenity: 'pharmacy' }, 'Parafarmacia di Prova')?.category).toBe('parafarmacie');
    expect(t({ amenity: 'pharmacy' })?.evidence).toBe('OpenStreetMap: amenity=pharmacy');
    // fonte e nome in contrasto («Farmacia» senza dispensazione): nessuna scelta automatica data per certa
    expect(t({ amenity: 'pharmacy', dispensing: 'no' }, 'Farmacia Comunale di Prova')).toMatchObject({
      category: 'parafarmacie',
      status: 'da_verificare',
    });
  });

  it('strutture ricettive: B&B e case vacanza distinti da hotel, ostelli, campeggi e agriturismi', () => {
    expect(t({ tourism: 'guest_house' })?.category).toBe('bnb_case_vacanza');
    expect(t({ tourism: 'apartment' })?.category).toBe('bnb_case_vacanza');
    expect(t({ tourism: 'chalet' })?.category).toBe('bnb_case_vacanza');
    expect(t({ tourism: 'hotel' })?.category).toBe('hotel_ricettive');
    expect(t({ tourism: 'motel' })?.category).toBe('hotel_ricettive');
    expect(t({ tourism: 'hostel' })?.category).toBe('hotel_ricettive');
    expect(t({ tourism: 'camp_site' })?.category).toBe('hotel_ricettive');
    // l'agriturismo non è un B&B anche se mappato come guest house
    expect(t({ tourism: 'guest_house', guest_house: 'agritourism' })?.category).toBe('hotel_ricettive');
    expect(t({ tourism: 'guest_house' }, 'Agriturismo di Prova')?.category).toBe('hotel_ricettive');
    // un hotel con «B&B» nel nome è un B&B (il nome lo dichiara); un hotel qualsiasi resta un hotel
    expect(t({ tourism: 'hotel' }, 'B&B di Prova')).toMatchObject({
      category: 'bnb_case_vacanza',
      evidence: expect.stringMatching(/nome indica un B&B/),
    });
    expect(t({ tourism: 'hotel' }, 'Bed & Breakfast di Prova')?.category).toBe('bnb_case_vacanza');
    // la catena «B&B Hotels» è un hotel
    expect(t({ tourism: 'hotel' }, 'B&B Hotel Prova Centro')?.category).toBe('hotel_ricettive');
    expect(t({ tourism: 'hotel', brand: 'B&B Hotels' }, 'B&B Hotel')?.category).toBe('hotel_ricettive');
    expect(t({ tourism: 'hotel' }, 'Grand Hotel di Prova')?.category).toBe('hotel_ricettive');
    // turismo non ricettivo (un punto informazioni) non è una struttura ricettiva
    expect(t({ tourism: 'information' })?.category).toBe('altre_attivita');
  });

  it('ristorazione: pizzerie (cucina o nome), ristoranti, bar e caffetterie', () => {
    expect(t({ amenity: 'restaurant', cuisine: 'italian;pizza' })?.category).toBe('pizzerie');
    expect(t({ amenity: 'fast_food', cuisine: 'pizza' })?.category).toBe('pizzerie');
    expect(t({ amenity: 'restaurant' }, 'Pizzeria di Prova')?.category).toBe('pizzerie');
    expect(t({ amenity: 'restaurant', cuisine: 'italian' })?.category).toBe('ristoranti');
    expect(t({ amenity: 'fast_food' })?.category).toBe('ristoranti');
    for (const a of ['cafe', 'bar', 'pub', 'ice_cream', 'biergarten'])
      expect(t({ amenity: a })?.category, a).toBe('bar_caffetterie');
  });

  it('persona e benessere, salute, professionisti, immobiliari, officine, negozi, altro', () => {
    expect(t({ shop: 'hairdresser' })?.category).toBe('parrucchieri_barbieri');
    expect(t({ shop: 'barber' })?.category).toBe('parrucchieri_barbieri');
    expect(t({ shop: 'beauty' })?.category).toBe('centri_estetici');
    expect(t({ leisure: 'spa' })?.category).toBe('centri_estetici');
    expect(t({ leisure: 'fitness_centre' })?.category).toBe('palestre_fitness');
    expect(t({ amenity: 'dentist' })?.category).toBe('studi_medici');
    expect(t({ healthcare: 'physiotherapist' })?.category).toBe('studi_medici');
    expect(t({ amenity: 'veterinary' })?.category).toBe('studi_medici');
    expect(t({ office: 'lawyer' })?.category).toBe('studi_professionali');
    expect(t({ office: 'accountant' })?.category).toBe('studi_professionali');
    expect(t({ office: 'estate_agent' })?.category).toBe('agenzie_immobiliari');
    expect(t({ shop: 'estate_agent' })?.category).toBe('agenzie_immobiliari');
    expect(t({ shop: 'car_repair' })?.category).toBe('officine');
    expect(t({ shop: 'tyres' })?.category).toBe('officine');
    // un concessionario non è un'officina
    expect(t({ shop: 'car' })?.category).toBe('negozi');
    expect(t({ shop: 'supermarket' })?.category).toBe('negozi');
    expect(t({ shop: 'bakery' })?.category).toBe('negozi');
    // agenzia di viaggi, ufficio, artigiano: riconosciuti ma fuori dalle categorie principali
    expect(t({ shop: 'travel_agency' })).toMatchObject({ category: 'altre_attivita', status: 'classificata' });
    expect(t({ office: 'company' })?.category).toBe('altre_attivita');
    expect(t({ craft: 'electrician' })?.category).toBe('altre_attivita');
    expect(t({ amenity: 'driving_school' })?.category).toBe('altre_attivita');
    // solo il nome, nessun tipo di attività: la regola sui tag non decide
    expect(t({ name: 'Attività di Prova' })).toBeNull();
    expect(t({ shop: 'vacant' })).toBeNull();
  });

  it('dati mancanti o ambigui: settore, categoria della scoperta, nome (da verificare), altrimenti «Altre attività»', () => {
    const base = { name: 'Attività di Prova', tags: { name: 'Attività di Prova' }, sector: null, category: null };
    expect(classifyBusiness({ ...base, sector: 'dentisti' })).toMatchObject({
      category: 'studi_medici',
      status: 'classificata',
      evidence: 'Settore della ricerca: Studi dentistici',
    });
    // settore misto (case vacanza comprende ostelli e campeggi): non decide da solo
    expect(classifyBusiness({ ...base, sector: 'case_vacanza' }).status).toBe('da_verificare');
    expect(classifyBusiness({ ...base, category: 'farmacie' })).toMatchObject({
      category: 'farmacie',
      status: 'classificata',
    });
    // categoria della scoperta mista (ristoranti e bar insieme): il nome è solo un indizio
    expect(classifyBusiness({ ...base, name: 'Trattoria di Prova', category: 'ristorazione' })).toMatchObject({
      category: 'ristoranti',
      status: 'da_verificare',
    });
    expect(classifyBusiness({ ...base, category: 'ristorazione' })).toMatchObject({
      category: 'altre_attivita',
      status: 'da_verificare',
    });
    expect(classifyBusiness({ ...base, tags: null })).toMatchObject({
      category: 'altre_attivita',
      status: 'da_verificare',
      evidence: 'Tipo di attività non indicato dalla fonte',
    });
    // i tag prevalgono sul settore e sul nome
    expect(
      classifyBusiness({ ...base, name: 'Pizzeria di Prova', tags: { amenity: 'bar' }, sector: 'ristoranti' }).category,
    ).toBe('bar_caffetterie');
  });
});

let n = 0;
function record(over: Partial<ProviderRecord> = {}): ProviderRecord {
  n++;
  return {
    provider: 'osm',
    ref: `node/${7_000_000_000 + n}`,
    sourceUrl: `https://www.openstreetmap.org/node/${7_000_000_000 + n}`,
    name: `Attività di Prova ${n}`,
    category: 'negozi',
    sector: null,
    contacts: { phone: null, email: null, emailKind: null },
    websiteUrl: null,
    websiteDomain: null,
    websiteShared: false,
    address: { street: null, housenumber: null, postcode: null, city: null },
    municipalityCode: '058091',
    latitude: 41.5 + n * 0.01,
    longitude: 12.1,
    has: { website: false, address: false, phone: false, email: false, openingHours: false },
    sourceTags: { name: `Attività di Prova ${n}` },
    ...over,
  };
}
const ctx = (): SaveContext => ({
  jobId: null,
  fetchedAt: new Date('2026-10-01T10:00:00Z'),
  sourceDataAt: new Date('2026-10-01T09:00:00Z'),
  minCompleteness: 0,
  requireWebsite: false,
  seen: new Set(),
});
const save = (r: ProviderRecord) => db.transaction((tx) => saveRecord(tx, r, ctx()));
const categoryOf = async (id: string) =>
  (
    await db.query<{
      primary_category: string | null;
      category_status: string | null;
      category_source: string | null;
      category_evidence: string | null;
      category_version: number | null;
    }>(
      'SELECT primary_category, category_status, category_source, category_evidence, category_version FROM businesses WHERE id = $1',
      [id],
    )
  ).rows[0]!;

describe('salvataggio, classificazione delle aziende esistenti e scelta manuale', () => {
  it('ogni azienda salvata dalla scoperta riceve la categoria dalle sue prove, persistente', async () => {
    const r = record({
      name: 'Locanda di Prova Centrale',
      category: 'ristorazione',
      sector: 'pizzerie',
      sourceTags: { name: 'Locanda di Prova Centrale', amenity: 'restaurant', cuisine: 'pizza' },
    });
    const { businessId, outcome } = await save(r);
    expect(outcome).toBe('inserted');
    expect(await categoryOf(businessId!)).toEqual({
      primary_category: 'pizzerie',
      category_status: 'classificata',
      category_source: 'automatica',
      category_evidence: 'OpenStreetMap: amenity=restaurant, cuisine=pizza',
      category_version: CLASSIFIER_VERSION,
    });
    // la fonte cambia il tipo di attività: l'azienda resta una sola, la categoria segue la prova
    const again = await save({ ...r, sourceTags: { ...r.sourceTags, cuisine: 'italian' } });
    expect(again).toMatchObject({ outcome: 'unchanged', businessId });
    expect((await categoryOf(businessId!)).primary_category).toBe('ristoranti');
    // sector e category originali restano
    const { rows } = await db.query('SELECT sector, category FROM businesses WHERE id = $1', [businessId]);
    expect(rows[0]).toEqual({ sector: 'pizzerie', category: 'ristorazione' });
  });

  it('aziende esistenti: classificazione a blocchi, riprendibile dopo un’interruzione, senza doppioni', async () => {
    const ids: string[] = [];
    const kinds: Record<string, string>[] = [
      { amenity: 'pharmacy' },
      { tourism: 'guest_house' },
      { shop: 'hairdresser' },
      {},
    ];
    for (const tags of kinds) {
      const { businessId } = await save(record({ sourceTags: { name: 'x', ...tags } }));
      ids.push(businessId!);
    }
    // come prima della migrazione: nessuna categoria
    await db.query(
      `UPDATE businesses SET primary_category = NULL, category_status = NULL, category_source = NULL,
              category_evidence = NULL, category_version = NULL WHERE id = ANY($1)`,
      [ids],
    );
    const before = (await db.query<{ n: number }>('SELECT count(*)::int AS n FROM businesses')).rows[0]!.n;
    expect(await pendingClassification(db)).toBe(4);
    // interruzione dopo il primo blocco: il lavoro fatto resta, il resto riprende
    const first = await classifyPending(db, { batchSize: 1, maxBatches: 1 });
    expect(first).toMatchObject({ processed: 1, remaining: 3 });
    const rest = await classifyPending(db, { batchSize: 2 });
    expect(rest).toMatchObject({ processed: 3, remaining: 0 });
    expect((await Promise.all(ids.map(categoryOf))).map((c) => [c.primary_category, c.category_status])).toEqual([
      ['farmacie', 'classificata'],
      ['bnb_case_vacanza', 'classificata'],
      ['parrucchieri_barbieri', 'classificata'],
      ['negozi', 'classificata'], // nessun tag: decide la categoria della scoperta (negozi)
    ]);
    expect((await db.query<{ n: number }>('SELECT count(*)::int AS n FROM businesses')).rows[0]!.n).toBe(before);
    // nuove regole: si ricalcolano solo le automatiche
    await db.query('UPDATE businesses SET category_version = 0 WHERE id = ANY($1)', [ids]);
    await setManualCategory(db, ids[3]!, 'officine', userId);
    expect(await pendingClassification(db)).toBe(3);
    await classifyPending(db);
    expect((await categoryOf(ids[3]!)).primary_category).toBe('officine');
  });

  it('scelta manuale: prevale sulla classificazione automatica, registrata, reversibile', async () => {
    const { businessId } = await save(record({ sourceTags: { name: 'x', amenity: 'bar' } }));
    await setManualCategory(db, businessId!, 'pizzerie', userId);
    expect(await categoryOf(businessId!)).toMatchObject({
      primary_category: 'pizzerie',
      category_source: 'manuale',
      category_status: 'classificata',
    });
    // un nuovo salvataggio dalla fonte non la cambia
    expect(await db.transaction((tx) => classifyOne(tx, businessId!))).toBe(false);
    const { rows } = await db.query<{ action: string; details: { to: string } }>(
      "SELECT action, details FROM audit_log WHERE entity_id = $1 AND action LIKE 'business.category%'",
      [businessId],
    );
    expect(rows).toEqual([{ action: 'business.category_set', details: expect.objectContaining({ to: 'Pizzerie' }) }]);
    await setManualCategory(db, businessId!, null, userId);
    expect(await categoryOf(businessId!)).toMatchObject({
      primary_category: 'bar_caffetterie',
      category_source: 'automatica',
    });
  });
});

const filters = (over: Partial<BusinessFilters> = {}): BusinessFilters => ({
  sort: 'name',
  dir: 'asc',
  page: 1,
  pageSize: 25,
  ...over,
});

describe('ricerca per categoria con la pipeline reale', () => {
  const drive = async (runId: string) => {
    for (let i = 0; i < 200; i++) {
      await hunter.tick();
      const { rows } = await db.query<{ status: string }>('SELECT status FROM hunt_runs WHERE id = $1', [runId]);
      if (!['pending', 'running'].includes(rows[0]!.status)) return rows[0]!.status;
      while (await discovery.runOnce());
    }
    throw new Error('la ricerca non è terminata');
  };
  const comuni = geo().municipalitiesIn('province', '055').length;
  let farmacieRun = '';

  it('«Farmacie»: avvio dall’API con la sola categoria, settori della categoria, avanzamento reale, risultati salvati', async () => {
    const c = await login();
    const res = await c.request('POST', '/api/hunter/runs', {
      target: 10_000,
      area: TERNI,
      category: 'farmacie',
      options: { audit: false },
    });
    expect(res.status).toBe(201);
    farmacieRun = res.body.run.id;
    expect(res.body.run.category).toEqual({ id: 'farmacie', label: 'Farmacie' });
    expect(res.body.run.sectors.map((s: { id: string }) => s.id)).toEqual(['farmacie']);
    expect(await drive(farmacieRun)).toBe('completed_with_warnings');
    const r = await getHuntRun(db, farmacieRun);
    // il server finto ha una farmacia per comune (più una parafarmacia, che il settore «Farmacie» non prende)
    expect(r.progress.linked).toBe(comuni);
    expect(r.progress.newBusinesses).toBe(comuni);
    expect(r.distribution.categories).toEqual([
      { category: 'farmacie', label: 'Farmacie', count: comuni, new: comuni },
    ]);
    const list = await listBusinesses(db, filters({ businessCategory: 'farmacie', province: '055', pageSize: 10 }));
    expect(list.total).toBe(comuni);
    expect(list.items).toHaveLength(10);
    expect(list.items.every((b) => b.businessCategory?.id === 'farmacie')).toBe(true);
  });

  it('altre categorie nella stessa area: nessun doppione tra categorie e tra ricerche ripetute', async () => {
    const parrucchieri = await createHuntRun(
      db,
      {
        target: 10_000,
        area: TERNI,
        sectors: [],
        category: 'parrucchieri_barbieri',
        options: { minScore: null, websitePreference: 'any', excludeKnown: false, audit: false },
      },
      { userId, providerConfigured: true },
    );
    await drive(parrucchieri);
    const total = (await db.query<{ n: number }>('SELECT count(*)::int AS n FROM businesses')).rows[0]!.n;
    // la stessa categoria cercata di nuovo: tutte già presenti, nessuna azienda nuova
    const again = await createHuntRun(
      db,
      {
        target: 10_000,
        area: TERNI,
        sectors: [],
        category: 'farmacie',
        options: { minScore: null, websitePreference: 'any', excludeKnown: false, audit: false },
      },
      { userId, providerConfigured: true },
    );
    await drive(again);
    expect((await db.query<{ n: number }>('SELECT count(*)::int AS n FROM businesses')).rows[0]!.n).toBe(total);
    const r = await getHuntRun(db, again);
    expect(r.progress.linkedNew).toBe(0);
    expect(r.progress.alreadyKnown).toBe(comuni);
    // ogni elemento della fonte è una sola azienda
    const { rows } = await db.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM (SELECT provider_ref FROM business_sources GROUP BY 1 HAVING count(DISTINCT business_id) > 1) x',
    );
    expect(rows[0]!.n).toBe(0);
    expect((await getHuntRun(db, parrucchieri)).distribution.categories).toEqual([
      { category: 'parrucchieri_barbieri', label: 'Parrucchieri e barbieri', count: comuni, new: comuni },
    ]);
  });

  it('richiesta senza settori né categoria, o con una categoria sconosciuta: rifiutata', async () => {
    const c = await login();
    const none = await c.request('POST', '/api/hunter/runs', { target: 10, area: TERNI, sectors: [] });
    expect(none.status).toBe(400);
    expect(none.body.error.fields.sectors).toBe('Scegli almeno un settore.');
    const bad = await c.request('POST', '/api/hunter/runs', { target: 10, area: TERNI, category: 'astronavi' });
    expect(bad.status).toBe(400);
  });
});

describe('filtri, ordinamento, paginazione e conteggi', () => {
  it('conteggi per categoria con gli stessi filtri dell’elenco; «Tutte» senza doppioni', async () => {
    const all = await categoryCounts(db, filters());
    const sum = all.categories.reduce((s, c) => s + c.counts.total, 0);
    expect(all.all.total).toBe(sum + all.pending);
    expect(all.all.total).toBe((await listBusinesses(db, filters({ pageSize: 1 }))).total);
    for (const c of all.categories)
      expect((await listBusinesses(db, filters({ businessCategory: c.id, pageSize: 1 }))).total, c.id).toBe(
        c.counts.total,
      );
    // combinazione con i filtri: provincia, sito, email, stato del contatto
    const f = filters({ province: '055', website: 'own' });
    const withFilters = await categoryCounts(db, f);
    const farmacie = withFilters.categories.find((c) => c.id === 'farmacie')!.counts;
    expect(farmacie.total).toBe((await listBusinesses(db, { ...f, businessCategory: 'farmacie', pageSize: 1 })).total);
    // le farmacie di prova hanno tutte un sito proprio; i parrucchieri nessuno
    expect(farmacie.total).toBe(geo().municipalitiesIn('province', '055').length);
    expect(farmacie.website).toBe(farmacie.total);
    expect(withFilters.categories.find((c) => c.id === 'parrucchieri_barbieri')!.counts.total).toBe(0);
    const email = await categoryCounts(db, filters({ province: '055', email: 'yes' }));
    expect(email.all.total).toBe(email.all.email);
    const ready = await categoryCounts(db, filters({ province: '055', contactStatus: ['da_contattare'] }));
    expect(ready.all.contacted).toBe(0);
  });

  it('ordinamenti per punteggio, nome, città e stato della valutazione; pagine senza sovrapposizioni', async () => {
    for (const sort of ['commercial', 'name', 'city', 'assessment'] as const) {
      const p1 = await listBusinesses(db, filters({ businessCategory: 'farmacie', sort, pageSize: 10 }));
      const p2 = await listBusinesses(db, filters({ businessCategory: 'farmacie', sort, pageSize: 10, page: 2 }));
      expect(p1.items).toHaveLength(10);
      expect(
        p2.items.some((b) => p1.items.some((x) => x.id === b.id)),
        sort,
      ).toBe(false);
    }
    const byCity = await listBusinesses(db, filters({ businessCategory: 'farmacie', sort: 'city', pageSize: 50 }));
    const cities = byCity.items.map((b) => b.place.municipality ?? '');
    expect(cities).toEqual([...cities].sort((a, b) => a.localeCompare(b, 'en', { sensitivity: 'base' })));
  });

  it('API: elenco per categoria, categorie con conteggi ed etichette, scelta manuale; validazione', async () => {
    const c = await login();
    const cats = await c.request('GET', '/api/businesses/categories?province=055');
    expect(cats.status).toBe(200);
    const farmacie = cats.body.categories.find((x: { id: string }) => x.id === 'farmacie');
    expect(farmacie).toMatchObject({
      label: 'Farmacie',
      empty: 'Nessuna farmacia trovata con questi filtri',
      discover: 'Cerca nuove farmacie',
      sectors: ['farmacie'],
    });
    const list = await c.request('GET', '/api/businesses?businessCategory=farmacie&province=055&pageSize=5');
    expect(list.body.total).toBe(farmacie.counts.total);
    expect(list.body.items[0].businessCategory).toMatchObject({ id: 'farmacie', label: 'Farmacie' });
    expect((await c.request('GET', '/api/businesses?businessCategory=astronavi')).status).toBe(400);
    const id = list.body.items[0].id;
    const set = await c.request('PUT', `/api/businesses/${id}/category`, { category: 'negozi' });
    expect(set.status).toBe(200);
    expect(set.body.business.businessCategory).toMatchObject({ id: 'negozi', source: 'manuale' });
    const back = await c.request('PUT', `/api/businesses/${id}/category`, { category: null });
    expect(back.body.business.businessCategory).toMatchObject({ id: 'farmacie', source: 'automatica' });
    expect((await c.request('PUT', `/api/businesses/${id}/category`, { category: 'astronavi' })).status).toBe(400);
  });
});
