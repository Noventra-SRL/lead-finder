import { readFileSync } from 'node:fs';

/*
 * Geografia amministrativa italiana con codici ISTAT canonici (server/geo/istat.json, generato da
 * scripts/istat-comuni.ts; fonte ISTAT, licenza CC BY 4.0).
 *  - regione: codice a 2 cifre ("12" = Lazio);
 *  - provincia / città metropolitana / unità territoriale sovracomunale: codice UTS a 3 cifre ("258" = Roma);
 *  - comune: codice alfanumerico a 6 cifre ("058091" = Roma), lo stesso usato in OpenStreetMap (ref:ISTAT).
 * Dati di riferimento statici: caricati in memoria una volta per processo.
 */

export type AreaType = 'italy' | 'region' | 'province' | 'municipality';

export interface Region {
  code: string;
  name: string;
}
export interface Province {
  code: string;
  name: string;
  sigla: string;
  regionCode: string;
  /** Tipologia ISTAT: provincia, provincia autonoma, città metropolitana, libero consorzio, unità non amministrativa. */
  kind: string;
}
export interface Municipality {
  code: string;
  name: string;
  /** Denominazione bilingue ufficiale, se diversa (es. "Bolzano/Bozen"). */
  altName?: string;
  provinceCode: string;
  regionCode: string;
}

export interface AreaRef {
  type: AreaType;
  code: string;
  name: string;
  /** Contesto leggibile, es. "Provincia di Roma, Lazio". */
  context: string;
}

const KINDS: Record<number, string> = {
  1: 'Provincia',
  2: 'Provincia autonoma',
  3: 'Città metropolitana',
  4: 'Libero consorzio comunale',
  5: 'Unità territoriale',
};

interface RawData {
  meta: { source: string; url: string; license: string; licenseUrl: string; generatedAt: string };
  regions: [string, string][];
  provinces: [string, string, string, string, number][];
  municipalities: ([string, string, string] | [string, string, string, string])[];
}

/** Testo per confronti: minuscolo, senza accenti, solo lettere e cifre separate da uno spazio. */
export function fold(s: string): string {
  return s
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

export class Geo {
  readonly meta: RawData['meta'];
  readonly regions: Region[];
  readonly provinces: Province[];
  readonly municipalities: Municipality[];
  private readonly regionByCode: Map<string, Region>;
  private readonly provinceByCode: Map<string, Province>;
  private readonly municipalityByCode: Map<string, Municipality>;

  constructor(raw: RawData) {
    this.meta = raw.meta;
    this.regions = raw.regions.map(([code, name]) => ({ code, name }));
    this.provinces = raw.provinces.map(([code, name, sigla, regionCode, kind]) => ({
      code,
      name,
      sigla,
      regionCode,
      kind: KINDS[kind] ?? 'Unità territoriale',
    }));
    this.regionByCode = new Map(this.regions.map((r) => [r.code, r]));
    this.provinceByCode = new Map(this.provinces.map((p) => [p.code, p]));
    this.municipalities = raw.municipalities.map(([code, name, provinceCode, altName]) => ({
      code,
      name,
      ...(altName ? { altName } : {}),
      provinceCode,
      regionCode: this.provinceByCode.get(provinceCode)!.regionCode,
    }));
    this.municipalityByCode = new Map(this.municipalities.map((m) => [m.code, m]));
  }

  region(code: string) {
    return this.regionByCode.get(code) ?? null;
  }
  province(code: string) {
    return this.provinceByCode.get(code) ?? null;
  }
  municipality(code: string) {
    return this.municipalityByCode.get(code) ?? null;
  }

  provincesOf(regionCode: string): Province[] {
    return this.provinces.filter((p) => p.regionCode === regionCode).sort((a, b) => a.name.localeCompare(b.name, 'it'));
  }

  municipalitiesOf(provinceCode: string): Municipality[] {
    return this.municipalities
      .filter((m) => m.provinceCode === provinceCode)
      .sort((a, b) => a.name.localeCompare(b.name, 'it'));
  }

  /** Comuni compresi in un'area, in ordine di codice (stabile tra un'esecuzione e l'altra). */
  municipalitiesIn(type: AreaType, code: string): Municipality[] {
    if (type === 'italy') return this.municipalities;
    if (type === 'region') return this.municipalities.filter((m) => m.regionCode === code);
    if (type === 'province') return this.municipalities.filter((m) => m.provinceCode === code);
    const m = this.municipality(code);
    return m ? [m] : [];
  }

  /** Riferimento leggibile a un'area; null se il codice non esiste. */
  area(type: AreaType, code: string): AreaRef | null {
    if (type === 'italy')
      return code === 'IT' ? { type, code, name: 'Italia', context: 'Tutto il territorio nazionale' } : null;
    if (type === 'region') {
      const r = this.region(code);
      return r ? { type, code, name: r.name, context: 'Regione' } : null;
    }
    if (type === 'province') {
      const p = this.province(code);
      return p ? { type, code, name: p.name, context: `${p.kind}, ${this.region(p.regionCode)!.name}` } : null;
    }
    const m = this.municipality(code);
    if (!m) return null;
    const p = this.province(m.provinceCode)!;
    return { type, code, name: m.name, context: `Comune, ${p.name} (${p.sigla}), ${this.region(m.regionCode)!.name}` };
  }

  /** Ricerca per nome (senza accenti, per inizio di parola), regioni e province prima dei comuni. */
  search(query: string, limit = 20): AreaRef[] {
    const q = fold(query);
    if (q.length < 2) return [];
    const matches = (name: string) => {
      const f = fold(name);
      return f === q ? 0 : f.startsWith(q) ? 1 : ` ${f}`.includes(` ${q}`) ? 2 : -1;
    };
    const found: { ref: AreaRef; rank: number }[] = [];
    for (const r of this.regions) {
      const rank = matches(r.name);
      if (rank >= 0) found.push({ ref: this.area('region', r.code)!, rank });
    }
    for (const p of this.provinces) {
      const rank = Math.min(...[matches(p.name), fold(p.sigla) === q ? 0 : -1].filter((x) => x >= 0), 9);
      if (rank < 9) found.push({ ref: this.area('province', p.code)!, rank: rank + 0.1 });
    }
    for (const m of this.municipalities) {
      const rank = Math.min(...[matches(m.name), m.altName ? matches(m.altName) : -1].filter((x) => x >= 0), 9);
      if (rank < 9) found.push({ ref: this.area('municipality', m.code)!, rank: rank + 0.2 });
    }
    return found
      .sort((a, b) => a.rank - b.rank || a.ref.name.localeCompare(b.ref.name, 'it'))
      .slice(0, limit)
      .map((f) => f.ref);
  }
}

let shared: Geo | null = null;

/** Dataset ISTAT del progetto (caricato alla prima richiesta). */
export function geo(): Geo {
  shared ??= new Geo(JSON.parse(readFileSync(new URL('./istat.json', import.meta.url), 'utf8')) as RawData);
  return shared;
}
