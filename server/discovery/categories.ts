/*
 * Categorie interne di attività, indipendenti dal fornitore di dati.
 * Ogni fornitore dichiara come le riconosce (per OpenStreetMap: server/discovery/osm/tags.ts) e quanto le copre.
 * L'ordine conta: quando un elemento corrisponde a più categorie richieste, vince la prima (es. una parafarmacia
 * etichettata come negozio resta "Parafarmacie").
 */

export const CATEGORY_IDS = [
  'farmacie',
  'parafarmacie',
  'hotel',
  'extralberghiero',
  'ristorazione',
  'studi_sanitari',
  'studi_professionali',
  'palestre_benessere',
  'artigiani_servizi',
  'industria',
  'aziende_uffici',
  'negozi',
] as const;

export type CategoryId = (typeof CATEGORY_IDS)[number];

export interface Category {
  id: CategoryId;
  label: string;
  description: string;
}

export const CATEGORIES: Record<CategoryId, Category> = {
  farmacie: { id: 'farmacie', label: 'Farmacie', description: 'Farmacie con dispensazione di farmaci.' },
  parafarmacie: {
    id: 'parafarmacie',
    label: 'Parafarmacie',
    description: 'Parafarmacie e punti vendita di prodotti farmaceutici senza dispensazione.',
  },
  hotel: { id: 'hotel', label: 'Hotel', description: 'Alberghi, motel e ostelli.' },
  extralberghiero: {
    id: 'extralberghiero',
    label: 'B&B e strutture extralberghiere',
    description: 'Bed and breakfast, affittacamere, case vacanza, chalet.',
  },
  ristorazione: {
    id: 'ristorazione',
    label: 'Ristoranti e bar',
    description: 'Ristoranti, pizzerie, bar, caffetterie, gelaterie, pub, fast food.',
  },
  studi_sanitari: {
    id: 'studi_sanitari',
    label: 'Studi medici e sanitari',
    description: 'Studi medici e dentistici, cliniche, fisioterapisti, laboratori, veterinari.',
  },
  studi_professionali: {
    id: 'studi_professionali',
    label: 'Studi professionali',
    description:
      'Avvocati, notai, commercialisti, architetti, ingegneri, consulenti, assicurazioni, agenzie immobiliari.',
  },
  palestre_benessere: {
    id: 'palestre_benessere',
    label: 'Palestre e benessere',
    description: 'Palestre, centri fitness e sportivi, centri estetici, massaggi, saune.',
  },
  artigiani_servizi: {
    id: 'artigiani_servizi',
    label: 'Artigiani e servizi locali',
    description: 'Artigiani, parrucchieri, officine, lavanderie, autolavaggi, autoscuole.',
  },
  industria: {
    id: 'industria',
    label: 'Industria e produzione',
    description: 'Stabilimenti produttivi e impianti industriali con un nome.',
  },
  aziende_uffici: {
    id: 'aziende_uffici',
    label: 'Aziende e uffici',
    description: 'Sedi di aziende, società informatiche e di telecomunicazioni, agenzie di comunicazione e di viaggio.',
  },
  negozi: { id: 'negozi', label: 'Negozi', description: 'Commercio al dettaglio di ogni tipo.' },
};

export const isCategoryId = (v: string): v is CategoryId => (CATEGORY_IDS as readonly string[]).includes(v);

/** Categorie richieste nell'ordine di priorità del catalogo (non in quello scelto dall'utente). */
export const inPriorityOrder = (ids: readonly CategoryId[]): CategoryId[] =>
  CATEGORY_IDS.filter((id) => ids.includes(id));
