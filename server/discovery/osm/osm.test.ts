import { createServer, type IncomingMessage, type Server } from 'node:http';
import { listenOnFetchablePort } from '../../testing.ts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { geo } from '../../geo/geo.ts';
import { CATEGORY_IDS, inPriorityOrder } from '../categories.ts';
import { ProviderError } from '../types.ts';
import { normalizeWebsite } from '../website.ts';
import { romaFixture } from './fixtures.ts';
import { parseOverpassResponse } from './normalize.ts';
import { OverpassProvider, type Clock, type OverpassConfig } from './overpass.ts';
import { buildUnitQuery } from './query.ts';
import { classify, OSM_CATEGORIES, overpassFilter } from './tags.ts';

const g = geo();
const roma = g.municipality('058091')!;
const albano = g.municipality('058003')!;

describe('corrispondenza categorie ↔ tag OSM', () => {
  it('ogni categoria ha almeno un selettore e una copertura dichiarata', () => {
    for (const id of CATEGORY_IDS) {
      expect(OSM_CATEGORIES[id].selectors.length, id).toBeGreaterThan(0);
      expect(['buona', 'parziale', 'limitata']).toContain(OSM_CATEGORIES[id].coverage);
      if (OSM_CATEGORIES[id].coverage !== 'buona') expect(OSM_CATEGORIES[id].note, id).toBeTruthy();
    }
  });

  it('filtri Overpass espliciti, con nome obbligatorio', () => {
    expect(overpassFilter(OSM_CATEGORIES.farmacie.selectors[0]!)).toBe(
      '["amenity"="pharmacy"]["dispensing"!="no"]["name"]',
    );
    expect(overpassFilter(OSM_CATEGORIES.hotel.selectors[0]!)).toBe('["tourism"~"^(hotel|motel|hostel)$"]["name"]');
    expect(overpassFilter(OSM_CATEGORIES.parafarmacie.selectors[1]!)).toBe('["shop"="chemist"]["name"~"parafarm",i]');
    expect(overpassFilter(OSM_CATEGORIES.negozi.selectors[0]!)).toBe('["shop"]["shop"!="vacant"]["name"]');
  });

  it('classificazione coerente con i filtri e con la priorità delle categorie', () => {
    const all = inPriorityOrder([...CATEGORY_IDS]);
    expect(classify({ amenity: 'pharmacy', name: 'A' }, all)).toBe('farmacie');
    expect(classify({ amenity: 'pharmacy', dispensing: 'no', name: 'A' }, all)).toBe('parafarmacie');
    expect(classify({ shop: 'chemist', name: 'Parafarmacia Rossi' }, all)).toBe('parafarmacie');
    // senza "parafarmacie" tra le richieste, una drogheria resta un negozio
    expect(classify({ shop: 'chemist', name: 'Parafarmacia Rossi' }, ['negozi'])).toBe('negozi');
    expect(classify({ tourism: 'guest_house', name: 'B' }, all)).toBe('extralberghiero');
    expect(classify({ shop: 'vacant', name: 'C' }, all)).toBeNull();
    expect(classify({ amenity: 'pharmacy' }, all)).toBeNull();
    expect(classify({ amenity: 'restaurant', name: 'D' }, ['farmacie'])).toBeNull();
    expect(inPriorityOrder(['negozi', 'farmacie'])).toEqual(['farmacie', 'negozi']);
  });
});

describe('query Overpass', () => {
  const opts = { timeoutSeconds: 120, maxsizeBytes: 268435456 };

  it('individua i comuni per codice ISTAT e attribuisce i risultati al comune', () => {
    const q = buildUnitQuery({ municipalities: [roma, albano] }, ['farmacie'], 200, opts);
    expect(q).toContain('[out:json][timeout:120][maxsize:268435456];');
    expect(q).toContain('rel["ref:ISTAT"~"^(058091|058003)$"]["boundary"="administrative"]["admin_level"="8"];');
    expect(q).toContain('foreach.comuni->.c(');
    expect(q).toContain('.c out tags;');
    expect(q).toContain('nwr["amenity"="pharmacy"]["dispensing"!="no"]["name"](area.c);');
    expect(q).toContain('out center tags qt 200;');
  });

  it('con un raggio considera i comuni vicini solo entro la distanza', () => {
    const q = buildUnitQuery({ municipalities: [roma], radiusKm: 5 }, ['hotel'], 50, opts);
    expect(q).toContain('rel(around.base:5000)');
    expect(q).toContain('nwr.trovati(around.base:5000);');
    expect(() => buildUnitQuery({ municipalities: [roma, albano], radiusKm: 5 }, ['hotel'], 50, opts)).toThrow();
  });

  it('rifiuta codici non validi (nessun testo esterno nella query)', () => {
    expect(() =>
      buildUnitQuery({ municipalities: [{ ...roma, code: '058091"];out;' }] }, ['farmacie'], 10, opts),
    ).toThrow(/ISTAT/);
  });
});

describe('normalizzazione della risposta', () => {
  it('produce record tracciabili, senza recapiti personali, attribuiti al comune', () => {
    const { records, foundMunicipalities } = parseOverpassResponse(romaFixture(), [
      'farmacie',
      'parafarmacie',
      'ristorazione',
    ]);
    expect(foundMunicipalities).toEqual(['058091', '058003']);
    expect(records.map((r) => r.name)).toEqual([
      'Farmacia di Prova Centrale',
      'Parafarmacia di Prova',
      'Trattoria di Prova',
      'Farmacia di Prova dei Castelli',
    ]);
    const [farmacia, parafarmacia, trattoria, castelli] = records;
    expect(farmacia).toMatchObject({
      provider: 'osm',
      ref: 'node/9000000001',
      sourceUrl: 'https://www.openstreetmap.org/node/9000000001',
      category: 'farmacie',
      websiteUrl: 'http://www.farmaciadiprova.example.it/',
      websiteDomain: 'farmaciadiprova.example.it',
      websiteShared: false,
      municipalityCode: '058091',
      address: { street: 'Via di Prova', housenumber: '1', postcode: '00100', city: 'Roma' },
      has: { website: true, address: true, phone: true, email: false, openingHours: true },
    });
    // Fase 6: il telefono pubblico dell'attività è conservato nei recapiti, mai tra i tag di provenienza
    expect(farmacia!.contacts).toEqual({ phone: '+39 06 5551234', email: null, emailKind: null });
    expect(JSON.stringify(farmacia!.sourceTags)).not.toContain('5551234');
    expect(farmacia!.sector).toBe('farmacie');
    // un'email che sembra personale non viene conservata: si registra solo che esiste
    expect(JSON.stringify(parafarmacia)).not.toContain('privato@example.it');
    expect(parafarmacia).toMatchObject({
      category: 'parafarmacie',
      websiteUrl: null,
      contacts: { email: null, emailKind: 'personal' },
      has: { email: true, website: false },
    });
    expect(trattoria).toMatchObject({ ref: 'way/9000000003', latitude: 41.905, websiteShared: true });
    expect(castelli?.municipalityCode).toBe('058003');
  });

  it('una risposta vuota è un successo con zero risultati', () => {
    expect(parseOverpassResponse({ elements: [] }, ['farmacie'])).toEqual({
      records: [],
      foundMunicipalities: [],
      sourceTimestamp: null,
    });
  });

  it('registra la data dei dati dichiarata dal server (osm3s.timestamp_osm_base)', () => {
    const body = { elements: [], osm3s: { timestamp_osm_base: '2026-07-24T11:04:51Z', copyright: 'ODbL' } };
    expect(parseOverpassResponse(body, ['farmacie']).sourceTimestamp).toBe('2026-07-24T11:04:51.000Z');
    const invalid = { elements: [], osm3s: { timestamp_osm_base: 'non una data' } };
    expect(parseOverpassResponse(invalid, ['farmacie']).sourceTimestamp).toBeNull();
  });

  it('forma inattesa o esecuzione interrotta: errore, mai un risultato vuoto', () => {
    expect(() => parseOverpassResponse({ foo: 1 }, ['farmacie'])).toThrow(ProviderError);
    expect(() => parseOverpassResponse({ elements: [{ type: 'node', id: 'x' }] }, ['farmacie'])).toThrow(ProviderError);
    try {
      parseOverpassResponse({ elements: [], remark: 'runtime error: Query timed out in "query" at line 4' }, [
        'farmacie',
      ]);
      expect.unreachable();
    } catch (e) {
      expect((e as ProviderError).kind).toBe('timeout');
    }
  });
});

describe('siti web', () => {
  it('normalizza il formato senza inventare nulla', () => {
    expect(normalizeWebsite('www.Esempio.it')).toEqual({
      url: 'http://www.esempio.it/',
      domain: 'esempio.it',
      shared: false,
    });
    expect(normalizeWebsite('https://shop.esempio.it/negozio#x')?.url).toBe('https://shop.esempio.it/negozio');
    expect(normalizeWebsite('https://a.it; https://b.it')?.domain).toBe('a.it');
    expect(normalizeWebsite('https://m.facebook.com/pagina')?.shared).toBe(true);
    expect(normalizeWebsite('https://negozio.wixsite.com/x')?.shared).toBe(true);
    for (const bad of [
      undefined,
      '',
      'nessuno',
      'ftp://esempio.it',
      'http://127.0.0.1',
      'http://u:p@esempio.it',
      'javascript:alert(1)',
    ])
      expect(normalizeWebsite(bad), String(bad)).toBeNull();
  });
});

describe('client Overpass', () => {
  type Reply = { status: number; body?: string; headers?: Record<string, string> };
  let replies: Reply[] = [];
  const received: { ua: string; body: string }[] = [];
  let server: Server;
  let endpoint = '';

  beforeAll(async () => {
    server = createServer(async (req: IncomingMessage, res) => {
      let body = '';
      for await (const c of req) body += c;
      received.push({ ua: String(req.headers['user-agent']), body });
      const r = replies.shift() ?? { status: 500 };
      res.writeHead(r.status, { 'Content-Type': 'application/json', ...r.headers });
      res.end(r.body ?? '');
    });
    endpoint = `http://127.0.0.1:${await listenOnFetchablePort(server)}/api/interpreter`;
  });
  afterAll(() => server.close());

  /** Orologio finto: le attese non passano davvero, ma vengono registrate. */
  function fakeClock() {
    let t = 1_000_000;
    const sleeps: number[] = [];
    const clock: Clock = {
      now: () => t,
      sleep: async (ms) => {
        sleeps.push(ms);
        t += ms;
      },
    };
    return { clock, sleeps };
  }

  const config = (over: Partial<OverpassConfig> = {}): OverpassConfig => ({
    endpoint,
    userAgent: 'NoventraLeadFinder/test (+test)',
    minIntervalMs: 10_000,
    timeoutSeconds: 30,
    maxsizeBytes: 1 << 28,
    maxRetries: 2,
    maxResponseBytes: 1 << 20,
    cacheTtlMs: 3_600_000,
    ...over,
  });
  const unit = { municipalities: [roma, albano] };
  const ok = (): Reply => ({ status: 200, body: JSON.stringify(romaFixture()) });

  it('senza endpoint configurato: errore chiaro con le istruzioni', async () => {
    const p = new OverpassProvider(config({ endpoint: null }));
    expect(p.info()).toMatchObject({ configured: false, setupHint: expect.stringContaining('DISCOVERY_OVERPASS_URL') });
    await expect(p.fetchUnit(unit, ['farmacie'], 10, new AbortController().signal)).rejects.toMatchObject({
      kind: 'not_configured',
    });
  });

  it('invia la query con User-Agent identificabile e restituisce record normalizzati', async () => {
    replies = [ok()];
    received.length = 0;
    const p = new OverpassProvider(config());
    const r = await p.fetchUnit(unit, ['farmacie'], 10, new AbortController().signal);
    expect(received[0]!.ua).toBe('NoventraLeadFinder/test (+test)');
    expect(new URLSearchParams(received[0]!.body).get('data')).toContain('058091|058003');
    expect(r.records.map((x) => x.name)).toEqual(['Farmacia di Prova Centrale', 'Farmacia di Prova dei Castelli']);
    expect(r).toMatchObject({ fromCache: false, requests: 1, foundMunicipalities: ['058091', '058003'] });
  });

  it('429 e 504: nuovi tentativi limitati con attesa crescente e Retry-After, poi successo', async () => {
    replies = [{ status: 429, headers: { 'Retry-After': '40' } }, { status: 504 }, ok()];
    const { clock, sleeps } = fakeClock();
    const p = new OverpassProvider(config(), { clock });
    const retries: { attempt: number; waitMs: number; reason: string }[] = [];
    const r = await p.fetchUnit(unit, ['farmacie'], 10, new AbortController().signal, (info) => retries.push(info));
    expect(r.requests).toBe(3);
    // 40 s (Retry-After > 15 s), poi 30 s; più gli intervalli minimi tra le richieste
    expect(sleeps.filter((s) => s !== 10_000 && s > 1000)).toEqual([40_000, 30_000]);
    // ogni nuovo tentativo è comunicato con il motivo e l'attesa
    expect(retries).toEqual([
      { attempt: 1, maxAttempts: 3, waitMs: 40_000, reason: 'Limite di richieste del server OpenStreetMap raggiunto.' },
      {
        attempt: 2,
        maxAttempts: 3,
        waitMs: 30_000,
        reason: 'Server OpenStreetMap occupato o sovraccarico (HTTP 504).',
      },
    ]);
  });

  it('tentativi esauriti: errore del fornitore con il numero di richieste', async () => {
    replies = [{ status: 503 }, { status: 503 }, { status: 503 }, ok()];
    const p = new OverpassProvider(config(), { clock: fakeClock().clock });
    const err = (await p
      .fetchUnit(unit, ['farmacie'], 10, new AbortController().signal)
      .catch((e) => e)) as ProviderError;
    expect(err).toBeInstanceOf(ProviderError);
    expect(err.kind).toBe('unavailable');
    expect(err.attempts).toBe(3);
    replies = [];
  });

  it('richieste distanziate dell’intervallo minimo', async () => {
    replies = [ok(), ok()];
    const { clock, sleeps } = fakeClock();
    const p = new OverpassProvider(config({ minIntervalMs: 10_000 }), { clock });
    const s = new AbortController().signal;
    await p.fetchUnit(unit, ['farmacie'], 10, s);
    await p.fetchUnit(unit, ['ristorazione'], 10, s);
    expect(sleeps).toEqual([10_000]);
  });

  it('risposte non valide o troppo grandi: errore, nessun dato parziale', async () => {
    replies = [{ status: 200, body: '{"elements": [{"type": "node"' }];
    const p = new OverpassProvider(config({ minIntervalMs: 0 }));
    await expect(p.fetchUnit(unit, ['farmacie'], 10, new AbortController().signal)).rejects.toMatchObject({
      kind: 'invalid_response',
    });
    replies = [{ status: 200, body: JSON.stringify({ elements: [], pad: 'x'.repeat(5000) }) }];
    const small = new OverpassProvider(config({ minIntervalMs: 0, maxResponseBytes: 1000 }));
    await expect(small.fetchUnit(unit, ['farmacie'], 10, new AbortController().signal)).rejects.toMatchObject({
      kind: 'too_large',
    });
    replies = [{ status: 400, body: 'Error: line 1: parse error' }];
    await expect(p.fetchUnit(unit, ['farmacie'], 10, new AbortController().signal)).rejects.toMatchObject({
      kind: 'invalid_response',
    });
  });

  it('annullamento: interrompe l’attesa e la richiesta', async () => {
    replies = [{ status: 503 }, ok()];
    const ac = new AbortController();
    const clock: Clock = {
      now: () => Date.now(),
      sleep: async (_ms, signal) => {
        ac.abort();
        if (signal.aborted) throw new ProviderError('aborted', 'interrotta');
      },
    };
    const p = new OverpassProvider(config({ minIntervalMs: 0 }), { clock });
    await expect(p.fetchUnit(unit, ['farmacie'], 10, ac.signal)).rejects.toMatchObject({ kind: 'aborted' });
    replies = [];
  });

  it('cache: la stessa ricerca non viene ripetuta entro la validità', async () => {
    const store = new Map<string, { value: never; fetchedAt: Date }>();
    const cache = {
      get: async (k: string) => store.get(k) ?? null,
      set: async (k: string, _p: string, value: never, fetchedAt: Date) => void store.set(k, { value, fetchedAt }),
    };
    replies = [ok()];
    const p = new OverpassProvider(config({ minIntervalMs: 0 }), { cache });
    const first = await p.fetchUnit(unit, ['farmacie'], 10, new AbortController().signal);
    const second = await p.fetchUnit(unit, ['farmacie'], 10, new AbortController().signal);
    expect(first.fromCache).toBe(false);
    expect(second).toMatchObject({ fromCache: true, requests: 0, fetchedAt: first.fetchedAt });
    expect(second.records).toEqual(first.records);
    expect(p.requestsSent).toBe(1);
  });
});
