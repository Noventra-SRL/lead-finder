import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from '../db/client.ts';
import { testDatabase } from '../testing.ts';
import { distanceM, saveRecord, searchName, type SaveContext } from './store.ts';
import type { ProviderRecord } from './types.ts';

/* DATI DI TEST: record costruiti a mano con nomi "di Prova", mai usati fuori dai test. */

let db: Db;
beforeAll(async () => {
  db = await testDatabase();
});
afterAll(() => db.close());

let n = 0;
function record(
  over: Omit<Partial<ProviderRecord>, 'has'> & { has?: Partial<ProviderRecord['has']> } = {},
): ProviderRecord {
  n++;
  const { has, ...rest } = over;
  return {
    provider: 'osm',
    ref: `node/${8_000_000_000 + n}`,
    sourceUrl: `https://www.openstreetmap.org/node/${8_000_000_000 + n}`,
    name: `Attività di Prova ${n}`,
    category: 'farmacie',
    sector: null,
    contacts: { phone: null, email: null, emailKind: null },
    websiteUrl: null,
    websiteDomain: null,
    websiteShared: false,
    address: { street: null, housenumber: null, postcode: null, city: null },
    municipalityCode: '058091',
    latitude: 41.9 + n * 0.01,
    longitude: 12.5,
    has: { website: false, address: false, phone: false, email: false, openingHours: false, ...has },
    sourceTags: { name: `Attività di Prova ${n}` },
    ...rest,
  };
}

const ctx = (over: Partial<SaveContext> = {}): SaveContext => ({
  jobId: null,
  fetchedAt: new Date('2026-10-01T10:00:00Z'),
  sourceDataAt: new Date('2026-10-01T09:00:00Z'),
  minCompleteness: 0,
  requireWebsite: false,
  seen: new Set(),
  ...over,
});

const save = (r: ProviderRecord, c = ctx()) => db.transaction((tx) => saveRecord(tx, r, c));
const count = async (sql: string, params: unknown[] = []) =>
  (await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${sql}`, params)).rows[0]!.n;

describe('salvataggio e deduplica', () => {
  it('nuovo record: azienda con provincia e regione risolte dal codice ISTAT, fonte e cronologia', async () => {
    const r = record({
      name: 'Farmacia di Prova S.r.l.',
      has: { website: true },
      websiteUrl: 'https://fp.example.it/',
      websiteDomain: 'fp.example.it',
    });
    const res = await save(r);
    expect(res.outcome).toBe('inserted');
    const { rows } = await db.query<Record<string, unknown>>('SELECT * FROM businesses WHERE id = $1', [
      res.businessId,
    ]);
    expect(rows[0]).toMatchObject({
      name: 'Farmacia di Prova S.r.l.',
      search_name: 'farmacia di prova',
      municipality_code: '058091',
      municipality_name: 'Roma',
      province_code: '258',
      region_code: '12',
      has_website: true,
      completeness: 1,
    });
    const src = await db.query<{ is_primary: boolean; license: string; tags: unknown }>(
      'SELECT is_primary, license, tags FROM business_sources WHERE business_id = $1',
      [res.businessId],
    );
    expect(src.rows[0]).toMatchObject({ is_primary: true, license: expect.stringContaining('ODbL') });
    expect(await count("audit_log WHERE action = 'business.created' AND entity_id = $1", [res.businessId])).toBe(1);
  });

  it('ripetere lo stesso record non crea doppioni (idempotente)', async () => {
    const r = record();
    const first = await save(r);
    const again = await save(r, ctx({ fetchedAt: new Date('2026-10-02T10:00:00Z') }));
    expect(again).toMatchObject({ outcome: 'unchanged', businessId: first.businessId });
    expect(await count('business_sources WHERE provider_ref = $1', [r.ref])).toBe(1);
    const { rows } = await db.query<{ last_verified_at: Date }>(
      'SELECT last_verified_at FROM businesses WHERE id = $1',
      [first.businessId],
    );
    expect(new Date(rows[0]!.last_verified_at).toISOString()).toBe('2026-10-02T10:00:00.000Z');
  });

  it('una copia più vecchia dei dati della fonte non sovrascrive quella già salvata', async () => {
    const r = record({ name: 'Ottica di Prova Nuova' });
    const first = await save(r, ctx({ sourceDataAt: new Date('2026-09-01T00:00:00Z') }));
    // un altro server risponde con una copia di luglio, dove l'attività aveva il nome vecchio
    const older = await save(
      { ...r, name: 'Ottica di Prova Vecchia' },
      ctx({ sourceDataAt: new Date('2026-07-24T00:00:00Z') }),
    );
    expect(older).toMatchObject({ outcome: 'unchanged', businessId: first.businessId });
    const { rows } = await db.query<{ name: string }>('SELECT name FROM businesses WHERE id = $1', [first.businessId]);
    expect(rows[0]!.name).toBe('Ottica di Prova Nuova');
    // una copia più recente invece aggiorna
    const newer = await save(
      { ...r, name: 'Ottica di Prova Rinnovata' },
      ctx({ sourceDataAt: new Date('2026-10-15T00:00:00Z') }),
    );
    expect(newer.outcome).toBe('updated');
    const src = await db.query<{ source_data_at: Date }>(
      'SELECT source_data_at FROM business_sources WHERE provider_ref = $1',
      [r.ref],
    );
    expect(new Date(src.rows[0]!.source_data_at).toISOString()).toBe('2026-10-15T00:00:00.000Z');
  });

  it('un record visto due volte nello stesso job conta come doppione saltato', async () => {
    const c = ctx();
    const r = record();
    expect((await save(r, c)).outcome).toBe('inserted');
    expect((await save(r, c)).outcome).toBe('duplicate_skipped');
  });

  it('i cambiamenti della fonte aggiornano l’azienda e restano nella cronologia', async () => {
    const r = record({ name: 'Farmacia Vecchio Nome di Prova' });
    const first = await save(r);
    const changed = {
      ...r,
      name: 'Farmacia Nuovo Nome di Prova',
      websiteUrl: 'https://nuovo.example.it/',
      websiteDomain: 'nuovo.example.it',
      has: { ...r.has, website: true },
    };
    const res = await save(changed);
    expect(res).toMatchObject({ outcome: 'updated', businessId: first.businessId });
    const { rows } = await db.query<{ name: string; search_name: string; completeness: number }>(
      'SELECT name, search_name, completeness FROM businesses WHERE id = $1',
      [first.businessId],
    );
    expect(rows[0]).toEqual({
      name: 'Farmacia Nuovo Nome di Prova',
      search_name: 'farmacia nuovo nome di prova',
      completeness: 1,
    });
    const log = await db.query<{ details: { changes: Record<string, { from: unknown; to: unknown }> } }>(
      "SELECT details FROM audit_log WHERE action = 'business.updated' AND entity_id = $1",
      [first.businessId],
    );
    expect(log.rows[0]!.details.changes.name).toEqual({
      from: 'Farmacia Vecchio Nome di Prova',
      to: 'Farmacia Nuovo Nome di Prova',
    });
  });

  it('stesso sito e stessa posizione: la nuova fonte si collega all’azienda esistente e completa i dati mancanti', async () => {
    const base = record({
      websiteUrl: 'https://unica.example.it/',
      websiteDomain: 'unica.example.it',
      has: { website: true },
    });
    const first = await save(base);
    const other = record({
      name: 'Altro nome di Prova',
      websiteUrl: 'https://www.unica.example.it/contatti',
      websiteDomain: 'unica.example.it',
      latitude: base.latitude! + 0.0005,
      longitude: base.longitude,
      address: { street: 'Via di Prova', housenumber: '9', postcode: null, city: null },
      has: { website: true, address: true, openingHours: true },
    });
    const res = await save(other);
    expect(res).toMatchObject({ outcome: 'merged', businessId: first.businessId });
    const { rows } = await db.query<{
      name: string;
      address_street: string;
      has_opening_hours: boolean;
      website_url: string;
      completeness: number;
    }>('SELECT name, address_street, has_opening_hours, website_url, completeness FROM businesses WHERE id = $1', [
      first.businessId,
    ]);
    // il nome e il sito della fonte principale restano; i dati mancanti vengono completati
    expect(rows[0]).toEqual({
      name: base.name,
      address_street: 'Via di Prova',
      has_opening_hours: true,
      website_url: 'https://unica.example.it/',
      completeness: 3,
    });
    expect(await count('business_sources WHERE business_id = $1', [first.businessId])).toBe(2);
  });

  it('stesso dominio ma lontano (catena): aziende distinte, senza revisione se in comuni diversi', async () => {
    const a = await save(
      record({
        websiteUrl: 'https://catena.example.it/',
        websiteDomain: 'catena.example.it',
        municipalityCode: '058091',
      }),
    );
    const b = await save(
      record({
        websiteUrl: 'https://catena.example.it/',
        websiteDomain: 'catena.example.it',
        municipalityCode: '063049',
      }),
    );
    expect(a.outcome).toBe('inserted');
    expect(b).toMatchObject({ outcome: 'inserted', flaggedForReview: 0 });
  });

  it('stesso sito e stesso nome nello stesso comune ma sedi lontane: due aziende e una coppia da revisionare', async () => {
    const branch = {
      name: 'Farmacia Comunale di Prova',
      websiteUrl: 'https://farmaciecomunali-prova.example.it/',
      websiteDomain: 'farmaciecomunali-prova.example.it',
      municipalityCode: '058091',
    };
    const a = record(branch);
    const first = await save(a);
    // seconda sede a circa 2 km: stessa insegna, stesso sito, stesso comune
    const second = await save(record({ ...branch, latitude: a.latitude! + 0.018, longitude: a.longitude }));
    expect(first.outcome).toBe('inserted');
    expect(second).toMatchObject({ outcome: 'inserted', flaggedForReview: 1 });
    expect(second.businessId).not.toBe(first.businessId);
  });

  it('un dominio di piattaforma condivisa non identifica l’attività', async () => {
    const fb = { websiteUrl: 'https://facebook.com/x', websiteDomain: 'facebook.com', websiteShared: true };
    const a = record(fb);
    const b = record({ ...fb, latitude: a.latitude, longitude: a.longitude });
    expect((await save(a)).outcome).toBe('inserted');
    expect((await save(b)).outcome).toBe('inserted');
  });

  it('stesso nome a breve distanza: due aziende e una coppia da revisionare, mai unite in automatico', async () => {
    const a = record({ name: 'Bar di Prova' });
    const b = record({ name: 'BAR DI PROVA', latitude: a.latitude! + 0.001, longitude: a.longitude });
    const ra = await save(a);
    const rb = await save(b);
    expect(rb).toMatchObject({ outcome: 'inserted', flaggedForReview: 1 });
    expect(rb.businessId).not.toBe(ra.businessId);
    const { rows } = await db.query<{ reason: string; distance_m: number; status: string }>(
      'SELECT reason, distance_m, status FROM duplicate_candidates WHERE business_a = ANY($1) AND business_b = ANY($1)',
      [[ra.businessId, rb.businessId]],
    );
    expect(rows).toEqual([{ reason: 'Stesso nome a breve distanza', distance_m: 111, status: 'pending' }]);
  });

  it('nomi simili ma lontani non vengono segnalati', async () => {
    const a = record({ name: 'Pizzeria di Prova' });
    const b = record({ name: 'Pizzeria di Prova', latitude: a.latitude! + 0.05 });
    await save(a);
    expect(await save(b)).toMatchObject({ outcome: 'inserted', flaggedForReview: 0 });
  });

  it('filtri di completezza: i record sotto soglia non vengono salvati', async () => {
    const poor = record();
    expect((await save(poor, ctx({ minCompleteness: 1 }))).outcome).toBe('skipped_incomplete');
    expect((await save(record(), ctx({ requireWebsite: true }))).outcome).toBe('skipped_incomplete');
    expect(await count('business_sources WHERE provider_ref = $1', [poor.ref])).toBe(0);
  });

  it('un errore a metà transazione non lascia dati parziali', async () => {
    const r = record();
    await expect(
      db.transaction(async (tx) => {
        await saveRecord(tx, r, ctx());
        throw new Error('interruzione simulata');
      }),
    ).rejects.toThrow('interruzione simulata');
    expect(await count('business_sources WHERE provider_ref = $1', [r.ref])).toBe(0);
  });
});

describe('utilità', () => {
  it('nome di ricerca senza forma giuridica e distanza in metri', () => {
    expect(searchName('Rossi & Figli S.n.c.')).toBe('rossi figli');
    expect(searchName('Caffè Società Cooperativa')).toBe('caffe');
    expect(searchName('Bianchi S.r.l.s.')).toBe('bianchi');
    expect(searchName('Verdi SRL')).toBe('verdi');
    expect(distanceM({ lat: 41.9, lon: 12.5 }, { lat: 41.901, lon: 12.5 })).toBe(111);
  });
});
