import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import type { AddressInfo } from 'node:net';
import { gzipSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isAllowedHostname, isPublicAddress } from './address.ts';
import { checkUrl, FetchError, safeFetch, type FetchPolicy } from './safeFetch.ts';

/*
 * Protezione SSRF e limiti delle richieste. I siti "esterni" sono server locali su 127.0.0.1: per raggiungerli i test
 * ammettono esplicitamente le loro porte (testLoopbackPorts); tutto il resto resta bloccato come in produzione.
 */

let site: Server;
let tlsSite: ReturnType<typeof createHttpsServer>;
let port = 0;
let tlsPort = 0;
let hits: string[] = [];

beforeAll(async () => {
  site = createServer((req, res) => {
    hits.push(req.url ?? '');
    // nessuna intestazione interna o cookie deve arrivare ai siti
    if (req.url === '/headers') {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      return res.end(JSON.stringify(req.headers));
    }
    if (req.url === '/') {
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Set-Cookie': 'sessione=segreta',
        'X-Frame-Options': 'DENY',
      });
      return res.end('<html><head><title>Ciao</title></head><body>Città</body></html>');
    }
    if (req.url === '/latin1') {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      return res.end(Buffer.from('<meta charset="iso-8859-1"><p>Perch\xe9</p>', 'latin1'));
    }
    if (req.url === '/gzip') {
      res.writeHead(200, { 'Content-Type': 'text/html', 'Content-Encoding': 'gzip' });
      return res.end(gzipSync('<p>compresso</p>'));
    }
    if (req.url === '/bomba') {
      // 50 MB di zeri compressi in pochi KB
      res.writeHead(200, { 'Content-Type': 'text/html', 'Content-Encoding': 'gzip' });
      return res.end(gzipSync(Buffer.alloc(50 * 1024 * 1024)));
    }
    if (req.url === '/grande') {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      return res.end('x'.repeat(300_000));
    }
    if (req.url === '/pdf') {
      res.writeHead(200, { 'Content-Type': 'application/pdf' });
      return res.end('%PDF-1.4 non deve essere letto');
    }
    if (req.url === '/lento') return void setTimeout(() => res.end('tardi'), 3000);
    if (req.url?.startsWith('/redirect/')) {
      const n = Number(req.url.split('/')[2]);
      res.writeHead(302, { Location: n > 0 ? `/redirect/${n - 1}` : '/' });
      return res.end();
    }
    if (req.url === '/verso-metadati') {
      res.writeHead(301, { Location: 'http://169.254.169.254/latest/meta-data/' });
      return res.end();
    }
    if (req.url === '/verso-localhost') {
      res.writeHead(302, { Location: 'http://localhost/admin' });
      return res.end();
    }
    if (req.url === '/verso-porta') {
      res.writeHead(302, { Location: `http://example.com:6379/` });
      return res.end();
    }
    if (req.url === '/verso-file') {
      res.writeHead(302, { Location: 'file:///etc/passwd' });
      return res.end();
    }
    res.writeHead(404, { 'Content-Type': 'text/html' });
    res.end('<h1>non trovato</h1>');
  });
  await new Promise<void>((r) => site.listen(0, '127.0.0.1', r));
  port = (site.address() as AddressInfo).port;
  const dir = new URL('./testdata/', import.meta.url);
  tlsSite = createHttpsServer(
    { cert: readFileSync(new URL('selfsigned-cert.pem', dir)), key: readFileSync(new URL('selfsigned-key.pem', dir)) },
    (_req, res) => res.end('<p>tls</p>'),
  );
  await new Promise<void>((r) => tlsSite.listen(0, '127.0.0.1', r));
  tlsPort = (tlsSite.address() as AddressInfo).port;
});
afterAll(() => {
  site.close();
  tlsSite.close();
});

const policy = (over: Partial<FetchPolicy> = {}): FetchPolicy => ({
  allowedPorts: [80, 443],
  connectTimeoutMs: 2000,
  totalTimeoutMs: 5000,
  maxBytes: 200_000,
  maxRedirects: 5,
  userAgent: 'NoventraLeadFinder-Audit/test (+test)',
  testLoopbackPorts: [port, tlsPort],
  ...over,
});
const base = () => `http://127.0.0.1:${port}`;
const fail = async (p: Promise<unknown>) => (await p.then(() => null).catch((e) => e)) as FetchError;

describe('indirizzi e nomi ammessi', () => {
  it('solo indirizzi pubblici, compresi IPv4 incorporati in IPv6', () => {
    for (const ip of ['8.8.8.8', '2606:4700::1111', '::ffff:8.8.8.8']) expect(isPublicAddress(ip), ip).toBe(true);
    for (const ip of [
      '127.0.0.1',
      '10.0.0.1',
      '172.16.5.4',
      '192.168.1.1',
      '169.254.169.254',
      '100.64.0.1',
      '0.0.0.0',
      '224.0.0.1',
      '255.255.255.255',
      '198.18.0.1',
      '::1',
      '::',
      'fe80::1',
      'fd00::1',
      'ff02::1',
      '::ffff:127.0.0.1',
      '::ffff:7f00:1',
      '64:ff9b::a9fe:a9fe',
      '2002:c0a8:101::1',
      '2001:db8::1',
    ])
      expect(isPublicAddress(ip), ip).toBe(false);
  });

  it('nomi locali e di metadati rifiutati prima del DNS', () => {
    for (const h of ['localhost', 'app.localhost', 'nas.local', 'metadata.google.internal', 'x.internal', 'senzapunto'])
      expect(isAllowedHostname(h), h).toBe(false);
    expect(isAllowedHostname('www.farmacia.it')).toBe(true);
  });

  it('URL rifiutati: protocolli, credenziali, porte, host privati', () => {
    const p = policy({ testLoopbackPorts: [] });
    for (const [raw, kind] of [
      ['ftp://example.com/', 'invalid_url'],
      ['file:///etc/passwd', 'invalid_url'],
      ['javascript:alert(1)', 'invalid_url'],
      ['http://utente:password@example.com/', 'invalid_url'],
      ['non un url', 'invalid_url'],
      ['http://example.com:8080/', 'blocked'],
      ['http://127.0.0.1/', 'blocked'],
      ['http://[::1]/', 'blocked'],
      ['http://169.254.169.254/latest/meta-data/', 'blocked'],
      ['http://0x7f000001/', 'blocked'],
      ['http://2130706433/', 'blocked'],
      ['http://localhost/', 'blocked'],
    ] as const) {
      let error: unknown = null;
      try {
        checkUrl(raw, p);
      } catch (e) {
        error = e;
      }
      expect(error, raw).toBeInstanceOf(FetchError);
      expect((error as FetchError).kind, raw).toBe(kind);
    }
  });
});

describe('DNS', () => {
  it('un nome pubblico che risolve verso un indirizzo privato è bloccato, senza connessione', async () => {
    hits = [];
    const e = await fail(
      safeFetch(
        'http://sito-di-prova.example.com/',
        policy({ resolve: async () => [{ address: '127.0.0.1', family: 4 }] }),
        { accept: 'html' },
      ),
    );
    expect(e.kind).toBe('blocked');
    expect(hits).toEqual([]);
  });

  it('basta un solo indirizzo privato tra quelli restituiti per bloccare', async () => {
    const e = await fail(
      safeFetch(
        'http://misto.example.com/',
        policy({
          resolve: async () => [
            { address: '93.184.216.34', family: 4 },
            { address: '10.0.0.5', family: 4 },
          ],
        }),
        { accept: 'html' },
      ),
    );
    expect(e.kind).toBe('blocked');
  });

  it('DNS rebinding: la connessione usa l’indirizzo validato, la seconda risoluzione non viene mai fatta', async () => {
    let calls = 0;
    // prima risposta pubblica (non raggiungibile in test: porta chiusa), le successive private
    const resolve = async () =>
      ++calls === 1 ? [{ address: '192.0.2.1', family: 4 }] : [{ address: '127.0.0.1', family: 4 }];
    const e = await fail(
      safeFetch('http://rebind.example.com/', policy({ resolve, connectTimeoutMs: 300, totalTimeoutMs: 1000 }), {
        accept: 'html',
      }),
    );
    // 192.0.2.1 è di documentazione e quindi bloccato già alla prima risoluzione
    expect(e.kind).toBe('blocked');
    expect(calls).toBe(1);
  });

  it('nome inesistente: errore DNS, non "sito inesistente"', async () => {
    const e = await fail(
      safeFetch(
        'http://non-esiste.invalido-ma-pubblico.it/',
        policy({ resolve: async () => Promise.reject(Object.assign(new Error('x'), { code: 'ENOTFOUND' })) }),
        { accept: 'html' },
      ),
    );
    expect(e.kind).toBe('dns');
  });
});

describe('richieste e redirect', () => {
  it('scarica l’HTML, decodifica il charset, conserva solo intestazioni generiche e nessun cookie', async () => {
    const r = await safeFetch(`${base()}/`, policy(), { accept: 'html' });
    expect(r.status).toBe(200);
    expect(r.body).toContain('Città');
    expect(r.headers['x-frame-options']).toBe('DENY');
    expect(JSON.stringify(r.headers)).not.toContain('segreta');
    const latin = await safeFetch(`${base()}/latin1`, policy(), { accept: 'html' });
    expect(latin.body).toContain('Perché');
    expect((await safeFetch(`${base()}/gzip`, policy(), { accept: 'html' })).body).toBe('<p>compresso</p>');
  });

  it('nessun cookie, credenziale o intestazione interna inviata al sito', async () => {
    const r = await safeFetch(`${base()}/headers`, policy(), { accept: 'text' });
    const sent = JSON.parse(r.body!) as Record<string, string>;
    expect(Object.keys(sent).sort()).toEqual([
      'accept',
      'accept-encoding',
      'accept-language',
      'connection',
      'host',
      'user-agent',
    ]);
    expect(sent['user-agent']).toBe('NoventraLeadFinder-Audit/test (+test)');
  });

  it('segue i redirect registrandoli, con un limite', async () => {
    const r = await safeFetch(`${base()}/redirect/2`, policy(), { accept: 'html' });
    expect(r.redirects.map((x) => x.status)).toEqual([302, 302, 302]);
    expect(r.finalUrl).toBe(`${base()}/`);
    const e = await fail(safeFetch(`${base()}/redirect/9`, policy({ maxRedirects: 3 }), { accept: 'html' }));
    expect(e.kind).toBe('too_many_redirects');
    expect(e.redirects).toHaveLength(4);
  });

  it('redirect verso metadati del cloud, localhost, porte o protocolli non ammessi: bloccati', async () => {
    for (const path of ['/verso-metadati', '/verso-localhost', '/verso-porta']) {
      const e = await fail(safeFetch(`${base()}${path}`, policy(), { accept: 'html' }));
      expect(e.kind, path).toBe('blocked');
      expect(e.redirects, path).toHaveLength(1);
    }
    expect((await fail(safeFetch(`${base()}/verso-file`, policy(), { accept: 'html' }))).kind).toBe('invalid_url');
  });

  it('timeout totale', async () => {
    const e = await fail(safeFetch(`${base()}/lento`, policy({ totalTimeoutMs: 500 }), { accept: 'html' }));
    expect(e.kind).toBe('timeout');
  });

  it('dimensione massima, anche dopo la decompressione', async () => {
    const big = await safeFetch(`${base()}/grande`, policy({ maxBytes: 10_000 }), { accept: 'html' });
    expect(big).toMatchObject({ truncated: true, bytes: 10_000 });
    const bomb = await safeFetch(`${base()}/bomba`, policy({ maxBytes: 100_000 }), { accept: 'html' });
    expect(bomb.truncated).toBe(true);
    expect(bomb.bytes).toBeLessThanOrEqual(100_000);
  });

  it('i file non vengono scaricati: solo stato e tipo di contenuto', async () => {
    const r = await safeFetch(`${base()}/pdf`, policy(), { accept: 'html' });
    expect(r).toMatchObject({ status: 200, contentType: 'application/pdf', body: null, bytes: 0 });
  });

  it('certificato non valido: errore TLS, la verifica non si disattiva mai', async () => {
    const e = await fail(safeFetch(`https://127.0.0.1:${tlsPort}/`, policy(), { accept: 'html' }));
    expect(e.kind).toBe('tls');
    expect(e.code).toMatch(/SELF_SIGNED|DEPTH_ZERO|UNABLE_TO/);
  });

  it('annullamento dall’esterno', async () => {
    const ac = new AbortController();
    const p = safeFetch(`${base()}/lento`, policy(), { accept: 'html', signal: ac.signal });
    setTimeout(() => ac.abort(), 100);
    expect((await fail(p)).kind).toBe('aborted');
  });
});
