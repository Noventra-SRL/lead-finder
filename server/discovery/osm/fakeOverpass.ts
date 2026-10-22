import { createServer, type Server } from 'node:http';
import { listenOnFetchablePort } from '../../testing.ts';
import type { AddressInfo } from 'node:net';
import { geo } from '../../geo/geo.ts';
import { FIXTURE_ID_BASE, type FixtureElement } from './fixtures.ts';

/*
 * SERVER OVERPASS FINTO — SOLO PER I TEST (automatici ed end-to-end). Non fa parte dell'applicazione.
 * Risponde come Overpass alle query del progetto: legge i codici ISTAT richiesti e restituisce, per ogni comune,
 * l'area e alcune attività INVENTATE ("di Prova", identificativi da 9.000.000.000 in su). Il filtro per categoria
 * lo fa il normalizzatore reale, come con il vero Overpass.
 * Si può programmare per rispondere con errori (429, 503…), per simulare comuni assenti o per rallentare.
 */

export interface FakeOverpassControl {
  /** Codici HTTP da restituire alle prossime richieste, uno per richiesta (poi risposte normali). */
  failures: number[];
  /** Comuni da considerare assenti in OpenStreetMap. */
  missing: Set<string>;
  /** Ritardo di ogni risposta in millisecondi. */
  delayMs: number;
  /** Query ricevute (per le verifiche). */
  queries: string[];
  /** Data dei dati dichiarata (osm3s.timestamp_osm_base); predefinita: adesso. */
  osmBase?: string;
}

function hash(s: string) {
  let h = 0;
  for (const c of s) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return h;
}

/** Attività inventate per un comune: posizioni deterministiche, un paio di quasi-duplicati per la revisione. */
export function fakeElementsFor(code: string): FixtureElement[] {
  const m = geo().municipality(code);
  const name = m?.name ?? code;
  const lat = 37 + (hash(code) % 900) / 100;
  const lon = 7 + (hash(`${code}x`) % 1100) / 100;
  const id = (k: number) => FIXTURE_ID_BASE + Number(code) * 100 + k;
  const slug = name
    .toLowerCase()
    .normalize('NFD')
    .replace(/[^a-z]/g, '');
  return [
    {
      type: 'area',
      id: 3_600_000_000 + Number(code),
      tags: { boundary: 'administrative', admin_level: '8', 'ref:ISTAT': code, name },
    },
    {
      type: 'node',
      id: id(1),
      lat,
      lon,
      tags: {
        amenity: 'pharmacy',
        name: `Farmacia di Prova ${name}`,
        website: `https://www.farmacia-${slug}.example.it`,
        phone: '+39 000 0000000',
        'addr:street': 'Via di Prova',
        'addr:housenumber': '1',
        'addr:postcode': '00000',
        'addr:city': name,
        opening_hours: 'Mo-Sa 09:00-19:00',
      },
    },
    {
      type: 'node',
      id: id(2),
      lat: lat + 0.01,
      lon,
      tags: { amenity: 'pharmacy', dispensing: 'no', name: `Parafarmacia di Prova ${name}` },
    },
    {
      type: 'way',
      id: id(3),
      center: { lat: lat + 0.02, lon },
      tags: {
        amenity: 'restaurant',
        name: `Trattoria di Prova ${name}`,
        website: 'https://www.facebook.com/trattoriadiprova',
      },
    },
    {
      type: 'node',
      id: id(4),
      lat: lat + 0.03,
      lon,
      tags: {
        tourism: 'hotel',
        name: `Hotel di Prova ${name}`,
        website: `https://hotel-${slug}.example.it`,
        'addr:street': 'Piazza di Prova',
        'addr:housenumber': '2',
      },
    },
    // due elementi con lo stesso nome a 80 m: devono finire in revisione, non essere uniti in automatico
    { type: 'node', id: id(5), lat: lat + 0.04, lon, tags: { amenity: 'bar', name: `Bar di Prova ${name}` } },
    {
      type: 'way',
      id: id(6),
      center: { lat: lat + 0.04072, lon },
      tags: { amenity: 'bar', name: `Bar di Prova ${name}`, opening_hours: '24/7' },
    },
    // senza nome: ignorato
    { type: 'node', id: id(7), lat, lon, tags: { amenity: 'cafe' } },
    // altri settori (Fase 6): email generica conservata, email personale mai conservata
    {
      type: 'node',
      id: id(8),
      lat: lat + 0.05,
      lon,
      tags: {
        amenity: 'dentist',
        name: `Studio Dentistico di Prova ${name}`,
        email: 'info@dentista-prova.example.it',
        phone: '+39 000 1111111',
      },
    },
    {
      type: 'node',
      id: id(9),
      lat: lat + 0.06,
      lon,
      tags: {
        office: 'accountant',
        name: `Studio Commercialista di Prova ${name}`,
        email: 'mario.rossi@studio-prova.example.it',
      },
    },
    {
      type: 'node',
      id: id(10),
      lat: lat + 0.07,
      lon,
      tags: { shop: 'hairdresser', name: `Parrucchiere di Prova ${name}`, phone: '000 2222222' },
    },
    { type: 'node', id: id(11), lat: lat + 0.08, lon, tags: { shop: 'bakery', name: `Panificio di Prova ${name}` } },
  ];
}

export async function startFakeOverpass(
  port = 0,
): Promise<{ url: string; control: FakeOverpassControl; close(): Promise<void>; server: Server }> {
  const control: FakeOverpassControl = { failures: [], missing: new Set(), delayMs: 0, queries: [] };
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    // programmazione dai test end-to-end (processo separato): POST /__control { failures, missing, delayMs, osmBase }
    if (req.url === '/__control' && req.method === 'POST') {
      const c = JSON.parse(body || '{}') as {
        failures?: number[];
        missing?: string[];
        delayMs?: number;
        osmBase?: string | null;
      };
      if (c.failures) control.failures = c.failures;
      if (c.missing) control.missing = new Set(c.missing);
      if (c.delayMs !== undefined) control.delayMs = c.delayMs;
      if (c.osmBase !== undefined) control.osmBase = c.osmBase ?? undefined;
      res.writeHead(204);
      res.end();
      return;
    }
    const query = new URLSearchParams(body).get('data') ?? '';
    control.queries.push(query);
    if (control.delayMs) await new Promise((r) => setTimeout(r, control.delayMs));
    const failure = control.failures.shift();
    if (failure) {
      res.writeHead(failure, { 'Content-Type': 'text/plain' });
      res.end(`errore simulato ${failure}`);
      return;
    }
    if (req.method !== 'POST' || !query.startsWith('[out:json]')) {
      res.writeHead(400, { 'Content-Type': 'text/plain' });
      res.end('query non valida');
      return;
    }
    const codes = [...query.matchAll(/\b(\d{6})\b/g)].map((m) => m[1]!);
    const elements = [...new Set(codes)].filter((c) => !control.missing.has(c)).flatMap(fakeElementsFor);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        version: 0.6,
        generator: 'Overpass finto per i test',
        osm3s: { timestamp_osm_base: control.osmBase ?? new Date().toISOString().replace(/\.\d{3}Z$/, 'Z') },
        elements,
      }),
    );
  });
  // porta 0 (test): una porta che fetch() accetta; porta fissa (e2e): quella richiesta
  if (port === 0) await listenOnFetchablePort(server);
  else await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));
  const { port: actual } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${actual}/api/interpreter`,
    control,
    server,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
