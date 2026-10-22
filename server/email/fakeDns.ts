import type { DnsResolver } from './deliverability.ts';

/* SOLO TEST: DNS finto per il controllo del dominio del mittente, nessuna rete. */

const missing = () => Promise.reject(Object.assign(new Error('non trovato'), { code: 'ENOTFOUND' }));

/** Resolver finto: TXT e A per nome, MX per dominio; tutto il resto non esiste. */
export function fakeResolver(zone: {
  mx?: Record<string, string[]>;
  txt?: Record<string, string[]>;
  a?: Record<string, string[]>;
  fail?: boolean;
}): DnsResolver {
  const err = () => Promise.reject(Object.assign(new Error('timeout'), { code: 'ETIMEOUT' }));
  return {
    resolveMx: (n) =>
      zone.fail
        ? err()
        : zone.mx?.[n]
          ? Promise.resolve(zone.mx[n].map((e) => ({ exchange: e, priority: 10 })))
          : missing(),
    resolveTxt: (n) => (zone.fail ? err() : zone.txt?.[n] ? Promise.resolve(zone.txt[n].map((t) => [t])) : missing()),
    resolve4: (n) => (zone.fail ? err() : zone.a?.[n] ? Promise.resolve(zone.a[n]) : missing()),
  };
}

const KEY = 'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA';

export const readyZone = {
  mx: { 'noventra.it': ['mx.esempio.it'] },
  txt: {
    'noventra.it': ['v=spf1 include:_spf.esempio.it -all'],
    '_dmarc.noventra.it': ['v=DMARC1; p=quarantine; rua=mailto:dmarc@noventra.it'],
    'google._domainkey.noventra.it': [`v=DKIM1; k=rsa; p=${KEY}`],
  },
  a: { 'smtp.esempio.it': ['203.0.113.7'] },
};
