import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { defaultDiscovery } from '../config.ts';
import type { Db } from '../db/client.ts';
import { geo } from '../geo/geo.ts';
import { silentLogger } from '../logger.ts';
import { createTestUser, testDatabase } from '../testing.ts';
import type { CategoryId } from './categories.ts';
import {
  cancelJob,
  createJob,
  JobError,
  pauseJob,
  planUnits,
  recoverInterrupted,
  resumeJob,
  type JobRequest,
} from './jobs.ts';
import {
  ProviderError,
  type DiscoveryProvider,
  type DiscoveryUnitSpec,
  type ProviderRecord,
  type UnitResult,
} from './types.ts';
import { DiscoveryWorker } from './worker.ts';

/*
 * Job e worker con un fornitore finto programmabile (DATI DI TEST: nomi "di Prova", identificativi fittizi).
 * Nessuna richiesta di rete.
 */

type Handler = (
  unit: DiscoveryUnitSpec,
  categories: CategoryId[],
  limit: number,
  signal: AbortSignal,
) => Promise<UnitResult>;

class ScriptedProvider implements DiscoveryProvider {
  handler: Handler = async (unit) => result(unit);
  calls: DiscoveryUnitSpec[] = [];
  info() {
    return {
      id: 'osm',
      label: 'finto',
      configured: true,
      attribution: { text: '', url: '', license: '', licenseUrl: '' },
      supportsRadius: true,
      categories: [],
    };
  }
  fetchUnit(unit: DiscoveryUnitSpec, categories: CategoryId[], limit: number, signal: AbortSignal) {
    this.calls.push(unit);
    return this.handler(unit, categories, limit, signal);
  }
}

/** Due attività di prova per ogni comune dell'unità, con posizioni distinte. */
function recordsFor(unit: DiscoveryUnitSpec, perMunicipality = 2): ProviderRecord[] {
  return unit.municipalities.flatMap((m, i) =>
    Array.from({ length: perMunicipality }, (_, k) => ({
      provider: 'osm',
      ref: `node/${7_000_000_000 + Number(m.code) * 10 + k}`,
      sourceUrl: 'https://www.openstreetmap.org/node/0',
      name: `Farmacia di Prova ${m.code}-${k}`,
      category: 'farmacie' as const,
      websiteUrl: null,
      websiteDomain: null,
      websiteShared: false,
      sector: null,
      contacts: { phone: null, email: null, emailKind: null },
      address: { street: null, housenumber: null, postcode: null, city: null },
      municipalityCode: m.code,
      latitude: 40 + i * 0.1 + k * 0.01,
      longitude: 12,
      has: { website: false, address: false, phone: false, email: false, openingHours: false },
      sourceTags: {},
    })),
  );
}

const result = (unit: DiscoveryUnitSpec, over: Partial<UnitResult> = {}): UnitResult => ({
  records: recordsFor(unit),
  foundMunicipalities: unit.municipalities.map((m) => m.code),
  fromCache: false,
  fetchedAt: new Date('2026-10-01T10:00:00Z'),
  requests: 1,
  // dati della fonte recenti (un'ora fa): nessun avviso di dati vecchi, salvo nei test che lo verificano
  sourceTimestamp: new Date(Date.now() - 3_600_000).toISOString(),
  ...over,
});

let db: Db;
let userId: string;
let provider: ScriptedProvider;
let worker: DiscoveryWorker;
const config = { ...defaultDiscovery, municipalitiesPerRequest: 2, maxUnitsPerJob: 10 };

// tre comuni della provincia di Roma: due unità (2 + 1 comuni)
const AREA = { type: 'municipality' as const, code: '058091' };
const request = (over: Partial<JobRequest> = {}): JobRequest => ({
  area: AREA,
  categories: ['farmacie'],
  maxResults: 100,
  minCompleteness: 0,
  requireWebsite: false,
  ...over,
});
const create = (over: Partial<JobRequest> = {}, user = userId) =>
  createJob(db, request(over), { userId: user, provider: 'osm', providerConfigured: true, config });

async function job(id: string) {
  const { rows } = await db.query<Record<string, unknown>>('SELECT * FROM discovery_jobs WHERE id = $1', [id]);
  return rows[0]!;
}
/** Record salvati da un job (nuovi, aggiornati, invariati o collegati): è ciò che conta per il limite. */
const savedCount = (j: Record<string, unknown>) =>
  ['inserted', 'updated', 'unchanged', 'merged'].reduce((s, k) => s + Number(j[k]), 0);

async function units(id: string) {
  const { rows } = await db.query<{ seq: number; status: string; municipality_codes: string[] }>(
    'SELECT seq, status, municipality_codes FROM discovery_job_units WHERE job_id = $1 ORDER BY seq',
    [id],
  );
  return rows;
}
/** Area con tre comuni: si crea un job "provincia" fittizio limitando la pianificazione a tre comuni reali. */
async function threeMunicipalityJob(over: Partial<JobRequest> = {}) {
  const id = await create(over);
  await db.query('DELETE FROM discovery_job_units WHERE job_id = $1', [id]);
  await db.query(
    "INSERT INTO discovery_job_units (job_id, seq, municipality_codes) VALUES ($1, 0, '{058091,058003}'), ($1, 1, '{058004}')",
    [id],
  );
  await db.query('UPDATE discovery_jobs SET units_total = 2 WHERE id = $1', [id]);
  return id;
}

beforeAll(async () => {
  db = await testDatabase();
  userId = (await createTestUser(db, { email: 'job@noventra.test', password: 'password-di-prova-lunga' })).id;
});
afterAll(() => db.close());
beforeEach(async () => {
  provider = new ScriptedProvider();
  worker = new DiscoveryWorker(db, provider, { log: silentLogger, heartbeatMs: 20 });
  // ogni test parte senza job attivi (i limiti per utente sono verificati a parte)
  await db.query("UPDATE discovery_jobs SET status = 'cancelled' WHERE status IN ('pending', 'running', 'paused')");
});

describe('pianificazione', () => {
  it('divide l’area in unità di comuni della stessa provincia', () => {
    const roma = planUnits('province', '258', 25);
    expect(roma.length).toBe(Math.ceil(geo().municipalitiesIn('province', '258').length / 25));
    expect(roma.every((u) => u.length <= 25)).toBe(true);
    const lazio = planUnits('region', '12', 25);
    // nessuna unità mescola comuni di province diverse
    for (const u of lazio) expect(new Set(u.map((c) => geo().municipality(c)!.provinceCode)).size).toBe(1);
    expect(lazio.flat().length).toBe(geo().municipalitiesIn('region', '12').length);
    expect(planUnits('municipality', '058091', 25)).toEqual([['058091']]);
  });
});

describe('creazione dei job', () => {
  it('rifiuta fornitore non configurato, area sconosciuta, raggio senza comune, area troppo grande', async () => {
    const ctx = { userId, provider: 'osm', config };
    await expect(createJob(db, request(), { ...ctx, providerConfigured: false })).rejects.toMatchObject({
      code: 'PROVIDER_NOT_CONFIGURED',
      status: 503,
    });
    await expect(create({ area: { type: 'municipality', code: '999999' } })).rejects.toMatchObject({
      code: 'UNKNOWN_AREA',
    });
    await expect(create({ area: { type: 'province', code: '258' }, radiusKm: 5 })).rejects.toMatchObject({
      code: 'RADIUS_NEEDS_MUNICIPALITY',
    });
    await expect(create({ area: { type: 'italy', code: 'IT' } })).rejects.toMatchObject({ code: 'AREA_TOO_LARGE' });
    await expect(create({ maxResults: 999_999 })).rejects.toMatchObject({ code: 'TOO_MANY_RESULTS' });
  });

  it('un job identico attivo non si duplica; con parametri diversi sì', async () => {
    const first = await create();
    const dup = (await create().catch((e) => e)) as JobError;
    expect(dup).toMatchObject({ status: 409, code: 'DUPLICATE_JOB', jobId: first });
    // l'ordine delle categorie non cambia l'identità della richiesta
    const a = await create({ categories: ['hotel', 'farmacie'] });
    await expect(create({ categories: ['farmacie', 'hotel'] })).rejects.toMatchObject({
      code: 'DUPLICATE_JOB',
      jobId: a,
    });
  });

  it('limite di ricerche attive per utente', async () => {
    const other = (await createTestUser(db, { email: 'limite@noventra.test', password: 'password-di-prova-lunga' })).id;
    for (const max of [10, 11, 12]) await create({ maxResults: max }, other);
    await expect(create({ maxResults: 13 }, other)).rejects.toMatchObject({
      status: 429,
      code: 'TOO_MANY_ACTIVE_JOBS',
    });
  });
});

describe('esecuzione', () => {
  it('completa il job, salva le aziende e aggiorna avanzamento e contatori', async () => {
    const id = await threeMunicipalityJob();
    expect(await worker.runOnce()).toBe(true);
    const j = await job(id);
    expect(j).toMatchObject({
      status: 'completed',
      units_total: 2,
      units_done: 2,
      discovered: 6,
      inserted: 6,
      failed_requests: 0,
      requests_sent: 2,
    });
    expect(j.started_at).toBeTruthy();
    expect(j.finished_at).toBeTruthy();
    expect((await units(id)).map((u) => u.status)).toEqual(['done', 'done']);
    const { rows } = await db.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM business_sources WHERE last_job_id = $1',
      [id],
    );
    expect(rows[0]!.n).toBe(6);
    expect(await worker.runOnce()).toBe(false);
  });

  it('ripetere la stessa ricerca non crea doppioni', async () => {
    const before = (await db.query<{ n: number }>('SELECT count(*)::int AS n FROM businesses')).rows[0]!.n;
    const id = await threeMunicipalityJob();
    await worker.runOnce();
    expect(await job(id)).toMatchObject({ status: 'completed', inserted: 0, unchanged: 6 });
    expect((await db.query<{ n: number }>('SELECT count(*)::int AS n FROM businesses')).rows[0]!.n).toBe(before);
  });

  it('i tentativi falliti prima di un successo contano tra le richieste non riuscite', async () => {
    provider.handler = async (unit) => result(unit, { requests: 3 });
    const id = await threeMunicipalityJob({ categories: ['studi_professionali'] });
    await worker.runOnce();
    expect(await job(id)).toMatchObject({ status: 'completed', requests_sent: 6, failed_requests: 4 });
  });

  it('zero risultati è un successo, distinto da un errore', async () => {
    provider.handler = async (unit) => result(unit, { records: [] });
    const id = await threeMunicipalityJob({ categories: ['hotel'] });
    await worker.runOnce();
    expect(await job(id)).toMatchObject({ status: 'completed', discovered: 0, failed_requests: 0 });
  });

  it('comune assente nella fonte: avviso esplicito, non "zero risultati"', async () => {
    provider.handler = async (unit) => result(unit, { foundMunicipalities: [unit.municipalities[0]!.code] });
    const id = await threeMunicipalityJob({ categories: ['ristorazione'] });
    await worker.runOnce();
    const j = await job(id);
    expect(j.status).toBe('completed_with_warnings');
    expect(JSON.stringify(j.messages)).toContain('Comune non trovato su OpenStreetMap');
  });

  it('dati della fonte vecchi: un avviso per copia dei dati e ricerca completata con avvisi', async () => {
    const old = new Date(Date.now() - 89 * 86_400_000).toISOString();
    provider.handler = async (unit) => result(unit, { sourceTimestamp: old });
    const id = await threeMunicipalityJob({ categories: ['parafarmacie'] });
    await worker.runOnce();
    const j = await job(id);
    expect(j.status).toBe('completed_with_warnings');
    const warnings = (j.messages as { message: string }[]).filter((m) =>
      m.message.includes('Il server OpenStreetMap usa dati aggiornati al'),
    );
    // due unità con la stessa copia dei dati: un solo avviso
    expect(warnings).toHaveLength(1);
    expect(warnings[0]!.message).toContain('(89 giorni fa)');
    const { rows } = await db.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM discovery_job_units WHERE job_id = $1 AND source_data_at IS NOT NULL',
      [id],
    );
    expect(rows[0]!.n).toBe(2);
  });

  it('fornitore non disponibile su un’unità: avvisi visibili, poi ripresa solo della parte mancante', async () => {
    provider.handler = async (unit) => {
      if (unit.municipalities.length === 1)
        throw Object.assign(
          new ProviderError('unavailable', 'Server OpenStreetMap occupato (HTTP 504).', { retryable: true }),
          { attempts: 4 },
        );
      return result(unit);
    };
    const id = await threeMunicipalityJob({ categories: ['negozi'] });
    await worker.runOnce();
    let j = await job(id);
    expect(j).toMatchObject({ status: 'completed_with_warnings', failed_requests: 4, units_done: 2 });
    expect(JSON.stringify(j.messages)).toContain('HTTP 504');
    expect((await units(id)).map((u) => u.status)).toEqual(['done', 'failed']);

    provider.handler = async (unit) => result(unit);
    provider.calls = [];
    await resumeJob(db, id, userId, true);
    expect((await job(id)).status).toBe('pending');
    await worker.runOnce();
    j = await job(id);
    expect(j.status).toBe('completed');
    expect(provider.calls.map((c) => c.municipalities.map((m) => m.code))).toEqual([['058004']]);
  });

  it('tutte le unità fallite: job fallito', async () => {
    provider.handler = async () => {
      throw new ProviderError('rate_limited', 'Limite di richieste raggiunto.', { retryable: true });
    };
    const id = await threeMunicipalityJob({ categories: ['industria'] });
    await worker.runOnce();
    expect(await job(id)).toMatchObject({ status: 'failed', inserted: 0 });
  });

  it('richiesta troppo ampia: l’unità viene divisa e completata in parti', async () => {
    provider.handler = async (unit) => {
      if (unit.municipalities.length > 1) throw new ProviderError('too_large', 'Troppo ampia.', { retryable: true });
      return result(unit);
    };
    const id = await threeMunicipalityJob({ categories: ['studi_sanitari'] });
    await worker.runOnce();
    expect(await job(id)).toMatchObject({ status: 'completed', units_total: 4, units_done: 4 });
    expect((await units(id)).map((u) => `${u.status}:${u.municipality_codes.join('+')}`)).toEqual([
      'split:058091+058003',
      'done:058004',
      'done:058091',
      'done:058003',
    ]);
  });

  it('limite massimo di risultati: si ferma e salta le unità rimanenti', async () => {
    const id = await threeMunicipalityJob({ categories: ['hotel', 'ristorazione'], maxResults: 3 });
    await worker.runOnce();
    const j = await job(id);
    expect(j).toMatchObject({ status: 'completed', limit_reached: true });
    expect(savedCount(j)).toBe(3);
    expect((await units(id)).map((u) => u.status)).toEqual(['done', 'skipped']);
  });

  it('fornitore non configurato durante l’esecuzione: job sospeso con istruzioni', async () => {
    provider.handler = async () => {
      throw new ProviderError('not_configured', 'Nessun server OpenStreetMap configurato.');
    };
    const id = await threeMunicipalityJob({ categories: ['palestre_benessere'] });
    await worker.runOnce();
    expect(await job(id)).toMatchObject({ status: 'paused', pause_reason: 'not_configured' });
    expect((await units(id)).map((u) => u.status)).toEqual(['pending', 'pending']);
  });
});

/** Fornitore che resta in attesa finché la richiesta non viene annullata. */
const blockUntilAborted: Handler = (_u, _c, _l, signal) =>
  new Promise((_, reject) =>
    signal.addEventListener('abort', () => reject(new ProviderError('aborted', 'interrotta')), { once: true }),
  );

describe('annullamento, pausa e ripresa', () => {
  it('annullare una ricerca in corso interrompe la richiesta e conserva i risultati già salvati', async () => {
    let calls = 0;
    provider.handler = (unit, c, l, signal) =>
      ++calls === 1 ? Promise.resolve(result(unit)) : blockUntilAborted(unit, c, l, signal);
    const id = await threeMunicipalityJob({ categories: ['artigiani_servizi'] });
    const run = worker.runOnce();
    await waitFor(async () => calls === 2);
    await cancelJob(db, id, userId);
    await run;
    const j = await job(id);
    expect(j).toMatchObject({ status: 'cancelled', units_done: 1 });
    expect(savedCount(j)).toBe(4);
    await expect(resumeJob(db, id, userId, true)).rejects.toMatchObject({ code: 'INVALID_STATE' });
    await expect(cancelJob(db, id, userId)).rejects.toMatchObject({ code: 'INVALID_STATE' });
  });

  it('pausa e ripresa dal punto in cui si era fermata', async () => {
    let calls = 0;
    provider.handler = (unit, c, l, signal) =>
      ++calls === 1 ? Promise.resolve(result(unit)) : blockUntilAborted(unit, c, l, signal);
    const id = await threeMunicipalityJob({ categories: ['aziende_uffici'] });
    const run = worker.runOnce();
    await waitFor(async () => calls === 2);
    await pauseJob(db, id, userId);
    await run;
    expect(await job(id)).toMatchObject({ status: 'paused', pause_reason: 'manual', units_done: 1 });
    expect((await units(id)).map((u) => u.status)).toEqual(['done', 'pending']);

    provider.handler = async (unit) => result(unit);
    provider.calls = [];
    await resumeJob(db, id, userId, true);
    await worker.runOnce();
    expect(await job(id)).toMatchObject({ status: 'completed', units_done: 2 });
    expect(provider.calls).toHaveLength(1);
  });

  it('ricerca in coda: annullabile e sospendibile senza essere eseguita', async () => {
    const a = await threeMunicipalityJob({ categories: ['negozi'], maxResults: 7 });
    await cancelJob(db, a, userId);
    expect((await job(a)).status).toBe('cancelled');
    const b = await threeMunicipalityJob({ categories: ['negozi'], maxResults: 8 });
    await pauseJob(db, b, userId);
    expect(await job(b)).toMatchObject({ status: 'paused', pause_reason: 'manual' });
    expect(await worker.runOnce()).toBe(false);
  });

  it('server interrotto: la ricerca "in corso" senza battito diventa riprendibile', async () => {
    const id = await threeMunicipalityJob({ categories: ['hotel'], maxResults: 9 });
    await db.query(
      "UPDATE discovery_jobs SET status = 'running', worker_id = 'processo-terminato', heartbeat_at = now() - interval '5 minutes' WHERE id = $1",
      [id],
    );
    await db.query("UPDATE discovery_job_units SET status = 'running' WHERE job_id = $1 AND seq = 0", [id]);
    expect(await recoverInterrupted(db, 60_000, worker.id)).toEqual([id]);
    expect(await job(id)).toMatchObject({ status: 'paused', pause_reason: 'interrupted' });
    expect((await units(id)).map((u) => u.status)).toEqual(['pending', 'pending']);
    await resumeJob(db, id, userId, true);
    await worker.runOnce();
    expect((await job(id)).status).toBe('completed');
  });

  it('un job con battito recente di un altro processo non viene toccato', async () => {
    const id = await threeMunicipalityJob({ categories: ['hotel'], maxResults: 10 });
    await db.query(
      "UPDATE discovery_jobs SET status = 'running', worker_id = 'altro-processo', heartbeat_at = now() WHERE id = $1",
      [id],
    );
    expect(await recoverInterrupted(db, 60_000, worker.id)).toEqual([]);
    expect(await worker.runOnce()).toBe(false);
  });

  it('arresto del server durante una ricerca: in pausa per interruzione', async () => {
    provider.handler = blockUntilAborted;
    const id = await threeMunicipalityJob({ categories: ['hotel'], maxResults: 11 });
    const run = worker.runOnce();
    await waitFor(async () => provider.calls.length === 1);
    await worker.stop();
    await run;
    expect(await job(id)).toMatchObject({ status: 'paused', pause_reason: 'interrupted' });
  });
});

async function waitFor(check: () => Promise<boolean>, timeoutMs = 5000) {
  const start = Date.now();
  while (!(await check())) {
    if (Date.now() - start > timeoutMs) throw new Error('condizione non raggiunta');
    await new Promise((r) => setTimeout(r, 10));
  }
}
