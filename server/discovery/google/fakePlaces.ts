import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { listenOnFetchablePort } from '../../testing.ts';

/*
 * SERVER GOOGLE PLACES FINTO — SOLO PER I TEST (automatici ed end-to-end). Non fa parte dell'applicazione.
 * Risponde a POST /v1/places:searchText come la Places API (New), con attività inventate «di Prova Google»:
 * per ogni ricerca «<testo> a <Comune> (<SG>)» restituisce `perQuery` luoghi, `perPage` per pagina (nextPageToken).
 * Controlla la chiave (X-Goog-Api-Key) e il FieldMask; si può programmare per rispondere con errori.
 */

export const FAKE_GOOGLE_KEY = 'chiave-google-di-prova-0000000000';

/** Tipo di luogo e nome per il testo della ricerca (stessi testi di server/discovery/google/queries.ts). */
const KINDS: [RegExp, { type: string; label: string }][] = [
  [/^farmacia/, { type: 'pharmacy', label: 'Farmacia' }],
  [/^bed and breakfast/, { type: 'bed_and_breakfast', label: 'B&B' }],
  [/^pizzeria/, { type: 'pizza_restaurant', label: 'Pizzeria' }],
  [/^ristorante/, { type: 'restaurant', label: 'Ristorante' }],
  [/^bar/, { type: 'bar', label: 'Bar' }],
  [/^parrucchiere/, { type: 'hair_salon', label: 'Parrucchiere' }],
  [/^studio dentistico/, { type: 'dentist', label: 'Studio Dentistico' }],
  [/^hotel/, { type: 'hotel', label: 'Hotel' }],
];

export interface FakePlacesControl {
  /** Prossime risposte di errore (codici HTTP), una per richiesta. */
  failures: number[];
  /** Corpi delle richieste ricevute. */
  requests: Record<string, unknown>[];
  /** Intestazioni FieldMask ricevute. */
  fieldMasks: string[];
  perQuery: number;
  perPage: number;
  /** Sito del luogo i-esimo (null = senza sito). */
  websiteFor: (slug: string, i: number) => string | null;
  /** Tipi rifiutati come includedType (per provare la ripetizione senza tipo). */
  rejectTypes: Set<string>;
}

const slugOf = (s: string) =>
  s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');

export async function startFakePlaces(
  port = 0,
): Promise<{ url: string; control: FakePlacesControl; close(): Promise<void>; server: Server }> {
  const control: FakePlacesControl = {
    failures: [],
    requests: [],
    fieldMasks: [],
    perQuery: 3,
    perPage: 2,
    websiteFor: (slug, i) => (i === 0 ? `https://${slug}.example.it/` : null),
    rejectTypes: new Set(),
  };
  const server = createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(body));
    };
    if (req.method !== 'POST' || req.url !== '/v1/places:searchText')
      return send(404, { error: { status: 'NOT_FOUND' } });
    if (req.headers['x-goog-api-key'] !== FAKE_GOOGLE_KEY)
      return send(403, {
        error: { status: 'PERMISSION_DENIED', message: 'API key not valid. Please pass a valid API key.' },
      });
    const failure = control.failures.shift();
    if (failure) return send(failure, { error: { status: failure === 429 ? 'RESOURCE_EXHAUSTED' : 'UNAVAILABLE' } });
    const body = JSON.parse(raw) as { textQuery: string; pageToken?: string; pageSize?: number; includedType?: string };
    control.requests.push(body);
    control.fieldMasks.push(String(req.headers['x-goog-fieldmask'] ?? ''));
    if (body.includedType && control.rejectTypes.has(body.includedType))
      return send(400, {
        error: { status: 'INVALID_ARGUMENT', message: `Unsupported includedType: ${body.includedType}` },
      });
    const m = /^(.*) a (.+?) \(([A-Z]{2})\)$/.exec(body.textQuery);
    if (!m) return send(400, { error: { status: 'INVALID_ARGUMENT', message: 'Invalid textQuery' } });
    const [, text, comune, sigla] = m as unknown as [string, string, string, string];
    const kind = KINDS.find(([re]) => re.test(text))?.[1] ?? { type: 'store', label: 'Attività' };
    const start = Number(body.pageToken ?? 0);
    const size = Math.min(control.perPage, body.pageSize ?? 20);
    const places = [];
    for (let i = start; i < Math.min(start + size, control.perQuery); i++) {
      const name = `${kind.label} di Prova Google ${comune} ${i + 1}`;
      const slug = slugOf(name);
      places.push({
        id: `fake-${slugOf(text)}-${slugOf(comune)}-${i + 1}`,
        displayName: { text: name, languageCode: 'it' },
        formattedAddress: `Via di Prova ${i + 1}, 00000 ${comune} ${sigla}, Italia`,
        addressComponents: [
          { longText: String(i + 1), shortText: String(i + 1), types: ['street_number'] },
          { longText: 'Via di Prova', shortText: 'Via di Prova', types: ['route'] },
          { longText: comune, shortText: comune, types: ['locality', 'political'] },
          { longText: comune, shortText: comune, types: ['administrative_area_level_3', 'political'] },
          { longText: '00000', shortText: '00000', types: ['postal_code'] },
        ],
        location: { latitude: 40 + i * 0.01, longitude: 9 + slug.length * 0.001 },
        ...(control.websiteFor(slug, i) ? { websiteUri: control.websiteFor(slug, i) } : {}),
        nationalPhoneNumber: `000 ${String(1000000 + i)}`,
        types: [kind.type, 'point_of_interest', 'establishment'],
        primaryType: kind.type,
        // il terzo luogo di ogni ricerca è chiuso definitivamente: va scartato
        businessStatus: i === 2 ? 'CLOSED_PERMANENTLY' : 'OPERATIONAL',
        googleMapsUri: `https://maps.google.com/?cid=${i + 1}`,
      });
    }
    const next = start + size < control.perQuery ? String(start + size) : undefined;
    send(200, { places, ...(next ? { nextPageToken: next } : {}) });
  });
  if (port === 0) await listenOnFetchablePort(server);
  else await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));
  const actual = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${actual}`,
    control,
    server,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
