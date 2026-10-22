import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from '../db/client.ts';
import { silentLogger } from '../logger.ts';
import { createTestUser, testDatabase } from '../testing.ts';
import { DEFAULT_SCORING_CONFIG } from './config.ts';
import { cancelScoringJob, createScoringJob, getScoringJob, ScoringWorker } from './jobs.ts';
import {
  activeConfig,
  latestScore,
  loadInputs,
  rescoreAfterAudit,
  saveConfig,
  scoreBusinesses,
  scoreHistory,
} from './store.ts';
import { insertAudit, insertBusiness } from './testData.ts';

/* Punteggi salvati nel database reale (PGlite o PostgreSQL), con aziende e audit "di Prova". */

let db: Db;
let userId: string;
beforeAll(async () => {
  db = await testDatabase();
  userId = (await createTestUser(db, { email: 'admin.punteggi@noventra.test', role: 'admin' })).id;
});
afterAll(() => db.close());

const current = async (id: string) =>
  (
    await db.query<{ n: number }>('SELECT count(*)::int AS n FROM lead_scores WHERE business_id = $1 AND is_current', [
      id,
    ])
  ).rows[0]!.n;

describe('configurazione', () => {
  it('al primo uso registra i valori predefiniti come versione 1', async () => {
    const cfg = await activeConfig(db);
    expect(cfg.version).toBe(1);
    expect(cfg.config).toEqual(DEFAULT_SCORING_CONFIG);
  });
});

describe('istantanee del punteggio', () => {
  let strong: string;
  it('azienda con audit: punteggio, fascia, dettaglio e riferimento all’audit salvati', async () => {
    strong = await insertBusiness(db, { name: 'Hotel di Prova Datato', category: 'hotel' });
    const auditId = await insertAudit(db, strong, {
      hasViewport: false,
      signals: { booking: false, rooms: false, callToAction: false },
      findings: [{ code: 'SEC_NO_HTTPS' }, { code: 'MOBILE_NO_VIEWPORT' }, { code: 'SEO_MISSING_META_DESCRIPTION' }],
    });
    const r = await scoreBusinesses(db, [strong], { trigger: 'manual', userId });
    expect(r).toMatchObject({ created: 1, unchanged: 0, skipped: 0 });
    const s = (await latestScore(db, strong))!;
    expect(s).toMatchObject({
      status: 'ranked',
      auditId,
      configVersion: 1,
      algorithmVersion: 1,
      trigger: 'manual',
      outdated: [],
    });
    expect(s.score).toBeGreaterThanOrEqual(60);
    expect(['A', 'B']).toContain(s.band);
    expect(s.explanation).toMatch(/sito ufficiale raggiungibile con 3 problemi tecnici/);
    const breakdown = s.breakdown as { dimensions: Record<string, unknown>; topFindings: { auditId: string }[] };
    // jsonb non conserva l'ordine delle chiavi: l'interfaccia segue l'ordine di DIMENSIONS
    expect(Object.keys(breakdown.dimensions).sort()).toEqual([
      'capabilities',
      'commercial',
      'evidence',
      'industry',
      'technical',
    ]);
    expect(breakdown.topFindings[0]?.auditId).toBe(auditId);
  });

  it('dati invariati: nessuna istantanea nuova; ricalcolo esplicito: nuova, la precedente resta nello storico', async () => {
    expect(await scoreBusinesses(db, [strong], { trigger: 'manual' })).toMatchObject({ created: 0, unchanged: 1 });
    expect((await scoreHistory(db, strong, 1, 10)).total).toBe(1);
    expect(await scoreBusinesses(db, [strong], { trigger: 'manual', force: true })).toMatchObject({ created: 1 });
    const h = await scoreHistory(db, strong, 1, 10);
    expect(h.total).toBe(2);
    expect(h.items.filter((x) => x.isCurrent)).toHaveLength(1);
    expect(await current(strong)).toBe(1);
  });

  it('nuovo audit: il punteggio risulta da aggiornare e si ricalcola per tutte le aziende con quel sito', async () => {
    const twin = await insertBusiness(db, {
      name: 'Hotel di Prova Gemello',
      category: 'hotel',
      website: (await db.query<{ website_url: string }>('SELECT website_url FROM businesses WHERE id = $1', [strong]))
        .rows[0]!.website_url,
    });
    await db.query(
      'INSERT INTO business_websites (business_id, website_id, original_url) SELECT $1, website_id, original_url FROM business_websites WHERE business_id = $2',
      [twin, strong],
    );
    const newAudit = await insertAudit(db, strong, { findings: [] });
    expect((await latestScore(db, strong))!.outdated.join(' ')).toMatch(/audit più recente/);
    const r = await rescoreAfterAudit(db, strong);
    expect(r.created).toBe(2);
    const s = (await latestScore(db, strong))!;
    expect(s).toMatchObject({ auditId: newAudit, trigger: 'audit', outdated: [] });
    expect((await latestScore(db, twin))!.auditId).toBe(newAudit);
    // sito sistemato: nessun problema tecnico, punteggio più basso
    expect(s.score!).toBeLessThan(60);
  });

  it('dati dell’azienda cambiati (es. nuovo indirizzo del sito): ricalcolo con prove non più valide', async () => {
    await db.query(
      "UPDATE businesses SET website_url = 'https://nuovo-sito-di-prova.example.it/', updated_at = now() WHERE id = $1",
      [strong],
    );
    expect((await latestScore(db, strong))!.outdated.join(' ')).toMatch(/dati dell’azienda sono cambiati/);
    await scoreBusinesses(db, [strong], { trigger: 'manual' });
    expect((await latestScore(db, strong))!).toMatchObject({
      status: 'insufficient_data',
      score: null,
      band: null,
      nextStep: expect.stringMatching(/indirizzo del sito è cambiato/),
    });
  });

  it('nuova configurazione: punteggi precedenti conservati con la loro versione, i nuovi usano la nuova', async () => {
    const b = await insertBusiness(db, { category: 'ristorazione' });
    await insertAudit(db, b, { signals: { menu: false }, findings: [{ code: 'SEO_MISSING_TITLE' }] });
    await scoreBusinesses(db, [b], { trigger: 'manual' });
    const before = (await latestScore(db, b))!;
    const cfg = structuredClone(DEFAULT_SCORING_CONFIG);
    cfg.weights.technical = 60;
    expect(await saveConfig(db, cfg, { userId, note: 'Più peso ai problemi tecnici' })).toBe(2);
    expect((await latestScore(db, b))!.outdated.join(' ')).toMatch(/configurazione v1; attiva: v2/);
    await scoreBusinesses(db, [b], { trigger: 'manual' });
    const after = (await latestScore(db, b))!;
    expect(after.configVersion).toBe(2);
    const old = await db.query<{ config_version: number; score: number }>(
      'SELECT config_version, score FROM lead_scores WHERE id = $1',
      [before.id],
    );
    expect(old.rows[0]).toMatchObject({ config_version: 1, score: before.score });
    await expect(
      saveConfig(db, { ...cfg, weights: { ...cfg.weights, evidence: -5 } }, { userId }),
    ).rejects.toMatchObject({ code: 'INVALID_CONFIG' });
    expect((await activeConfig(db)).version).toBe(2);
  });

  it('nessun sito, nessun audit, sito irraggiungibile: mai punteggi inventati', async () => {
    const none = await insertBusiness(db, { website: null });
    const unaudited = await insertBusiness(db);
    const down = await insertBusiness(db);
    await insertAudit(db, down, { websiteStatus: 'unreachable', runStatus: 'partial' });
    await scoreBusinesses(db, [none, unaudited, down], { trigger: 'manual' });
    for (const id of [none, unaudited, down])
      expect((await latestScore(db, id))!).toMatchObject({ status: 'insufficient_data', score: null });
    expect((await latestScore(db, none))!.nextStep).toMatch(/Verifica se l’azienda ha un sito/);
    expect((await latestScore(db, unaudited))!.nextStep).toMatch(/Avvia l’audit/);
    expect((await latestScore(db, down))!.nextStep).toMatch(/Ripeti l’audit più tardi/);
  });

  it('aziende unite o inesistenti: escluse, nessun errore', async () => {
    const keep = await insertBusiness(db);
    const merged = await insertBusiness(db);
    await db.query('UPDATE businesses SET merged_into = $1 WHERE id = $2', [keep, merged]);
    expect(
      await scoreBusinesses(db, [merged, '00000000-0000-4000-8000-000000000000'], { trigger: 'manual' }),
    ).toMatchObject({ skipped: 2, created: 0 });
  });

  it('calcoli contemporanei della stessa azienda: sempre un solo punteggio attuale', async () => {
    const b = await insertBusiness(db);
    await insertAudit(db, b, { findings: [{ code: 'SEO_MISSING_H1' }] });
    await Promise.all(Array.from({ length: 4 }, () => scoreBusinesses(db, [b], { trigger: 'manual', force: true })));
    expect(await current(b)).toBe(1);
  });
});

describe('ricalcoli in blocco', () => {
  it('centinaia di aziende a lotti: query per lotto costanti, ripetizione senza istantanee nuove', async () => {
    const ids: string[] = [];
    for (let i = 0; i < 450; i++) ids.push(await insertBusiness(db, { category: i % 2 ? 'negozi' : 'farmacie' }));
    for (const id of ids.slice(0, 30))
      await insertAudit(db, id, { findings: [{ code: 'SEO_NO_SITEMAP' }, { code: 'PERF_LOW_SCORE' }] });
    // lettura dei dati in ingresso: 5 query per un lotto intero, indipendentemente dai rilievi
    let queries = 0;
    const counting = { ...db, query: (...args: Parameters<Db['query']>) => (queries++, db.query(...args)) } as Db;
    const inputs = await loadInputs(counting, ids.slice(0, 200));
    expect(inputs.size).toBe(200);
    expect(queries).toBeLessThanOrEqual(5);

    const jobId = await createScoringJob(db, { scope: { kind: 'all' }, trigger: 'bulk' }, userId);
    await expect(createScoringJob(db, { scope: { kind: 'all' }, trigger: 'bulk' }, userId)).rejects.toMatchObject({
      code: 'DUPLICATE_JOB',
    });
    const worker = new ScoringWorker(db, { log: silentLogger });
    expect(await worker.runOnce()).toBe(true);
    const job = await getScoringJob(db, jobId);
    expect(job.status).toBe('completed');
    expect(job.progress.processed).toBe(job.progress.total);
    expect(job.progress.created).toBeGreaterThanOrEqual(450);
    for (const id of ids) expect(await current(id)).toBe(1);

    const again = await createScoringJob(db, { scope: { kind: 'businesses', ids }, trigger: 'manual' }, userId);
    await worker.runOnce();
    expect((await getScoringJob(db, again)).progress).toMatchObject({ processed: 450, created: 0, unchanged: 450 });
    // prova di volume (450 aziende): ~4 s da sola, molto di più con gli altri file in parallelo
  }, 60_000);

  it('job interrotto: riprende dal cursore; annullamento di un job in coda', async () => {
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) ids.push(await insertBusiness(db));
    const jobId = await createScoringJob(
      db,
      { scope: { kind: 'businesses', ids }, trigger: 'manual', force: true },
      userId,
    );
    const sorted = [...ids].sort();
    // simula un processo terminato dopo i primi due
    await db.query(
      "UPDATE scoring_jobs SET status = 'running', worker_id = 'processo-morto', heartbeat_at = now() - interval '5 minutes', cursor = $2, processed = 2 WHERE id = $1",
      [jobId, sorted[1]],
    );
    await new ScoringWorker(db, { log: silentLogger }).runOnce();
    const job = await getScoringJob(db, jobId);
    expect(job).toMatchObject({ status: 'completed', progress: { processed: 5, created: 3 } });

    const pending = await createScoringJob(db, { scope: { kind: 'businesses', ids }, trigger: 'manual' }, userId);
    await cancelScoringJob(db, pending, userId);
    expect((await getScoringJob(db, pending)).status).toBe('cancelled');
    await expect(cancelScoringJob(db, pending, userId)).rejects.toMatchObject({ status: 409 });
  });
});
