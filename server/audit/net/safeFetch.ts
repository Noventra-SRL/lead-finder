import { lookup as dnsLookup } from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import type { LookupFunction } from 'node:net';
import type { TLSSocket } from 'node:tls';
import { createBrotliDecompress, createGunzip, createInflate } from 'node:zlib';
import type { Readable } from 'node:stream';
import { isAllowedHostname, isPublicAddress } from './address.ts';

/*
 * Richieste HTTP verso siti di terzi, con protezione SSRF obbligatoria.
 *
 *  - solo http: e https:, nessuna credenziale nell'URL, porte ammesse esplicite (di norma 80 e 443);
 *  - nomi host locali rifiutati; il DNS è risolto da noi e TUTTI gli indirizzi devono essere pubblici;
 *  - la connessione usa l'indirizzo appena validato (funzione lookup del socket): nessuna seconda risoluzione,
 *    quindi nessun "DNS rebinding" tra controllo e connessione;
 *  - redirect seguiti a mano, uno alla volta, rivalidando ogni destinazione (schema, porta, host, DNS), con un limite;
 *  - timeout di connessione/inattività e timeout totale; dimensione massima sia scaricata sia decompressa;
 *  - si legge il corpo solo per i tipi di contenuto richiesti (HTML, testo, XML): niente file, niente esecuzione;
 *  - certificati TLS sempre verificati; nessun cookie inviato o conservato; solo intestazioni generiche.
 */

export interface FetchPolicy {
  allowedPorts: number[];
  connectTimeoutMs: number;
  totalTimeoutMs: number;
  maxBytes: number;
  maxRedirects: number;
  userAgent: string;
  /** SOLO TEST: porte di 127.0.0.1 ammesse (per i server finti locali). Mai impostato in produzione. */
  testLoopbackPorts?: number[];
  /** Risoluzione DNS (sostituibile nei test). */
  resolve?: (host: string) => Promise<{ address: string; family: number }[]>;
}

export type FetchErrorKind =
  | 'invalid_url'
  | 'blocked'
  | 'dns'
  | 'timeout'
  | 'connection'
  | 'tls'
  | 'too_many_redirects'
  | 'http_protocol'
  | 'aborted';

export interface Redirect {
  url: string;
  status: number;
  location: string;
}

export class FetchError extends Error {
  readonly kind: FetchErrorKind;
  /** Codice tecnico (es. CERT_HAS_EXPIRED, ENOTFOUND), utile come evidenza. */
  readonly code?: string;
  readonly redirects: Redirect[];
  constructor(kind: FetchErrorKind, message: string, code?: string, redirects: Redirect[] = []) {
    super(message);
    this.kind = kind;
    this.code = code;
    this.redirects = redirects;
  }
}

export type Accept = 'html' | 'text' | 'xml';

const ACCEPT_HEADER: Record<Accept, string> = {
  html: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.1',
  text: 'text/plain,*/*;q=0.1',
  xml: 'application/xml,text/xml;q=0.9,*/*;q=0.1',
};
const READABLE: Record<Accept, RegExp> = {
  html: /^(text\/html|application\/xhtml\+xml)$/i,
  text: /^text\/plain$/i,
  xml: /^(application|text)\/([\w.+-]*\+)?xml$/i,
};

/** Intestazioni di risposta conservate (le altre, compresi i cookie, non vengono salvate). */
const KEPT_HEADERS = [
  'content-type',
  'content-length',
  'content-encoding',
  'content-language',
  'server',
  'x-powered-by',
  'x-generator',
  'strict-transport-security',
  'content-security-policy',
  'x-content-type-options',
  'x-frame-options',
  'referrer-policy',
  'permissions-policy',
  'x-robots-tag',
  'retry-after',
  'cf-mitigated',
  'cache-control',
];

export interface TlsInfo {
  protocol: string | null;
  validTo: string | null;
  daysToExpiry: number | null;
  issuer: string | null;
}

export interface FetchResult {
  requestedUrl: string;
  finalUrl: string;
  status: number;
  headers: Record<string, string>;
  redirects: Redirect[];
  contentType: string | null;
  /** Corpo decodificato; null se il tipo di contenuto non è tra quelli letti. */
  body: string | null;
  /** Byte del corpo dopo la decompressione (fino al limite). */
  bytes: number;
  /** Il corpo è stato troncato al limite di dimensione. */
  truncated: boolean;
  ttfbMs: number;
  totalMs: number;
  tls: TlsInfo | null;
  remoteAddress: string | null;
}

/** Verifica di un URL prima di contattarlo: schema, credenziali, porta, nome host. */
export function checkUrl(raw: string, policy: FetchPolicy): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new FetchError('invalid_url', 'Indirizzo non valido.');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:')
    throw new FetchError('invalid_url', `Protocollo non ammesso: ${url.protocol}`);
  if (url.username || url.password) throw new FetchError('invalid_url', 'Indirizzo con credenziali non ammesso.');
  const port = url.port ? Number(url.port) : url.protocol === 'https:' ? 443 : 80;
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (policy.testLoopbackPorts?.includes(port) && host === '127.0.0.1') return url;
  if (!policy.allowedPorts.includes(port)) throw new FetchError('blocked', `Porta non ammessa: ${port}.`);
  if (!isAllowedHostname(host)) throw new FetchError('blocked', `Destinazione non ammessa: ${host}.`);
  return url;
}

const defaultResolve = (host: string) => dnsLookup(host, { all: true, verbatim: true });

/** Funzione lookup per il socket: risolve, valida tutti gli indirizzi, connette a quello validato. */
function safeLookup(policy: FetchPolicy, port: number): LookupFunction {
  return (hostname, options, callback) => {
    const resolve = policy.resolve ?? defaultResolve;
    resolve(hostname).then(
      (addresses) => {
        if (!addresses.length)
          return callback(Object.assign(new Error('nessun indirizzo'), { code: 'ENOTFOUND' }), '', 4);
        const loopbackTest = policy.testLoopbackPorts?.includes(port);
        const allowed = addresses.every(
          (a) => isPublicAddress(a.address) || (loopbackTest && a.address === '127.0.0.1'),
        );
        if (!allowed) {
          const err = Object.assign(new Error(`Il nome ${hostname} risolve verso un indirizzo non pubblico.`), {
            code: 'ESSRFBLOCKED',
          });
          return callback(err, '', 4);
        }
        const wanted = options.family === 6 ? 6 : options.family === 4 ? 4 : 0;
        const pick = addresses.filter((a) => !wanted || a.family === wanted);
        if (!pick.length)
          return callback(Object.assign(new Error('famiglia di indirizzi assente'), { code: 'ENOTFOUND' }), '', 4);
        if (options.all)
          callback(
            null,
            pick.map((a) => ({ address: a.address, family: a.family })),
          );
        else callback(null, pick[0]!.address, pick[0]!.family);
      },
      (error: NodeJS.ErrnoException) => callback(error, '', 4),
    );
  };
}

const TLS_CODES = /^(CERT_|DEPTH_ZERO|SELF_SIGNED|UNABLE_TO_|ERR_TLS|ERR_SSL|HOSTNAME_MISMATCH)/;

function classify(error: NodeJS.ErrnoException, timedOut: boolean, aborted: boolean): FetchError {
  const code = error.code;
  if (aborted) return new FetchError('aborted', 'Richiesta interrotta.', code);
  if (timedOut || code === 'ETIMEDOUT' || code === 'ESOCKETTIMEDOUT')
    return new FetchError('timeout', 'Il sito non ha risposto entro il tempo massimo.', code ?? 'TIMEOUT');
  if (code === 'ESSRFBLOCKED') return new FetchError('blocked', error.message, code);
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN' || code === 'ENODATA')
    return new FetchError('dns', 'Il nome del sito non risolve (DNS).', code);
  if (code && TLS_CODES.test(code))
    return new FetchError('tls', `Errore del certificato o della connessione sicura (${code}).`, code);
  if (code?.startsWith('HPE_')) return new FetchError('http_protocol', `Risposta HTTP non valida (${code}).`, code);
  return new FetchError('connection', `Connessione non riuscita${code ? ` (${code})` : ''}.`, code);
}

function charsetOf(contentType: string | null, head: Buffer): string {
  const fromHeader = /charset\s*=\s*["']?([\w-]+)/i.exec(contentType ?? '')?.[1];
  if (fromHeader) return fromHeader;
  const sniff = head.subarray(0, 2048).toString('latin1');
  return /<meta[^>]+charset\s*=\s*["']?([\w-]+)/i.exec(sniff)?.[1] ?? 'utf-8';
}

function decode(buf: Buffer, contentType: string | null): string {
  try {
    return new TextDecoder(charsetOf(contentType, buf), { fatal: false }).decode(buf);
  } catch {
    return new TextDecoder('utf-8').decode(buf);
  }
}

interface Hop {
  status: number;
  headers: http.IncomingHttpHeaders;
  location: string | null;
  body: Buffer | null;
  bytes: number;
  truncated: boolean;
  ttfbMs: number;
  tls: TlsInfo | null;
  remoteAddress: string | null;
}

function oneRequest(url: URL, policy: FetchPolicy, accept: Accept, signal: AbortSignal): Promise<Hop> {
  return new Promise((resolve, reject) => {
    const started = performance.now();
    const port = url.port ? Number(url.port) : url.protocol === 'https:' ? 443 : 80;
    const host = url.hostname.replace(/^\[|\]$/g, '');
    let timedOut = false;
    const options: https.RequestOptions = {
      protocol: url.protocol,
      hostname: host,
      port,
      path: `${url.pathname}${url.search}`,
      method: 'GET',
      agent: false,
      lookup: safeLookup(policy, port),
      headers: {
        'User-Agent': policy.userAgent,
        Accept: ACCEPT_HEADER[accept],
        'Accept-Language': 'it-IT,it;q=0.9,en;q=0.5',
        'Accept-Encoding': 'gzip, deflate, br',
      },
      signal,
      timeout: policy.connectTimeoutMs,
      // mai disattivare la verifica dei certificati
      rejectUnauthorized: true,
      maxHeaderSize: 32 * 1024,
    };
    const req = (url.protocol === 'https:' ? https : http).request(options, (res) => {
      const ttfbMs = Math.round(performance.now() - started);
      const status = res.statusCode ?? 0;
      let tls: TlsInfo | null = null;
      const socket = res.socket as TLSSocket;
      if (url.protocol === 'https:' && typeof socket.getPeerCertificate === 'function') {
        const cert = socket.getPeerCertificate();
        const validTo = cert?.valid_to ? new Date(cert.valid_to) : null;
        tls = {
          protocol: socket.getProtocol?.() ?? null,
          validTo: validTo && !Number.isNaN(validTo.getTime()) ? validTo.toISOString() : null,
          daysToExpiry:
            validTo && !Number.isNaN(validTo.getTime())
              ? Math.floor((validTo.getTime() - Date.now()) / 86_400_000)
              : null,
          issuer: (Array.isArray(cert?.issuer?.O) ? cert.issuer.O[0] : cert?.issuer?.O) ?? null,
        };
      }
      const remoteAddress = res.socket?.remoteAddress ?? null;
      const location = status >= 300 && status < 400 ? (res.headers.location ?? null) : null;
      const type = (res.headers['content-type'] ?? '').split(';')[0]!.trim();
      // redirect o tipo non letto: niente corpo
      if (location || !READABLE[accept].test(type) || status === 204 || status === 304) {
        res.destroy();
        return resolve({
          status,
          headers: res.headers,
          location,
          body: null,
          bytes: 0,
          truncated: false,
          ttfbMs,
          tls,
          remoteAddress,
        });
      }
      const encoding = (res.headers['content-encoding'] ?? '').toLowerCase().trim();
      let stream: Readable = res;
      if (encoding === 'gzip' || encoding === 'x-gzip') stream = res.pipe(createGunzip());
      else if (encoding === 'deflate') stream = res.pipe(createInflate());
      else if (encoding === 'br') stream = res.pipe(createBrotliDecompress());
      const chunks: Buffer[] = [];
      let bytes = 0;
      let done = false;
      const finish = (truncated: boolean) => {
        if (done) return;
        done = true;
        res.destroy();
        stream.destroy();
        resolve({
          status,
          headers: res.headers,
          location: null,
          body: Buffer.concat(chunks),
          bytes,
          truncated,
          ttfbMs,
          tls,
          remoteAddress,
        });
      };
      stream.on('data', (c: Buffer) => {
        if (done) return;
        const room = policy.maxBytes - bytes;
        if (c.length > room) {
          // limite sui byte decompressi (difesa dalle "bombe" di compressione)
          chunks.push(c.subarray(0, room));
          bytes += room;
          return finish(true);
        }
        chunks.push(c);
        bytes += c.length;
      });
      // limite anche sui byte scaricati (registrato dopo quello sui decompressi, che taglia con precisione)
      let raw = 0;
      res.on('data', (c: Buffer) => {
        raw += c.length;
        if (raw > policy.maxBytes) finish(true);
      });
      stream.on('end', () => finish(false));
      stream.on('error', (e) => {
        if (done) return;
        done = true;
        reject(
          new FetchError(
            'http_protocol',
            `Contenuto compresso non valido (${(e as NodeJS.ErrnoException).code ?? 'errore'}).`,
          ),
        );
      });
      res.on('error', (e) => {
        if (done) return;
        done = true;
        reject(classify(e as NodeJS.ErrnoException, timedOut, signal.aborted && !timedOut));
      });
    });
    req.on('timeout', () => {
      timedOut = true;
      req.destroy(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' }));
    });
    req.on('error', (e) => {
      const isAbort = (e as NodeJS.ErrnoException).name === 'AbortError';
      reject(
        classify(
          e as NodeJS.ErrnoException,
          timedOut || (isAbort && signal.reason?.name === 'TimeoutError'),
          isAbort && signal.reason?.name !== 'TimeoutError',
        ),
      );
    });
    req.end();
  });
}

/** Scarica un URL seguendo i redirect in modo sicuro. Gli errori di rete diventano FetchError. */
export async function safeFetch(
  rawUrl: string,
  policy: FetchPolicy,
  opts: { accept: Accept; signal?: AbortSignal },
): Promise<FetchResult> {
  const started = performance.now();
  const timeout = AbortSignal.timeout(policy.totalTimeoutMs);
  const signal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout;
  const redirects: Redirect[] = [];
  let url = checkUrl(rawUrl, policy);
  for (;;) {
    let hop: Hop;
    try {
      hop = await oneRequest(url, policy, opts.accept, signal);
    } catch (error) {
      if (error instanceof FetchError) throw new FetchError(error.kind, error.message, error.code, redirects);
      throw error;
    }
    if (hop.location) {
      let next: URL;
      try {
        next = new URL(hop.location, url);
      } catch {
        throw new FetchError('invalid_url', 'Redirect verso un indirizzo non valido.', undefined, redirects);
      }
      redirects.push({ url: url.toString(), status: hop.status, location: next.toString() });
      if (redirects.length > policy.maxRedirects)
        throw new FetchError('too_many_redirects', `Più di ${policy.maxRedirects} redirect.`, undefined, redirects);
      try {
        url = checkUrl(next.toString(), policy);
      } catch (error) {
        const e = error as FetchError;
        throw new FetchError(e.kind, `Redirect verso una destinazione non ammessa: ${e.message}`, e.code, redirects);
      }
      continue;
    }
    const headers: Record<string, string> = {};
    for (const name of KEPT_HEADERS) {
      const v = hop.headers[name];
      if (v !== undefined) headers[name] = (Array.isArray(v) ? v.join(', ') : v).slice(0, 2000);
    }
    const contentType = headers['content-type'] ?? null;
    return {
      requestedUrl: rawUrl,
      finalUrl: url.toString(),
      status: hop.status,
      headers,
      redirects,
      contentType,
      body: hop.body ? decode(hop.body, contentType) : null,
      bytes: hop.bytes,
      truncated: hop.truncated,
      ttfbMs: hop.ttfbMs,
      totalMs: Math.round(performance.now() - started),
      tls: hop.tls,
      remoteAddress: hop.remoteAddress,
    };
  }
}
