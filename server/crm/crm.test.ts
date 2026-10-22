import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from '../db/client.ts';
import { mergeCandidate } from '../discovery/businesses.ts';
import { saveRecord } from '../discovery/store.ts';
import { activeConfig, scoreBusinesses } from '../scoring/store.ts';
import { client, createTestUser, startTestServer, testDatabase, type TestServer } from '../testing.ts';
import { todayInRome } from './model.ts';

/*
 * CRM (Fase 7) sul server reale e su un database di prova. Aziende di prova create con il salvataggio reale
 * della scoperta (nomi "di Prova", nessun dato reale); nessun servizio esterno.
 */

const PASSWORD = 'password-di-prova-lunga';
let db: Db;
let server: TestServer;
let adminId: string;
let n = 0;

type Client = ReturnType<typeof client>;

/** Azienda di prova salvata come farebbe una ricerca. */
async function business(
  name: string,
  opts: { sector?: string; municipality?: string; website?: string; lat?: number } = {},
): Promise<string> {
  n++;
  const r = await db.transaction((tx) =>
    saveRecord(
      tx,
      {
        provider: 'osm',
        ref: `node/${8_800_000_000 + n}`,
        sourceUrl: `https://www.openstreetmap.org/node/${8_800_000_000 + n}`,
        name,
        category: 'ristorazione',
        websiteUrl: opts.website ?? null,
        websiteDomain: opts.website ? new URL(opts.website).host : null,
        websiteShared: false,
        sector: opts.sector ?? 'ristoranti',
        contacts: { phone: null, email: null, emailKind: null },
        address: { street: null, housenumber: null, postcode: null, city: null },
        municipalityCode: opts.municipality ?? '058091',
        latitude: opts.lat ?? 41.8 + n * 0.01,
        longitude: 12.4,
        has: { website: Boolean(opts.website), address: false, phone: false, email: false, openingHours: false },
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

/** Punteggio del lead di prova (Fase 4), scritto come snapshot corrente. */
async function score(businessId: string, value: number) {
  const config = await activeConfig(db);
  await db.query('UPDATE lead_scores SET is_current = false WHERE business_id = $1', [businessId]);
  await db.query(
    `INSERT INTO lead_scores (business_id, algorithm_version, config_version, input_hash, status, score, raw_score, band,
       confidence, confidence_level, completeness, breakdown, explanation, next_step, trigger)
     VALUES ($1, 1, $2, $3, 'ranked', $4, $6, $5, 70, 'medium', 60, '{}', 'Punteggio di prova', 'Verifica', 'manual')`,
    [businessId, config.version, 'a'.repeat(64), value, value >= 70 ? 'A' : value >= 50 ? 'B' : 'C', value.toFixed(2)],
  );
}

beforeAll(async () => {
  db = await testDatabase();
  server = await startTestServer(db);
  adminId = (await createTestUser(db, { email: 'crm.admin@noventra.test', role: 'admin', password: PASSWORD })).id;
  await createTestUser(db, { email: 'crm.sales@noventra.test', role: 'sales', password: PASSWORD });
});
afterAll(async () => {
  await server.close();
  await db.close();
});

async function login(email = 'crm.admin@noventra.test', url = server.url): Promise<Client> {
  const c = client(url);
  expect((await c.request('POST', '/api/auth/login', { email, password: PASSWORD })).status).toBe(200);
  return c;
}

const create = (c: Client, businessId: string, extra: Record<string, unknown> = {}) =>
  c.request('POST', '/api/crm/opportunities', { businessId, ...extra });
const stage = (c: Client, id: string, body: Record<string, unknown>) =>
  c.request('POST', `/api/crm/opportunities/${id}/stage`, body);
const tomorrow = () => {
  const d = new Date(`${todayInRome()}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
};

describe('CRM', () => {
  it('crea un’opportunità per un’azienda esistente, senza copiarne i dati; cronologia con la creazione', async () => {
    const c = await login();
    const b = await business('Trattoria CRM di Prova');
    const r = await create(c, b, { priority: 'alta', estimatedValue: 2500.5, services: ['sviluppo_siti_web'] });
    expect(r.status).toBe(201);
    const o = r.body.opportunity;
    expect(o).toMatchObject({ stage: 'da_qualificare', priority: 'alta', estimatedValue: 2500.5, open: true });
    expect(o.business).toMatchObject({ id: b, name: 'Trattoria CRM di Prova' });
    expect(o.services).toEqual([{ id: 'sviluppo_siti_web', name: expect.any(String) }]);
    expect(o.owner.id).toBe(adminId);
    expect(r.body.activities).toHaveLength(1);
    expect(r.body.activities[0]).toMatchObject({
      type: 'stage_change',
      summary: 'Opportunità creata in «Da qualificare»',
    });
    // nessuna nuova azienda: l'opportunità fa riferimento a quella esistente
    expect(
      (await db.query('SELECT count(*)::int AS n FROM businesses WHERE name = $1', ['Trattoria CRM di Prova'])).rows[0],
    ).toEqual({
      n: 1,
    });
  });

  it('una sola opportunità aperta per azienda; dopo la chiusura se ne può creare un’altra, non riaprire due volte', async () => {
    const c = await login();
    const b = await business('Bar Unico di Prova');
    const first = (await create(c, b)).body.opportunity.id;
    const dup = await create(c, b);
    expect(dup.status).toBe(409);
    expect(dup.body.error).toMatchObject({ code: 'OPPORTUNITY_EXISTS', data: { opportunityId: first } });
    expect((await stage(c, first, { stage: 'perso', lostReason: 'Ha già un fornitore' })).status).toBe(200);
    const second = await create(c, b);
    expect(second.status).toBe(201);
    // riaprire la prima ora creerebbe due opportunità aperte
    const reopen = await stage(c, first, { stage: 'da_contattare' });
    expect(reopen.status).toBe(409);
    expect(reopen.body.error.code).toBe('OPPORTUNITY_EXISTS');
    // la scheda dell'azienda indica l'opportunità aperta
    const detail = await c.request('GET', `/api/businesses/${b}`);
    expect(detail.body.business.crm).toEqual({
      opportunityId: second.body.opportunity.id,
      stage: 'da_qualificare',
      open: true,
    });
  });

  it('cambio di fase registrato nella cronologia; "perso" richiede il motivo; chiudere annulla i follow-up in attesa', async () => {
    const c = await login();
    const id = (await create(c, await business('Pizzeria Fasi di Prova'))).body.opportunity.id;
    expect((await stage(c, id, { stage: 'primo_contatto', note: 'Telefonato in mattinata' })).status).toBe(200);
    expect((await stage(c, id, { stage: 'primo_contatto' })).body.error.code).toBe('SAME_STAGE');
    const f = await c.request('POST', `/api/crm/opportunities/${id}/followups`, {
      description: 'Richiamare',
      dueDate: tomorrow(),
    });
    expect(f.status).toBe(201);
    const noReason = await stage(c, id, { stage: 'perso' });
    expect(noReason.status).toBe(400);
    expect(noReason.body.error.code).toBe('LOST_REASON_REQUIRED');
    const lost = await stage(c, id, { stage: 'perso', lostReason: 'Budget non disponibile' });
    expect(lost.body).toMatchObject({ cancelledFollowUps: 1 });
    expect(lost.body.opportunity).toMatchObject({ stage: 'perso', open: false, lostReason: 'Budget non disponibile' });
    expect(lost.body.opportunity.closedAt).not.toBeNull();
    const changes = lost.body.activities.filter((a: { type: string }) => a.type === 'stage_change');
    expect(changes.map((a: { summary: string }) => a.summary)).toEqual([
      'Primo contatto effettuato → Perso',
      'Da qualificare → Primo contatto effettuato',
      'Opportunità creata in «Da qualificare»',
    ]);
    expect(changes[0].notes).toContain('Motivo: Budget non disponibile');
    expect(changes[0].notes).toContain('1 follow-up in attesa annullati');
    expect(lost.body.followUps[0]).toMatchObject({ status: 'cancelled' });
    // riapertura: torna aperta, motivo e data di chiusura azzerati, registrata
    const reopened = await stage(c, id, { stage: 'interessato' });
    expect(reopened.body.opportunity).toMatchObject({
      stage: 'interessato',
      open: true,
      lostReason: null,
      closedAt: null,
    });
  });

  it('note e campi commerciali; attività manuali modificabili solo da chi le ha registrate (o da un amministratore)', async () => {
    const admin = await login();
    const sales = await login('crm.sales@noventra.test');
    const id = (await create(sales, await business('Gelateria Note di Prova'))).body.opportunity.id;
    const patched = await sales.request('PATCH', `/api/crm/opportunities/${id}`, {
      notes: 'Titolare disponibile il martedì',
      estimatedValue: 1200,
      priority: 'bassa',
    });
    expect(patched.status).toBe(200);
    expect(patched.body.opportunity).toMatchObject({
      notes: 'Titolare disponibile il martedì',
      estimatedValue: 1200,
      priority: 'bassa',
    });
    const edited = await sales.request('PATCH', `/api/crm/opportunities/${id}`, {
      notes: 'Preferisce essere contattato via email',
    });
    expect(edited.body.opportunity.notes).toBe('Preferisce essere contattato via email');
    // la fase non cambia modificando i campi commerciali
    expect(edited.body.opportunity.stage).toBe('da_qualificare');

    const added = await sales.request('POST', `/api/crm/opportunities/${id}/activities`, {
      type: 'call',
      occurredAt: new Date(Date.now() - 3_600_000).toISOString(),
      summary: 'Telefonata conoscitiva',
      notes: 'Interessati a un preventivo',
    });
    expect(added.status).toBe(201);
    const call = added.body.activities.find((a: { type: string }) => a.type === 'call');
    expect(call).toMatchObject({ summary: 'Telefonata conoscitiva', user: { name: expect.any(String) } });
    // un altro commerciale non può modificarla; l'autore sì; un amministratore sì
    const otherSales = await createTestUser(db, {
      email: 'crm.sales2@noventra.test',
      role: 'sales',
      password: PASSWORD,
    });
    void otherSales;
    const sales2 = await login('crm.sales2@noventra.test');
    expect((await sales2.request('PATCH', `/api/crm/activities/${call.id}`, { summary: 'x' })).status).toBe(403);
    expect(
      (await sales.request('PATCH', `/api/crm/activities/${call.id}`, { summary: 'Telefonata conoscitiva (15 min)' }))
        .status,
    ).toBe(200);
    expect((await admin.request('PATCH', `/api/crm/activities/${call.id}`, { notes: null })).status).toBe(200);
    const after = (await sales.request('GET', `/api/crm/opportunities/${id}`)).body.activities.find(
      (a: { id: string }) => a.id === call.id,
    );
    expect(after).toMatchObject({
      summary: 'Telefonata conoscitiva (15 min)',
      notes: null,
      edited: { by: expect.any(String) },
    });
    // i cambi di fase non si modificano; un'attività nel futuro va pianificata come follow-up
    const creation = (await sales.request('GET', `/api/crm/opportunities/${id}`)).body.activities.find(
      (a: { type: string }) => a.type === 'stage_change',
    );
    expect((await admin.request('PATCH', `/api/crm/activities/${creation.id}`, { summary: 'x' })).body.error.code).toBe(
      'NOT_EDITABLE',
    );
    const future = await sales.request('POST', `/api/crm/opportunities/${id}/activities`, {
      type: 'meeting',
      occurredAt: new Date(Date.now() + 86_400_000).toISOString(),
      summary: 'Incontro',
    });
    expect(future.status).toBe(400);
  });

  it('follow-up: creazione, completamento (attività, nessun cambio di fase), annullamento, scadenze passate rifiutate', async () => {
    const c = await login();
    const id = (await create(c, await business('Panificio Follow di Prova'))).body.opportunity.id;
    const past = await c.request('POST', `/api/crm/opportunities/${id}/followups`, {
      description: 'Ieri',
      dueDate: '2020-01-01',
    });
    expect(past.status).toBe(400);
    expect(past.body.error.code).toBe('DATE_IN_PAST');
    expect(
      (await c.request('POST', `/api/crm/opportunities/${id}/followups`, { description: 'x', dueDate: '2026-02-30' }))
        .status,
    ).toBe(400);
    const r = await c.request('POST', `/api/crm/opportunities/${id}/followups`, {
      description: 'Inviare esempi di siti',
      dueDate: tomorrow(),
      dueTime: '10:30',
    });
    const [a] = r.body.followUps;
    expect(a).toMatchObject({ status: 'pending', dueDate: tomorrow(), dueTime: '10:30', overdue: false });
    expect(r.body.opportunity.nextFollowUp).toMatchObject({ id: a.id, description: 'Inviare esempi di siti' });
    const b = (
      await c.request('POST', `/api/crm/opportunities/${id}/followups`, {
        description: 'Seconda azione',
        dueDate: tomorrow(),
      })
    ).body.followUps.find((f: { description: string }) => f.description === 'Seconda azione');

    expect((await c.request('POST', `/api/crm/followups/${a.id}/complete`, { note: 'Inviati 3 esempi' })).status).toBe(
      200,
    );
    expect((await c.request('POST', `/api/crm/followups/${a.id}/complete`, {})).body.error.code).toBe('NOT_PENDING');
    expect((await c.request('POST', `/api/crm/followups/${b.id}/cancel`, {})).status).toBe(200);
    const detail = (await c.request('GET', `/api/crm/opportunities/${id}`)).body;
    expect(detail.opportunity.stage).toBe('da_qualificare');
    expect(detail.opportunity.nextFollowUp).toBeNull();
    expect(detail.followUps.find((f: { id: string }) => f.id === a.id)).toMatchObject({
      status: 'completed',
      completedAt: expect.any(String),
    });
    expect(detail.followUps.find((f: { id: string }) => f.id === b.id)).toMatchObject({ status: 'cancelled' });
    expect(detail.activities[0]).toMatchObject({
      type: 'follow_up',
      summary: 'Follow-up completato: Inviare esempi di siti',
      notes: 'Inviati 3 esempi',
    });
    const completed = await c.request('GET', '/api/crm/followups?view=completed');
    expect(completed.status, JSON.stringify(completed.body)).toBe(200);
    expect(completed.body.items.some((f: { id: string }) => f.id === a.id)).toBe(true);
  });

  it('follow-up scaduti e di oggi: viste, filtro dell’elenco e dashboard', async () => {
    const c = await login();
    const id = (await create(c, await business('Enoteca Scaduta di Prova'))).body.opportunity.id;
    // una scadenza passata non si può creare dall'API: la si porta indietro come se fosse rimasta in sospeso
    await c.request('POST', `/api/crm/opportunities/${id}/followups`, {
      description: 'Richiamare',
      dueDate: tomorrow(),
    });
    await db.query("UPDATE crm_followups SET due_date = (now() - interval '3 days')::date WHERE opportunity_id = $1", [
      id,
    ]);
    await c.request('POST', `/api/crm/opportunities/${id}/followups`, { description: 'Oggi', dueDate: todayInRome() });
    const overdue = await c.request('GET', '/api/crm/followups?view=overdue');
    expect(overdue.body.items.map((f: { opportunityId: string }) => f.opportunityId)).toContain(id);
    expect(overdue.body.items.find((f: { opportunityId: string }) => f.opportunityId === id)).toMatchObject({
      overdue: true,
      business: { name: 'Enoteca Scaduta di Prova' },
    });
    const today = await c.request('GET', '/api/crm/followups?view=today');
    expect(today.body.items.find((f: { opportunityId: string }) => f.opportunityId === id)).toMatchObject({
      dueToday: true,
    });
    const list = await c.request('GET', '/api/crm/opportunities?followUp=overdue');
    expect(list.body.items.map((o: { id: string }) => o.id)).toEqual([id]);
    expect(list.body.items[0].nextFollowUp).toMatchObject({ overdue: true });
    const d = await c.request('GET', '/api/crm/dashboard');
    expect(d.body.followUps.overdue).toBe(1);
    expect(d.body.followUps.today).toBeGreaterThanOrEqual(1);
  });

  it('dashboard: conteggi dalle righe reali; valori solo se inseriti; le chiuse escluse dal valore attivo', async () => {
    const fresh = await testDatabase();
    const s = await startTestServer(fresh);
    try {
      await createTestUser(fresh, { email: 'crm.admin@noventra.test', role: 'admin', password: PASSWORD });
      const c = await login('crm.admin@noventra.test', s.url);
      const empty = (await c.request('GET', '/api/crm/dashboard')).body;
      expect(empty).toMatchObject({
        total: 0,
        active: 0,
        activeValue: { euro: null, withValue: 0 },
        wonValue: { euro: null },
      });
      const prev = db;
      db = fresh;
      const ids = [];
      for (const name of ['A', 'B', 'C', 'D', 'E']) ids.push(await business(`Dashboard ${name} di Prova`));
      db = prev;
      const opp = async (b: string, value?: number) =>
        (await create(c, b, value === undefined ? {} : { estimatedValue: value })).body.opportunity.id;
      const a = await opp(ids[0]!, 1000);
      const b = await opp(ids[1]!, 500.25);
      const d = await opp(ids[2]!);
      const w = await opp(ids[3]!, 3000);
      const l = await opp(ids[4]!, 9999);
      await stage(c, b, { stage: 'da_contattare' });
      await stage(c, d, { stage: 'appuntamento' });
      await stage(c, w, { stage: 'vinto' });
      await stage(c, l, { stage: 'perso', lostReason: 'Scelto un altro fornitore' });
      void a;
      const r = (await c.request('GET', '/api/crm/dashboard')).body;
      expect(r).toMatchObject({
        total: 5,
        active: 3,
        toQualify: 1,
        readyToContact: 1,
        meetings: 1,
        quotes: 0,
        won: 1,
        lost: 1,
        doNotContact: 0,
        // 1000 + 500,25: vinto e perso esclusi dal valore della pipeline attiva
        activeValue: { euro: 1500.25, withValue: 2 },
        wonValue: { euro: 3000, withValue: 1 },
      });
      expect(r.byStage.find((x: { id: string }) => x.id === 'vinto').count).toBe(1);
    } finally {
      await s.close();
      await fresh.close();
    }
  });

  it('filtri per fase, settore, territorio, punteggio e priorità; Kanban per fase senza caricare tutto', async () => {
    const c = await login();
    const milano = await business('Hotel Filtro di Prova', { sector: 'hotel', municipality: '015146' });
    const roma = await business('Ristorante Filtro di Prova', { sector: 'ristoranti', municipality: '058091' });
    await score(milano, 82);
    await score(roma, 41);
    const m = (await create(c, milano, { priority: 'alta' })).body.opportunity.id;
    const r = (await create(c, roma)).body.opportunity.id;
    await stage(c, m, { stage: 'preventivo' });
    const ids = async (query: string) =>
      (await c.request('GET', `/api/crm/opportunities?q=filtro%20di%20prova&${query}`)).body.items.map(
        (o: { id: string }) => o.id,
      );
    expect(await ids('stage=preventivo')).toEqual([m]);
    expect(await ids('sector=ristoranti')).toEqual([r]);
    expect(await ids('region=03')).toEqual([m]);
    expect(await ids('municipality=058091')).toEqual([r]);
    expect(await ids('minScore=70')).toEqual([m]);
    expect(await ids('crmPriority=alta')).toEqual([m]);
    expect(await ids('sort=score&dir=desc')).toEqual([m, r]);
    // il punteggio è mostrato accanto alla priorità commerciale, distinti
    const item = (await c.request('GET', `/api/crm/opportunities?q=hotel%20filtro`)).body.items[0];
    expect(item).toMatchObject({ priority: 'alta', business: { lead: { score: 82 } } });
    expect((await c.request('GET', '/api/crm/opportunities?stage=inventata')).status).toBe(400);
    const board = await c.request('GET', '/api/crm/board?q=filtro%20di%20prova&perStage=1');
    const col = (id: string) => board.body.stages.find((s: { id: string }) => s.id === id);
    expect(col('preventivo')).toMatchObject({ total: 1, items: [{ id: m }] });
    expect(col('da_qualificare')).toMatchObject({ total: 1, items: [{ id: r }] });
    expect(board.body.stages).toHaveLength(11);
  });

  it('aggiunta in blocco: aggiunte, saltate (già aperte, escluse), non riuscite; ripetere non crea doppioni', async () => {
    const c = await login();
    const fresh1 = await business('Blocco Uno di Prova');
    const fresh2 = await business('Blocco Due di Prova');
    const already = await business('Blocco Aperta di Prova');
    const excluded = await business('Blocco Esclusa di Prova');
    const existing = (await create(c, already)).body.opportunity.id;
    await c.request('POST', `/api/businesses/${excluded}/exclusion`, { excluded: true, reason: 'Già cliente' });
    const missing = '00000000-0000-4000-8000-000000000000';
    const r = await c.request('POST', '/api/crm/opportunities/bulk', {
      businessIds: [fresh1, fresh2, fresh1, already, excluded, missing],
    });
    expect(r.status).toBe(200);
    expect(r.body.created.map((x: { businessId: string }) => x.businessId).sort()).toEqual([fresh1, fresh2].sort());
    expect(r.body.skipped).toEqual([
      expect.objectContaining({ businessId: already, reason: 'OPPORTUNITY_EXISTS', opportunityId: existing }),
      expect.objectContaining({ businessId: excluded, reason: 'BUSINESS_EXCLUDED' }),
    ]);
    expect(r.body.failed).toEqual([expect.objectContaining({ businessId: missing, reason: 'BUSINESS_NOT_FOUND' })]);
    const again = await c.request('POST', '/api/crm/opportunities/bulk', { businessIds: [fresh1, fresh2] });
    expect(again.body.created).toEqual([]);
    expect(again.body.skipped).toHaveLength(2);
    const { rows } = await db.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM crm_opportunities WHERE business_id = ANY($1)',
      [[fresh1, fresh2]],
    );
    expect(rows[0]!.n).toBe(2);
    // Lead Hunter: elenco delle aziende con il filtro CRM e lo stato dell'opportunità
    const none = await c.request('GET', '/api/businesses?q=blocco&crm=none&excluded=include');
    expect(none.body.items.map((b: { id: string }) => b.id)).toEqual([excluded]);
    const open = await c.request('GET', '/api/businesses?q=blocco&crm=open&pageSize=10');
    expect(open.body.items).toHaveLength(3);
    expect(open.body.items[0].crm).toMatchObject({ open: true, stage: 'da_qualificare' });
    expect((await c.request('POST', '/api/crm/opportunities/bulk', { businessIds: [] })).status).toBe(400);
  });

  it('"non contattare" esclude l’azienda; riaprire richiede di reincluderla; nuove opportunità bloccate', async () => {
    const c = await login();
    const b = await business('Studio Non Contattare di Prova');
    const id = (await create(c, b)).body.opportunity.id;
    const r = await stage(c, id, { stage: 'non_contattare', note: 'Richiesta del titolare' });
    expect(r.status).toBe(200);
    expect(r.body.opportunity.business.excluded).toMatchObject({
      reason: 'CRM: non contattare — Richiesta del titolare',
    });
    expect((await create(c, b)).body.error.code).toBe('BUSINESS_EXCLUDED');
    expect((await stage(c, id, { stage: 'da_contattare' })).body.error.code).toBe('BUSINESS_EXCLUDED');
    await c.request('POST', `/api/businesses/${b}/exclusion`, { excluded: false });
    expect((await stage(c, id, { stage: 'da_contattare' })).status).toBe(200);
  });

  it('punteggi e audit restano invariati quando cambia il CRM; un ricalcolo del punteggio non tocca il CRM', async () => {
    const c = await login();
    const b = await business('Osteria Integra di Prova');
    await score(b, 66);
    const before = (await db.query('SELECT * FROM lead_scores WHERE business_id = $1 ORDER BY calculated_at', [b]))
      .rows;
    const id = (await create(c, b, { priority: 'alta', estimatedValue: 800, notes: 'Nota manuale' })).body.opportunity
      .id;
    await stage(c, id, { stage: 'interessato' });
    await c.request('PATCH', `/api/crm/opportunities/${id}`, { priority: 'bassa' });
    expect(
      (await db.query('SELECT * FROM lead_scores WHERE business_id = $1 ORDER BY calculated_at', [b])).rows,
    ).toEqual(before);
    await scoreBusinesses(db, [b], { trigger: 'manual', force: true });
    const o = (await c.request('GET', `/api/crm/opportunities/${id}`)).body.opportunity;
    expect(o).toMatchObject({ stage: 'interessato', priority: 'bassa', estimatedValue: 800, notes: 'Nota manuale' });
  });

  it('validazione e autorizzazione', async () => {
    const anon = client(server.url);
    expect((await anon.request('GET', '/api/crm/opportunities')).status).toBe(401);
    expect((await anon.request('GET', '/api/crm/dashboard')).status).toBe(401);
    const c = await login();
    const b = await business('Validazione di Prova');
    const bad = async (body: Record<string, unknown>) => (await create(c, b, body)).status;
    expect(await bad({ estimatedValue: -1 })).toBe(400);
    expect(await bad({ estimatedValue: 10.123 })).toBe(400);
    expect(await bad({ stage: 'vinto' })).toBe(400);
    expect(await bad({ priority: 'urgentissima' })).toBe(400);
    expect(await bad({ ownerId: '00000000-0000-4000-8000-000000000000' })).toBe(400);
    const svc = await create(c, b, { services: ['servizio_inventato'] });
    expect(svc.body.error.code).toBe('UNKNOWN_SERVICE');
    expect((await c.request('POST', '/api/crm/opportunities', { businessId: 'non-un-id' })).status).toBe(400);
    expect((await c.request('POST', '/api/crm/opportunities', { businessId: b, extra: 1 })).status).toBe(400);
    expect((await c.request('GET', '/api/crm/opportunities/00000000-0000-4000-8000-000000000000')).status).toBe(404);
    // modifica da un'altra origine: rifiutata (protezione CSRF comune)
    const id = (await create(c, b)).body.opportunity.id;
    const foreign = await c.request(
      'PATCH',
      `/api/crm/opportunities/${id}`,
      { priority: 'alta' },
      { Origin: 'https://evil.example' },
    );
    expect(foreign.status).toBe(403);
  });

  it('aziende mancanti o unite: errore chiaro; l’unione dei duplicati sposta l’opportunità sull’azienda mantenuta', async () => {
    const c = await login();
    const missing = await create(c, '00000000-0000-4000-8000-000000000001');
    expect(missing.status).toBe(404);
    expect(missing.body.error.code).toBe('BUSINESS_NOT_FOUND');
    const keep = await business('Unione di Prova', { lat: 45.1 });
    const drop = await business('Unione di Prova', { lat: 45.1001 });
    const { rows } = await db.query<{ id: string }>(
      'SELECT id FROM duplicate_candidates WHERE (business_a = $1 AND business_b = $2) OR (business_a = $2 AND business_b = $1)',
      [keep, drop],
    );
    const id = (await create(c, drop)).body.opportunity.id;
    await mergeCandidate(db, rows[0]!.id, keep, adminId);
    const o = (await c.request('GET', `/api/crm/opportunities/${id}`)).body.opportunity;
    expect(o.business.id).toBe(keep);
    const merged = await create(c, drop);
    expect(merged.body.error).toMatchObject({ code: 'BUSINESS_MERGED', data: { mergedInto: keep } });
  });

  it('i dati restano dopo il riavvio del server', async () => {
    const c = await login();
    const b = await business('Persistenza di Prova');
    const id = (await create(c, b, { notes: 'Da ricordare' })).body.opportunity.id;
    await c.request('POST', `/api/crm/opportunities/${id}/followups`, {
      description: 'Richiamare',
      dueDate: tomorrow(),
    });
    await server.close();
    server = await startTestServer(db);
    const again = await login();
    const d = (await again.request('GET', `/api/crm/opportunities/${id}`)).body;
    expect(d.opportunity).toMatchObject({ notes: 'Da ricordare', business: { id: b } });
    expect(d.followUps).toHaveLength(1);
  });
});
