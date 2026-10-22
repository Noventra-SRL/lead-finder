import { describe, expect, it } from 'vitest';
import { defaultAudit } from '../config.ts';
import { silentLogger } from '../logger.ts';
import { HostScheduler, runAudit } from './engine.ts';
import { policyFor } from './jobs.ts';
import { safeFetch } from './net/safeFetch.ts';
import { PageSpeedProvider } from './performance/pagespeed.ts';

/*
 * Prove dal vivo dell'audit. Non fanno parte della suite normale: si avviano solo con
 *
 *   LIVE_AUDIT_URL=https://example.com/ npm run test:live
 *
 * LIVE_AUDIT_URL deve essere un dominio di prova controllato (example.com è riservato dallo IANA per questo uso):
 * mai il sito di un'azienda. Con LIVE_PAGESPEED_KEY si misura anche una pagina con PageSpeed Insights (consuma quota).
 */

const target = process.env.LIVE_AUDIT_URL;
const pagespeedKey = process.env.LIVE_PAGESPEED_KEY;
const policy = policyFor(defaultAudit, 'test-live');

describe.skipIf(!target)(`audit dal vivo (${target ?? 'non configurato'})`, () => {
  it('pagina principale reale: HTTPS verificato, robots letto, rilievi con evidenza', async () => {
    const out = await runAudit(
      target!,
      'aziende_uffici',
      { maxPages: 1, strategies: ['mobile'], usePerformance: false },
      { policy, hostIntervalMs: 2000, performance: null, hosts: new HostScheduler(), log: silentLogger },
      AbortSignal.timeout(120_000),
    );
    expect(['valid', 'redirected']).toContain(out.websiteStatus);
    expect(out.summary.https?.available).toBe(true);
    expect(out.pages[0]?.status).toBe(200);
    expect(out.pages[0]?.tls?.daysToExpiry).toBeGreaterThan(0);
    for (const f of out.findings) expect(f.evidence).toBeTypeOf('object');
  });

  it('SSRF: i nomi che risolvono verso indirizzi privati vengono rifiutati anche con un DNS reale', async () => {
    // "localtest.me" risolve pubblicamente a 127.0.0.1 ("dns" solo se il resolver locale non risponde)
    await expect(safeFetch('http://localtest.me/', policy, { accept: 'html' })).rejects.toMatchObject({
      kind: expect.stringMatching(/blocked|dns/),
    });
  });
});

describe.skipIf(!target || !pagespeedKey)('PageSpeed Insights dal vivo', () => {
  it('misura reale: punteggio 0–100 e metriche di laboratorio, chiave mai nei risultati', async () => {
    const provider = new PageSpeedProvider({
      apiKey: pagespeedKey!,
      enabled: true,
      endpoint: 'https://www.googleapis.com/pagespeedonline/v5/runPagespeed',
      timeoutMs: 120_000,
      maxRetries: 1,
      minIntervalMs: 0,
      cacheTtlMs: 0,
    });
    const r = await provider.analyze(target!, 'mobile', AbortSignal.timeout(150_000));
    expect(JSON.stringify(r)).not.toContain(pagespeedKey!);
    expect(r.status).toBe('ok');
    if (r.status === 'ok') {
      expect(r.lab.performanceScore).toBeGreaterThanOrEqual(0);
      expect(r.lab.performanceScore).toBeLessThanOrEqual(100);
    }
  });
});
