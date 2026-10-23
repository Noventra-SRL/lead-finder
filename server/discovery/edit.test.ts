import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from '../db/client.ts';
import { client, createTestUser, startTestServer, testDatabase, type TestServer } from '../testing.ts';
import { saveRecord } from './store.ts';
import type { ProviderRecord } from './types.ts';

/*
 * «Modifica» della scheda azienda sul server reale e su un database di prova: validazione, protezione dalle
 * sovrascritture, dati collegati intatti, nessun doppione, divieto di contatto invariato, fonte che non sovrascrive.
 */

const PASSWORD = 'password-di-prova-lunga';
let db: Db;
let server: TestServer;
let n = 0;

type Client = ReturnType<typeof client>;

function record(over: Partial<ProviderRecord> = {}): ProviderRecord {
  n++;
  return {
    provider: 'osm',
    ref: `node/${8_100_000_000 + n}`,
    sourceUrl: `https://www.openstreetmap.org/node/${8_100_000_000 + n}`,
    name: `Bar Modifica di Prova ${n}`,
    category: 'ristorazione',
    sector: 'bar_caffe',
    websiteUrl: 'https://www.bar-prova.example.it/',
    websiteDomain: 'bar-prova.example.it',
    websiteShared: false,
    contacts: { phone: '+39 06 1234567', email: 'info@bar-prova.example.it', emailKind: 'generic' },
    address: { street: 'Via Roma', housenumber: '1', postcode: '00041', city: 'Albano Laziale' },
    municipalityCode: '058003',
    latitude: 41.73 + n * 0.01,
    longitude: 12.66,
    has: { website: true, address: true, phone: true, email: true, openingHours: false },
    sourceTags: { amenity: 'bar', name: `Bar Modifica di Prova ${n}` },
    ...over,
  } as ProviderRecord;
}

const save = (r: ProviderRecord) =>
  db.transaction((tx) =>
    saveRecord(tx, r, {
      jobId: null,
      fetchedAt: new Date(),
      sourceDataAt: null,
      minCompleteness: 0,
      requireWebsite: false,
      seen: new Set(),
    }),
  );

beforeAll(async () => {
  db = await testDatabase();
  server = await startTestServer(db);
  await createTestUser(db, { email: 'modifica@noventra.test', role: 'admin', password: PASSWORD });
});
afterAll(async () => {
  await server.close();
  await db.close();
});

async function login(): Promise<Client> {
  const c = client(server.url);
  expect(
    (await c.request('POST', '/api/auth/login', { email: 'modifica@noventra.test', password: PASSWORD })).status,
  ).toBe(200);
  return c;
}

const detail = async (c: Client, id: string) => (await c.request('GET', `/api/businesses/${id}`)).body.business;

describe('modifica della scheda azienda', () => {
  it('campi letti, modificati, normalizzati e salvati; email e sito da verificare di nuovo; nessun doppione', async () => {
    const c = await login();
    const r = record();
    const id = (await save(r)).businessId!;
    let b = await detail(c, id);
    expect(b.contacts).toMatchObject({ email: 'info@bar-prova.example.it' });
    expect(b.updatedAt).toEqual(expect.any(String));
    const before = await db.query<{ n: number }>('SELECT count(*)::int AS n FROM businesses');

    const res = await c.request('PATCH', `/api/businesses/${id}`, {
      updatedAt: b.updatedAt,
      name: 'Bar Centrale di Prova',
      email: ' Prenotazioni@Bar-Centrale.example.it ',
      phone: '06 7654321',
      fax: '06 7654322',
      website: 'bar-centrale.example.it',
      street: 'Piazza Mazzini',
      housenumber: '7',
      postcode: '00041',
      city: 'Albano',
      contactName: 'Responsabile di prova',
      contactRole: 'Titolare',
      notes: 'Preferisce essere contattato al mattino.',
      operatingStatus: 'attiva',
    });
    expect(res.status).toBe(200);
    b = res.body.business;
    expect(b.name).toBe('Bar Centrale di Prova');
    expect(b.contacts).toMatchObject({
      email: 'prenotazioni@bar-centrale.example.it',
      fax: expect.stringContaining('7654322'),
    });
    expect(b.contacts.phone).toContain('7654321');
    expect(b.website).toMatchObject({ url: 'http://bar-centrale.example.it/', domain: 'bar-centrale.example.it' });
    expect(b.address).toMatchObject({ street: 'Piazza Mazzini', housenumber: '7', postcode: '00041', city: 'Albano' });
    expect(b).toMatchObject({
      contactPerson: { name: 'Responsabile di prova', role: 'Titolare' },
      notes: 'Preferisce essere contattato al mattino.',
      operatingStatus: 'attiva',
    });
    // email inserita a mano: mai verificata; sito nuovo da controllare
    expect(b.emailInfo).toMatchObject({ source: 'manuale', sourceUrl: null });
    expect(b.emailInfo.verification.level).not.toBe('delivery_verified');
    expect(b.audit.websiteStatus).toBe('not_checked');
    // riaperta: i dati restano; nessuna nuova azienda
    expect((await detail(c, id)).name).toBe('Bar Centrale di Prova');
    const after = await db.query<{ n: number }>('SELECT count(*)::int AS n FROM businesses');
    expect(after.rows[0]!.n).toBe(before.rows[0]!.n);
    // cronologia: chi e cosa
    expect(b.history.some((h: { action: string }) => h.action === 'business.edited')).toBe(true);

    // una nuova lettura della fonte non riporta i vecchi valori sui campi corretti a mano
    await save({ ...r });
    const reread = await detail(c, id);
    expect(reread.name).toBe('Bar Centrale di Prova');
    expect(reread.contacts.email).toBe('prenotazioni@bar-centrale.example.it');
    expect(reread.contacts.phone).toContain('7654321');
  });

  it('errori per campo in italiano; nulla salvato', async () => {
    const c = await login();
    const id = (await save(record())).businessId!;
    const b = await detail(c, id);
    const r = await c.request('PATCH', `/api/businesses/${id}`, {
      updatedAt: b.updatedAt,
      email: 'non-una-email',
      website: 'ftp://sito',
      phone: '12',
      postcode: '123',
      name: 'X',
    });
    expect(r.status).toBe(400);
    expect(r.body.error.fields).toMatchObject({
      email: expect.stringMatching(/email non valido/),
      website: expect.stringMatching(/web non valido/),
      phone: expect.stringMatching(/telefono non valido/),
      postcode: expect.stringMatching(/5 cifre/),
      name: expect.stringMatching(/obbligatorio/),
    });
    expect((await detail(c, id)).contacts.email).toBe('info@bar-prova.example.it');
  });

  it('un campo si svuota solo con conferma; scheda cambiata nel frattempo: nessuna sovrascrittura', async () => {
    const c = await login();
    const id = (await save(record())).businessId!;
    const b = await detail(c, id);
    let r = await c.request('PATCH', `/api/businesses/${id}`, { updatedAt: b.updatedAt, phone: null });
    expect(r.status).toBe(400);
    expect(r.body.error.fields.phone).toMatch(/conferma/);
    r = await c.request('PATCH', `/api/businesses/${id}`, { updatedAt: b.updatedAt, phone: null, clear: ['phone'] });
    expect(r.status).toBe(200);
    expect(r.body.business.contacts.phone).toBeNull();
    // versione superata (la modifica appena fatta ha cambiato la scheda)
    r = await c.request('PATCH', `/api/businesses/${id}`, { updatedAt: b.updatedAt, notes: 'tardiva' });
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('STALE');
    expect((await detail(c, id)).notes).toBeNull();
  });

  it('dati collegati intatti: email, CRM, punteggi, audit; divieto di contatto invariato; modello della categoria', async () => {
    const c = await login();
    const id = (await save(record())).businessId!;
    // bozza email e opportunità CRM esistenti
    const draft = await c.request('POST', '/api/emails', { requestId: randomUUID(), businessId: id });
    expect(draft.status).toBe(201);
    expect(draft.body.email.templateId).toBe('noventra_standard');
    const opp = await c.request('POST', '/api/crm/opportunities', { businessId: id });
    expect([200, 201]).toContain(opp.status);
    const counts = async () =>
      (
        await db.query<Record<string, number>>(
          `SELECT (SELECT count(*) FROM commercial_emails WHERE business_id = $1)::int AS emails,
                  (SELECT count(*) FROM crm_opportunities WHERE business_id = $1)::int AS opportunities,
                  (SELECT count(*) FROM crm_activities a JOIN crm_opportunities o ON o.id = a.opportunity_id
                    WHERE o.business_id = $1)::int AS activities,
                  (SELECT count(*) FROM lead_scores WHERE business_id = $1)::int AS scores,
                  (SELECT count(*) FROM business_sources WHERE business_id = $1)::int AS sources`,
          [id],
        )
      ).rows[0];
    const before = await counts();
    // divieto di contatto
    await c.request('POST', `/api/businesses/${id}/exclusion`, {
      excluded: true,
      code: 'rifiuto_commerciale',
      scope: 'tutti',
    });
    let b = await detail(c, id);
    expect(b.doNotContact).not.toBeNull();
    const r = await c.request('PATCH', `/api/businesses/${id}`, {
      updatedAt: b.updatedAt,
      email: 'nuova@bar-prova.example.it',
      category: 'farmacie',
      notes: 'Nota dopo il rifiuto.',
    });
    expect(r.status).toBe(200);
    b = r.body.business;
    expect(b.doNotContact).toMatchObject({ scope: 'tutti' });
    expect(b.businessCategory).toMatchObject({ id: 'farmacie', source: 'manuale' });
    expect(await counts()).toEqual(before);
    // la bozza esistente non cambia; l'invio resta bloccato dal divieto
    const old = await c.request('GET', `/api/emails/${draft.body.email.id}`);
    expect(old.body.email).toMatchObject({ templateId: 'noventra_standard', body: draft.body.email.body });
    expect((await c.request('POST', '/api/emails', { requestId: randomUUID(), businessId: id })).status).toBe(409);
  });
});
