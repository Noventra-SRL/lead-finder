import { describe, expect, it } from 'vitest';
import { checkDeliverability, evaluateDmarc, evaluateSpf } from './deliverability.ts';
import { fakeResolver, readyZone } from './fakeDns.ts';

/* Controllo DNS del dominio del mittente con un resolver finto: nessuna rete. */

describe('controllo DNS del mittente', () => {
  it('SPF: assente, doppio, +all, ?all, valido', () => {
    expect(evaluateSpf([]).status).toBe('fail');
    expect(evaluateSpf(['v=spf1 -all', 'v=spf1 ~all']).status).toBe('fail');
    expect(evaluateSpf(['v=spf1 +all']).status).toBe('fail');
    expect(evaluateSpf(['v=spf1 a mx all']).status).toBe('fail');
    expect(evaluateSpf(['v=spf1 include:x ?all']).status).toBe('warn');
    expect(evaluateSpf(['google-site-verification=abc', 'v=spf1 include:x ~all']).status).toBe('ok');
  });

  it('DMARC: assente, none, quarantine/reject, senza politica', () => {
    expect(evaluateDmarc([]).status).toBe('fail');
    expect(evaluateDmarc(['v=DMARC1; p=none']).status).toBe('warn');
    expect(evaluateDmarc(['v=DMARC1; p=reject']).status).toBe('ok');
    expect(evaluateDmarc(['v=DMARC1; rua=mailto:x@y.it']).status).toBe('fail');
  });

  it('dominio configurato bene: pronto, DKIM trovato tra i selettori comuni', async () => {
    const r = await checkDeliverability('noventra.it', {
      dns: fakeResolver(readyZone),
      dkimSelectors: null,
      smtpHost: 'smtp.esempio.it',
    });
    expect(r.ready).toBe(true);
    expect(r.checks.map((c) => [c.code, c.status])).toEqual([
      ['MX', 'ok'],
      ['SPF', 'ok'],
      ['DKIM', 'ok'],
      ['DMARC', 'ok'],
      ['DBL', 'ok'],
      ['ZEN', 'ok'],
    ]);
    expect(r.checks.find((c) => c.code === 'DKIM')!.detail).toMatch(/google/);
  });

  it('DKIM con selettore indicato ma assente: non pronto', async () => {
    const r = await checkDeliverability('noventra.it', {
      dns: fakeResolver(readyZone),
      dkimSelectors: ['selector1'],
      smtpHost: null,
    });
    expect(r.checks.find((c) => c.code === 'DKIM')!.status).toBe('fail');
    expect(r.ready).toBe(false);
  });

  it('dominio o server SMTP in blocklist: non pronto; risposta 127.255.255.x = non verificabile', async () => {
    const listed = await checkDeliverability('noventra.it', {
      dns: fakeResolver({
        ...readyZone,
        a: {
          ...readyZone.a,
          'noventra.it.dbl.spamhaus.org': ['127.0.1.2'],
          '7.113.0.203.zen.spamhaus.org': ['127.0.0.2'],
        },
      }),
      dkimSelectors: null,
      smtpHost: 'smtp.esempio.it',
    });
    expect(listed.checks.filter((c) => c.status === 'fail').map((c) => c.code)).toEqual(['DBL', 'ZEN']);
    expect(listed.ready).toBe(false);

    const refused = await checkDeliverability('noventra.it', {
      dns: fakeResolver({ ...readyZone, a: { ...readyZone.a, 'noventra.it.dbl.spamhaus.org': ['127.255.255.254'] } }),
      dkimSelectors: null,
      smtpHost: 'smtp.esempio.it',
    });
    expect(refused.checks.find((c) => c.code === 'DBL')!.status).toBe('unknown');
    // le blocklist non verificabili non bloccano
    expect(refused.ready).toBe(true);
  });

  it('DNS non raggiungibile: tutto non verificabile, non pronto', async () => {
    const r = await checkDeliverability('noventra.it', {
      dns: fakeResolver({ fail: true }),
      dkimSelectors: null,
      smtpHost: null,
    });
    expect(r.checks.every((c) => c.status === 'unknown')).toBe(true);
    expect(r.ready).toBe(false);
  });

  it('server SMTP locale: nessun controllo ZEN', async () => {
    const r = await checkDeliverability('noventra.it', {
      dns: fakeResolver(readyZone),
      dkimSelectors: null,
      smtpHost: '127.0.0.1',
    });
    expect(r.checks.some((c) => c.code === 'ZEN')).toBe(false);
  });
});
