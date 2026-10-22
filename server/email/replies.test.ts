import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FakeAiProvider } from '../ai/provider.ts';
import type { EmailConfig } from '../config.ts';
import type { Db } from '../db/client.ts';
import { saveRecord } from '../discovery/store.ts';
import { client, createTestUser, startTestServer, testDatabase, type TestServer } from '../testing.ts';
import { FakeInboxReader, ruleCategory, stripQuoted } from './replies.ts';
import { FakeEmailSender } from './sender.ts';
import { DEFAULT_SUBJECT } from './template.ts';

/*
 * Risposte lette dalla casella (portate da Harvey): casella finta in memoria, invio finto, AI finta. Nessuna rete.
 */

const PASSWORD = 'password-di-prova-lunga';
let db: Db;
let sender: FakeEmailSender;
let n = 0;

const configured: EmailConfig = {
  smtp: { host: '127.0.0.1', port: 2525, security: 'none', user: null, password: null },
  fromAddress: 'staff@noventra.it',
  fromName: 'Noventra',
  replyTo: null,
  senderAuthorized: true,
  dkimSelectors: null,
  timeoutMs: 5000,
  missing: [],
  imap: null,
  repliesWorker: false,
  repliesPollMs: 600_000,
};

beforeAll(async () => {
  db = await testDatabase();
  sender = new FakeEmailSender();
  await createTestUser(db, { email: 'risposte.admin@noventra.test', role: 'admin', password: PASSWORD });
});
afterAll(async () => {
  await db.close();
});

async function business(name: string): Promise<string> {
  n++;
  const r = await db.transaction((tx) =>
    saveRecord(
      tx,
      {
        provider: 'osm',
        ref: `node/${5_600_000_000 + n}`,
        sourceUrl: `https://www.openstreetmap.org/node/${5_600_000_000 + n}`,
        name,
        category: 'ristorazione',
        websiteUrl: null,
        websiteDomain: null,
        websiteShared: false,
        sector: 'ristoranti',
        contacts: { phone: null, email: `info${n}@risposte.example`, emailKind: 'generic' },
        address: { street: null, housenumber: null, postcode: null, city: null },
        municipalityCode: '058091',
        latitude: 43 + n * 0.01,
        longitude: 12,
        has: { website: false, address: false, phone: false, email: true, openingHours: false },
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

async function setup(opts: { ai?: FakeAiProvider } = {}) {
  const inbox = new FakeInboxReader();
  const server = await startTestServer(db, {
    email: { sender, config: configured, inbox },
    ...(opts.ai ? { ai: { provider: opts.ai } } : {}),
  });
  const c = client(server.url);
  const r = await c.request('POST', '/api/auth/login', { email: 'risposte.admin@noventra.test', password: PASSWORD });
  expect(r.status).toBe(200);
  return { inbox, server, c };
}

type Client = ReturnType<typeof client>;

async function sentEmail(c: Client, businessId: string) {
  const d = (await c.request('POST', '/api/emails', { requestId: randomUUID(), businessId })).body.email;
  const r = await c.request('POST', `/api/emails/${d.id}/send`, {
    requestId: randomUUID(),
    version: d.version,
    reviewed: true,
    lawful: true,
  });
  expect(r.body.outcome).toBe('accepted');
  return r.body.email as { id: string; recipient: string; providerMessageId: string; opportunityId: string };
}

const raw = (o: { from: string; subject: string; body: string; inReplyTo?: string; headers?: string[] }) =>
  [
    `From: Cliente <${o.from}>`,
    'To: staff@noventra.it',
    `Subject: ${o.subject}`,
    `Message-ID: <${randomUUID()}@cliente.example>`,
    `Date: ${new Date().toUTCString()}`,
    ...(o.inReplyTo ? [`In-Reply-To: ${o.inReplyTo}`, `References: ${o.inReplyTo}`] : []),
    ...(o.headers ?? []),
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
    '',
    o.body,
  ].join('\r\n');

describe('risposte dalla casella (IMAP)', () => {
  it('risposta nel thread: classificata con l’AI, attività nel CRM, bozza nello stesso thread', async () => {
    const ai = new FakeAiProvider(() => ({
      category: 'interessato',
      summary: 'Chiede una call la prossima settimana.',
      suggestedReply: 'Buongiorno,\n\ngrazie! Quando sei disponibile per una breve call?\n\nIl Team Noventra',
    }));
    const { inbox, server, c } = await setup({ ai });
    const b = await business('Gelateria Risposta di Prova');
    const sent = await sentEmail(c, b);
    // posta non collegata: ignorata e non salvata
    inbox.add(raw({ from: 'newsletter@altro.example', subject: 'Offerte', body: 'Promozioni della settimana' }));
    inbox.add(
      raw({
        from: 'titolare@gelateria.example',
        subject: `Re: ${DEFAULT_SUBJECT}`,
        inReplyTo: sent.providerMessageId,
        body: 'Sì, mi interessa. Possiamo sentirci?\n\nIl giorno lun 20 ott 2026 Noventra ha scritto:\n> Buongiorno,\n> mi presento',
      }),
    );
    expect((await c.request('POST', '/api/email/inbox/check')).body).toEqual({ read: 2, saved: 1 });
    // un secondo giro non rilegge gli stessi messaggi
    expect((await c.request('POST', '/api/email/inbox/check')).body).toEqual({ read: 0, saved: 0 });
    const list = (await c.request('GET', '/api/emails/replies')).body;
    const r = list.items.find((x: { businessId: string }) => x.businessId === b);
    expect(r).toMatchObject({
      kind: 'reply',
      category: 'interessato',
      classifiedBy: 'ai',
      body: 'Sì, mi interessa. Possiamo sentirci?',
      handled: false,
    });
    const { rows: unrelated } = await db.query(
      "SELECT 1 FROM commercial_email_replies WHERE from_address = 'newsletter@altro.example'",
    );
    expect(unrelated).toHaveLength(0);
    // il testo della risposta arriva all'AI solo nel blocco dei dati
    expect(ai.calls[0]!.user).toMatch(/<risposta>[\s\S]*mi interessa[\s\S]*<\/risposta>/);
    const opp = await c.request('GET', `/api/crm/opportunities/${sent.opportunityId}`);
    expect(opp.body.activities.find((a: { type: string }) => a.type === 'email_reply').summary).toMatch(/Interessato/);
    // «Rispondi»: bozza verso il mittente, stesso thread, nessun invio automatico
    const before = sender.sent.length;
    const draft = await c.request('POST', `/api/emails/replies/${r.id}/draft`);
    expect(draft.status).toBe(201);
    expect(sender.sent.length).toBe(before);
    const e = (await c.request('GET', `/api/emails/${draft.body.emailId}`)).body.email;
    expect(e).toMatchObject({
      recipient: 'titolare@gelateria.example',
      status: 'draft',
      subject: `Re: ${DEFAULT_SUBJECT}`,
    });
    expect(e.body).toMatch(/Quando sei disponibile/);
    const open = (await c.request('GET', '/api/emails/replies')).body.items;
    expect(open.some((x: { id: string }) => x.id === r.id)).toBe(false);
    const s = await c.request('POST', `/api/emails/${e.id}/send`, {
      requestId: randomUUID(),
      version: e.version,
      reviewed: true,
      lawful: true,
    });
    expect(s.body.outcome).toBe('accepted');
    expect(sender.sent.at(-1)!.inReplyTo).toMatch(/@cliente\.example>$/);
    await server.close();
  });

  it('«non contattateci» (regole, senza AI): azienda esclusa, sequenza ferma; risposta automatica separata', async () => {
    const { inbox, server, c } = await setup();
    const b = await business('Bottega Disiscrizione di Prova');
    const sent = await sentEmail(c, b);
    inbox.add(
      raw({
        from: sent.recipient,
        subject: 'Risposta automatica: fuori sede',
        body: 'Sono fuori sede fino al 3 novembre.',
        headers: ['Auto-Submitted: auto-replied'],
      }),
    );
    inbox.add(raw({ from: sent.recipient, subject: 'Re: Noventra', body: 'Per favore non contattateci più.' }));
    await c.request('POST', '/api/email/inbox/check');
    const items = (await c.request('GET', '/api/emails/replies')).body.items.filter(
      (x: { businessId: string }) => x.businessId === b,
    );
    expect(items.map((x: { category: string }) => x.category).sort()).toEqual(['disiscrizione', 'fuori_ufficio']);
    const { rows } = await db.query<{ excluded_reason: string }>(
      'SELECT excluded_reason FROM businesses WHERE id = $1',
      [b],
    );
    expect(rows[0]!.excluded_reason).toMatch(/Ha chiesto di non essere contattata/);
    const step2 = (await c.request('GET', '/api/emails/followups')).body.items.find(
      (f: { businessId: string }) => f.businessId === b,
    );
    expect(step2.stopped).toMatch(/non contattare/);
    await server.close();
  });

  it('rimbalzo: indirizzo segnato, nuovi invii allo stesso indirizzo bloccati', async () => {
    const { inbox, server, c } = await setup();
    const b = await business('Officina Rimbalzo di Prova');
    const sent = await sentEmail(c, b);
    inbox.add(
      [
        'From: Mail Delivery System <MAILER-DAEMON@mx.noventra.it>',
        'To: staff@noventra.it',
        'Subject: Undelivered Mail Returned to Sender',
        `Message-ID: <${randomUUID()}@mx.noventra.it>`,
        'MIME-Version: 1.0',
        'Content-Type: multipart/report; report-type=delivery-status; boundary="b1"',
        '',
        '--b1',
        'Content-Type: text/plain',
        '',
        `Recipient address rejected: ${sent.recipient}`,
        '--b1',
        'Content-Type: text/rfc822-headers',
        '',
        `Message-ID: ${sent.providerMessageId}`,
        '--b1--',
      ].join('\r\n'),
    );
    expect((await c.request('POST', '/api/email/inbox/check')).body.saved).toBe(1);
    expect((await c.request('GET', `/api/emails/${sent.id}`)).body.email.bouncedAt).not.toBeNull();
    const d2 = (await c.request('POST', '/api/emails', { requestId: randomUUID(), businessId: b })).body.email;
    const pre = await c.request('GET', `/api/emails/${d2.id}/precheck`);
    expect(pre.body.blockers.join(' ')).toMatch(/tornato indietro/);
    await server.close();
  });

  it('casella non configurata: errore chiaro, nessuna lettura', async () => {
    const server: TestServer = await startTestServer(db, { email: { sender, config: configured } });
    const c = client(server.url);
    await c.request('POST', '/api/auth/login', { email: 'risposte.admin@noventra.test', password: PASSWORD });
    expect((await c.request('POST', '/api/email/inbox/check')).status).toBe(503);
    expect((await c.request('GET', '/api/emails/meta')).body.inbox).toMatchObject({ configured: false });
    await server.close();
  });

  it('testo citato rimosso; regole per disiscrizione e rifiuto', () => {
    expect(stripQuoted('Va bene.\n\n> testo vecchio\nOn Mon, Oct 20 Noventra wrote:\n> altro')).toBe('Va bene.');
    expect(ruleCategory('STOP')).toBe('disiscrizione');
    expect(ruleCategory('Vi prego di cancellarmi, non voglio più ricevere email')).toBe('disiscrizione');
    expect(ruleCategory('Grazie ma non siamo interessati')).toBe('non_interessato');
    expect(ruleCategory('Mi mandate un preventivo?')).toBeNull();
  });
});
