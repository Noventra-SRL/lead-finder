import { SECTORS } from '../sectors.ts';

/*
 * Ricerche Google Places per ogni settore del catalogo (server/discovery/sectors.ts): testo in italiano usato in
 * «<testo> a <Comune>», e il tipo di luogo di Google Places (API New) quando è un tipo esatto e documentato, che
 * restringe i risultati. Senza tipo restano solo testo e area: i risultati sono più larghi e la categoria di ogni
 * azienda la decide comunque il classificatore dai tipi restituiti.
 * Tipi: https://developers.google.com/maps/documentation/places/web-service/place-types
 */

export interface GoogleQuery {
  text: string;
  includedType?: string;
}

export const GOOGLE_QUERIES: Record<string, GoogleQuery> = {
  agriturismi: { text: 'agriturismo', includedType: 'farmstay' },
  hotel: { text: 'hotel', includedType: 'hotel' },
  bed_and_breakfast: { text: 'bed and breakfast', includedType: 'bed_and_breakfast' },
  case_vacanza: { text: 'casa vacanze' },
  agenzie_viaggio: { text: 'agenzia viaggi', includedType: 'travel_agency' },
  location_eventi: { text: 'location per eventi e matrimoni' },
  pizzerie: { text: 'pizzeria', includedType: 'pizza_restaurant' },
  ristoranti: { text: 'ristorante', includedType: 'restaurant' },
  bar_caffe: { text: 'bar caffè', includedType: 'bar' },
  panifici_pasticcerie: { text: 'panificio pasticceria', includedType: 'bakery' },
  catering: { text: 'catering' },
  abbigliamento: { text: 'negozio di abbigliamento', includedType: 'clothing_store' },
  arredamento: { text: 'negozio di arredamento', includedType: 'furniture_store' },
  elettronica: { text: 'negozio di elettronica', includedType: 'electronics_store' },
  gioiellerie: { text: 'gioielleria', includedType: 'jewelry_store' },
  negozi_specializzati: { text: 'negozio' },
  negozi: { text: 'negozio', includedType: 'store' },
  commercialisti: { text: 'commercialista', includedType: 'accounting' },
  avvocati: { text: 'studio legale avvocato', includedType: 'lawyer' },
  architetti: { text: 'studio di architettura architetto' },
  ingegneri: { text: 'studio di ingegneria geometra' },
  consulenti: { text: 'agenzia assicurazioni consulente', includedType: 'insurance_agency' },
  agenzie_immobiliari: { text: 'agenzia immobiliare', includedType: 'real_estate_agency' },
  servizi_imprese: { text: 'servizi alle imprese' },
  imprese_edili: { text: 'impresa edile', includedType: 'general_contractor' },
  impiantisti: { text: 'elettricista idraulico', includedType: 'electrician' },
  produttori: { text: 'azienda produttrice stabilimento' },
  ingrosso: { text: 'ingrosso distributore', includedType: 'wholesaler' },
  produzioni_locali: { text: 'cantina frantoio produttore' },
  farmacie: { text: 'farmacia', includedType: 'pharmacy' },
  parafarmacie: { text: 'parafarmacia' },
  dentisti: { text: 'studio dentistico dentista', includedType: 'dentist' },
  fisioterapia: { text: 'fisioterapista', includedType: 'physiotherapist' },
  cliniche: { text: 'poliambulatorio studio medico', includedType: 'doctor' },
  veterinari: { text: 'veterinario', includedType: 'veterinary_care' },
  palestre: { text: 'palestra', includedType: 'gym' },
  centri_benessere: { text: 'centro benessere spa', includedType: 'spa' },
  estetica: { text: 'centro estetico', includedType: 'beauty_salon' },
  parrucchieri: { text: 'parrucchiere barbiere', includedType: 'hair_salon' },
  scuole_formazione: { text: 'scuola privata centro di formazione' },
  scuole_lingue: { text: 'scuola di lingue' },
  autoscuole: { text: 'autoscuola' },
  foto_eventi: { text: 'fotografo' },
  automotive: { text: 'autofficina meccanico', includedType: 'car_repair' },
  pulizie_manutenzione: { text: 'impresa di pulizie lavanderia' },
};

/** Ogni settore del catalogo ha la sua ricerca (controllato all'avvio e nei test). */
for (const s of SECTORS) if (!GOOGLE_QUERIES[s.id]) throw new Error(`Settore senza ricerca Google Places: ${s.id}`);
