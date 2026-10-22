import type { CategoryId } from '../categories.ts';

/*
 * Corrispondenza tra categorie interne e tag di OpenStreetMap (https://wiki.openstreetmap.org/wiki/Map_features).
 * Un'unica definizione produce sia il filtro Overpass sia il classificatore usato sui risultati: i due non possono
 * divergere. Si considerano solo elementi con un nome (un punto senza nome non è un'attività contattabile).
 *
 * Copertura: indica quanto la categoria è rappresentata in OSM in Italia. OSM è una base volontaria: anche
 * "buona" non significa completa, e le categorie "limitata" sfuggono in gran parte (es. studi professionali,
 * industrie: spesso mappati solo come edifici senza nome o non mappati).
 */

export type Coverage = 'buona' | 'parziale' | 'limitata';

/**
 * Condizione su un tag: valore esatto, uno tra più valori, solo la presenza della chiave, oppure un valore che
 * contiene un testo (es. cuisine="italian;pizza"), senza distinzione tra maiuscole e minuscole.
 */
export type TagCondition = string | readonly string[] | true | { contains: string };

export interface OsmSelector {
  /** Tutte le condizioni devono valere. */
  tags: Record<string, TagCondition>;
  /** Tag che non devono avere quel valore (un tag assente va bene). */
  not?: Record<string, string>;
  /** Il nome deve contenere questo testo (senza distinzione tra maiuscole e minuscole). */
  nameContains?: string;
}

export interface OsmCategoryMapping {
  selectors: OsmSelector[];
  coverage: Coverage;
  /** Limite da mostrare all'utente, se la categoria è riconoscibile solo in parte. */
  note?: string;
}

export const OSM_CATEGORIES: Record<CategoryId, OsmCategoryMapping> = {
  farmacie: {
    coverage: 'buona',
    selectors: [
      { tags: { amenity: 'pharmacy' }, not: { dispensing: 'no' } },
      { tags: { healthcare: 'pharmacy' }, not: { dispensing: 'no', amenity: 'pharmacy' } },
    ],
  },
  parafarmacie: {
    coverage: 'parziale',
    note: 'Riconosciute solo se etichettate come farmacie senza dispensazione o se il nome contiene "parafarmacia".',
    selectors: [
      { tags: { amenity: 'pharmacy', dispensing: 'no' } },
      { tags: { shop: 'chemist' }, nameContains: 'parafarm' },
      { tags: { shop: 'medical_supply' }, nameContains: 'parafarm' },
    ],
  },
  hotel: { coverage: 'buona', selectors: [{ tags: { tourism: ['hotel', 'motel', 'hostel'] } }] },
  extralberghiero: {
    coverage: 'parziale',
    note: 'Molti B&B e affittacamere non sono mappati o non hanno un nome registrato.',
    selectors: [{ tags: { tourism: ['guest_house', 'apartment', 'chalet'] } }],
  },
  ristorazione: {
    coverage: 'buona',
    selectors: [{ tags: { amenity: ['restaurant', 'cafe', 'bar', 'pub', 'fast_food', 'ice_cream'] } }],
  },
  studi_sanitari: {
    coverage: 'parziale',
    note: 'Gli studi all’interno di condomini sono spesso assenti.',
    selectors: [
      { tags: { amenity: ['dentist', 'doctors', 'clinic', 'veterinary'] } },
      { tags: { healthcare: ['dentist', 'doctor', 'physiotherapist', 'psychotherapist', 'laboratory', 'clinic'] } },
    ],
  },
  studi_professionali: {
    coverage: 'limitata',
    note: 'Pochi studi professionali sono mappati in OpenStreetMap: i risultati sono indicativi, non completi.',
    selectors: [
      {
        tags: {
          office: [
            'lawyer',
            'notary',
            'accountant',
            'tax_advisor',
            'architect',
            'engineer',
            'surveyor',
            'consulting',
            'insurance',
            'estate_agent',
            'financial_advisor',
          ],
        },
      },
    ],
  },
  palestre_benessere: {
    coverage: 'buona',
    selectors: [
      { tags: { leisure: ['fitness_centre', 'sports_centre', 'sauna'] } },
      { tags: { shop: ['beauty', 'massage'] } },
    ],
  },
  artigiani_servizi: {
    coverage: 'parziale',
    note: 'Parrucchieri e officine sono mappati spesso; molti artigiani senza negozio su strada mancano.',
    selectors: [
      { tags: { craft: true } },
      { tags: { shop: ['hairdresser', 'car_repair', 'dry_cleaning', 'laundry'] } },
      { tags: { amenity: ['car_wash', 'driving_school'] } },
    ],
  },
  industria: {
    coverage: 'limitata',
    note: 'Gli stabilimenti sono spesso mappati come aree o edifici senza nome: la copertura è bassa.',
    selectors: [{ tags: { man_made: 'works' } }, { tags: { industrial: true }, not: { industrial: 'port' } }],
  },
  aziende_uffici: {
    coverage: 'limitata',
    note: 'Le sedi aziendali sono mappate solo in parte, soprattutto nelle grandi città.',
    selectors: [
      { tags: { office: ['company', 'it', 'telecommunication', 'advertising_agency', 'travel_agent', 'logistics'] } },
    ],
  },
  negozi: {
    coverage: 'buona',
    note: 'Categoria ampia: nelle città i risultati sono molti, usa il limite massimo per contenerli.',
    selectors: [{ tags: { shop: true }, not: { shop: 'vacant' } }],
  },
};

const escapeOverpass = (s: string) => s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Filtro Overpass di un selettore, es. ["amenity"="pharmacy"]["dispensing"!="no"]["name"]. */
export function overpassFilter(sel: OsmSelector): string {
  const parts: string[] = [];
  for (const [k, cond] of Object.entries(sel.tags)) {
    if (cond === true) parts.push(`["${escapeOverpass(k)}"]`);
    else if (typeof cond === 'object' && 'contains' in cond)
      parts.push(`["${escapeOverpass(k)}"~"${escapeOverpass(escapeRegex(cond.contains))}",i]`);
    else if (typeof cond === 'string') parts.push(`["${escapeOverpass(k)}"="${escapeOverpass(cond)}"]`);
    else parts.push(`["${escapeOverpass(k)}"~"^(${cond.map((v) => escapeOverpass(escapeRegex(v))).join('|')})$"]`);
  }
  for (const [k, v] of Object.entries(sel.not ?? {})) parts.push(`["${escapeOverpass(k)}"!="${escapeOverpass(v)}"]`);
  parts.push(sel.nameContains ? `["name"~"${escapeOverpass(escapeRegex(sel.nameContains))}",i]` : '["name"]');
  return parts.join('');
}

/**
 * Filtri larghi, uno per chiave principale (la prima chiave di ogni selettore), con tutti i valori richiesti per
 * quella chiave: ogni elemento che soddisfa un selettore soddisfa anche il filtro della sua chiave.
 * Servono a leggere l'area di un comune poche volte (una per chiave) invece di una volta per selettore:
 * con decine di settori la differenza è tra pochi secondi e una richiesta che il server interrompe.
 */
export function keyPrefilters(selectors: readonly OsmSelector[]): string[] {
  const byKey = new Map<string, Set<string> | true>();
  for (const sel of selectors) {
    const first = Object.entries(sel.tags)[0];
    if (!first) throw new Error('Selettore senza tag');
    const [k, cond] = first;
    const cur = byKey.get(k);
    if (cur === true) continue;
    if (cond === true || (typeof cond === 'object' && 'contains' in cond)) {
      byKey.set(k, true);
      continue;
    }
    const values = cur ?? new Set<string>();
    for (const v of typeof cond === 'string' ? [cond] : cond) values.add(v);
    byKey.set(k, values);
  }
  return [...byKey].map(([k, v]) =>
    v === true
      ? `["${escapeOverpass(k)}"]["name"]`
      : `["${escapeOverpass(k)}"~"^(${[...v]
          .sort()
          .map((x) => escapeOverpass(escapeRegex(x)))
          .join('|')})$"]["name"]`,
  );
}

/** Lo stesso selettore applicato ai tag di un elemento già scaricato. */
export function matchesSelector(tags: Record<string, string>, sel: OsmSelector): boolean {
  if (!tags.name?.trim()) return false;
  for (const [k, cond] of Object.entries(sel.tags)) {
    const v = tags[k];
    if (v === undefined) return false;
    if (cond === true) continue;
    if (typeof cond === 'string') {
      if (v !== cond) return false;
    } else if ('contains' in cond) {
      if (!v.toLowerCase().includes(cond.contains.toLowerCase())) return false;
    } else if (!cond.includes(v)) return false;
  }
  for (const [k, v] of Object.entries(sel.not ?? {})) if (tags[k] === v) return false;
  if (sel.nameContains && !tags.name.toLowerCase().includes(sel.nameContains.toLowerCase())) return false;
  return true;
}

/** Prima categoria (in ordine di priorità) a cui l'elemento appartiene, tra quelle richieste. */
export function classify(tags: Record<string, string>, requested: readonly CategoryId[]): CategoryId | null {
  for (const id of requested) if (OSM_CATEGORIES[id].selectors.some((s) => matchesSelector(tags, s))) return id;
  return null;
}
