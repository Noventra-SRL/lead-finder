import { SECTORS, sectorById } from '../discovery/sectors.ts';

/*
 * Categorie commerciali di «Trova aziende»: un insieme controllato di identificativi canonici, con le etichette
 * italiane mostrate nell'interfaccia. Ogni azienda ha una sola categoria principale (businesses.primary_category,
 * calcolata da server/categories/classify.ts); il settore del Lead Hunter e la categoria interna della scoperta
 * restano come dati di origine.
 *
 * `sectors`: i settori del catalogo del Lead Hunter (server/discovery/sectors.ts) usati per CERCARE nuove aziende di
 * questa categoria con la pipeline di scoperta esistente. Una ricerca può trovare anche attività vicine (es. un ostello
 * cercando case vacanza): la categoria di ogni azienda trovata la decide sempre il classificatore, non la ricerca.
 */

export const BUSINESS_CATEGORY_IDS = [
  'farmacie',
  'parafarmacie',
  'bnb_case_vacanza',
  'hotel_ricettive',
  'ristoranti',
  'bar_caffetterie',
  'pizzerie',
  'parrucchieri_barbieri',
  'centri_estetici',
  'palestre_fitness',
  'studi_medici',
  'studi_professionali',
  'negozi',
  'agenzie_immobiliari',
  'officine',
  'altre_attivita',
] as const;
export type BusinessCategoryId = (typeof BUSINESS_CATEGORY_IDS)[number];

export interface BusinessCategory {
  id: BusinessCategoryId;
  label: string;
  /** Stato vuoto dell'elenco filtrato, es. «Nessuna farmacia trovata con questi filtri». */
  empty: string;
  /** Testo del pulsante di ricerca, es. «Cerca nuove farmacie». */
  discover: string;
  /** Settori del Lead Hunter con cui cercare nuove aziende di questa categoria. */
  sectors: string[];
  /** Cosa comprende (suggerimento nell'interfaccia). */
  description: string;
}

const c = (
  id: BusinessCategoryId,
  label: string,
  empty: string,
  discover: string,
  sectors: string[],
  description: string,
): BusinessCategory => ({ id, label, empty, discover, sectors, description });

const LIST: BusinessCategory[] = [
  c(
    'farmacie',
    'Farmacie',
    'Nessuna farmacia trovata con questi filtri',
    'Cerca nuove farmacie',
    ['farmacie'],
    'Farmacie con dispensazione di farmaci (le parafarmacie hanno una categoria propria).',
  ),
  c(
    'parafarmacie',
    'Parafarmacie',
    'Nessuna parafarmacia trovata con questi filtri',
    'Cerca nuove parafarmacie',
    ['parafarmacie'],
    'Parafarmacie: senza dispensazione di farmaci con ricetta.',
  ),
  c(
    'bnb_case_vacanza',
    'B&B e case vacanza',
    'Nessun B&B o casa vacanza trovato con questi filtri',
    'Cerca nuovi B&B e case vacanza',
    ['bed_and_breakfast', 'case_vacanza'],
    'Bed and breakfast, affittacamere, appartamenti e case vacanza, chalet.',
  ),
  c(
    'hotel_ricettive',
    'Hotel e strutture ricettive',
    'Nessun hotel o struttura ricettiva trovato con questi filtri',
    'Cerca nuovi hotel e strutture ricettive',
    ['hotel', 'agriturismi', 'case_vacanza'],
    'Hotel e motel, agriturismi, ostelli, campeggi.',
  ),
  c(
    'ristoranti',
    'Ristoranti',
    'Nessun ristorante trovato con questi filtri',
    'Cerca nuovi ristoranti',
    ['ristoranti'],
    'Ristoranti, trattorie, osterie e fast food (le pizzerie hanno la loro categoria).',
  ),
  c(
    'bar_caffetterie',
    'Bar e caffetterie',
    'Nessun bar o caffetteria trovato con questi filtri',
    'Cerca nuovi bar e caffetterie',
    ['bar_caffe'],
    'Bar, caffetterie, pub, gelaterie.',
  ),
  c(
    'pizzerie',
    'Pizzerie',
    'Nessuna pizzeria trovata con questi filtri',
    'Cerca nuove pizzerie',
    ['pizzerie'],
    'Locali indicati dalla fonte come pizzeria (cucina o nome).',
  ),
  c(
    'parrucchieri_barbieri',
    'Parrucchieri e barbieri',
    'Nessun parrucchiere o barbiere trovato con questi filtri',
    'Cerca nuovi parrucchieri e barbieri',
    ['parrucchieri'],
    'Parrucchieri e barbieri.',
  ),
  c(
    'centri_estetici',
    'Centri estetici',
    'Nessun centro estetico trovato con questi filtri',
    'Cerca nuovi centri estetici',
    ['estetica', 'centri_benessere'],
    'Centri estetici, unghie, massaggi, centri benessere e spa.',
  ),
  c(
    'palestre_fitness',
    'Palestre e centri fitness',
    'Nessuna palestra o centro fitness trovato con questi filtri',
    'Cerca nuove palestre e centri fitness',
    ['palestre'],
    'Palestre, centri fitness e centri sportivi.',
  ),
  c(
    'studi_medici',
    'Studi medici e dentistici',
    'Nessuno studio medico o dentistico trovato con questi filtri',
    'Cerca nuovi studi medici e dentistici',
    ['dentisti', 'cliniche', 'fisioterapia', 'veterinari'],
    'Studi dentistici e medici, poliambulatori, cliniche, fisioterapisti, laboratori, veterinari.',
  ),
  c(
    'studi_professionali',
    'Studi professionali',
    'Nessuno studio professionale trovato con questi filtri',
    'Cerca nuovi studi professionali',
    ['commercialisti', 'avvocati', 'architetti', 'ingegneri', 'consulenti'],
    'Commercialisti, avvocati e notai, architetti, ingegneri e geometri, consulenti e assicurazioni.',
  ),
  c(
    'negozi',
    'Negozi e attività commerciali',
    'Nessun negozio trovato con questi filtri',
    'Cerca nuovi negozi',
    [
      'abbigliamento',
      'arredamento',
      'elettronica',
      'gioiellerie',
      'negozi_specializzati',
      'panifici_pasticcerie',
      'negozi',
    ],
    'Commercio al dettaglio: abbigliamento, arredamento, alimentari, concessionari e ogni altro negozio.',
  ),
  c(
    'agenzie_immobiliari',
    'Agenzie immobiliari',
    'Nessuna agenzia immobiliare trovata con questi filtri',
    'Cerca nuove agenzie immobiliari',
    ['agenzie_immobiliari'],
    'Agenzie immobiliari.',
  ),
  c(
    'officine',
    'Officine e autofficine',
    'Nessuna officina trovata con questi filtri',
    'Cerca nuove officine',
    ['automotive'],
    'Autofficine, gommisti, officine per moto (la ricerca trova anche concessionari, classificati tra i negozi).',
  ),
  c(
    'altre_attivita',
    'Altre attività',
    'Nessuna altra attività trovata con questi filtri',
    'Cerca altre attività',
    [
      'agenzie_viaggio',
      'location_eventi',
      'catering',
      'servizi_imprese',
      'imprese_edili',
      'impiantisti',
      'produttori',
      'ingrosso',
      'produzioni_locali',
      'scuole_formazione',
      'scuole_lingue',
      'autoscuole',
      'foto_eventi',
      'pulizie_manutenzione',
    ],
    'Attività che non rientrano nelle categorie precedenti, e quelle con prove insufficienti (da verificare).',
  ),
];

/** Controllo del catalogo all'avvio: categorie e settori esistenti, ogni settore cercabile da almeno una categoria. */
export function validateCatalog(list: BusinessCategory[]): BusinessCategory[] {
  const ids = list.map((x) => x.id);
  if (ids.length !== BUSINESS_CATEGORY_IDS.length || BUSINESS_CATEGORY_IDS.some((id) => !ids.includes(id)))
    throw new Error('Il catalogo delle categorie non corrisponde agli identificativi canonici');
  for (const cat of list) {
    if (!cat.sectors.length) throw new Error(`Categoria senza settori di ricerca: ${cat.id}`);
    for (const s of cat.sectors) if (!sectorById(s)) throw new Error(`Settore inesistente in ${cat.id}: ${s}`);
  }
  for (const s of SECTORS)
    if (!list.some((cat) => cat.sectors.includes(s.id)))
      throw new Error(`Settore non raggiungibile da nessuna categoria: ${s.id}`);
  return list;
}

export const BUSINESS_CATEGORIES = validateCatalog(LIST);
const BY_ID = new Map(BUSINESS_CATEGORIES.map((x) => [x.id, x]));

export const isBusinessCategoryId = (v: string): v is BusinessCategoryId => BY_ID.has(v as BusinessCategoryId);
export const businessCategory = (id: BusinessCategoryId) => BY_ID.get(id)!;
export const BUSINESS_CATEGORY_LABEL = Object.fromEntries(BUSINESS_CATEGORIES.map((x) => [x.id, x.label])) as Record<
  BusinessCategoryId,
  string
>;
