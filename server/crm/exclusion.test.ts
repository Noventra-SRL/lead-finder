import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from '../db/client.ts';
import { contactsFromTags } from '../discovery/contacts.ts';
import { listBusinesses, type BusinessFilters } from '../discovery/businesses.ts';
import { saveRecord, type SaveContext } from '../discovery/store.ts';
import type { ProviderRecord } from '../discovery/types.ts';
import { createEmail } from '../email/store.ts';
import { exportBusinesses } from '../exports/datasets.ts';
import { homeOverview } from '../home.ts';
import { client, createTestUser, startTestServer, testDatabase, type TestServer } from '../testing.ts';
import { addActivity, changeStage, createOpportunity } from './store.ts';
import { randomUUID } from 'node:crypto';

/*
 * Esclusione dai potenziali clienti e divieto di contatto: motivi, conferma, viste, reinclusione, revoca solo per
 * gli amministratori, controlli del server (non solo del pulsante), ricerche ripetute, storia conservata, conteggi ed
 * esportazioni; recapiti aggiuntivi (fax, altri telefoni) e recapiti mai cancellati da una fonte. DATI DI TEST.
 */

const PASSWORD = 'password-di-prova-lunga';
let db: Db;
let server: TestServer;
let adminId = '';

beforeAll(async () => {
  db = await testDatabase();
  server = await startTestServer(db);
  adminId = (await createTestUser(db, { email: 'escl.admin@noventra.test', role: 'admin', password: PASSWORD })).id;
  await createTestUser(db, { email: 'escl.sales@noventra.test', role: 'sales', password: PASSWORD });
});
afterAll(async () => {
  await server.close();
  await db.close();
});

async function login(email = 'escl.admin@noventra.test') {
  const c = client(server.url);
  expect((await c.request('POST', '/api/auth/login', { email, password: PASSWORD })).status).toBe(200);
  return c;
}

let n = 0;
const ctx = (): SaveContext => ({
  jobId: null,
  fetchedAt: new Date(),
  sourceDataAt: null,
  minCompleteness: 0,
  requireWebsite: false,
  seen: new Set(),
});
function record(name: string, tags: Record<string, string> = {}): ProviderRecord {
  n++;
  return {
    provider: 'osm',
    ref: `node/${6_000_000_000 + n}`,
    sourceUrl: `https://www.openstreetmap.org/node/${6_000_000_000 + n}`,
    name,
    category: 'negozi',
    sector: null,
    contacts: contactsFromTags(tags),
    websiteUrl: null,
    websiteDomain: null,
    websiteShared: false,
    address: { street: null, housenumber: null, postcode: null, city: null },
    municipalityCode: '058091',
    latitude: 41.7 + n * 0.01,
    longitude: 12.3,
    has: {
      website: false,
      address: false,
      phone: Boolean(tags.phone),
      email: Boolean(tags.email),
      openingHours: false,
    },
    sourceTags: { name, shop: 'clothes' },
  };
}
const save = (r: ProviderRecord) => db.transaction((tx) => saveRecord(tx, r, ctx()));
const business = async (name: string, tags: Record<string, string> = { email: 'info@negozio-prova.example.it' }) =>
  (await save(record(name, tags))).businessId!;
const filters = (over: Partial<BusinessFilters> = {}): BusinessFilters => ({
  sort: 'name',
  dir: 'asc',
  page: 1,
  pageSize: 50,
  ...over,
});
const row = async (id: string) =>
  (
    await db.query<{
      excluded_at: Date | null;
      exclusion_code: string | null;
      excluded_reason: string | null;
      do_not_contact_at: Date | null;
      do_not_contact_scope: string | null;
    }>(
      'SELECT excluded_at, exclusion_code, excluded_reason, do_not_contact_at, do_not_contact_scope FROM businesses WHERE id = $1',
      [id],
    )
  ).rows[0]!;

describe('esclusione dai potenziali clienti', () => {
  it('ogni motivo è accettato e registrato; senza motivo l’esclusione è rifiutata', async () => {
    const c = await login();
    for (const code of [
      'nessun_contatto',
      'contatti_non_validi',
      'attivita_chiusa',
      'non_pertinente',
      'duplicato',
      'altro',
    ] as const) {
      const id = await business(`Negozio Escluso ${code} di Prova`);
      const r = await c.request('POST', `/api/businesses/${id}/exclusion`, {
        excluded: true,
        code,
        note: code === 'altro' ? 'Motivo di prova' : undefined,
      });
      expect(r.status, code).toBe(200);
      expect(r.body.business.excluded).toMatchObject({ code });
      expect(r.body.business.doNotContact).toBeNull();
      expect(r.body.business.contact.status).toBe('esclusa');
    }
    const id = await business('Negozio Senza Motivo di Prova');
    const bad = await c.request('POST', `/api/businesses/${id}/exclusion`, { excluded: true });
    expect(bad.status).toBe(400);
    expect(bad.body.error.fields.code).toBe('Scegli il motivo.');
    expect((await row(id)).excluded_at).toBeNull();
    expect(
      (await c.request('POST', `/api/businesses/${id}/exclusion`, { excluded: true, code: 'inventato' })).status,
    ).toBe(400);
  });

  it('esclusa: fuori dagli elenchi, dai conteggi, dalle raccomandazioni e dalle esportazioni; visibile in «Aziende escluse»', async () => {
    const id = await business('Negozio Da Escludere Visibilità di Prova');
    const before = await homeOverview(db, adminId);
    const c = await login();
    await c.request('POST', `/api/businesses/${id}/exclusion`, { excluded: true, code: 'non_pertinente' });
    expect((await listBusinesses(db, filters({ q: 'Da Escludere Visibilità' }))).total).toBe(0);
    expect((await listBusinesses(db, filters({ q: 'Da Escludere Visibilità', excluded: 'only' }))).total).toBe(1);
    const after = await homeOverview(db, adminId);
    expect(after.sales.found).toBe(before.sales.found - 1);
    expect(after.sales.readyToContact).toBe(before.sales.readyToContact - 1);
    expect(after.sales.bestProspects.map((b) => b.id)).not.toContain(id);
    const csv = await exportBusinesses(db, filters({ q: 'Da Escludere Visibilità' }), {
      format: 'csv',
      name: 'prova',
      userId: adminId,
    });
    expect(csv.rows).toBe(0);
    // conteggi separati
    const cats = await c.request('GET', '/api/businesses/categories?q=Da%20Escludere%20Visibilit%C3%A0');
    expect(cats.body.status).toMatchObject({ excluded: 1, doNotContact: 0 });
    expect(cats.body.all.total).toBe(0);
    // reinclusa: torna negli elenchi
    await c.request('POST', `/api/businesses/${id}/exclusion`, { excluded: false });
    expect((await listBusinesses(db, filters({ q: 'Da Escludere Visibilità' }))).total).toBe(1);
    expect(await row(id)).toMatchObject({ excluded_at: null, exclusion_code: null });
  });

  it('storia conservata: trattativa, attività ed email restano dopo l’esclusione', async () => {
    const id = await business('Negozio Con Storia di Prova');
    const opp = await createOpportunity(db, { businessId: id, stage: 'da_contattare', priority: 'media' }, adminId);
    await addActivity(db, opp, { type: 'call', occurredAt: new Date(), summary: 'Telefonata di prova' }, adminId);
    const draft = await createEmail(db, { requestId: randomUUID(), businessId: id }, adminId);
    const c = await login();
    await c.request('POST', `/api/businesses/${id}/exclusion`, { excluded: true, code: 'attivita_chiusa' });
    const count = async (sql: string) => (await db.query<{ n: number }>(sql, [id])).rows[0]!.n;
    expect(await count('SELECT count(*)::int AS n FROM businesses WHERE id = $1')).toBe(1);
    expect(await count('SELECT count(*)::int AS n FROM crm_opportunities WHERE business_id = $1')).toBe(1);
    expect(
      await count(
        'SELECT count(*)::int AS n FROM crm_activities a JOIN crm_opportunities o ON o.id = a.opportunity_id WHERE o.business_id = $1',
      ),
    ).toBeGreaterThanOrEqual(1);
    expect(await count('SELECT count(*)::int AS n FROM commercial_emails WHERE business_id = $1')).toBe(1);
    expect(draft.created).toBe(true);
  });
});

describe('divieto di contatto (rifiuto commerciale)', () => {
  it('rifiuto: divieto su tutti i canali per impostazione predefinita, che resta reincludendo l’azienda', async () => {
    const id = await business('Negozio Rifiuto di Prova');
    const c = await login();
    const r = await c.request('POST', `/api/businesses/${id}/exclusion`, {
      excluded: true,
      code: 'rifiuto_commerciale',
      note: 'Ha chiesto per telefono di non essere contattato',
    });
    expect(r.body.business.doNotContact).toMatchObject({ scope: 'tutti' });
    expect(r.body.business.contact.status).toBe('non_contattare');
    const back = await c.request('POST', `/api/businesses/${id}/exclusion`, { excluded: false });
    expect(back.body.business.excluded).toBeNull();
    expect(back.body.business.doNotContact).not.toBeNull();
    expect(back.body.business.contact.status).toBe('non_contattare');
    // dal server, non solo dal pulsante: nessuna email, nemmeno in bozza
    await expect(createEmail(db, { requestId: randomUUID(), businessId: id }, adminId)).rejects.toMatchObject({
      code: 'DO_NOT_CONTACT',
    });
    // fuori dalle aziende pronte da contattare e dalle raccomandazioni
    const home = await homeOverview(db, adminId);
    expect(home.sales.bestProspects.map((b) => b.id)).not.toContain(id);
    expect((await listBusinesses(db, filters({ doNotContact: true, q: 'Rifiuto di Prova' }))).total).toBe(1);
  });

  it('rifiuto solo telefonico: l’email resta possibile; rifiuto solo email: email bloccata', async () => {
    const phone = await business('Negozio Rifiuto Telefono di Prova');
    const mail = await business('Negozio Rifiuto Email di Prova');
    const c = await login();
    for (const [id, scope] of [
      [phone, 'telefono'],
      [mail, 'email'],
    ] as const) {
      await c.request('POST', `/api/businesses/${id}/exclusion`, {
        excluded: true,
        code: 'rifiuto_commerciale',
        scope,
      });
      await c.request('POST', `/api/businesses/${id}/exclusion`, { excluded: false });
    }
    expect((await createEmail(db, { requestId: randomUUID(), businessId: phone }, adminId)).created).toBe(true);
    await expect(createEmail(db, { requestId: randomUUID(), businessId: mail }, adminId)).rejects.toMatchObject({
      code: 'DO_NOT_CONTACT',
    });
  });

  it('«non contattare» nel CRM attiva il divieto; la revoca è solo degli amministratori, con un motivo registrato', async () => {
    const id = await business('Negozio CRM Non Contattare di Prova');
    const opp = await createOpportunity(db, { businessId: id, stage: 'da_contattare', priority: 'media' }, adminId);
    await changeStage(db, opp, { stage: 'non_contattare', note: 'Richiesta del titolare' }, adminId);
    expect(await row(id)).toMatchObject({ exclusion_code: 'rifiuto_commerciale', do_not_contact_scope: 'tutti' });
    const sales = await login('escl.sales@noventra.test');
    expect(
      (await sales.request('POST', `/api/businesses/${id}/do-not-contact/revoke`, { note: 'Consenso ricevuto' }))
        .status,
    ).toBe(403);
    const admin = await login();
    expect((await admin.request('POST', `/api/businesses/${id}/do-not-contact/revoke`, { note: 'no' })).status).toBe(
      400,
    );
    const ok = await admin.request('POST', `/api/businesses/${id}/do-not-contact/revoke`, {
      note: 'Consenso scritto ricevuto il 22/10',
    });
    expect(ok.status).toBe(200);
    expect(ok.body.business.doNotContact).toBeNull();
    const { rows } = await db.query<{ action: string }>(
      "SELECT action FROM audit_log WHERE entity_id = $1 AND action IN ('business.excluded', 'business.do_not_contact_revoked') ORDER BY id",
      [id],
    );
    expect(rows.map((r) => r.action)).toEqual(['business.excluded', 'business.do_not_contact_revoked']);
  });

  it('una ricerca che ritrova l’azienda non la riattiva né toglie il divieto o l’esclusione', async () => {
    const r = record('Negozio Ritrovato di Prova', { email: 'info@ritrovato-prova.example.it', phone: '06 1234567' });
    const id = (await save(r)).businessId!;
    const c = await login();
    await c.request('POST', `/api/businesses/${id}/exclusion`, { excluded: true, code: 'rifiuto_commerciale' });
    const again = await save({ ...r, name: 'Negozio Ritrovato di Prova (nuovo nome)' });
    expect(again).toMatchObject({ businessId: id, outcome: 'updated' });
    const after = await row(id);
    expect(after.excluded_at).not.toBeNull();
    expect(after.do_not_contact_at).not.toBeNull();
  });
});

describe('recapiti', () => {
  it('fax e altri telefoni dalla fonte, mai dedotti', () => {
    expect(contactsFromTags({ phone: '06 1111111; 333 2222222', fax: '06 3333333' })).toEqual({
      phone: '06 1111111',
      email: null,
      emailKind: null,
      fax: '06 3333333',
      phonesExtra: ['333 2222222'],
    });
    expect(contactsFromTags({ phone: '06 1111111' })).toMatchObject({ fax: null, phonesExtra: [] });
  });

  it('una nuova lettura della fonte non cancella un recapito e non sostituisce l’email trovata sul sito', async () => {
    const r = record('Negozio Recapiti di Prova', { phone: '06 4444444', fax: '06 5555555' });
    const id = (await save(r)).businessId!;
    await db.query(
      "UPDATE businesses SET email = 'info.recapiti@gmail.com', email_kind = 'generic', email_source = 'website', email_status = 'pubblicata' WHERE id = $1",
      [id],
    );
    // la fonte non riporta più telefono né fax e indica un'altra email
    await save({
      ...r,
      contacts: { phone: null, email: 'altro@negozio-prova.example.it', emailKind: 'generic', fax: null },
    });
    const { rows } = await db.query<{ phone: string; fax: string; email: string; email_source: string }>(
      'SELECT phone, fax, email, email_source FROM businesses WHERE id = $1',
      [id],
    );
    expect(rows[0]).toEqual({
      phone: '06 4444444',
      fax: '06 5555555',
      email: 'info.recapiti@gmail.com',
      email_source: 'website',
    });
  });
});
