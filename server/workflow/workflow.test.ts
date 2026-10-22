import { crc32 } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { todayInRome } from '../crm/model.ts';
import type { Db } from '../db/client.ts';
import { saveRecord } from '../discovery/store.ts';
import { csvCell, readAll } from '../exports/format.ts';
import { xlsx } from '../exports/xlsx.ts';
import { activeConfig } from '../scoring/store.ts';
import { client, createTestUser, startTestServer, testDatabase, type TestServer } from '../testing.ts';
import { syncReminders } from './reminders.ts';
import { observations, periodRange } from './reports.ts';
import { canonicalQuery } from './savedFilters.ts';

/*
 * Fase 8 sul server reale e su un database di prova: esportazioni CSV e XLSX, follow-up, promemoria, filtri salvati,
 * report commerciali. Aziende di prova salvate come farebbe una ricerca (nomi "di Prova"); nessun servizio esterno.
 */

const PASSWORD = 'password-di-prova-lunga';
let db: Db;
let server: TestServer;
let adminId: string;
let salesId: string;
let n = 0;

type Client = ReturnType<typeof client>;

async function business(name: string, opts: { sector?: string; phone?: string } = {}): Promise<string> {
  n++;
  const r = await db.transaction((tx) =>
    saveRecord(
      tx,
      {
        provider: 'osm',
        ref: `node/${7_700_000_000 + n}`,
        sourceUrl: `https://www.openstreetmap.org/node/${7_700_000_000 + n}`,
        name,
        category: 'ristorazione',
        websiteUrl: null,
        websiteDomain: null,
        websiteShared: false,
        sector: opts.sector ?? 'ristoranti',
        contacts: { phone: opts.phone ?? null, email: null, emailKind: null },
        address: { street: null, housenumber: null, postcode: null, city: null },
        municipalityCode: '058091',
        latitude: 40 + n * 0.01,
        longitude: 13,
        has: { website: false, address: false, phone: Boolean(opts.phone), email: false, openingHours: false },
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
  adminId = (await createTestUser(db, { email: 'wf.admin@noventra.test', role: 'admin', password: PASSWORD })).id;
  salesId = (await createTestUser(db, { email: 'wf.sales@noventra.test', role: 'sales', password: PASSWORD })).id;
});
afterAll(async () => {
  await server.close();
  await db.close();
});

async function login(email = 'wf.admin@noventra.test'): Promise<Client> {
  const c = client(server.url);
  expect((await c.request('POST', '/api/auth/login', { email, password: PASSWORD })).status).toBe(200);
  return c;
}

const addDays = (d: string, k: number) => {
  const t = new Date(`${d}T12:00:00Z`);
  t.setUTCDate(t.getUTCDate() + k);
  return t.toISOString().slice(0, 10);
};

async function opportunity(c: Client, businessId: string, extra: Record<string, unknown> = {}): Promise<string> {
  const r = await c.request('POST', '/api/crm/opportunities', { businessId, ...extra });
  expect(r.status).toBe(201);
  return r.body.opportunity.id;
}

async function followUp(c: Client, oppId: string, body: Record<string, unknown>): Promise<string> {
  const r = await c.request('POST', `/api/crm/opportunities/${oppId}/followups`, {
    description: 'Richiamare',
    dueDate: addDays(todayInRome(), 3),
    ...body,
  });
  expect(r.status).toBe(201);
  const f = r.body.followUps.find((x: { description: string }) => x.description === (body.description ?? 'Richiamare'));
  return f.id;
}

/** Scadenza nel passato: l'API la rifiuta, quindi si sposta direttamente nel database. */
const backdate = (followUpId: string, days: number) =>
  db.query('UPDATE crm_followups SET due_date = $2::date WHERE id = $1', [followUpId, addDays(todayInRome(), -days)]);

async function download(c: Client, path: string) {
  const res = await fetch(server.url + path, { headers: { Cookie: c.cookie } });
  return { status: res.status, headers: res.headers, buf: Buffer.from(await res.arrayBuffer()) };
}

/** CSV con separatore ";" e virgolette (RFC 4180), senza BOM. */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ';') {
      row.push(cell);
      cell = '';
    } else if (ch === '\r' && text[i + 1] === '\n') {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
      i++;
    } else cell += ch;
  }
  return rows;
}

/** Lettura di un archivio ZIP "store" con verifica del CRC di ogni file. */
function unzip(buf: Buffer): Map<string, string> {
  const files = new Map<string, string>();
  let p = 0;
  while (buf.readUInt32LE(p) === 0x04034b50) {
    const method = buf.readUInt16LE(p + 8);
    const crc = buf.readUInt32LE(p + 14);
    const size = buf.readUInt32LE(p + 18);
    const nameLen = buf.readUInt16LE(p + 26);
    const extraLen = buf.readUInt16LE(p + 28);
    const name = buf.subarray(p + 30, p + 30 + nameLen).toString('utf8');
    const data = buf.subarray(p + 30 + nameLen + extraLen, p + 30 + nameLen + extraLen + size);
    expect(method).toBe(0);
    expect(crc32(data) >>> 0).toBe(crc);
    files.set(name, data.toString('utf8'));
    p += 30 + nameLen + extraLen + size;
  }
  expect(buf.readUInt32LE(p)).toBe(0x02014b50); // directory centrale
  return files;
}

describe('esportazioni', () => {
  it('CSV aziende: intestazioni in italiano, UTF-8 con BOM, filtri applicati, formule neutralizzate, nome del file', async () => {
    const c = await login();
    const a = await business('=HYPERLINK("http://x") Bar di Prova', { phone: '+39 06 1234567' });
    const b = await business('Caffè Perù di Prova');
    await business('Panificio Escluso di Prova', { sector: 'panifici' });
    await score(a, 80);
    await score(b, 40);
    const r = await download(c, '/api/businesses/export?sector=ristoranti&q=di%20Prova');
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toBe('text/csv; charset=utf-8');
    expect(r.headers.get('content-disposition')).toMatch(/filename="aziende_noventra_\d{4}-\d{2}-\d{2}\.csv"/);
    expect([...r.buf.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    const rows = parseCsv(r.buf.toString('utf8').slice(1));
    expect(rows[0]!.slice(0, 3)).toEqual(['Azienda', 'Settore', 'Categoria']);
    const names = rows.slice(1).map((x) => x[0]);
    expect(names).toContain('Caffè Perù di Prova');
    expect(names).not.toContain('Panificio Escluso di Prova');
    // la formula diventa testo: apostrofo davanti
    expect(names).toContain(`'=HYPERLINK("http://x") Bar di Prova`);
    expect(r.headers.get('x-export-rows')).toBe(String(rows.length - 1));
    // il telefono che inizia con "+" è neutralizzato come formula
    const phoneCol = rows[0]!.indexOf('Telefono (pubblico)');
    expect(rows.find((x) => x[0]!.includes('HYPERLINK'))![phoneCol]).toBe("'+39 06 1234567");
    // nessuna colonna con credenziali o dati degli utenti
    expect(rows[0]!.join(' ')).not.toMatch(/password|hash|token|chiave/i);
  });

  it('colonne scelte, nome del file personalizzato, colonne sconosciute rifiutate, elenco vuoto con sole intestazioni', async () => {
    const c = await login();
    const r = await download(c, '/api/businesses/export?fields=name,municipality&name=prospect&q=di%20Prova');
    expect(r.headers.get('content-disposition')).toMatch(/filename="prospect_noventra_\d{4}-\d{2}-\d{2}\.csv"/);
    const rows = parseCsv(r.buf.toString('utf8').slice(1));
    expect(rows[0]).toEqual(['Azienda', 'Comune']);
    const bad = await download(c, '/api/businesses/export?fields=name,password_hash');
    expect(bad.status).toBe(400);
    expect(bad.buf.toString()).toContain('Colonne sconosciute');
    const empty = await download(c, '/api/businesses/export?q=nessuna-azienda-con-questo-nome');
    expect(empty.status).toBe(200);
    expect(parseCsv(empty.buf.toString('utf8').slice(1))).toHaveLength(1);
    expect(empty.headers.get('x-export-rows')).toBe('0');
  });

  it('esporta tutte le righe dei filtri, non solo la pagina visibile (lettura a blocchi)', async () => {
    const pages: number[] = [];
    const all = await readAll(async (limit, offset) => {
      pages.push(offset);
      return Array.from({ length: Math.max(0, Math.min(limit, 2500 - offset)) }, (_, i) => offset + i);
    });
    expect(all.rows).toHaveLength(2500);
    expect(all.truncated).toBe(false);
    expect(pages).toEqual([0, 1000, 2000]);
    expect(new Set(all.rows).size).toBe(2500);
    // oltre il limite: le prime 10.000 righe e l'avviso di troncamento
    const big = await readAll(async (limit, offset) =>
      Array.from({ length: Math.max(0, Math.min(limit, 10_500 - offset)) }, (_, i) => offset + i),
    );
    expect(big.rows).toHaveLength(10_000);
    expect(big.truncated).toBe(true);
  });

  it('XLSX valido: archivio integro, foglio con intestazione e testo non interpretato come formula', async () => {
    const c = await login();
    const r = await download(c, '/api/businesses/export?format=xlsx&q=di%20Prova');
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toBe('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    expect(r.headers.get('content-disposition')).toMatch(/\.xlsx"/);
    const files = unzip(r.buf);
    expect([...files.keys()]).toEqual(
      expect.arrayContaining(['[Content_Types].xml', 'xl/workbook.xml', 'xl/worksheets/sheet1.xml']),
    );
    const sheet = files.get('xl/worksheets/sheet1.xml')!;
    expect(sheet).toContain('<t xml:space="preserve">Azienda</t>');
    expect(sheet).toContain('Caffè Perù di Prova');
    expect(sheet).toContain('=HYPERLINK(&quot;http://x&quot;) Bar di Prova');
    expect(sheet).not.toContain('<f>');
  });

  it('XLSX: caratteri di controllo rimossi, numeri come numeri, fogli con nomi validi', () => {
    const files = unzip(
      xlsx([
        { name: 'Vinto: [ok]?', header: ['A', 'B'], rows: [['a\u0001b <&>', 12.5]] },
        { name: 'Vinto: [ok]?', header: ['A'], rows: [] },
      ]),
    );
    const wb = files.get('xl/workbook.xml')!;
    expect(wb).toContain('name="Vinto   ok"');
    expect(wb).toContain('name="Vinto   ok 2"');
    const s1 = files.get('xl/worksheets/sheet1.xml')!;
    expect(s1).toContain('ab &lt;&amp;&gt;');
    expect(s1).toContain('<v>12.5</v>');
    expect(csvCell('-2+3')).toBe("'-2+3");
    expect(csvCell('@SUM(A1)')).toBe("'@SUM(A1)");
    expect(csvCell('a;b')).toBe('"a;b"');
  });

  it('opportunità (anche per fase in fogli separati), follow-up e attività con i filtri dell’elenco', async () => {
    const c = await login();
    const o1 = await opportunity(c, await business('Osteria Export di Prova'), {
      stage: 'interessato',
      estimatedValue: 1200,
    });
    const o2 = await opportunity(c, await business('Pizzeria Export di Prova'), { stage: 'da_contattare' });
    await followUp(c, o1, { description: 'Inviare preventivo', priority: 'alta' });
    await followUp(c, o2, { description: 'Prima telefonata', priority: 'bassa' });

    const csv = await download(c, '/api/crm/opportunities/export?stage=interessato');
    const rows = parseCsv(csv.buf.toString('utf8').slice(1));
    expect(rows[0]).toContain('Fase');
    expect(rows.slice(1).map((r) => r[0])).toEqual(['Osteria Export di Prova']);
    expect(rows[1]![rows[0]!.indexOf('Valore stimato (€)')]).toBe('1200');

    const grouped = await download(c, '/api/crm/opportunities/export?format=xlsx&groupByStage=1&q=Export%20di%20Prova');
    const wb = unzip(grouped.buf).get('xl/workbook.xml')!;
    expect(wb).toContain('name="Da contattare"');
    expect(wb).toContain('name="Interessato"');
    expect(wb).not.toContain('name="Vinto"'); // fasi senza opportunità: nessun foglio vuoto

    const fu = await download(c, '/api/crm/followups/export?priority=alta');
    const fRows = parseCsv(fu.buf.toString('utf8').slice(1));
    expect(fRows[0]).toEqual(expect.arrayContaining(['Titolo', 'Azienda', 'Priorità', 'Stato', 'Scadenza']));
    expect(fRows.slice(1).map((r) => r[0])).toEqual(['Inviare preventivo']);
    expect(fRows[1]![fRows[0]!.indexOf('Stato')]).toBe('Da fare');

    const act = await download(c, `/api/crm/activities/export?from=${todayInRome()}&type=stage_change`);
    const aRows = parseCsv(act.buf.toString('utf8').slice(1));
    expect(aRows.length).toBeGreaterThan(2);
    expect(aRows.slice(1).every((r) => r.includes('Cambio di fase'))).toBe(true);
    const future = await download(c, `/api/crm/activities/export?from=${addDays(todayInRome(), 1)}`);
    expect(parseCsv(future.buf.toString('utf8').slice(1))).toHaveLength(1);

    const cols = await c.request('GET', '/api/exports/columns');
    expect(Object.keys(cols.body)).toEqual(['businesses', 'opportunities', 'followups', 'activities', 'limit']);
    // ogni esportazione è registrata nel registro delle operazioni
    const { rows: logged } = await db.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM audit_log WHERE action = 'leads.exported' AND user_id = $1",
      [adminId],
    );
    expect(logged[0]!.n).toBeGreaterThanOrEqual(8);
  });

  it('esportazioni solo con una sessione', async () => {
    const anon = client(server.url);
    expect((await download(anon, '/api/crm/followups/export')).status).toBe(401);
    expect((await download(anon, '/api/businesses/export')).status).toBe(401);
  });
});

describe('follow-up', () => {
  it('dalla scheda azienda: serve un’opportunità aperta, oppure la conferma di crearla', async () => {
    const c = await login();
    const b = await business('Gelateria Follow-up di Prova');
    const body = { description: 'Prima chiamata', dueDate: addDays(todayInRome(), 2), priority: 'alta' };
    const refused = await c.request('POST', `/api/businesses/${b}/followups`, body);
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe('NO_OPEN_OPPORTUNITY');
    expect((await db.query('SELECT 1 FROM crm_opportunities WHERE business_id = $1', [b])).rows).toHaveLength(0);
    const r = await c.request('POST', `/api/businesses/${b}/followups`, { ...body, createOpportunity: true });
    expect(r.status).toBe(201);
    expect(r.body.createdOpportunity).toBe(true);
    const again = await c.request('POST', `/api/businesses/${b}/followups`, { ...body, description: 'Secondo' });
    expect(again.body).toMatchObject({ createdOpportunity: false, opportunityId: r.body.opportunityId });
    const opp = await c.request('GET', `/api/crm/opportunities/${r.body.opportunityId}`);
    expect(opp.body.opportunity.stage).toBe('da_qualificare');
    expect(opp.body.followUps.map((f: { priority: string }) => f.priority)).toEqual(['alta', 'alta']);
  });

  it('filtri per stato, priorità, scadenza e fase; spostare la scadenza; completare non cambia la fase', async () => {
    const c = await login();
    const b = await business('Enoteca Filtri di Prova');
    const o = await opportunity(c, b, { stage: 'preventivo' });
    const late = await followUp(c, o, { description: 'Scaduto di prova', priority: 'alta' });
    await backdate(late, 2);
    const soon = await followUp(c, o, { description: 'Presto di prova', priority: 'media' });
    const far = await followUp(c, o, {
      description: 'Lontano di prova',
      dueDate: addDays(todayInRome(), 20),
      priority: 'bassa',
    });
    const list = async (q: string) =>
      (await c.request('GET', `/api/crm/followups?business=${b}&${q}`)).body.items.map(
        (f: { description: string }) => f.description,
      );
    expect(await list('due=overdue')).toEqual(['Scaduto di prova']);
    expect(await list('due=soon')).toEqual(['Presto di prova']);
    expect(await list('due=later')).toEqual(['Lontano di prova']);
    expect(await list('priority=alta,bassa')).toEqual(['Scaduto di prova', 'Lontano di prova']);
    expect(await list('stage=preventivo')).toHaveLength(3);
    expect(await list('stage=interessato')).toHaveLength(0);

    // riprogrammare
    expect((await c.request('PATCH', `/api/crm/followups/${far}`, { dueDate: addDays(todayInRome(), 1) })).status).toBe(
      200,
    );
    expect(await list('due=soon')).toEqual(['Lontano di prova', 'Presto di prova']);

    // completare: attività registrata, fase invariata
    expect((await c.request('POST', `/api/crm/followups/${soon}/complete`, {})).status).toBe(200);
    expect(await list('status=completed')).toEqual(['Presto di prova']);
    const opp = await c.request('GET', `/api/crm/opportunities/${o}`);
    expect(opp.body.opportunity.stage).toBe('preventivo');

    // annullare a mano: motivo "manual"
    expect((await c.request('POST', `/api/crm/followups/${late}/cancel`, {})).status).toBe(200);
    const { rows } = await db.query('SELECT status, cancel_reason FROM crm_followups WHERE id = $1', [late]);
    expect(rows[0]).toEqual({ status: 'cancelled', cancel_reason: 'manual' });
  });

  it('chiudere l’opportunità annulla i follow-up in attesa con un motivo distinto, senza cancellarli', async () => {
    const c = await login();
    const o = await opportunity(c, await business('Bistrot Chiusura di Prova'));
    const f = await followUp(c, o, { description: 'Da annullare alla chiusura' });
    expect((await c.request('POST', `/api/crm/opportunities/${o}/stage`, { stage: 'vinto' })).status).toBe(200);
    const { rows } = await db.query('SELECT status, cancel_reason FROM crm_followups WHERE id = $1', [f]);
    expect(rows[0]).toEqual({ status: 'cancelled', cancel_reason: 'opportunity_closed' });
  });
});

describe('promemoria', () => {
  it('scaduti e in scadenza per il responsabile; nessun doppione; si chiudono quando il follow-up cambia', async () => {
    const c = await login();
    const o = await opportunity(c, await business('Trattoria Promemoria di Prova'), { ownerId: salesId });
    const late = await followUp(c, o, { description: 'Promemoria scaduto' });
    await backdate(late, 1);
    const today = await followUp(c, o, { description: 'Promemoria oggi', dueDate: todayInRome() });
    const later = await followUp(c, o, { description: 'Promemoria lontano', dueDate: addDays(todayInRome(), 10) });

    await syncReminders(db);
    const again = await syncReminders(db);
    expect(again.created).toBe(0); // stesso evento, nessun doppione
    const mine = async (id: string) =>
      (
        await db.query<{ kind: string; resolved: boolean }>(
          'SELECT kind, resolved_at IS NOT NULL AS resolved FROM notifications WHERE followup_id = $1 ORDER BY created_at',
          [id],
        )
      ).rows;
    expect(await mine(late)).toEqual([{ kind: 'followup_overdue', resolved: false }]);
    expect(await mine(today)).toEqual([{ kind: 'followup_due_soon', resolved: false }]);
    expect(await mine(later)).toEqual([]);
    const { rows: who } = await db.query('SELECT DISTINCT user_id FROM notifications WHERE opportunity_id = $1', [o]);
    expect(who).toEqual([{ user_id: salesId }]);

    // il commerciale li vede; l'amministratore no (non è il responsabile)
    const sales = await login('wf.sales@noventra.test');
    const list = await sales.request('GET', '/api/notifications');
    expect(list.status).toBe(200);
    const items = list.body.items.filter(
      (x: { business: { name: string } }) => x.business.name === 'Trattoria Promemoria di Prova',
    );
    expect(items.map((x: { kind: string }) => x.kind)).toEqual(['followup_overdue', 'followup_due_soon']);
    expect(list.body.unreadOverdue).toBeGreaterThanOrEqual(1);
    const adminList = await c.request('GET', '/api/notifications');
    expect(adminList.body.items.some((x: { opportunity: { id: string } }) => x.opportunity.id === o)).toBe(false);

    // segnare come letto: solo i propri
    expect((await c.request('POST', `/api/notifications/${items[0].id}/read`, {})).status).toBe(404);
    expect((await sales.request('POST', `/api/notifications/${items[0].id}/read`, {})).status).toBe(200);
    const unread = await sales.request('GET', '/api/notifications?unread=1');
    expect(unread.body.items.some((x: { id: string }) => x.id === items[0].id)).toBe(false);

    // spostare la scadenza: il vecchio promemoria si chiude; oggi -> fra 10 giorni: nessun nuovo promemoria
    await sales.request('PATCH', `/api/crm/followups/${today}`, { dueDate: addDays(todayInRome(), 10) });
    // completare: il promemoria scaduto si chiude
    await sales.request('POST', `/api/crm/followups/${late}/complete`, {});
    const r = await syncReminders(db);
    expect(r.resolved).toBe(2);
    expect(await mine(today)).toEqual([{ kind: 'followup_due_soon', resolved: true }]);
    expect(await mine(late)).toEqual([{ kind: 'followup_overdue', resolved: true }]);

    // riportato a domani: è un evento nuovo, un nuovo promemoria
    await sales.request('PATCH', `/api/crm/followups/${today}`, { dueDate: addDays(todayInRome(), 1) });
    expect((await syncReminders(db)).created).toBe(1);
    expect((await sales.request('POST', '/api/notifications/read-all', {})).body.marked).toBeGreaterThanOrEqual(1);
    expect((await sales.request('GET', '/api/notifications')).body.unread).toBe(0);

    // spostato via e poi di nuovo a domani: lo stesso promemoria si riapre, da leggere (nessun doppione)
    await sales.request('PATCH', `/api/crm/followups/${today}`, { dueDate: addDays(todayInRome(), 10) });
    expect((await syncReminders(db)).resolved).toBe(1);
    await sales.request('PATCH', `/api/crm/followups/${today}`, { dueDate: addDays(todayInRome(), 1) });
    // l'API sincronizza subito dopo una modifica del CRM, senza attendere il minuto
    const reopened = await sales.request('GET', '/api/notifications?unread=1');
    expect(reopened.body.items.filter((x: { followUp: { id: string } }) => x.followUp.id === today)).toHaveLength(1);
    const { rows: same } = await db.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM notifications WHERE followup_id = $1 AND kind = 'followup_due_soon' AND due_date = $2::date",
      [today, addDays(todayInRome(), 1)],
    );
    expect(same[0]!.n).toBe(1);
  });

  it('aprire la pagina non crea promemoria nuovi per lo stesso evento', async () => {
    const c = await login();
    await syncReminders(db);
    const { rows: before } = await db.query<{ n: number }>('SELECT count(*)::int AS n FROM notifications');
    for (let i = 0; i < 3; i++) await c.request('GET', '/api/notifications');
    const { rows: after } = await db.query<{ n: number }>('SELECT count(*)::int AS n FROM notifications');
    expect(after[0]!.n).toBe(before[0]!.n);
  });
});

describe('filtri salvati', () => {
  it('salva i criteri (non le aziende), conteggi di oggi, nessun doppione, rinomina ed eliminazione', async () => {
    const c = await login();
    await business('Ristorante Filtro Salvato di Prova');
    const create = (body: Record<string, unknown>) => c.request('POST', '/api/saved-filters', body);
    const r = await create({ scope: 'businesses', name: 'Filtro di prova', query: 'q=Filtro+Salvato&page=3' });
    expect(r.status).toBe(201);
    expect(r.body.query).toBe('q=Filtro+Salvato'); // la paginazione non è un criterio
    // stessi criteri in altro ordine: rifiutati con il nome del filtro esistente
    const dup = await create({ scope: 'businesses', name: 'Altro nome', query: 'page=1&q=Filtro+Salvato' });
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe('DUPLICATE_FILTER');
    const sameName = await create({ scope: 'businesses', name: 'FILTRO DI PROVA', query: 'q=altro' });
    expect(sameName.body.error.code).toBe('DUPLICATE_NAME');

    let list = await c.request('GET', '/api/saved-filters?scope=businesses');
    expect(list.body.items[0]).toMatchObject({ name: 'Filtro di prova', valid: true, count: 1 });
    // un'azienda nuova che corrisponde ai criteri entra nel conteggio: si salvano i criteri
    await business('Pizzeria Filtro Salvato di Prova');
    list = await c.request('GET', '/api/saved-filters?scope=businesses');
    expect(list.body.items[0].count).toBe(2);

    expect((await c.request('PATCH', `/api/saved-filters/${r.body.id}`, { name: 'Rinominato' })).body.name).toBe(
      'Rinominato',
    );
    // un altro utente non vede né modifica il filtro
    const sales = await login('wf.sales@noventra.test');
    expect((await sales.request('GET', '/api/saved-filters')).body.items).toEqual([]);
    expect((await sales.request('DELETE', `/api/saved-filters/${r.body.id}`)).status).toBe(404);
    expect((await c.request('DELETE', `/api/saved-filters/${r.body.id}`)).status).toBe(200);
    expect((await c.request('GET', '/api/saved-filters')).body.items).toEqual([]);
  });

  it('criteri non validi rifiutati al salvataggio; criteri diventati obsoleti segnalati senza conteggio', async () => {
    const c = await login();
    const bad = await c.request('POST', '/api/saved-filters', {
      scope: 'opportunities',
      name: 'Rotto',
      query: 'stage=inesistente',
    });
    expect(bad.status).toBe(400);
    await db.query(
      "INSERT INTO saved_filters (user_id, scope, name, query) VALUES ($1, 'followups', 'Vecchio', 'colore=rosso'), ($1, 'opportunities', 'Fase rimossa', 'stage=vecchia_fase')",
      [adminId],
    );
    const list = await c.request('GET', '/api/saved-filters');
    const byName = Object.fromEntries(list.body.items.map((f: { name: string }) => [f.name, f]));
    expect(byName.Vecchio).toMatchObject({ valid: false, count: null });
    expect(byName.Vecchio.invalidReason).toContain('colore');
    expect(byName['Fase rimossa']).toMatchObject({ valid: false, count: null });
    expect(canonicalQuery('b=2&a=1&pageSize=50&c=')).toBe('a=1&b=2');
  });

  it('opportunità e follow-up: conteggi con gli stessi filtri degli elenchi', async () => {
    const c = await login();
    await c.request('POST', '/api/saved-filters', {
      scope: 'opportunities',
      name: 'Preventivi',
      query: 'stage=preventivo',
    });
    await c.request('POST', '/api/saved-filters', {
      scope: 'followups',
      name: 'Alta',
      query: 'priority=alta&status=all',
    });
    const list = await c.request('GET', '/api/saved-filters');
    const byName = Object.fromEntries(list.body.items.map((f: { name: string; count: number }) => [f.name, f.count]));
    const opps = await c.request('GET', '/api/crm/opportunities?stage=preventivo');
    const fus = await c.request('GET', '/api/crm/followups?priority=alta&status=all');
    expect(byName.Preventivi).toBe(opps.body.total);
    expect(byName.Alta).toBe(fus.body.total);
  });
});

describe('report commerciali', () => {
  it('periodi in ora italiana', () => {
    expect(periodRange('7d', '2026-10-22')).toMatchObject({ from: '2026-10-16', to: '2026-10-23' });
    expect(periodRange('month', '2026-10-22')).toMatchObject({ from: '2026-10-01', to: '2026-10-23' });
    expect(periodRange('prev_month', '2026-01-15')).toMatchObject({ from: '2025-12-01', to: '2026-01-01' });
    expect(periodRange('all', '2026-10-22')).toMatchObject({ from: null, to: null });
  });

  it('tasso di vittoria = vinte / (vinte + perse) nel periodo; nessun valore senza chiusure; tempo medio solo con dati sufficienti', async () => {
    const c = await login();
    // database con le sole opportunità di questo test per i conteggi esatti
    await db.query('DELETE FROM notifications');
    await db.query('DELETE FROM crm_followups');
    await db.query('DELETE FROM crm_activities');
    await db.query('DELETE FROM crm_opportunity_services');
    await db.query('DELETE FROM crm_opportunities');

    let r = await c.request('GET', '/api/reports?period=30d');
    expect(r.status).toBe(200);
    expect(r.body.crm).toMatchObject({
      won: 0,
      lost: 0,
      winRate: null,
      avgDaysToClose: null,
      wonValue: null,
      openValue: null,
    });
    expect(r.body.observations.join(' ')).not.toMatch(/tasso di vittoria/i);

    const ids: string[] = [];
    for (const name of ['A', 'B', 'C', 'D', 'E'])
      ids.push(await opportunity(c, await business(`Report ${name} di Prova`), { estimatedValue: 1000 }));
    await c.request('POST', `/api/crm/opportunities/${ids[0]}/stage`, { stage: 'vinto' });
    await c.request('POST', `/api/crm/opportunities/${ids[1]}/stage`, { stage: 'perso', lostReason: 'Prezzo' });
    await c.request('POST', `/api/crm/opportunities/${ids[2]}/stage`, { stage: 'perso', lostReason: 'Tempi' });
    await c.request('POST', `/api/crm/opportunities/${ids[3]}/stage`, { stage: 'interessato' });
    // una vinta chiusa 100 giorni fa: fuori dagli ultimi 30 giorni, dentro "tutto il periodo"
    const old = await opportunity(c, await business('Report Vecchia di Prova'));
    await c.request('POST', `/api/crm/opportunities/${old}/stage`, { stage: 'vinto' });
    await db.query(
      "UPDATE crm_opportunities SET created_at = now() - interval '120 days', closed_at = now() - interval '100 days' WHERE id = $1",
      [old],
    );

    r = await c.request('GET', '/api/reports?period=30d');
    expect(r.body.crm).toMatchObject({ won: 1, lost: 2, active: 2, wonValue: 1000, openValue: 2000 });
    expect(r.body.crm.winRate).toBeCloseTo(1 / 3);
    expect(r.body.crm.avgDaysToClose).toBe(0); // tre chiuse oggi
    const stages = Object.fromEntries(r.body.crm.byStage.map((s: { id: string; count: number }) => [s.id, s.count]));
    expect(stages).toMatchObject({ vinto: 2, perso: 2, interessato: 1, da_qualificare: 1 });

    const all = await c.request('GET', '/api/reports?period=all');
    expect(all.body.crm).toMatchObject({ won: 2, lost: 2 });
    expect(all.body.crm.winRate).toBe(0.5);
    expect(all.body.crm.avgDaysToClose).toBe(5); // (0 + 0 + 0 + 20) / 4: la vecchia è durata 20 giorni

    const week = await c.request('GET', '/api/reports?period=7d');
    expect(week.body.trend.buckets).toHaveLength(7);
    expect(week.body.trend.won.reduce((a: number, b: number) => a + b, 0)).toBe(1);
    expect(week.body.trend.lost.reduce((a: number, b: number) => a + b, 0)).toBe(2);

    expect((await c.request('GET', '/api/reports?period=anno')).status).toBe(400);
  });

  it('prospezione: totali, fasce, settori e regioni dalle righe reali; osservazioni solo dai numeri', async () => {
    const c = await login();
    const r = await c.request('GET', '/api/reports?period=all');
    const { rows } = await db.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM businesses WHERE merged_into IS NULL',
    );
    expect(r.body.prospecting.total).toBe(rows[0]!.n);
    expect(r.body.prospecting.bySector.reduce((a: number, s: { count: number }) => a + s.count, 0)).toBe(rows[0]!.n);
    expect(r.body.prospecting.byRegion.reduce((a: number, s: { count: number }) => a + s.count, 0)).toBe(rows[0]!.n);
    expect(r.body.prospecting.aiAssessed).toBe(0);
    expect(r.body.observations).toContain(
      'Nessuna azienda ha ancora una valutazione AI: i punteggi commerciali sono quelli a regole.',
    );
    const empty = observations({
      ...r.body,
      prospecting: { ...r.body.prospecting, total: 0, discovered: 0, scored: 0, bySector: [] },
      crm: { ...r.body.crm, won: 0, lost: 0, winRate: null, followUps: { ...r.body.crm.followUps, overdue: 0 } },
    });
    expect(empty).toEqual([]);
  });
});

describe('home', () => {
  it('widget del flusso commerciale: follow-up, prospect prioritari fuori dal CRM, opportunità recenti, filtri salvati', async () => {
    const c = await login();
    const hot = await business('Prospect Caldo di Prova');
    await score(hot, 95);
    const r = await c.request('GET', '/api/home');
    expect(r.status).toBe(200);
    const w = r.body.workflow;
    expect(w.priorityNotInCrm.map((b: { name: string }) => b.name)).toContain('Prospect Caldo di Prova');
    expect(w.recentlyClosed.every((o: { stage: string }) => ['vinto', 'perso'].includes(o.stage))).toBe(true);
    expect(w.recentlyUpdated.length).toBeGreaterThan(0);
    expect(w.savedFilters.map((f: { name: string }) => f.name)).toEqual(expect.arrayContaining(['Preventivi', 'Alta']));
    expect(w.overdue).toMatchObject({ total: expect.any(Number) });
  });
});
