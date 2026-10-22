import { describe, expect, it } from 'vitest';
import { geo } from '../../geo/geo.ts';
import { OverpassProvider, realClock } from './overpass.ts';

/*
 * Prova d'integrazione con un VERO server Overpass. Non fa parte della suite normale: si avvia solo con
 *
 *   LIVE_OVERPASS_URL=https://overpass.private.coffee/api/interpreter npm run test:live
 *
 * Invia poche richieste piccole (un comune, una categoria), una alla volta, con User-Agent identificabile.
 * Controlla la forma dei dati reali, non il loro contenuto (che cambia nel tempo su OpenStreetMap).
 */

const endpoint = process.env.LIVE_OVERPASS_URL;

describe.skipIf(!endpoint)(`Overpass dal vivo (${endpoint ?? 'non configurato'})`, () => {
  const provider = new OverpassProvider(
    {
      endpoint: endpoint ?? null,
      userAgent: 'NoventraLeadFinder/test-live (+https://www.noventra.it)',
      minIntervalMs: 5000,
      timeoutSeconds: 120,
      maxsizeBytes: 256 * 1024 * 1024,
      maxRetries: 1,
      maxResponseBytes: 32 * 1024 * 1024,
      cacheTtlMs: 0,
    },
    { clock: realClock },
  );
  const albano = geo().municipality('058003')!;

  it(
    'un comune per codice ISTAT: attività reali normalizzate e attribuite al comune',
    { timeout: 300_000 },
    async () => {
      const r = await provider.fetchUnit({ municipalities: [albano] }, ['farmacie'], 50, AbortSignal.timeout(280_000));
      expect(r.foundMunicipalities).toEqual(['058003']);
      expect(r.records.length).toBeGreaterThan(0);
      for (const rec of r.records) {
        expect(rec.ref).toMatch(/^(node|way|relation)\/\d+$/);
        expect(rec.sourceUrl).toBe(`https://www.openstreetmap.org/${rec.ref}`);
        expect(rec.category).toBe('farmacie');
        expect(rec.municipalityCode).toBe('058003');
        expect(rec.name.length).toBeGreaterThan(0);
        expect(rec.latitude).toBeGreaterThan(41);
        expect(JSON.stringify(rec.sourceTags)).not.toMatch(/"(phone|email|contact:phone|contact:email)"/);
      }
    },
  );

  it('raggio attorno a un comune: include i comuni vicini con il loro codice', { timeout: 300_000 }, async () => {
    const r = await provider.fetchUnit(
      { municipalities: [albano], radiusKm: 2 },
      ['farmacie'],
      50,
      AbortSignal.timeout(280_000),
    );
    expect(r.foundMunicipalities).toContain('058003');
    expect(r.foundMunicipalities.length).toBeGreaterThan(1);
    for (const rec of r.records) expect(r.foundMunicipalities).toContain(rec.municipalityCode);
  });
});
