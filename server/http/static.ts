import { createReadStream, statSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { extname, join, normalize, resolve, sep } from 'node:path';

/*
 * Interfaccia compilata (dist/) servita dallo stesso processo dell'API: in produzione basta un solo servizio,
 * stessa origine per pagina e API (niente CORS), cookie SameSite=Strict validi.
 * Percorsi senza estensione → index.html (navigazione dell'app). Nessun elenco delle cartelle, nessuna uscita da dist/.
 */

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
};

/** CSP stretta: solo risorse della stessa origine; nessuno script inline, nessuna cornice esterna. */
export const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "object-src 'none'",
].join('; ');

/** HTTPS obbligatorio per un anno sul dominio dell'app (solo in produzione, dove il sito è servito in HTTPS). */
export const STRICT_TRANSPORT_SECURITY = 'max-age=31536000';

function fileSize(path: string): number | null {
  try {
    const stat = statSync(path);
    return stat.isFile() ? stat.size : null;
  } catch {
    // file inesistente o illeggibile: per chi chiama è semplicemente "non c'è"
    return null;
  }
}

/**
 * Gestore dei file di dist/. Restituisce false se la richiesta non è sua (metodo, percorso fuori da dist/,
 * file con estensione inesistente): in quel caso risponde l'API con un 404 uniforme.
 */
export function createStaticHandler(distDir: string, options: { hsts: boolean }) {
  const root = resolve(distDir);
  const index = join(root, 'index.html');

  return function serveStatic(req: IncomingMessage, res: ServerResponse): boolean {
    if (req.method !== 'GET' && req.method !== 'HEAD') return false;
    let pathname: string;
    try {
      pathname = decodeURIComponent(new URL(req.url ?? '/', 'http://localhost').pathname);
    } catch {
      return false;
    }
    const candidate = normalize(join(root, pathname));
    if (candidate !== root && !candidate.startsWith(root + sep)) return false;

    // con estensione: un file reale di dist/; senza: una pagina dell'app → index.html
    const file = extname(pathname) ? candidate : index;
    const size = fileSize(file);
    if (size === null) return false;

    res.writeHead(200, {
      'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream',
      'Content-Length': size,
      // i file in assets/ hanno l'hash nel nome: si conservano a lungo; il resto si riconvalida sempre
      'Cache-Control':
        file !== index && pathname.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache',
      'Content-Security-Policy': CONTENT_SECURITY_POLICY,
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'no-referrer',
      ...(options.hsts ? { 'Strict-Transport-Security': STRICT_TRANSPORT_SECURITY } : {}),
    });
    if (req.method === 'HEAD') {
      res.end();
      return true;
    }
    // un errore di lettura a metà non deve far cadere il processo: si interrompe solo questa risposta
    createReadStream(file)
      .on('error', () => res.destroy())
      .pipe(res);
    return true;
  };
}
