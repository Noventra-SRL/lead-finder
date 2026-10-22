import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { activeConfig } from './scoring/store.ts';
import type { Db } from './db/client.ts';
import { saveRecord } from './discovery/store.ts';
import { client, createTestUser, startTestServer, testDatabase, type TestServer } from './testing.ts';

/* Home: numeri della pagina iniziale dalle stesse definizioni del resto dell'applicazione. */

const PASSWORD = 'password-di-prova-lunga';
let db: Db;
let server: TestServer;
let n = 0;

async function business(name: string) {
  n++;
  const r = await db.transaction((tx) =>
    saveRecord(
      tx,
      {
        provider: 'osm',
        ref: `node/${6_600_000_000 + n}`,
        sourceUrl: `https://www.openstreetmap.org/node/${6_600_000_000 + n}`,
        name,
        category: 'ristorazione',
        websiteUrl: null,
        websiteDomain: null,
        websiteShared: false,
        sector: 'ristoranti',
        contacts: { phone: null, email: null, emailKind: null },
        address: { street: null, housenumber: null, postcode: null, city: null },
        municipalityCode: '058091',
        latitude: 41 + n * 0.01,
        longitude: 12,
        has: { website: false, address: false, phone: false, email: false, openingHours: false },
        sourceTags: { name },
      },
      {
        jobId: null,
        fetchedAt: new Date(),
        sourceDataAt: null,
        minCompleteness: 0,
        requireWebsite: false,
        seen: new Set(),
      },
    ),
  );
  return r.businessId!;
}

async function rulesScore(id: string, score: number) {
  const config = await activeConfig(db);
  await db.query(
    `INSERT INTO lead_scores (business_id, algorithm_version, config_version, input_hash, status, score, raw_score, band,
       confidence, confidence_level, completeness, breakdown, explanation, next_step, trigger)
     VALUES ($1, 1, $2, $3, 'ranked', $4, $5, 'A', 60, 'medium', 60, '{}', 'Prova', 'Prova', 'manual')`,
    [id, config.version, 'b'.repeat(64), score, score.toFixed(2)],
  );
}

beforeAll(async () => {
  db = await testDatabase();
  server = await startTestServer(db);
  await createTestUser(db, { email: 'home@noventra.test', role: 'admin', password: PASSWORD });
});
afterAll(async () => {
  await server.close();
  await db.close();
});

describe('home', () => {
  it('aziende uniche, fasce del punteggio commerciale, prioritari fuori dal CRM, CRM e attività recenti', async () => {
    const c = client(server.url);
    await c.request('POST', '/api/auth/login', { email: 'home@noventra.test', password: PASSWORD });
    const empty = (await c.request('GET', '/api/home')).body;
    expect(empty).toMatchObject({
      businesses: 0,
      aiConfigured: false,
      commercial: { scored: 0, highPriority: 0 },
      recent: [],
    });

    const high1 = await business('Alta Uno di Prova');
    const high2 = await business('Alta Due di Prova');
    const mid = await business('Media di Prova');
    await business('Senza Punteggio di Prova');
    const excluded = await business('Esclusa di Prova');
    const merged = await business('Unita di Prova');
    await rulesScore(high1, 85);
    await rulesScore(high2, 90);
    await rulesScore(mid, 65);
    await rulesScore(excluded, 95);
    await rulesScore(merged, 99);
    await db.query("UPDATE businesses SET excluded_at = now(), excluded_reason = 'Prova' WHERE id = $1", [excluded]);
    await db.query('UPDATE businesses SET merged_into = $1 WHERE id = $2', [high1, merged]);
    // una prioritaria è già nel CRM, pronta da contattare
    const opp = (await c.request('POST', '/api/crm/opportunities', { businessId: high2 })).body.opportunity.id;
    await c.request('POST', `/api/crm/opportunities/${opp}/stage`, { stage: 'da_contattare' });

    const h = (await c.request('GET', '/api/home')).body;
    expect(h.businesses).toBe(4);
    expect(h.excluded).toBe(1);
    expect(h.commercial).toMatchObject({
      scored: 3,
      unscored: 1,
      fromRules: 3,
      fromAi: 0,
      highPriority: 2,
      highPriorityNotInCrm: 1,
    });
    expect(h.commercial.bands.map((b: { count: number }) => b.count)).toEqual([2, 1, 0, 0, 0]);
    expect(h.commercial.bands[0]).toMatchObject({ min: 80, max: 100 });
    expect(h.crm).toMatchObject({ active: 1, readyToContact: 1, followUpsOverdue: 0 });
    expect(h.recent[0]).toMatchObject({ kind: 'crm', business: 'Alta Due di Prova', link: `/pipeline/${opp}` });
    expect((await client(server.url).request('GET', '/api/home')).status).toBe(401);
  });
});
