import { CATEGORIES as INTERNAL, type CategoryId } from '../discovery/categories.ts';
import { sectorById } from '../discovery/sectors.ts';
import { fold } from '../geo/geo.ts';
import type { BusinessCategoryId } from './catalog.ts';

/*
 * Classificazione di un'azienda in una categoria commerciale, solo da dati presenti: i tag originali della fonte
 * (OpenStreetMap: amenity, tourism, shop, office, healthcare, leisure, craft, cuisine…), il nome come scritto dalla
 * fonte, il settore e la categoria interna con cui la scoperta l'ha salvata. Nessuna chiamata esterna, nessun dato
 * inventato: la stessa azienda dà sempre la stessa categoria, con la prova che l'ha decisa.
 *
 * Ordine delle prove:
 *  1. tag della fonte (prova diretta del tipo di attività) → «classificata»;
 *  2. settore del Lead Hunter, se porta a una sola categoria → «classificata»;
 *  3. categoria interna della scoperta, se porta a una sola categoria → «classificata»;
 *  4. parole del nome (es. «Pizzeria», «B&B») → categoria proposta ma «da_verificare»;
 *  5. nulla di affidabile → «Altre attività», «da_verificare».
 *
 * Le strutture ricettive non sono tutte B&B: hotel e motel, ostelli, campeggi e agriturismi vanno in «Hotel e
 * strutture ricettive»; guest house, affittacamere, appartamenti e chalet in «B&B e case vacanza». Un hotel mappato
 * come tale ma con «B&B» nel nome è un B&B (il nome lo dichiara).
 * Cambiando le regole va aumentata CLASSIFIER_VERSION: le aziende classificate in automatico vengono ricalcolate.
 */

// 5: parafarmacie in una categoria propria (prima tra i negozi)
export const CLASSIFIER_VERSION = 5;

export type CategoryStatus = 'classificata' | 'da_verificare';

export interface ClassifyInput {
  name: string;
  /** Tag della fonte principale per prima, poi delle altre fonti (unite: la principale prevale). */
  tags: Record<string, string> | null;
  sector: string | null;
  category: string | null;
}

export interface Classification {
  category: BusinessCategoryId;
  status: CategoryStatus;
  evidence: string;
}

// sul nome normalizzato da fold(): «B&B» diventa «b b», «Bed & Breakfast» diventa «bed breakfast»
const BNB_NAME = /\b(b b|b and b|bnb|bed (and )?breakfast|affittacamere|cas[ae] vacanz[ae])\b/;
const AGRI_NAME = /\bagriturism/;
const PIZZA_NAME = /\bpizzeri[ae]\b/;

const OFFICE_PRO = new Set([
  'lawyer',
  'notary',
  'accountant',
  'tax_advisor',
  'architect',
  'engineer',
  'surveyor',
  'consulting',
  'financial_advisor',
  'insurance',
  'financial',
]);
const FOOD = new Set(['restaurant', 'fast_food', 'food_court']);
const DRINK = new Set(['cafe', 'bar', 'pub', 'ice_cream', 'biergarten']);
const MEDICAL_AMENITY = new Set(['dentist', 'doctors', 'clinic', 'veterinary', 'hospital']);
const RICETTIVE = new Set(['hotel', 'motel', 'hostel', 'camp_site', 'caravan_site', 'alpine_hut', 'wilderness_hut']);
const CASE_VACANZA = new Set(['apartment', 'chalet']);
const CAR_SERVICE = new Set(['car_repair', 'tyres', 'motorcycle_repair']);
const BEAUTY = new Set(['beauty', 'nails', 'massage']);
/** Negozi che non vendono al pubblico come un negozio: agenzie (viaggi) e locali vuoti. */
const SHOP_NOT_RETAIL = new Set(['vacant', 'travel_agency', 'estate_agent', 'hairdresser', 'barber']);

const ok = (category: BusinessCategoryId, evidence: string): Classification => ({
  category,
  status: 'classificata',
  evidence,
});
const tag = (k: string, v: string) => `OpenStreetMap: ${k}=${v}`;

/** Regola 1: tag della fonte. null se nessun tag riconosce il tipo di attività. */
export function fromTags(t: Record<string, string>, name: string): Classification | null {
  const n = fold(name);
  const amenity = t.amenity;
  const healthcare = t.healthcare;
  const tourism = t.tourism;
  const shop = t.shop;
  const office = t.office;
  const leisure = t.leisure;

  // farmacie (non le parafarmacie: senza dispensazione o dichiarate dal nome)
  if (amenity === 'pharmacy' || healthcare === 'pharmacy') {
    const k = amenity === 'pharmacy' ? 'amenity' : 'healthcare';
    if (n.includes('parafarm'))
      return ok('parafarmacie', `${tag(k, 'pharmacy')}, parafarmacia (senza dispensazione di farmaci)`);
    if (t.dispensing === 'no') {
      // la fonte dice «senza dispensazione» ma il nome dice «Farmacia»: prove in contrasto, decide una persona
      if (/\bfarmacia\b/.test(n))
        return {
          category: 'parafarmacie',
          status: 'da_verificare',
          evidence: `${tag(k, 'pharmacy')}, dispensing=no, ma il nome indica una farmacia`,
        };
      return ok('parafarmacie', `${tag(k, 'pharmacy')}, parafarmacia (senza dispensazione di farmaci)`);
    }
    return ok('farmacie', tag(k, 'pharmacy'));
  }

  // strutture ricettive: B&B e case vacanza distinti da hotel, ostelli, campeggi, agriturismi
  if (tourism) {
    if (AGRI_NAME.test(n) || t.guest_house === 'agritourism' || t.guest_house === 'farm' || tourism === 'agritourism')
      return ok('hotel_ricettive', `${tag('tourism', tourism)}, agriturismo`);
    if (tourism === 'guest_house') return ok('bnb_case_vacanza', tag('tourism', 'guest_house'));
    if (CASE_VACANZA.has(tourism)) return ok('bnb_case_vacanza', tag('tourism', tourism));
    if (RICETTIVE.has(tourism)) {
      // «B&B Hotels» è una catena alberghiera, non un bed and breakfast
      const chain = /\bb b hotels?\b/.test(n) || /^b\s*&\s*b hotels?$/i.test(t.brand ?? '');
      if ((tourism === 'hotel' || tourism === 'motel') && BNB_NAME.test(n) && !chain)
        return ok('bnb_case_vacanza', `${tag('tourism', tourism)}, ma il nome indica un B&B o un affittacamere`);
      return ok('hotel_ricettive', tag('tourism', tourism));
    }
  }

  // ristorazione: pizzerie (cucina o nome), ristoranti, bar e caffetterie
  if (amenity && FOOD.has(amenity)) {
    if (t.cuisine && /pizza/i.test(t.cuisine))
      return ok('pizzerie', `${tag('amenity', amenity)}, ${tag('cuisine', t.cuisine).replace('OpenStreetMap: ', '')}`);
    if (PIZZA_NAME.test(n)) return ok('pizzerie', `${tag('amenity', amenity)}, «pizzeria» nel nome`);
    return ok('ristoranti', tag('amenity', amenity));
  }
  if (amenity && DRINK.has(amenity)) return ok('bar_caffetterie', tag('amenity', amenity));

  // cura della persona e benessere
  if (shop === 'hairdresser' || shop === 'barber') return ok('parrucchieri_barbieri', tag('shop', shop));
  if (shop && BEAUTY.has(shop)) return ok('centri_estetici', tag('shop', shop));
  if (leisure === 'spa' || leisure === 'sauna' || amenity === 'spa')
    return ok('centri_estetici', leisure ? tag('leisure', leisure) : tag('amenity', 'spa'));
  if (leisure === 'fitness_centre' || leisure === 'sports_centre')
    return ok('palestre_fitness', tag('leisure', leisure));

  // salute (le farmacie sono già escluse)
  if (amenity && MEDICAL_AMENITY.has(amenity)) return ok('studi_medici', tag('amenity', amenity));
  if (healthcare) return ok('studi_medici', tag('healthcare', healthcare));

  // professionisti
  if (office === 'estate_agent' || shop === 'estate_agent')
    return ok('agenzie_immobiliari', tag(office === 'estate_agent' ? 'office' : 'shop', 'estate_agent'));
  if (office && OFFICE_PRO.has(office)) return ok('studi_professionali', tag('office', office));

  // officine (i concessionari e i ricambi sono negozi)
  if (shop && CAR_SERVICE.has(shop)) return ok('officine', tag('shop', shop));
  if (t.craft === 'car_repair') return ok('officine', tag('craft', 'car_repair'));

  // commercio al dettaglio
  if (shop && !SHOP_NOT_RETAIL.has(shop)) return ok('negozi', tag('shop', shop));

  // tipo di attività riconosciuto ma fuori dalle categorie principali (uffici, artigiani, agenzie di viaggio, scuole…)
  for (const k of ['office', 'craft', 'amenity', 'shop', 'tourism', 'leisure', 'man_made', 'industrial'] as const)
    if (t[k] && t[k] !== 'vacant' && t[k] !== 'yes') return ok('altre_attivita', tag(k, t[k]));
  return null;
}

/** Categoria commerciale di ogni settore: quella che ne raccoglie le aziende (null se il settore è misto). */
const SECTOR_CATEGORY: Record<string, BusinessCategoryId | null> = {
  agriturismi: 'hotel_ricettive',
  hotel: 'hotel_ricettive',
  bed_and_breakfast: 'bnb_case_vacanza',
  case_vacanza: null, // ostelli e campeggi (ricettive) insieme ad appartamenti e chalet (case vacanza)
  pizzerie: 'pizzerie',
  ristoranti: 'ristoranti',
  bar_caffe: 'bar_caffetterie',
  farmacie: 'farmacie',
  parafarmacie: 'parafarmacie',
  dentisti: 'studi_medici',
  fisioterapia: 'studi_medici',
  cliniche: 'studi_medici',
  veterinari: 'studi_medici',
  palestre: 'palestre_fitness',
  centri_benessere: 'centri_estetici',
  estetica: 'centri_estetici',
  parrucchieri: 'parrucchieri_barbieri',
  commercialisti: 'studi_professionali',
  avvocati: 'studi_professionali',
  architetti: 'studi_professionali',
  ingegneri: 'studi_professionali',
  consulenti: 'studi_professionali',
  agenzie_immobiliari: 'agenzie_immobiliari',
  automotive: null, // officine e concessionari insieme
  abbigliamento: 'negozi',
  arredamento: 'negozi',
  elettronica: 'negozi',
  gioiellerie: 'negozi',
  negozi_specializzati: 'negozi',
  panifici_pasticcerie: 'negozi',
  negozi: 'negozi',
};

/** Categoria interna della scoperta che porta a una sola categoria commerciale (le altre sono miste). */
const INTERNAL_CATEGORY: Partial<Record<CategoryId, BusinessCategoryId>> = {
  farmacie: 'farmacie',
  parafarmacie: 'parafarmacie',
  hotel: 'hotel_ricettive',
  studi_sanitari: 'studi_medici',
  negozi: 'negozi',
  industria: 'altre_attivita',
  aziende_uffici: 'altre_attivita',
};

/** Parole del nome: indizio, non prova (la categoria resta da verificare). */
const NAME_HINTS: [RegExp, BusinessCategoryId][] = [
  [/\bparafarmaci/, 'parafarmacie'],
  [/\bfarmacia\b/, 'farmacie'],
  [PIZZA_NAME, 'pizzerie'],
  [BNB_NAME, 'bnb_case_vacanza'],
  [AGRI_NAME, 'hotel_ricettive'],
  [/\b(hotel|albergo|ostello|residence|campeggio|camping|motel)\b/, 'hotel_ricettive'],
  [/\b(ristorante|trattoria|osteria|taverna|sushi|braceria|steakhouse)\b/, 'ristoranti'],
  [/\b(bar|caffe|caffetteria|pasticceria bar|pub|gelateria|enoteca)\b/, 'bar_caffetterie'],
  [/\b(parrucchier[ei]|barbier[ei]|barber|hair)\b/, 'parrucchieri_barbieri'],
  [/\b(estetica|estetico|beauty|nails|spa)\b/, 'centri_estetici'],
  [/\b(palestra|fitness|gym|crossfit)\b/, 'palestre_fitness'],
  [
    /\b(studio dentistico|dentist[ai]|odontoiatric[oa]|poliambulatorio|studio medico|fisioterapi[ac]|veterinari[oa])\b/,
    'studi_medici',
  ],
  [/\b(immobiliare|immobiliari)\b/, 'agenzie_immobiliari'],
  [
    /\b(studio legale|avvocat[oi]|notai?o|commercialist[ai]|architett[oi]|ingegneri[ao]|geometra)\b/,
    'studi_professionali',
  ],
  [/\b(autofficina|officina|gommista|carrozzeria|elettrauto)\b/, 'officine'],
];

/** Tipi di luogo di Google Places → categoria (il primo tipo riconosciuto vince; il tipo principale per primo). */
const GOOGLE_TYPES: [RegExp, BusinessCategoryId][] = [
  [/^pharmacy$/, 'farmacie'],
  [/^(bed_and_breakfast|guest_house|cottage|private_guest_room)$/, 'bnb_case_vacanza'],
  [
    /^(hotel|motel|hostel|resort_hotel|inn|campground|camping_cabin|rv_park|farmstay|extended_stay_hotel|budget_japanese_inn|japanese_inn|lodging)$/,
    'hotel_ricettive',
  ],
  [/^pizza_restaurant$/, 'pizzerie'],
  [
    /^(bar|pub|wine_bar|cafe|coffee_shop|ice_cream_shop|cafeteria|tea_house|juice_shop|dessert_shop|bar_and_grill)$/,
    'bar_caffetterie',
  ],
  [/(^restaurant$|_restaurant$|^meal_takeaway$|^fast_food)/, 'ristoranti'],
  [/^(hair_salon|barber_shop|hair_care)$/, 'parrucchieri_barbieri'],
  [/^(beauty_salon|nail_salon|spa|massage|skin_care_clinic|beautician|wellness_center|sauna)$/, 'centri_estetici'],
  [/^(gym|fitness_center|sports_club|yoga_studio|pilates_studio)$/, 'palestre_fitness'],
  [
    /^(dentist|dental_clinic|doctor|physiotherapist|medical_lab|veterinary_care|hospital|chiropractor|medical_clinic)$/,
    'studi_medici',
  ],
  [/^real_estate_agency$/, 'agenzie_immobiliari'],
  [/^(lawyer|accounting|insurance_agency|consultant)$/, 'studi_professionali'],
  [/^(car_repair|auto_parts_store_repair)$/, 'officine'],
  [
    /(_store$|^store$|^supermarket$|^bakery$|^car_dealer$|^shopping_mall$|^market$|^grocery_store$|^butcher_shop$|^florist$|^drugstore$)/,
    'negozi',
  ],
];

/** Regola 1 bis: tipi di Google Places (aziende trovate con Google). null se nessun tipo è riconosciuto. */
export function fromGoogleTypes(t: Record<string, string>, name: string): Classification | null {
  const types = [t.google_primary_type, ...(t.google_types ?? '').split(';')].filter((x): x is string => Boolean(x));
  if (!types.length) return null;
  const n = fold(name);
  for (const type of types)
    for (const [re, category] of GOOGLE_TYPES)
      if (re.test(type)) {
        // stesse distinzioni dei tag OSM: pizzeria dal nome, parafarmacia, B&B nel nome di un hotel
        if (category === 'ristoranti' && PIZZA_NAME.test(n))
          return ok('pizzerie', `Google Maps: tipo ${type}, «pizzeria» nel nome`);
        if (category === 'farmacie' && n.includes('parafarm'))
          return ok('parafarmacie', `Google Maps: tipo ${type}, parafarmacia`);
        if (category === 'hotel_ricettive' && BNB_NAME.test(n) && !/\bb b hotels?\b/.test(n))
          return ok('bnb_case_vacanza', `Google Maps: tipo ${type}, ma il nome indica un B&B o un affittacamere`);
        return ok(category, `Google Maps: tipo ${type}`);
      }
  // tipo indicato ma fuori dalle categorie principali (es. agenzia di viaggi, scuola)
  const generic = types.find((x) => !['point_of_interest', 'establishment', 'store'].includes(x));
  return generic ? ok('altre_attivita', `Google Maps: tipo ${generic}`) : null;
}

export function classifyBusiness(input: ClassifyInput): Classification {
  if (input.tags) {
    const byTags = fromTags(input.tags, input.name) ?? fromGoogleTypes(input.tags, input.name);
    if (byTags) return byTags;
  }
  const bySector = input.sector ? SECTOR_CATEGORY[input.sector] : undefined;
  if (bySector) return ok(bySector, `Settore della ricerca: ${sectorById(input.sector!)?.label ?? input.sector}`);
  const byCategory = input.category ? INTERNAL_CATEGORY[input.category as CategoryId] : undefined;
  if (byCategory)
    return ok(
      byCategory,
      `Categoria della scoperta: ${INTERNAL[input.category as CategoryId]?.label ?? input.category}`,
    );
  const n = fold(input.name);
  for (const [re, category] of NAME_HINTS)
    if (re.test(n)) return { category, status: 'da_verificare', evidence: 'Solo il nome dell’attività' };
  return {
    category: 'altre_attivita',
    status: 'da_verificare',
    evidence: 'Tipo di attività non indicato dalla fonte',
  };
}
