/** Categorie commerciali di «Trova aziende» (server/categories/catalog.ts). */
export type BusinessCategoryId =
  | 'farmacie'
  | 'parafarmacie'
  | 'bnb_case_vacanza'
  | 'hotel_ricettive'
  | 'ristoranti'
  | 'bar_caffetterie'
  | 'pizzerie'
  | 'parrucchieri_barbieri'
  | 'centri_estetici'
  | 'palestre_fitness'
  | 'studi_medici'
  | 'studi_professionali'
  | 'negozi'
  | 'agenzie_immobiliari'
  | 'officine'
  | 'altre_attivita';

/*
 * Etichette delle categorie commerciali, nello stesso ordine del catalogo del server (server/categories/catalog.ts):
 * servono dove non si caricano i conteggi (scheda dell'azienda). Un test verifica che coincidano con il server.
 */
export const BUSINESS_CATEGORY_OPTIONS: { id: BusinessCategoryId; label: string }[] = [
  { id: 'farmacie', label: 'Farmacie' },
  { id: 'parafarmacie', label: 'Parafarmacie' },
  { id: 'bnb_case_vacanza', label: 'B&B e case vacanza' },
  { id: 'hotel_ricettive', label: 'Hotel e strutture ricettive' },
  { id: 'ristoranti', label: 'Ristoranti' },
  { id: 'bar_caffetterie', label: 'Bar e caffetterie' },
  { id: 'pizzerie', label: 'Pizzerie' },
  { id: 'parrucchieri_barbieri', label: 'Parrucchieri e barbieri' },
  { id: 'centri_estetici', label: 'Centri estetici' },
  { id: 'palestre_fitness', label: 'Palestre e centri fitness' },
  { id: 'studi_medici', label: 'Studi medici e dentistici' },
  { id: 'studi_professionali', label: 'Studi professionali' },
  { id: 'negozi', label: 'Negozi e attività commerciali' },
  { id: 'agenzie_immobiliari', label: 'Agenzie immobiliari' },
  { id: 'officine', label: 'Officine e autofficine' },
  { id: 'altre_attivita', label: 'Altre attività' },
];
