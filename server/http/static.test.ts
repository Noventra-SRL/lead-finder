import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { listenOnFetchablePort } from '../testing.ts';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CONTENT_SECURITY_POLICY, createStaticHandler } from './static.ts';

/* File dell'interfaccia compilata serviti dal server: pagine, risorse, sicurezza dei percorsi. */

const tmp = mkdtempSync(join(tmpdir(), 'nlf-static-'));
const dist = join(tmp, 'dist');
let base = '';
let server: Server;

function start(hsts: boolean): Promise<{ url: string; server: Server }> {
  const serve = createStaticHandler(dist, { hsts });
  const s = createServer((req, res) => {
    if (!serve(req, res)) {
      res.writeHead(404, { 'X-Fallback': 'api' });
      res.end();
    }
  });
  return listenOnFetchablePort(s).then((port) => ({ url: `http://127.0.0.1:${port}`, server: s }));
}

beforeAll(async () => {
  mkdirSync(join(dist, 'assets'), { recursive: true });
  writeFileSync(join(dist, 'index.html'), '<!doctype html><title>app</title>');
  writeFileSync(join(dist, 'assets', 'index-abc.js'), 'console.log(1)');
  writeFileSync(join(dist, 'robots.txt'), 'User-agent: *');
  // un file FUORI da dist/ che non deve mai essere raggiungibile
  writeFileSync(join(tmp, 'segreto.txt'), 'DATABASE_URL=postgres://u:p@h/db');
  ({ url: base, server } = await start(false));
});
afterAll(() => {
  server.close();
  rmSync(tmp, { recursive: true, force: true });
});

describe('file statici', () => {
  it('le pagine dell’app ricevono index.html con CSP e senza cache', async () => {
    for (const path of ['/', '/impostazioni', '/aziende/123']) {
      const res = await fetch(base + path);
      expect(res.status).toBe(200);
      expect(await res.text()).toContain('<title>app</title>');
      expect(res.headers.get('content-security-policy')).toBe(CONTENT_SECURITY_POLICY);
      expect(res.headers.get('cache-control')).toBe('no-cache');
      expect(res.headers.get('x-frame-options')).toBe('DENY');
    }
  });

  it('la CSP non ammette script inline, risorse esterne o data: per i font', () => {
    expect(CONTENT_SECURITY_POLICY).not.toContain('unsafe-inline');
    expect(CONTENT_SECURITY_POLICY).toContain("font-src 'self'");
    expect(CONTENT_SECURITY_POLICY).toContain("frame-ancestors 'none'");
  });

  it('le risorse con hash si conservano a lungo, le altre si riconvalidano', async () => {
    const js = await fetch(base + '/assets/index-abc.js');
    expect(js.status).toBe(200);
    expect(js.headers.get('content-type')).toContain('text/javascript');
    expect(js.headers.get('cache-control')).toContain('immutable');
    const robots = await fetch(base + '/robots.txt');
    expect(robots.headers.get('cache-control')).toBe('no-cache');
  });

  it('un file con estensione inesistente non diventa la pagina dell’app', async () => {
    const res = await fetch(base + '/assets/manca.js');
    expect(res.status).toBe(404);
    expect(res.headers.get('x-fallback')).toBe('api');
  });

  it('nessun percorso esce da dist/', async () => {
    for (const path of [
      '/../segreto.txt',
      '/%2e%2e/segreto.txt',
      '/..%2fsegreto.txt',
      '/assets/..%2f..%2fsegreto.txt',
      '/%2e%2e%5csegreto.txt',
    ]) {
      const res = await fetch(base + path);
      const body = await res.text();
      expect(body, path).not.toContain('DATABASE_URL');
    }
  });

  it('i metodi diversi da GET e HEAD passano all’API', async () => {
    const res = await fetch(base + '/', { method: 'POST' });
    expect(res.headers.get('x-fallback')).toBe('api');
    const head = await fetch(base + '/', { method: 'HEAD' });
    expect(head.status).toBe(200);
    expect(await head.text()).toBe('');
  });

  it('HSTS solo quando richiesto (produzione)', async () => {
    expect((await fetch(base + '/')).headers.get('strict-transport-security')).toBeNull();
    const prod = await start(true);
    try {
      expect((await fetch(prod.url + '/')).headers.get('strict-transport-security')).toBe('max-age=31536000');
    } finally {
      prod.server.close();
    }
  });
});
