import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '../db/client.ts';
import { saveRecord } from '../discovery/store.ts';
import { silentLogger } from '../logger.ts';
import { client, createTestUser, startTestServer, testAiConfig, testDatabase, type TestServer } from '../testing.ts';
import { assessBusiness } from './assess.ts';
import type { AiOutput } from './prompt.ts';
import { AiError, FakeAiProvider } from './provider.ts';
import { AutoAssessor, coverage, recheckAll, refreshFingerprints, retryFailed, setAutoEnabled } from './queue.ts';
import { acquireLease } from './lease.ts';

/*
 * Valutazione commerciale di ogni azienda: impronte, coda automatica, lease, nuovi tentativi, copertura.
 * Solo fornitore AI finto: nessuna chiamata reale, nessun costo. Un database per file: i conteggi sono esatti.
 */

const PASSWORD = 'password-di-prova-lunga';
let db: Db;
let server: TestServer;
let adminId: string;
let n = 0;
/** Comportamento del fornitore finto per azienda (dal nome nel messaggio). */
let behaviour: (user: string) => AiOutput | Error | Promise<AiOutput | Error>;
const provider = new FakeAiProvider((user) => behaviour(user));
const config = { ...testAiConfig, concurrency: 4, autoAssess: true };

async function business(name: string, opts: { ref?: number } = {}): Promise<string> {
  const ref = opts.ref ?? ++n + 7_100_000_000;
  const r = await db.transaction((tx) =>
    saveRecord(
      tx,
      {
        provider: 'osm',
        ref: `node/${ref}`,
        sourceUrl: `https://www.openstreetmap.org/node/${ref}`,
        name,
        category: 'ristorazione',
        websiteUrl: null,
        websiteDomain: null,
        websiteShared: false,
        sector: 'ristoranti',
        contacts: { phone: '+39 06 0000000', email: null, emailKind: null },
        address: { street: null, housenumber: null, postcode: null, city: null },
        municipalityCode: '058091',
        // posizioni distanti: nessun possibile duplicato tra le aziende di prova
        latitude: 36 + (ref % 1000) * 0.01,
        longitude: 8 + Math.floor((ref % 1_000_000) / 1000) * 0.01,
        has: { website: false, address: false, phone: true, email: false, openingHours: false },
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

const idOf = (user: string) => /"business_id": "([0-9a-f-]{36})"/.exec(user)![1]!;
function answer(user: string): AiOutput {
  const comp = (score: number) => ({ score, explanation: 'Motivazione di prova.', evidence_refs: ['B1'] });
  return {
    business_id: idOf(user),
    summary: 'Sintesi di prova.',
    components: {
      acquisition: comp(70),
      service_fit: comp(70),
      improvement: comp(60),
      attractiveness: comp(60),
      evidence_quality: comp(50),
    },
    positive_signals: [{ text: 'Telefono pubblico', evidence_refs: ['B3'] }],
    negative_signals: [],
    obstacles: [],
    recommended_service_ids: ['sviluppo_siti_web'],
    verified_facts: [{ text: 'Telefono indicato', evidence_refs: ['B3'] }],
    inferences: [],
    unknowns: ['Sito non indicato dalla fonte'],
    business_status: 'likely_active',
    confidence: { level: 'medium', explanation: 'Prove parziali.' },
    next_step: 'Telefonare per qualificare il bisogno.',
  };
}

const assessor = (over: Partial<{ dailyLimit: number }> = {}) =>
  new AutoAssessor(db, { provider, config, log: silentLogger, dailyLimit: over.dailyLimit ?? 10_000 });

/** Giri della coda finché non resta nulla da fare (con un limite di sicurezza). */
async function drain(a = assessor()) {
  let processed = 0;
  for (let i = 0; i < 500; i++) {
    const r = await a.tick();
    processed += r.processed;
    if (r.checked === 0 && r.processed === 0) break;
  }
  return processed;
}

const counts = () => coverage(db, { providerConfigured: true, dailyLimit: 10_000 });
const assessments = async (id?: string) =>
  (
    await db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM ai_assessments WHERE status = 'succeeded' ${id ? 'AND business_id = $1' : ''}`,
      id ? [id] : [],
    )
  ).rows[0]!.n;

beforeAll(async () => {
  db = await testDatabase();
  server = await startTestServer(db, { ai: { provider } });
  adminId = (await createTestUser(db, { email: 'cov.admin@noventra.test', role: 'admin', password: PASSWORD })).id;
  await createTestUser(db, { email: 'cov.sales@noventra.test', role: 'sales', password: PASSWORD });
});
afterAll(async () => {
  await server.close();
  await db.close();
});
beforeEach(async () => {
  behaviour = answer;
  await db.query('UPDATE ai_auto_control SET enabled = true, backoff_until = NULL, paused_reason = NULL WHERE id = 1');
});

describe('ogni azienda', () => {
  it('tutte le aziende senza valutazione entrano in coda, oltre ogni pagina; nessun doppione ripetendo', async () => {
    for (let i = 0; i < 260; i++) await business(`Ristorante Copertura ${i} di Prova`);
    // impronte a lotti di 200: nessuna azienda dimenticata
    await refreshFingerprints(db, config.model, 200);
    let c = await counts();
    expect(c.unchecked).toBe(60);
    await refreshFingerprints(db, config.model, 200);
    c = await counts();
    expect(c).toMatchObject({ total: 260, eligible: 260, unchecked: 0 });
    expect(c.counts.pending).toBe(260);

    const processed = await drain();
    expect(processed).toBe(260);
    c = await counts();
    expect(c.covered).toBe(260);
    expect(c.coveredShare).toBe(1);
    expect(c.counts.pending + c.counts.failed + c.counts.outdated + c.counts.running).toBe(0);
    expect(await assessments()).toBe(260);
    // un nuovo giro non rifà nulla (impronte uguali, nessuna chiamata)
    const calls = provider.calls.length;
    expect(await drain()).toBe(0);
    expect(provider.calls.length).toBe(calls);
    expect(await assessments()).toBe(260);
    // conteggi uguali al database
    const { rows } = await db.query<{ n: number }>('SELECT count(*)::int AS n FROM ai_assessments WHERE is_current');
    expect(rows[0]!.n).toBe(c.covered);
    // prova di volume (260 aziende): pochi secondi da sola, molto di più con gli altri file in parallelo
  }, 120_000);

  it('nuova azienda scoperta: in coda da sola; la stessa azienda ritrovata non crea doppioni né nuove valutazioni', async () => {
    const id = await business('Pizzeria Nuova di Prova', { ref: 7_199_000_001 });
    await refreshFingerprints(db, config.model);
    expect((await counts()).counts.pending).toBe(1);
    await drain();
    expect(await assessments(id)).toBe(1);
    // la ricerca la ritrova: stessa azienda, impronta invariata, nessuna nuova valutazione
    const again = await business('Pizzeria Nuova di Prova', { ref: 7_199_000_001 });
    expect(again).toBe(id);
    await recheckAll(db);
    await drain();
    expect(await assessments(id)).toBe(1);
  });

  it('prove cambiate: «Da aggiornare», rivalutata; esclusa «non contattare»: mai inviata al modello', async () => {
    const id = await business('Trattoria Cambiata di Prova');
    const off = await business('Bar Escluso di Prova');
    await db.query("UPDATE businesses SET excluded_at = now(), excluded_reason = 'prova' WHERE id = $1", [off]);
    await drain();
    expect(await assessments(id)).toBe(1);
    expect(provider.calls.some((c) => c.user.includes(off))).toBe(false);
    await db.query(
      "UPDATE businesses SET name = 'Trattoria Cambiata Davvero di Prova', updated_at = now() WHERE id = $1",
      [id],
    );
    await refreshFingerprints(db, config.model);
    const list = await client(server.url);
    expect(
      (await list.request('POST', '/api/auth/login', { email: 'cov.admin@noventra.test', password: PASSWORD })).status,
    ).toBe(200);
    let r = await list.request('GET', `/api/businesses?q=trattoria%20cambiata`);
    expect(r.body.items[0].assessment).toMatchObject({ state: 'outdated', label: 'Da aggiornare' });
    expect(r.body.items[0].commercial.outdated).toBe(true);
    await drain();
    r = await list.request('GET', `/api/businesses?q=trattoria%20cambiata`);
    expect(['assessed', 'incomplete']).toContain(r.body.items[0].assessment.state);
    expect(r.body.items[0].commercial.outdated).toBe(false);
    expect(await assessments(id)).toBe(2);
    r = await list.request('GET', `/api/businesses?q=bar%20escluso&excluded=include`);
    expect(r.body.items[0].assessment.state).toBe('excluded');
  });
});

describe('errori e ripresa', () => {
  it('un errore non blocca le altre; nuovi tentativi limitati, poi «Riprova» a mano', async () => {
    const bad = await business('Osteria Guasto di Prova');
    const good = await business('Osteria Funzionante di Prova');
    behaviour = (user) =>
      user.includes('Guasto') ? new AiError('unavailable', 'Fornitore non raggiungibile.', true) : answer(user);
    await drain();
    expect(await assessments(good)).toBe(1);
    const state = async () =>
      (
        await db.query<{ queue_status: string; attempts: number; next_attempt_at: Date | null }>(
          'SELECT queue_status, attempts, next_attempt_at FROM ai_business_states WHERE business_id = $1',
          [bad],
        )
      ).rows[0]!;
    expect(await state()).toMatchObject({ queue_status: 'failed', attempts: 1 });
    expect((await state()).next_attempt_at).not.toBeNull();
    // i tentativi successivi partono solo alla scadenza
    for (let i = 2; i <= 3; i++) {
      await db.query(
        "UPDATE ai_business_states SET next_attempt_at = now() - interval '1 second' WHERE business_id = $1",
        [bad],
      );
      await assessor().tick();
      expect((await state()).attempts).toBe(i);
    }
    expect((await state()).next_attempt_at).toBeNull();
    const calls = provider.calls.length;
    await drain();
    expect(provider.calls.length).toBe(calls);
    expect((await counts()).failedFinal).toBeGreaterThanOrEqual(1);
    behaviour = answer;
    expect(await retryFailed(db)).toBeGreaterThanOrEqual(1);
    await drain();
    expect(await assessments(bad)).toBe(1);
  });

  it('chiave non valida o limite di richieste: coda in pausa, nessun errore a carico delle aziende', async () => {
    const id = await business('Enoteca Pausa di Prova');
    behaviour = () => new AiError('auth', 'Chiave del fornitore AI non valida o senza permessi.');
    await assessor().tick();
    await assessor().tick();
    const { rows } = await db.query<{ backoff_until: Date | null; paused_reason: string }>(
      'SELECT backoff_until, paused_reason FROM ai_auto_control WHERE id = 1',
    );
    expect(rows[0]!.backoff_until!.getTime()).toBeGreaterThan(Date.now());
    expect(rows[0]!.paused_reason).toMatch(/Chiave/);
    const { rows: s } = await db.query<{ queue_status: string; attempts: number }>(
      'SELECT queue_status, attempts FROM ai_business_states WHERE business_id = $1',
      [id],
    );
    expect(s[0]).toEqual({ queue_status: 'waiting', attempts: 0 });
    // in pausa: nessuna chiamata finché non scade
    const calls = provider.calls.length;
    await assessor().tick();
    expect(provider.calls.length).toBe(calls);
    behaviour = answer;
    await db.query('UPDATE ai_auto_control SET backoff_until = NULL WHERE id = 1');
    await drain();
    expect(await assessments(id)).toBe(1);
  });

  it('ripresa dopo un’interruzione: lease scaduti ripresi, nessuna valutazione doppia', async () => {
    const id = await business('Gelateria Interrotta di Prova');
    await refreshFingerprints(db, config.model);
    // un processo fermato a metà: lease mai rilasciato
    expect(await acquireLease(db, id, 'processo-fermato', 60_000)).toBe(true);
    await db.query(
      "UPDATE ai_business_states SET lease_expires_at = now() - interval '1 second' WHERE business_id = $1",
      [id],
    );
    await drain();
    expect(await assessments(id)).toBe(1);
  });

  it('mai due valutazioni contemporanee della stessa azienda', async () => {
    const id = await business('Bistrot Contemporaneo di Prova');
    await refreshFingerprints(db, config.model);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    behaviour = async (user) => {
      await gate;
      return answer(user);
    };
    const first = assessBusiness(db, provider, config, id, { trigger: 'manual', userId: adminId, force: true });
    await new Promise((r) => setTimeout(r, 50));
    const second = await assessBusiness(db, provider, config, id, { trigger: 'batch', userId: adminId, force: true });
    expect(second).toEqual({ status: 'skipped', reason: 'busy' });
    // e la coda automatica non la prende
    expect((await assessor().tick()).processed).toBe(0);
    release();
    expect((await first).status).toBe('assessed');
  });

  it('un risultato vecchio non sovrascrive: prove cambiate durante la chiamata → salvato ma non corrente, poi rivalutata', async () => {
    const id = await business('Pasticceria Concorrente di Prova');
    await refreshFingerprints(db, config.model);
    behaviour = async (user) => {
      // durante la chiamata cambia il nome (prova B1)
      await db.query(
        "UPDATE businesses SET name = 'Pasticceria Rinnovata di Prova', updated_at = now() WHERE id = $1",
        [id],
      );
      behaviour = answer;
      return answer(user);
    };
    const r = await assessBusiness(db, provider, config, id, { trigger: 'manual', userId: adminId });
    expect(r).toMatchObject({ status: 'assessed', current: false });
    const { rows } = await db.query('SELECT 1 FROM ai_assessments WHERE business_id = $1 AND is_current', [id]);
    expect(rows).toHaveLength(0);
    await drain();
    const { rows: cur } = await db.query<{ context: { evidence: { id: string; text: string }[] } }>(
      'SELECT context FROM ai_assessments WHERE business_id = $1 AND is_current',
      [id],
    );
    expect(cur[0]!.context.evidence.find((e) => e.id === 'B1')!.text).toContain('Rinnovata');
  });
});

describe('controlli, limiti e API', () => {
  it('valutazione automatica in pausa e limite giornaliero: le impronte continuano, le chiamate no', async () => {
    await business('Panificio Limite di Prova A');
    await business('Panificio Limite di Prova B');
    await setAutoEnabled(db, false, adminId);
    let r = await assessor().tick();
    expect(r.processed).toBe(0);
    expect((await counts()).counts.pending).toBeGreaterThanOrEqual(2);
    await setAutoEnabled(db, true, adminId);
    const { rows } = await db.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM ai_assessments WHERE trigger = 'auto' AND created_at > now() - interval '24 hours'",
    );
    r = await assessor({ dailyLimit: rows[0]!.n + 1 }).tick();
    expect(r.processed).toBe(1);
    r = await assessor({ dailyLimit: rows[0]!.n + 1 }).tick();
    expect(r.processed).toBe(0);
    await drain();
  });

  it('API: copertura dal database, filtri per stato, comandi; stesso punteggio ovunque', async () => {
    const c = client(server.url);
    expect(
      (await c.request('POST', '/api/auth/login', { email: 'cov.admin@noventra.test', password: PASSWORD })).status,
    ).toBe(200);
    const id = await business('Hotel Ovunque di Prova');
    await refreshFingerprints(db, config.model);
    let cov = await c.request('GET', '/api/ai/coverage');
    expect(cov.status).toBe(200);
    const direct = await counts();
    expect(cov.body.counts).toEqual(direct.counts);
    expect(cov.body).toMatchObject({
      total: direct.total,
      remaining: direct.counts.pending + direct.counts.outdated + direct.counts.failed,
    });
    const pending = await c.request('GET', '/api/businesses?aiStatus=state_pending&pageSize=100');
    expect(pending.body.total).toBe(direct.counts.pending);
    expect(
      pending.body.items.every((b: { assessment: { label: string } }) => b.assessment.label === 'Da valutare'),
    ).toBe(true);

    await drain();
    const score = (
      await db.query<{ final_score: number }>(
        'SELECT final_score FROM ai_assessments WHERE business_id = $1 AND is_current',
        [id],
      )
    ).rows[0]!.final_score;
    const list = await c.request('GET', '/api/businesses?q=hotel%20ovunque');
    expect(list.body.items[0].commercial).toMatchObject({ source: 'ai', score, outdated: false });
    const detail = await c.request('GET', `/api/businesses/${id}`);
    expect(detail.body.business.commercial.score).toBe(score);
    const assessment = await c.request('GET', `/api/businesses/${id}/assessment`);
    expect(assessment.body.current.score).toBe(score);
    const opp = await c.request('POST', '/api/crm/opportunities', { businessId: id });
    expect(opp.body.opportunity.business.commercial.score).toBe(score);

    // comandi
    const sales = client(server.url);
    await sales.request('POST', '/api/auth/login', { email: 'cov.sales@noventra.test', password: PASSWORD });
    expect((await sales.request('POST', '/api/ai/auto', { enabled: false })).status).toBe(403);
    expect((await c.request('POST', '/api/ai/auto', { enabled: false })).body).toEqual({ enabled: false });
    cov = await c.request('GET', '/api/ai/coverage');
    expect(cov.body.auto.enabled).toBe(false);
    expect((await c.request('POST', '/api/ai/auto', { enabled: true })).status).toBe(200);
    expect((await c.request('POST', '/api/ai/coverage/recheck', {})).body.affected).toBeGreaterThan(0);
    expect((await c.request('POST', '/api/ai/coverage/retry-failed', {})).status).toBe(200);
    // aprire una scheda non chiama il modello
    const calls = provider.calls.length;
    await c.request('GET', `/api/businesses/${id}`);
    await c.request('GET', `/api/businesses/${id}/assessment`);
    expect(provider.calls.length).toBe(calls);
  });
});
