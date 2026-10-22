import { describe, expect, it } from 'vitest';
import { fold, geo } from './geo.ts';

describe('geografia ISTAT', () => {
  const g = geo();

  it('contiene tutte le regioni, le unità sovracomunali e i comuni con codici coerenti', () => {
    expect(g.regions).toHaveLength(20);
    expect(g.provinces.length).toBeGreaterThanOrEqual(105);
    expect(g.municipalities.length).toBeGreaterThan(7800);
    for (const m of g.municipalities) {
      expect(m.code).toMatch(/^\d{6}$/);
      expect(g.province(m.provinceCode), m.code).not.toBeNull();
    }
    for (const p of g.provinces) expect(g.region(p.regionCode), p.code).not.toBeNull();
    expect(g.meta.license).toBe('CC BY 4.0');
  });

  it('risolve comune → provincia → regione', () => {
    expect(g.area('municipality', '058091')).toEqual({
      type: 'municipality',
      code: '058091',
      name: 'Roma',
      context: 'Comune, Roma (RM), Lazio',
    });
    expect(g.area('province', '258')?.context).toBe('Città metropolitana, Lazio');
    expect(g.area('region', '15')?.name).toBe('Campania');
    expect(g.area('municipality', '999999')).toBeNull();
    expect(g.area('italy', 'IT')?.name).toBe('Italia');
  });

  it('elenca i comuni di un’area', () => {
    const napoli = g.municipalitiesIn('province', '263');
    expect(napoli.some((m) => m.name === 'Napoli')).toBe(true);
    expect(napoli.every((m) => m.provinceCode === '263')).toBe(true);
    const campania = g.municipalitiesIn('region', '15');
    expect(campania.length).toBeGreaterThan(napoli.length);
    expect(g.municipalitiesIn('municipality', '063049').map((m) => m.name)).toEqual(['Napoli']);
  });

  it('ricerca per nome senza accenti, con regioni e province prima dei comuni', () => {
    expect(
      g
        .search('napoli')
        .slice(0, 2)
        .map((a) => `${a.type}:${a.name}`),
    ).toEqual(['province:Napoli', 'municipality:Napoli']);
    // corrispondenza esatta prima del prefisso: il comune "Forlì", poi la provincia "Forlì-Cesena"
    expect(
      g
        .search('forli')
        .slice(0, 2)
        .map((a) => a.name),
    ).toEqual(['Forlì', 'Forlì-Cesena']);
    expect(g.search('Bozen').some((a) => a.code === '021008')).toBe(true);
    expect(g.search('x')).toEqual([]);
  });

  it('normalizzazione dei testi', () => {
    expect(fold("  Valle d'Aosta/Vallée  ")).toBe('valle d aosta vallee');
  });
});
