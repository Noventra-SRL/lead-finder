import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { policyFor } from '../audit/jobs.ts';
import { defaultAudit, defaultDiscovery } from '../config.ts';
import type { Db } from '../db/client.ts';
import { classifyEmail, contactsFromTags, normalizePhone } from '../discovery/contacts.ts';
import { planUnits } from '../discovery/jobs.ts';
import { startFakeOverpass } from '../discovery/osm/fakeOverpass.ts';
import { OverpassProvider } from '../discovery/osm/overpass.ts';
import { buildUnitQuery } from '../discovery/osm/query.ts';
import { SECTORS, sectorsInOrder, validateSectors } from '../discovery/sectors.ts';
import { DiscoveryWorker } from '../discovery/worker.ts';
import { geo } from '../geo/geo.ts';
import { silentLogger } from '../logger.ts';
import { client, createTestUser, startTestServer, testDatabase, type TestServer } from '../testing.ts';
import { csvCell } from '../exports/format.ts';
import { controlHuntRun, createHuntRun, getHuntRun, planAreas, type HuntOptions } from './runs.ts';
import { HuntWorker } from './worker.ts';

/*
 * Lead Hunter dall'inizio alla fine: worker di scoperta e coordinatore reali, database reale, server Overpass FINTO
 * (attività inventate "di Prova"). Nessuna richiesta verso Internet; gli audit sono messi in coda ma non eseguiti.
 */

const PASSWORD = 'password-di-prova-lunga';
// Umbria: 2 province (Perugia 59 comuni, Terni 33): dati di prova contenuti, per non rallentare gli altri test
const UMBRIA = { type: 'region' as const, code: '10' };
const SECTORS3 = ['dentisti', 'commercialisti', 'panifici_pasticcerie'];
const NO_AUDIT: HuntOptions = { minScore: null, websitePreference: 'any', excludeKnown: false, audit: false };

let db: Db;
let fake: Awaited<ReturnType<typeof startFakeOverpass>>;
let provider: OverpassProvider;
let discovery: DiscoveryWorker;
let hunter: HuntWorker;
let server: TestServer;
let userId: string;

beforeAll(async () => {
  db = await testDatabase();
  fake = await startFakeOverpass();
  provider = new OverpassProvider({
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
  userId = (await createTestUser(db, { email: 'hunter@noventra.test', role: 'admin', password: PASSWORD })).id;
});
afterAll(async () => {
  await server.close();
  await fake.close();
  await db.close();
});

/** Fa avanzare coordinatore e scoperta finché la ricerca non termina (o si ferma in uno stato atteso). */
async function drive(
  runId: string,
  until: (status: string) => boolean = (s) => !['pending', 'running'].includes(s),
  max = 200,
) {
  for (let i = 0; i < max; i++) {
    await hunter.tick();
    const { rows } = await db.query<{ status: string }>('SELECT status FROM hunt_runs WHERE id = $1', [runId]);
    if (until(rows[0]!.status)) return rows[0]!.status;
    while (await discovery.runOnce());
  }
  throw new Error('la ricerca non è terminata');
}

const run = (target: number, options: Partial<HuntOptions> = {}, sectors = SECTORS3, area = UMBRIA) =>
  createHuntRun(
    db,
    { target, area, sectors, options: { ...NO_AUDIT, ...options } },
    { userId, providerConfigured: true },
  );

describe('catalogo dei settori e normalizzazione', () => {
  it('almeno 40 settori in 7 gruppi, validati; un catalogo errato è rifiutato', () => {
    expect(SECTORS.length).toBeGreaterThanOrEqual(40);
    expect(new Set(SECTORS.map((s) => s.group)).size).toBe(7);
    expect(() => validateSectors([...SECTORS, SECTORS[0]])).toThrow(/ripetuto/);
    expect(() => validateSectors([{ ...SECTORS[0], category: 'inventata' }])).toThrow();
  });

  it('una query per settori ha un blocco per settore con il proprio limite per comune', () => {
    const m = geo().municipality('070006')!;
    const q = buildUnitQuery(
      { municipalities: [m] },
      [],
      2,
      { timeoutSeconds: 60, maxsizeBytes: 1 << 28 },
      sectorsInOrder(['pizzerie', 'dentisti']),
    );
    expect(q.match(/out center tags qt 2;/g)).toHaveLength(2);
    expect(q).toContain('["cuisine"~"pizza",i]');
  });

  it('con tutti i settori l’area di un comune si legge una volta per chiave OSM, non per selettore', () => {
    const m = geo().municipality('070006')!;
    const q = buildUnitQuery({ municipalities: [m] }, [], 1, { timeoutSeconds: 60, maxsizeBytes: 1 << 28 }, SECTORS);
    // le letture dell'area sono poche (una per chiave); i settori filtrano l'insieme dei candidati
    expect(q.match(/\(area\.c\);/g)!.length).toBeLessThanOrEqual(10);
    expect(q.match(/out center tags qt 1;/g)).toHaveLength(SECTORS.length);
    expect(q.match(/nwr\.candidati\[/g)!.length).toBe(SECTORS.flatMap((s) => s.selectors).length);
    // ogni selettore è coperto da un filtro largo della sua chiave principale
    for (const sel of SECTORS.flatMap((s) => s.selectors)) {
      const key = Object.keys(sel.tags)[0]!;
      expect(q).toMatch(new RegExp(`nwr\\["${key}"[\\]~]`));
    }
  });

  it('nelle ricerche per settori il capoluogo apre ogni provincia, con richieste più piccole', () => {
    for (const [province, capital] of [
      ['201', 'Torino'],
      ['041', 'Pesaro'],
      ['280', 'Reggio di Calabria'],
      ['111', 'Carbonia'],
    ] as const) {
      const first = planUnits('province', province, 5, true)[0]!;
      expect(first.length).toBeLessThanOrEqual(5);
      expect(geo().municipality(first[0]!)!.name).toBe(capital);
    }
    // senza l'opzione l'ordine resta quello dei codici ISTAT
    expect(planUnits('province', '041', 25)[0]![0]).toBe(geo().municipalitiesIn('province', '041')[0]!.code);
  });

  it('recapiti: telefono pubblico normalizzato, email solo se generica', () => {
    expect(contactsFromTags({ phone: '+39 06 1234567;+39 333 1234567' }).phone).toBe('+39 06 1234567');
    expect(normalizePhone('12')).toBeNull();
    expect(classifyEmail('Info@Hotel-Prova.example.it')).toEqual({
      email: 'info@hotel-prova.example.it',
      kind: 'generic',
    });
    expect(classifyEmail('prenotazioni@prova.example.it').kind).toBe('generic');
    expect(classifyEmail('mario.rossi@prova.example.it')).toEqual({ email: null, kind: 'personal' });
    expect(classifyEmail('non-una-email')).toEqual({ email: null, kind: null });
  });

  it('piano: province alternate tra le regioni (varietà geografica anche fermandosi presto)', () => {
    const italy = planAreas('italy', 'IT');
    expect(italy.length).toBe(geo().provinces.length);
    const firstRegions = italy.slice(0, geo().regions.length).map((a) => geo().province(a.code)!.regionCode);
    expect(new Set(firstRegions).size).toBe(geo().regions.length);
    expect(
      planAreas('region', '10')
        .map((a) => a.code)
        .sort(),
    ).toEqual(['054', '055']);
    expect(planAreas('municipality', '070006')).toHaveLength(1);
  });
});

describe('ricerca di lead', () => {
  let first: string;

  it('aree esaurite prima dell’obiettivo: tutti i risultati salvati, conteggio reale, obiettivo dichiarato non raggiunto', async () => {
    first = await run(10_000);
    expect(await drive(first)).toBe('completed_with_warnings');
    const r = await getHuntRun(db, first);
    const comuni = geo().municipalitiesIn('region', '10').length;
    // il server finto restituisce un'attività per settore e per comune
    expect(r.progress.linked, JSON.stringify(r.run.messages)).toBe(comuni * SECTORS3.length);
    expect(r.progress.newBusinesses).toBe(comuni * SECTORS3.length);
    expect(r.progress.targetReached).toBe(false);
    expect(r.progress.remaining).toBe(10_000 - r.progress.qualified);
    expect(r.run.plan).toMatchObject({ total: 2, done: 2 });
    expect(r.run.messages.at(-1)!.message).toMatch(/Obiettivo non raggiunto: \d+ aziende su 10000/);
    // nessun settore prevale: stessa quantità per ognuno
    expect(r.distribution.sectors.map((s) => s.count)).toEqual(SECTORS3.map(() => comuni));
    expect(r.distribution.regions).toEqual([{ regionCode: '10', region: 'Umbria', count: comuni * SECTORS3.length }]);
    // siti: trovati (farmacia, hotel) e non indicati; nessuno verificato senza audit
    expect(r.progress.websites.found + r.progress.websites.missing).toBe(r.progress.linked);
    expect(r.progress.websites.unverified).toBe(r.progress.websites.found);
    expect(r.progress.websites.verified).toBe(0);
    // recapiti
    const { rows } = await db.query<{
      sector: string;
      email: string | null;
      email_kind: string | null;
      phone: string | null;
    }>(
      "SELECT sector, email, email_kind, phone FROM businesses WHERE sector IN ('dentisti', 'commercialisti') AND municipality_code = '054039'",
    );
    expect(rows.find((x) => x.sector === 'dentisti')).toMatchObject({
      email: 'info@dentista-prova.example.it',
      email_kind: 'generic',
      phone: '+39 000 1111111',
    });
    expect(rows.find((x) => x.sector === 'commercialisti')).toMatchObject({ email: null, email_kind: 'personal' });
  });

  it('ripetere la stessa ricerca: nessun doppione; "solo nuove" esclude quelle già note', async () => {
    const before = (await db.query<{ n: number }>('SELECT count(*)::int AS n FROM businesses')).rows[0]!.n;
    const again = await run(10_000);
    await drive(again);
    expect((await db.query<{ n: number }>('SELECT count(*)::int AS n FROM businesses')).rows[0]!.n).toBe(before);
    const r = await getHuntRun(db, again);
    expect(r.progress.linked).toBe(before);
    expect(r.progress.linkedNew).toBe(0);
    expect(r.progress.alreadyKnown).toBe(before);
    const onlyNew = await run(10_000, { excludeKnown: true });
    await drive(onlyNew);
    expect((await getHuntRun(db, onlyNew)).progress.linked).toBe(0);
  });

  it('obiettivo raggiunto: la scoperta si ferma e il risultato è "completata"', async () => {
    // quota della prima area: max(20, 20 × 1,5 / 2 aree) = 20, già sufficiente
    const id = await run(20);
    expect(await drive(id)).toBe('completed');
    const r = await getHuntRun(db, id);
    expect(r.progress.qualified).toBeGreaterThanOrEqual(20);
    expect(r.progress.targetReached).toBe(true);
    // la prima provincia basta: la seconda non viene cercata
    expect(r.run.plan.done).toBe(1);
  });

  it('settori: solo quelli richiesti; aziende escluse dal contatto mai ricollegate', async () => {
    const { rows: one } = await db.query<{ id: string }>("SELECT id FROM businesses WHERE sector = 'dentisti' LIMIT 1");
    await db.query(
      "UPDATE businesses SET excluded_at = now(), excluded_reason = 'Richiesta dell’azienda (prova)' WHERE id = $1",
      [one[0]!.id],
    );
    const id = await run(10_000, {}, ['dentisti']);
    await drive(id);
    const { rows } = await db.query<{ sector: string; excluded: boolean }>(
      'SELECT b.sector, b.excluded_at IS NOT NULL AS excluded FROM hunt_run_businesses hb JOIN businesses b ON b.id = hb.business_id WHERE hb.run_id = $1',
      [id],
    );
    expect(rows.every((x) => x.sector === 'dentisti' && !x.excluded)).toBe(true);
    expect(rows.length).toBe(geo().municipalitiesIn('region', '10').length - 1);
    await db.query('UPDATE businesses SET excluded_at = NULL, excluded_reason = NULL WHERE id = $1', [one[0]!.id]);
  });

  it('pausa, ripresa, annullamento; una sola ricerca attiva', async () => {
    const id = await run(10_000);
    await hunter.tick();
    await expect(run(10)).rejects.toMatchObject({ code: 'HUNT_ACTIVE' });
    await controlHuntRun(db, id, 'pause', userId);
    await hunter.tick();
    const paused = await getHuntRun(db, id);
    expect(paused.run.status).toBe('paused');
    expect(
      (await db.query<{ status: string }>('SELECT status FROM discovery_jobs WHERE id = $1', [paused.run.currentJobId]))
        .rows[0]!.status,
    ).toBe('paused');
    await controlHuntRun(db, id, 'resume', userId);
    await hunter.tick();
    expect(
      (await db.query<{ status: string }>('SELECT status FROM discovery_jobs WHERE id = $1', [paused.run.currentJobId]))
        .rows[0]!.status,
    ).toBe('pending');
    await controlHuntRun(db, id, 'cancel', userId);
    await hunter.tick();
    expect((await getHuntRun(db, id)).run.status).toBe('cancelled');
    await expect(controlHuntRun(db, id, 'cancel', userId)).rejects.toMatchObject({ status: 409 });
  });

  it('dopo un riavvio: il job dell’area interrotto riparte e la ricerca prosegue dal cursore', async () => {
    const id = await run(10_000, {}, ['farmacie']);
    await hunter.tick();
    const jobId = (await getHuntRun(db, id)).run.currentJobId!;
    // come recoverInterrupted all'avvio: job in pausa per interruzione, coordinatore "morto"
    await db.query("UPDATE discovery_jobs SET status = 'paused', pause_reason = 'interrupted' WHERE id = $1", [jobId]);
    await db.query(
      "UPDATE hunt_runs SET worker_id = 'processo-morto', heartbeat_at = now() - interval '10 minutes' WHERE id = $1",
      [id],
    );
    const restarted = new HuntWorker(db, {
      log: silentLogger,
      discovery: {
        config: { ...defaultDiscovery, municipalitiesPerRequest: 50 },
        providerId: 'osm',
        configured: () => true,
        wake: () => undefined,
      },
      audit: { config: defaultAudit, policy: policyFor(defaultAudit, 'test'), wake: () => undefined },
    });
    await restarted.tick();
    expect(
      (await db.query<{ status: string }>('SELECT status FROM discovery_jobs WHERE id = $1', [jobId])).rows[0]!.status,
    ).toBe('pending');
    hunter = restarted;
    expect(await drive(id)).toBe('completed_with_warnings');
  });

  it('fornitore non disponibile: l’area fallisce, la ricerca prosegue con le altre e lo dichiara', async () => {
    fake.control.failures = [503];
    const id = await run(10_000, {}, ['hotel']);
    await drive(id);
    const r = await getHuntRun(db, id);
    expect(r.progress.failedRequests).toBeGreaterThanOrEqual(1);
    expect(r.run.messages.map((m) => m.message).join(' ')).toMatch(/richieste non riuscite/);
    expect(r.run.plan.done).toBe(2);
    expect(r.progress.linked).toBeGreaterThan(0);
  });

  it('verifica dei siti: in coda solo i siti propri ancora da verificare, una verifica alla volta', async () => {
    const id = await run(10_000, { audit: true }, ['farmacie', 'hotel', 'ristoranti']);
    await drive(id, (s) => s !== 'running' && s !== 'pending', 60).catch(() => 'running');
    const { rows: jobs } = await db.query<{ id: string; status: string }>(
      'SELECT id, status FROM audit_jobs WHERE hunt_run_id = $1',
      [id],
    );
    expect(jobs).toHaveLength(1);
    const { rows: items } = await db.query<{ website_url: string | null; website_shared: boolean }>(
      'SELECT b.website_url, b.website_shared FROM audit_job_items i JOIN businesses b ON b.id = i.business_id WHERE i.job_id = $1',
      [jobs[0]!.id],
    );
    // la trattoria ha solo una pagina Facebook: mai in verifica
    expect(items.every((x) => x.website_url && !x.website_shared)).toBe(true);
    const r = await getHuntRun(db, id);
    expect(r.progress.audits.pending).toBe(items.length);
    expect(r.run.status).toBe('running');
    // la verifica (non eseguita nel test) termina: la ricerca accoda le successive e alla fine si chiude
    for (let i = 0; i < 20 && (await getHuntRun(db, id)).run.status === 'running'; i++) {
      await db.query(
        "UPDATE audit_job_items SET status = 'done' WHERE job_id IN (SELECT id FROM audit_jobs WHERE hunt_run_id = $1)",
        [id],
      );
      await db.query("UPDATE audit_jobs SET status = 'completed' WHERE hunt_run_id = $1", [id]);
      await hunter.tick();
    }
    expect((await getHuntRun(db, id)).run.status).toBe('completed_with_warnings');
  });

  it('punteggio minimo: senza punteggi calcolati l’obiettivo non è dichiarato raggiunto', async () => {
    const id = await run(5, { minScore: 60 }, ['farmacie']);
    expect(await drive(id)).toBe('completed_with_warnings');
    expect((await getHuntRun(db, id)).progress.qualified).toBe(0);
  });
});

describe('API, elenco ed esportazione', () => {
  async function login() {
    const c = client(server.url);
    expect(
      (await c.request('POST', '/api/auth/login', { email: 'hunter@noventra.test', password: PASSWORD })).status,
    ).toBe(200);
    return c;
  }

  it('accesso richiesto; validazione dell’obiettivo, dei settori e dell’area', async () => {
    const anon = client(server.url);
    expect((await anon.request('GET', '/api/hunter/meta')).status).toBe(401);
    expect((await anon.request('POST', '/api/hunter/runs', {})).status).toBe(401);
    expect((await anon.request('GET', '/api/businesses/export')).status).toBe(401);
    const c = await login();
    const meta = (await c.request('GET', '/api/hunter/meta')).body;
    expect(meta).toMatchObject({ defaults: { target: 1000 }, provider: { configured: true } });
    expect(meta.sectors.length).toBeGreaterThanOrEqual(40);
    const base = { target: 100, area: UMBRIA, sectors: ['farmacie'] };
    expect((await c.request('POST', '/api/hunter/runs', { ...base, target: 0 })).status).toBe(400);
    expect((await c.request('POST', '/api/hunter/runs', { ...base, target: 20_000 })).status).toBe(400);
    expect((await c.request('POST', '/api/hunter/runs', { ...base, sectors: ['inventato'] })).status).toBe(400);
    expect((await c.request('POST', '/api/hunter/runs', { ...base, sectors: [] })).status).toBe(400);
    expect(
      (await c.request('POST', '/api/hunter/runs', { ...base, area: { type: 'region', code: '99' } })).body.error.code,
    ).toBe('UNKNOWN_AREA');
  });

  it('elenco per ricerca e settore, varietà per settore, esclusione', async () => {
    const c = await login();
    const all = (
      await c.request(
        'GET',
        `/api/businesses?hunt=${(await getHuntRun(db, (await db.query<{ id: string }>('SELECT id FROM hunt_runs ORDER BY created_at LIMIT 1')).rows[0]!.id)).run.id}&pageSize=100`,
      )
    ).body;
    expect(all.total).toBeGreaterThan(100);
    expect(all.items[0]).toHaveProperty('sector.label');
    expect(all.items[0]).toHaveProperty('contacts');
    const dentists = (await c.request('GET', '/api/businesses?sector=dentisti&pageSize=100')).body;
    expect(dentists.items.every((b: { sector: { id: string } }) => b.sector.id === 'dentisti')).toBe(true);
    const varied = (await c.request('GET', '/api/businesses?maxPerSector=2&pageSize=100&sort=name&dir=asc')).body
      .items as { sector: { id: string } | null; category: string }[];
    const per = new Map<string, number>();
    for (const b of varied) per.set(b.sector?.id ?? b.category, (per.get(b.sector?.id ?? b.category) ?? 0) + 1);
    expect(Math.max(...per.values())).toBeLessThanOrEqual(2);
    // esclusione e reinclusione
    const id = dentists.items[0].id;
    expect(
      (
        await c.request('POST', `/api/businesses/${id}/exclusion`, {
          excluded: true,
          reason: 'Non vuole essere contattata (prova)',
        })
      ).body.business.excluded,
    ).toMatchObject({ reason: 'Non vuole essere contattata (prova)' });
    expect(
      (await c.request('GET', '/api/businesses?sector=dentisti&pageSize=100')).body.items.map(
        (b: { id: string }) => b.id,
      ),
    ).not.toContain(id);
    expect(
      (await c.request('GET', '/api/businesses?sector=dentisti&excluded=only')).body.items.map(
        (b: { id: string }) => b.id,
      ),
    ).toEqual([id]);
    await c.request('POST', `/api/businesses/${id}/exclusion`, { excluded: false });
    expect((await c.request('GET', '/api/businesses?sector=dentisti&excluded=only')).body.total).toBe(0);
  });

  it('esportazione CSV: UTF-8 con BOM, separatore ";", formule neutralizzate, email personali assenti, selezione', async () => {
    expect(csvCell('=HYPERLINK("x")')).toBe(`"'=HYPERLINK(""x"")"`);
    expect(csvCell('+39 06 123')).toBe("'+39 06 123");
    expect(csvCell('@SUM(1)')).toBe("'@SUM(1)");
    expect(csvCell('-2')).toBe("'-2");
    expect(csvCell('Bar; Caffè')).toBe('"Bar; Caffè"');
    expect(csvCell(null)).toBe('');
    // un'azienda con un nome che sembra una formula (dato di prova inserito a mano)
    await db.query(
      "UPDATE businesses SET name = '=1+1 Bar di Prova' WHERE id = (SELECT id FROM businesses WHERE sector = 'panifici_pasticcerie' LIMIT 1)",
    );
    const c = await login();
    const res = await fetch(`${server.url}/api/businesses/export?sector=panifici_pasticcerie,commercialisti,dentisti`, {
      headers: { Cookie: c.cookie },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/csv; charset=utf-8');
    expect(res.headers.get('content-disposition')).toMatch(
      /^attachment; filename="aziende_noventra_\d{4}-\d{2}-\d{2}\.csv"$/,
    );
    const bytes = new Uint8Array(await res.arrayBuffer());
    expect([...bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    const text = new TextDecoder().decode(bytes);
    // TextDecoder toglie il BOM (verificato sopra sui byte)
    const lines = text.trimEnd().split('\r\n');
    expect(lines[0]).toMatch(/^Azienda;Settore;Categoria;/);
    expect(text).toContain("'=1+1 Bar di Prova");
    expect(text).toContain('info@dentista-prova.example.it');
    expect(text).not.toContain('mario.rossi');
    expect(lines.length - 1).toBe(geo().municipalitiesIn('region', '10').length * 3);
    // righe e troncamento negli header, letti dall'interfaccia per il messaggio dopo il download
    expect(res.headers.get('x-export-rows')).toBe(String(lines.length - 1));
    expect(res.headers.get('x-export-truncated')).toBe('false');
    // selezione
    const ids = (await c.request('GET', '/api/businesses?sector=dentisti&pageSize=2')).body.items.map(
      (b: { id: string }) => b.id,
    );
    const sel = await fetch(`${server.url}/api/businesses/export`, {
      method: 'POST',
      headers: { Cookie: c.cookie, Origin: server.url, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids }),
    });
    expect((await sel.text()).trimEnd().split('\r\n')).toHaveLength(3);
    expect((await c.request('POST', '/api/businesses/export', { ids: [] })).status).toBe(400);
    const { rows } = await db.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM audit_log WHERE action = 'leads.exported'",
    );
    expect(rows[0]!.n).toBe(2);
  });
});
