/*
 * DATI DI TEST — risposte Overpass costruite a mano per i test automatici e per il server Overpass finto dei test
 * end-to-end. Nomi e indirizzi sono inventati ("di Prova") e gli identificativi OSM sono fuori dagli intervalli
 * reali (9_000_000_000+): non vanno mai mostrati come risultati reali e non vengono usati fuori dai test.
 */

export const FIXTURE_ID_BASE = 9_000_000_000;

export interface FixtureElement {
  type: 'area' | 'node' | 'way' | 'relation';
  id: number;
  lat?: number;
  lon?: number;
  center?: { lat: number; lon: number };
  tags?: Record<string, string>;
}

const area = (code: string, name: string): FixtureElement => ({
  type: 'area',
  id: 3_600_000_000 + Number(code),
  tags: { boundary: 'administrative', admin_level: '8', 'ref:ISTAT': code, name },
});

/** Due comuni della provincia di Roma con alcune attività di prova. */
export function romaFixture(): { elements: FixtureElement[] } {
  return {
    elements: [
      area('058091', 'Roma'),
      {
        type: 'node',
        id: FIXTURE_ID_BASE + 1,
        lat: 41.9,
        lon: 12.5,
        tags: {
          amenity: 'pharmacy',
          dispensing: 'yes',
          name: 'Farmacia di Prova Centrale',
          website: 'www.farmaciadiprova.example.it/',
          phone: '+39 06 5551234',
          'addr:street': 'Via di Prova',
          'addr:housenumber': '1',
          'addr:postcode': '00100',
          'addr:city': 'Roma',
          opening_hours: 'Mo-Sa 08:30-19:30',
        },
      },
      {
        type: 'node',
        id: FIXTURE_ID_BASE + 2,
        lat: 41.901,
        lon: 12.501,
        tags: { amenity: 'pharmacy', dispensing: 'no', name: 'Parafarmacia di Prova', email: 'privato@example.it' },
      },
      {
        type: 'way',
        id: FIXTURE_ID_BASE + 3,
        center: { lat: 41.905, lon: 12.49 },
        tags: {
          amenity: 'restaurant',
          name: 'Trattoria di Prova',
          website: 'https://www.facebook.com/trattoriadiprova',
        },
      },
      // senza nome: non è un'attività contattabile
      { type: 'node', id: FIXTURE_ID_BASE + 4, lat: 41.9, lon: 12.5, tags: { amenity: 'pharmacy' } },
      area('058003', 'Albano Laziale'),
      {
        type: 'node',
        id: FIXTURE_ID_BASE + 5,
        lat: 41.73,
        lon: 12.66,
        tags: {
          amenity: 'pharmacy',
          name: 'Farmacia di Prova dei Castelli',
          'contact:website': 'https://farmaciacastelli.example.it',
        },
      },
    ],
  };
}
