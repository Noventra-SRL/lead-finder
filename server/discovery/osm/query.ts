import type { CategoryId } from '../categories.ts';
import type { Sector } from '../sectors.ts';
import type { DiscoveryUnitSpec } from '../types.ts';
import { keyPrefilters, OSM_CATEGORIES, overpassFilter } from './tags.ts';

/*
 * Query Overpass per un'unità di lavoro. I comuni sono individuati dal loro codice ISTAT (tag ref:ISTAT dei
 * confini amministrativi di livello 8), non dal nome. Per ogni comune la risposta contiene prima l'area
 * (con i suoi tag) e poi le attività che contiene: così ogni attività è attribuita al suo comune e i comuni
 * assenti in OSM si distinguono da quelli senza risultati.
 *
 * Con un raggio (un solo comune): si considerano anche i comuni vicini, ma solo per le attività entro il raggio
 * dal confine del comune scelto.
 */

export interface QueryOptions {
  timeoutSeconds: number;
  maxsizeBytes: number;
}

function selectorsFor(categories: CategoryId[], areaSet: string): string {
  const lines: string[] = [];
  for (const id of categories)
    for (const sel of OSM_CATEGORIES[id].selectors) lines.push(`nwr${overpassFilter(sel)}(area.${areaSet});`);
  return lines.join('\n    ');
}

/**
 * Ricerca per settori: un blocco per settore, ognuno con il proprio limite per comune (nessun settore prevale).
 * L'area del comune viene letta una volta per chiave OSM (amenity, shop, office…) in un insieme di candidati;
 * i settori filtrano poi quell'insieme in memoria sul server, senza rileggere l'area.
 */
/** Solo elementi con un sito o un'email nei tag: il limite per comune conta solo le attività con un recapito. */
const CONTACT_FILTER = '[~"^(website|contact:website|url|email|contact:email)$"~"."]';

function sectorBlocks(
  sectors: Sector[],
  areaSet: string,
  limit: number,
  radius?: { meters: number },
  contact = '',
): string {
  const prefilters = keyPrefilters(sectors.flatMap((sec) => sec.selectors));
  const candidates = `(
    ${prefilters.map((f) => `nwr${f}(area.${areaSet});`).join('\n    ')}
  )->.candidati;`;
  const blocks = sectors
    .map((sec) => {
      const sel = sec.selectors.map((x) => `nwr.candidati${overpassFilter(x)}${contact};`).join('\n    ');
      if (!radius)
        return `(
    ${sel}
  );
  out center tags qt ${limit};`;
      return `(
    ${sel}
  )->.trovati;
  (
    nwr.trovati(area.baseArea);
    nwr.trovati(around.base:${radius.meters});
  );
  out center tags qt ${limit};`;
    })
    .join('\n  ');
  return `${candidates}\n  ${blocks}`;
}

export function buildUnitQuery(
  unit: DiscoveryUnitSpec,
  categories: CategoryId[],
  limitPerArea: number,
  options: QueryOptions,
  sectors?: Sector[],
  filters: { requireContact?: boolean } = {},
): string {
  const contact = filters.requireContact ? CONTACT_FILTER : '';
  const codes = unit.municipalities.map((m) => m.code);
  for (const c of codes) if (!/^\d{6}$/.test(c)) throw new Error(`Codice ISTAT non valido: ${c}`);
  if (!codes.length) throw new Error('Unità senza comuni');
  if (!Number.isInteger(limitPerArea) || limitPerArea < 1) throw new Error('Limite non valido');
  const header = `[out:json][timeout:${options.timeoutSeconds}][maxsize:${options.maxsizeBytes}];`;
  const boundary = '["boundary"="administrative"]["admin_level"="8"]';

  if (unit.radiusKm === undefined) {
    const codeFilter = codes.length === 1 ? `["ref:ISTAT"="${codes[0]}"]` : `["ref:ISTAT"~"^(${codes.join('|')})$"]`;
    return `${header}
rel${codeFilter}${boundary};
map_to_area->.comuni;
foreach.comuni->.c(
  .c out tags;
  ${
    sectors?.length
      ? sectorBlocks(sectors, 'c', limitPerArea, undefined, contact)
      : `(
    ${selectorsFor(categories, 'c')}
  );
  out center tags qt ${limitPerArea};`
  }
);`;
  }

  if (codes.length !== 1) throw new Error('La ricerca per raggio riguarda un solo comune');
  const meters = Math.round(unit.radiusKm * 1000);
  if (!(meters >= 100 && meters <= 50_000)) throw new Error('Raggio non valido');
  return `${header}
rel["ref:ISTAT"="${codes[0]}"]${boundary}->.base;
.base map_to_area->.baseArea;
rel(around.base:${meters})${boundary}["ref:ISTAT"]->.vicini;
.vicini map_to_area->.comuni;
foreach.comuni->.c(
  .c out tags;
  ${
    sectors?.length
      ? sectorBlocks(sectors, 'c', limitPerArea, { meters }, contact)
      : `(
    ${selectorsFor(categories, 'c')}
  )->.trovati;
  (
    nwr.trovati(area.baseArea);
    nwr.trovati(around.base:${meters});
  );
  out center tags qt ${limitPerArea};`
  }
);`;
}
