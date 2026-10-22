import { z } from 'zod';
import { CATEGORY_IDS, type CategoryId } from './categories.ts';
import type { Coverage, OsmSelector } from './osm/tags.ts';

/*
 * Catalogo dei SETTORI per la ricerca di lead (Lead Hunter, Fase 6): un solo file di configurazione.
 * Ogni settore è più specifico di una categoria interna (le categorie restano la base delle regole di punteggio e di
 * abbinamento delle Fasi 4 e 5) e dichiara come riconoscerlo in OpenStreetMap e quanto è coperto.
 * Per aggiungere un settore basta una voce qui: viene validata all'avvio (id unici, categoria esistente, selettori).
 *
 * L'ordine conta: un elemento che corrisponde a più settori va al primo (es. una pizzeria è "Pizzerie", non
 * "Ristoranti"; il negozio generico è l'ultimo). Tag: https://wiki.openstreetmap.org/wiki/Map_features
 */

export const SECTOR_GROUPS = {
  turismo: 'Turismo e ospitalità',
  ristorazione: 'Ristorazione e alimentari',
  commercio: 'Commercio al dettaglio',
  professionisti: 'Servizi professionali',
  edilizia_industria: 'Edilizia, produzione e B2B',
  salute_benessere: 'Salute, benessere e cura della persona',
  servizi: 'Formazione e altri servizi',
} as const;
export type SectorGroup = keyof typeof SECTOR_GROUPS;

export interface Sector {
  id: string;
  label: string;
  group: SectorGroup;
  /** Categoria interna usata dalle regole di punteggio e di abbinamento. */
  category: CategoryId;
  selectors: OsmSelector[];
  coverage: Coverage;
  note?: string;
}

const s = (
  id: string,
  label: string,
  group: SectorGroup,
  category: CategoryId,
  coverage: Coverage,
  selectors: OsmSelector[],
  note?: string,
): Sector => ({ id, label, group, category, coverage, selectors, ...(note ? { note } : {}) });

const RAW_SECTORS: Sector[] = [
  // ---- turismo e ospitalità ----
  s(
    'agriturismi',
    'Agriturismi',
    'turismo',
    'extralberghiero',
    'parziale',
    [
      { tags: { tourism: true }, nameContains: 'agriturismo' },
      { tags: { tourism: true, guest_house: ['agritourism', 'farm'] } },
    ],
    'Riconosciuti dal nome o dal sottotipo: alcuni sono mappati come B&B o hotel.',
  ),
  s('hotel', 'Hotel e hotel boutique', 'turismo', 'hotel', 'buona', [{ tags: { tourism: ['hotel', 'motel'] } }]),
  s(
    'bed_and_breakfast',
    'Bed and breakfast e affittacamere',
    'turismo',
    'extralberghiero',
    'parziale',
    [{ tags: { tourism: 'guest_house' } }],
    'Molti B&B non sono mappati o non hanno un nome registrato.',
  ),
  s('case_vacanza', 'Case vacanza, ostelli e campeggi', 'turismo', 'extralberghiero', 'parziale', [
    { tags: { tourism: ['apartment', 'chalet', 'hostel', 'camp_site', 'caravan_site'] } },
  ]),
  s('agenzie_viaggio', 'Agenzie di viaggio e tour operator', 'turismo', 'aziende_uffici', 'parziale', [
    { tags: { office: ['travel_agent', 'tour_operator'] } },
    { tags: { shop: 'travel_agency' } },
  ]),
  s(
    'location_eventi',
    'Location per eventi e matrimoni',
    'turismo',
    'aziende_uffici',
    'limitata',
    [{ tags: { amenity: ['events_venue', 'conference_centre'] } }],
    'Poche location sono mappate come tali: molte risultano hotel, ville o ristoranti.',
  ),

  // ---- ristorazione e alimentari ----
  s('pizzerie', 'Pizzerie', 'ristorazione', 'ristorazione', 'buona', [
    { tags: { amenity: ['restaurant', 'fast_food'], cuisine: { contains: 'pizza' } } },
  ]),
  s('ristoranti', 'Ristoranti e fast food', 'ristorazione', 'ristorazione', 'buona', [
    { tags: { amenity: ['restaurant', 'fast_food'] } },
  ]),
  s('bar_caffe', 'Bar, caffè e gelaterie', 'ristorazione', 'ristorazione', 'buona', [
    { tags: { amenity: ['cafe', 'bar', 'pub', 'ice_cream', 'biergarten'] } },
  ]),
  s('panifici_pasticcerie', 'Panifici e pasticcerie', 'ristorazione', 'negozi', 'buona', [
    { tags: { shop: ['bakery', 'pastry', 'confectionery'] } },
  ]),
  s('catering', 'Catering e gastronomie', 'ristorazione', 'ristorazione', 'parziale', [
    { tags: { craft: 'caterer' } },
    { tags: { shop: 'deli' } },
  ]),

  // ---- commercio ----
  s('abbigliamento', 'Abbigliamento e calzature', 'commercio', 'negozi', 'buona', [
    { tags: { shop: ['clothes', 'shoes', 'boutique', 'fashion_accessories', 'bag', 'leather'] } },
  ]),
  s('arredamento', 'Arredamento e interior design', 'commercio', 'negozi', 'buona', [
    {
      tags: {
        shop: [
          'furniture',
          'interior_decoration',
          'kitchen',
          'bed',
          'lighting',
          'houseware',
          'bathroom_furnishing',
          'flooring',
        ],
      },
    },
  ]),
  s('elettronica', 'Elettronica e informatica', 'commercio', 'negozi', 'buona', [
    { tags: { shop: ['electronics', 'computer', 'mobile_phone', 'hifi', 'appliance'] } },
  ]),
  s('gioiellerie', 'Gioiellerie e orologerie', 'commercio', 'negozi', 'buona', [
    { tags: { shop: ['jewelry', 'watches'] } },
  ]),
  s('negozi_specializzati', 'Negozi specializzati', 'commercio', 'negozi', 'buona', [
    {
      tags: {
        shop: [
          'books',
          'gift',
          'sports',
          'toys',
          'optician',
          'florist',
          'pet',
          'bicycle',
          'music',
          'art',
          'cosmetics',
          'perfumery',
          'wine',
          'outdoor',
          'stationery',
          'hardware',
          'doityourself',
          'garden_centre',
          'craft',
        ],
      },
    },
  ]),
  s(
    'negozi',
    'Altri negozi',
    'commercio',
    'negozi',
    'buona',
    [{ tags: { shop: true }, not: { shop: 'vacant' } }],
    'Commercio al dettaglio non compreso nei settori precedenti.',
  ),

  // ---- servizi professionali ----
  s(
    'commercialisti',
    'Commercialisti e consulenti fiscali',
    'professionisti',
    'studi_professionali',
    'limitata',
    [{ tags: { office: ['accountant', 'tax_advisor'] } }],
    'Pochi studi professionali sono mappati in OpenStreetMap: i risultati sono indicativi.',
  ),
  s(
    'avvocati',
    'Studi legali e notarili',
    'professionisti',
    'studi_professionali',
    'limitata',
    [{ tags: { office: ['lawyer', 'notary'] } }],
    'Pochi studi professionali sono mappati in OpenStreetMap: i risultati sono indicativi.',
  ),
  s('architetti', 'Architetti', 'professionisti', 'studi_professionali', 'limitata', [
    { tags: { office: 'architect' } },
  ]),
  s('ingegneri', 'Studi di ingegneria e geometri', 'professionisti', 'studi_professionali', 'limitata', [
    { tags: { office: ['engineer', 'surveyor'] } },
  ]),
  s('consulenti', 'Consulenti e assicurazioni', 'professionisti', 'studi_professionali', 'limitata', [
    { tags: { office: ['consulting', 'financial_advisor', 'insurance', 'financial'] } },
  ]),
  s('agenzie_immobiliari', 'Agenzie immobiliari', 'professionisti', 'studi_professionali', 'parziale', [
    { tags: { office: 'estate_agent' } },
    { tags: { shop: 'estate_agent' } },
  ]),
  s(
    'servizi_imprese',
    'Servizi alle imprese',
    'professionisti',
    'aziende_uffici',
    'limitata',
    [
      {
        tags: {
          office: [
            'company',
            'it',
            'advertising_agency',
            'logistics',
            'telecommunication',
            'coworking',
            'employment_agency',
          ],
        },
      },
    ],
    'Le sedi aziendali sono mappate solo in parte, soprattutto nelle grandi città.',
  ),

  // ---- edilizia, produzione e B2B ----
  s('imprese_edili', 'Imprese edili e ristrutturazioni', 'edilizia_industria', 'artigiani_servizi', 'limitata', [
    { tags: { craft: ['builder', 'roofer', 'carpenter', 'stonemason', 'scaffolder', 'insulation'] } },
    { tags: { office: 'construction_company' } },
  ]),
  s('impiantisti', 'Elettricisti, idraulici e artigiani', 'edilizia_industria', 'artigiani_servizi', 'parziale', [
    {
      tags: {
        craft: [
          'electrician',
          'plumber',
          'hvac',
          'heating_engineer',
          'painter',
          'tiler',
          'glaziery',
          'metal_construction',
          'locksmith',
          'window_construction',
          'floorer',
          'plasterer',
        ],
      },
    },
  ]),
  s(
    'produttori',
    'Produttori e stabilimenti',
    'edilizia_industria',
    'industria',
    'limitata',
    [{ tags: { man_made: 'works' } }, { tags: { industrial: true }, not: { industrial: 'port' } }],
    'Gli stabilimenti sono spesso mappati come aree o edifici senza nome.',
  ),
  s('ingrosso', 'Ingrosso, distributori e fornitori industriali', 'edilizia_industria', 'industria', 'limitata', [
    { tags: { shop: ['wholesale', 'trade', 'agrarian'] } },
  ]),
  s('produzioni_locali', 'Cantine, frantoi e produzioni locali', 'edilizia_industria', 'industria', 'parziale', [
    { tags: { craft: ['winery', 'brewery', 'distillery', 'oil_mill', 'cheese_maker', 'confectionery'] } },
    { tags: { shop: 'farm' } },
  ]),

  // ---- salute, benessere e cura della persona ----
  s('farmacie', 'Farmacie', 'salute_benessere', 'farmacie', 'buona', [
    { tags: { amenity: 'pharmacy' }, not: { dispensing: 'no' } },
    { tags: { healthcare: 'pharmacy' }, not: { dispensing: 'no', amenity: 'pharmacy' } },
  ]),
  s('parafarmacie', 'Parafarmacie', 'salute_benessere', 'parafarmacie', 'parziale', [
    { tags: { amenity: 'pharmacy', dispensing: 'no' } },
    { tags: { shop: 'chemist' }, nameContains: 'parafarm' },
  ]),
  s('dentisti', 'Studi dentistici', 'salute_benessere', 'studi_sanitari', 'parziale', [
    { tags: { amenity: 'dentist' } },
    { tags: { healthcare: 'dentist' } },
  ]),
  s('fisioterapia', 'Fisioterapia e riabilitazione', 'salute_benessere', 'studi_sanitari', 'parziale', [
    { tags: { healthcare: ['physiotherapist', 'rehabilitation', 'psychotherapist', 'podiatrist'] } },
  ]),
  s(
    'cliniche',
    'Cliniche private, poliambulatori e laboratori',
    'salute_benessere',
    'studi_sanitari',
    'parziale',
    [
      { tags: { amenity: ['clinic', 'doctors'] } },
      { tags: { healthcare: ['clinic', 'doctor', 'laboratory', 'centre'] } },
    ],
    'Gli studi all’interno di condomini sono spesso assenti.',
  ),
  s('veterinari', 'Veterinari', 'salute_benessere', 'studi_sanitari', 'buona', [{ tags: { amenity: 'veterinary' } }]),
  s('palestre', 'Palestre e centri fitness', 'salute_benessere', 'palestre_benessere', 'buona', [
    { tags: { leisure: ['fitness_centre', 'sports_centre'] } },
  ]),
  s('centri_benessere', 'Centri benessere e spa', 'salute_benessere', 'palestre_benessere', 'parziale', [
    { tags: { leisure: ['sauna', 'spa'] } },
    { tags: { amenity: 'spa' } },
  ]),
  s('estetica', 'Centri estetici e massaggi', 'salute_benessere', 'palestre_benessere', 'buona', [
    { tags: { shop: ['beauty', 'massage', 'tattoo', 'nails'] } },
  ]),
  s('parrucchieri', 'Parrucchieri e barbieri', 'salute_benessere', 'artigiani_servizi', 'buona', [
    { tags: { shop: ['hairdresser', 'barber'] } },
  ]),

  // ---- formazione e altri servizi ----
  s('scuole_formazione', 'Scuole private e centri di formazione', 'servizi', 'aziende_uffici', 'limitata', [
    { tags: { amenity: ['training', 'prep_school', 'music_school', 'dancing_school'] } },
    { tags: { office: 'educational_institution' } },
  ]),
  s('scuole_lingue', 'Scuole di lingue', 'servizi', 'aziende_uffici', 'limitata', [
    { tags: { amenity: 'language_school' } },
  ]),
  s('autoscuole', 'Autoscuole', 'servizi', 'artigiani_servizi', 'buona', [{ tags: { amenity: 'driving_school' } }]),
  s('foto_eventi', 'Fotografi e servizi per eventi', 'servizi', 'artigiani_servizi', 'limitata', [
    { tags: { craft: ['photographer', 'photographic_laboratory'] } },
    { tags: { shop: ['photo', 'camera', 'party'] } },
  ]),
  s('automotive', 'Officine, concessionari e servizi auto', 'servizi', 'artigiani_servizi', 'buona', [
    { tags: { shop: ['car_repair', 'car', 'car_parts', 'tyres', 'motorcycle', 'motorcycle_repair'] } },
    { tags: { amenity: 'car_wash' } },
  ]),
  s('pulizie_manutenzione', 'Pulizie, lavanderie e manutenzione', 'servizi', 'artigiani_servizi', 'parziale', [
    { tags: { shop: ['dry_cleaning', 'laundry'] } },
    { tags: { craft: ['cleaning', 'gardener', 'chimney_sweeper'] } },
  ]),
];

const selectorSchema: z.ZodType<OsmSelector> = z
  .object({
    tags: z.record(
      z.string().min(1),
      z.union([
        z.string().min(1),
        z.array(z.string().min(1)).min(1),
        z.literal(true),
        z.object({ contains: z.string().min(1) }).strict(),
      ]),
    ),
    not: z.record(z.string(), z.string()).optional(),
    nameContains: z.string().min(1).optional(),
  })
  .strict()
  .refine((sel) => Object.keys(sel.tags).length > 0, 'Un selettore deve indicare almeno un tag.');

const sectorSchema = z
  .object({
    id: z.string().regex(/^[a-z][a-z_]{1,40}$/),
    label: z.string().min(2).max(80),
    group: z.enum(Object.keys(SECTOR_GROUPS) as [SectorGroup, ...SectorGroup[]]),
    category: z.enum(CATEGORY_IDS),
    selectors: z.array(selectorSchema).min(1),
    coverage: z.enum(['buona', 'parziale', 'limitata']),
    note: z.string().max(200).optional(),
  })
  .strict();

/** Validazione del catalogo (all'avvio e nei test): un errore qui ferma il server con un messaggio chiaro. */
export function validateSectors(list: unknown): Sector[] {
  const parsed = z.array(sectorSchema).min(1).parse(list) as Sector[];
  const ids = new Set<string>();
  for (const sec of parsed) {
    if (ids.has(sec.id)) throw new Error(`Settore ripetuto nel catalogo: ${sec.id}`);
    ids.add(sec.id);
  }
  return parsed;
}

export const SECTORS: Sector[] = validateSectors(RAW_SECTORS);
export const SECTOR_IDS = SECTORS.map((x) => x.id);
const BY_ID = new Map(SECTORS.map((x) => [x.id, x]));

export const sectorById = (id: string) => BY_ID.get(id);
export const isSectorId = (id: string) => BY_ID.has(id);
/** Settori richiesti nell'ordine del catalogo (quello che decide la classificazione). */
export const sectorsInOrder = (ids: readonly string[]) => SECTORS.filter((x) => ids.includes(x.id));
