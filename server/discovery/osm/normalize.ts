import { z } from 'zod';
import type { CategoryId } from '../categories.ts';
import { ProviderError, type ProviderRecord } from '../types.ts';
import { contactsFromTags } from '../contacts.ts';
import { SECTORS, sectorsInOrder, type Sector } from '../sectors.ts';
import { normalizeWebsite } from '../website.ts';
import { classify, matchesSelector } from './tags.ts';

/*
 * Dalla risposta JSON di Overpass ai record normalizzati. La risposta viene validata: una forma inattesa è un
 * errore del fornitore, mai un risultato vuoto. Un "remark" di errore di esecuzione (tempo o memoria esauriti)
 * significa dati incompleti: anche questo è un errore, da cui il motore riparte dividendo l'unità.
 */

export const OSM_PROVIDER = 'osm';

const tagsSchema = z.record(z.string(), z.string()).optional();
const elementSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('area'), id: z.number(), tags: tagsSchema }),
  z.object({ type: z.literal('node'), id: z.number(), lat: z.number(), lon: z.number(), tags: tagsSchema }),
  z.object({
    type: z.enum(['way', 'relation']),
    id: z.number(),
    center: z.object({ lat: z.number(), lon: z.number() }).optional(),
    tags: tagsSchema,
  }),
]);
const responseSchema = z.object({
  elements: z.array(z.unknown()),
  remark: z.string().optional(),
  // data dei dati del server: le istanze pubbliche possono usare copie vecchie di mesi, anche diverse tra una
  // risposta e l'altra (più server dietro lo stesso indirizzo)
  osm3s: z.object({ timestamp_osm_base: z.string().optional() }).optional(),
});

/** Tag conservati come provenienza: identificazione, categoria, indirizzo, sito, orari. Mai telefono o email. */
const KEPT_TAGS =
  /^(name|brand|amenity|shop|tourism|office|healthcare|leisure|craft|man_made|industrial|dispensing|cuisine|website|contact:website|url|opening_hours|addr:(street|housenumber|postcode|city|place|province)|check_date)$/;

export interface ParsedResponse {
  records: ProviderRecord[];
  foundMunicipalities: string[];
  /** Data dei dati OpenStreetMap del server che ha risposto (ISO), se dichiarata. */
  sourceTimestamp: string | null;
}

const clean = (v: string | undefined, max: number) => {
  const t = v?.replace(/\s+/g, ' ').trim();
  return t ? t.slice(0, max) : null;
};

export function normalizeElement(
  tags: Record<string, string>,
  ref: { type: 'node' | 'way' | 'relation'; id: number },
  position: { lat: number; lon: number } | null,
  municipalityCode: string | null,
  categories: CategoryId[],
  sectors?: Sector[],
): ProviderRecord | null {
  const name = clean(tags.name, 200);
  if (!name) return null;
  // ricerca per settori: vale il primo settore richiesto che corrisponde, e la sua categoria;
  // ricerca per categorie (Fase 2): la categoria come prima, e il settore se uno del catalogo corrisponde
  const sector = (sectors ?? SECTORS).find((sec) => sec.selectors.some((sel) => matchesSelector(tags, sel))) ?? null;
  const category = sectors ? (sector?.category ?? null) : classify(tags, categories);
  if (!category || (sectors && !sector)) return null;
  const site = normalizeWebsite(tags.website ?? tags['contact:website'] ?? tags.url);
  const address = {
    street: clean(tags['addr:street'] ?? tags['addr:place'], 200),
    housenumber: clean(tags['addr:housenumber'], 20),
    postcode: clean(tags['addr:postcode'], 10),
    city: clean(tags['addr:city'], 100),
  };
  const sourceTags: Record<string, string> = {};
  for (const [k, v] of Object.entries(tags)) if (KEPT_TAGS.test(k)) sourceTags[k] = v.slice(0, 500);
  return {
    provider: OSM_PROVIDER,
    ref: `${ref.type}/${ref.id}`,
    sourceUrl: `https://www.openstreetmap.org/${ref.type}/${ref.id}`,
    name,
    category,
    sector: sector?.id ?? null,
    websiteUrl: site?.url ?? null,
    websiteDomain: site?.domain ?? null,
    websiteShared: site?.shared ?? false,
    address,
    municipalityCode,
    latitude: position?.lat ?? null,
    longitude: position?.lon ?? null,
    contacts: contactsFromTags(tags),
    has: {
      website: site !== null,
      address: Boolean(address.street && (address.housenumber || address.postcode)),
      phone: Boolean(tags.phone || tags['contact:phone'] || tags['contact:mobile'] || tags.mobile),
      email: Boolean(tags.email || tags['contact:email']),
      openingHours: Boolean(tags.opening_hours),
    },
    sourceTags,
  };
}

export function parseOverpassResponse(body: unknown, categories: CategoryId[], sectorIds?: string[]): ParsedResponse {
  const sectors = sectorIds?.length ? sectorsInOrder(sectorIds) : undefined;
  const parsed = responseSchema.safeParse(body);
  if (!parsed.success) throw new ProviderError('invalid_response', 'Risposta di OpenStreetMap in un formato inatteso.');
  const remark = parsed.data.remark ?? '';
  if (/runtime error|timed out|out of memory/i.test(remark)) {
    throw new ProviderError(
      /out of memory/i.test(remark) ? 'too_large' : 'timeout',
      'La richiesta è troppo ampia per il server OpenStreetMap: verrà divisa in parti più piccole.',
      { retryable: true },
    );
  }
  const records: ProviderRecord[] = [];
  const found: string[] = [];
  let currentArea: string | null = null;
  for (const raw of parsed.data.elements) {
    const el = elementSchema.safeParse(raw);
    if (!el.success) throw new ProviderError('invalid_response', 'Elemento di OpenStreetMap in un formato inatteso.');
    const e = el.data;
    if (e.type === 'area') {
      const code = e.tags?.['ref:ISTAT'];
      currentArea = code && /^\d{6}$/.test(code) ? code : null;
      if (currentArea && !found.includes(currentArea)) found.push(currentArea);
      continue;
    }
    const position = e.type === 'node' ? { lat: e.lat, lon: e.lon } : (e.center ?? null);
    const record = normalizeElement(
      e.tags ?? {},
      { type: e.type, id: e.id },
      position,
      currentArea,
      categories,
      sectors,
    );
    if (record) records.push(record);
  }
  const stamp = parsed.data.osm3s?.timestamp_osm_base;
  const sourceTimestamp = stamp && !Number.isNaN(Date.parse(stamp)) ? new Date(stamp).toISOString() : null;
  return { records, foundMunicipalities: found, sourceTimestamp };
}
