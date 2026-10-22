import type { Server as NetServer } from 'node:net';
import { createAiServices } from './ai/services.ts';
import { createEmailServices, type EmailSender } from './email/sender.ts';
import type { DnsResolver } from './email/deliverability.ts';
import type { InboxReader } from './email/replies.ts';
import type { AiProvider } from './ai/provider.ts';
import type { AiConfig, EmailConfig } from './config.ts';
import { randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import pg from 'pg';
import type { AddressInfo } from 'node:net';
import { hashPassword } from './auth/passwords.ts';
import { RateLimiter } from './auth/rateLimit.ts';
import { createUser, type Role } from './auth/users.ts';
import { policyFor } from './audit/jobs.ts';
import {
  defaultAudit,
  defaultDiscovery,
  defaultSessions,
  developmentSecurity,
  type SecurityConfig,
  type SessionConfig,
} from './config.ts';
import { OverpassProvider } from './discovery/osm/overpass.ts';
import type { AuditServices, DiscoveryServices, HunterServices, ScoringServices } from './http/core.ts';
import { openDatabase, type Db } from './db/client.ts';
import { migrate } from './db/migrate.ts';
import { createApp } from './http/app.ts';
import { silentLogger, type Logger } from './logger.ts';

/*
 * Strumenti per i test: un database nuovo per ogni file di test e un server HTTP su una porta libera.
 *  - predefinito: PostgreSQL incorporato IN MEMORIA (PGlite), isolato per costruzione;
 *  - con TEST_DATABASE_URL (npm run test:postgres): un database dedicato creato su quel server PostgreSQL
 *    ed eliminato alla chiusura, raggiunto con il driver `pg` di produzione.
 */

export const testingPostgres = () => Boolean(process.env.TEST_DATABASE_URL);

export async function testDatabase(options: { migrate?: boolean } = {}): Promise<Db> {
  const db = await emptyDatabase();
  if (options.migrate ?? true) await migrate(db);
  return db;
}

async function adminQuery(base: string, sql: string) {
  const admin = new pg.Client({ connectionString: base });
  await admin.connect();
  try {
    await admin.query(sql);
  } finally {
    await admin.end();
  }
}

/** Database vuoto dedicato sul server di TEST_DATABASE_URL: indirizzo ed eliminazione. */
export async function scratchPostgresDatabase(base: string): Promise<{ url: string; drop(): Promise<void> }> {
  // nome generato qui (solo lettere minuscole e cifre): sicuro da inserire nel testo SQL
  const name = `nlf_test_${randomBytes(6).toString('hex')}`;
  await adminQuery(base, `CREATE DATABASE ${name}`);
  const url = new URL(base);
  url.pathname = `/${name}`;
  return { url: url.toString(), drop: () => adminQuery(base, `DROP DATABASE IF EXISTS ${name} WITH (FORCE)`) };
}

async function emptyDatabase(): Promise<Db> {
  const base = process.env.TEST_DATABASE_URL;
  if (!base) return openDatabase({ kind: 'pglite-memory' });
  const scratch = await scratchPostgresDatabase(base);
  const db = await openDatabase({ kind: 'postgres', url: scratch.url, ssl: false });
  return {
    ...db,
    async close() {
      await db.close();
      await scratch.drop();
    },
  };
}

export interface TestServer {
  url: string;
  db: Db;
  limiter: RateLimiter;
  close(): Promise<void>;
}

export async function startTestServer(
  db: Db,
  options: {
    security?: SecurityConfig;
    sessions?: SessionConfig;
    log?: Logger;
    limiter?: RateLimiter;
    discovery?: Partial<DiscoveryServices>;
    audit?: Partial<AuditServices>;
    scoring?: Partial<ScoringServices>;
    hunter?: Partial<HunterServices>;
    /** Fornitore AI di prova (predefinito: nessuno, AI non configurata). */
    ai?: { provider?: AiProvider | null; config?: Partial<AiConfig>; workerActive?: boolean };
    /** Invio email di prova (predefinito: non configurato). */
    email?: {
      sender?: EmailSender | null;
      config?: Partial<EmailConfig>;
      dns?: DnsResolver;
      inbox?: InboxReader | null;
    };
  } = {},
): Promise<TestServer> {
  const limiter = options.limiter ?? new RateLimiter();
  const handler = createApp(db, {
    log: options.log ?? silentLogger,
    limiter,
    state: {
      startedAt: new Date(),
      version: 'test',
      config: {
        env: 'test',
        database: { kind: 'pglite-memory' },
        security: options.security ?? developmentSecurity,
        sessions: options.sessions ?? defaultSessions,
      },
      discovery: {
        // predefinito: fornitore NON configurato (nessuna richiesta di rete nei test)
        provider: new OverpassProvider({
          endpoint: null,
          userAgent: 'NoventraLeadFinder/test',
          minIntervalMs: 0,
          timeoutSeconds: 30,
          maxsizeBytes: 1 << 28,
          maxRetries: 0,
          maxResponseBytes: 1 << 20,
          cacheTtlMs: 0,
        }),
        config: defaultDiscovery,
        wake: () => undefined,
        workerActive: false,
        ...options.discovery,
      },
      audit: {
        // predefinito: prestazioni NON configurate, nessun esecutore (i test lo avviano esplicitamente)
        config: defaultAudit,
        policy: policyFor(defaultAudit, 'test'),
        performance: null,
        wake: () => undefined,
        workerActive: false,
        ...options.audit,
      },
      scoring: { wake: () => undefined, workerActive: false, ...options.scoring },
      hunter: { wake: () => undefined, workerActive: false, ...options.hunter },
      ai: createAiServices(db, {
        provider: options.ai?.provider ?? null,
        config: { ...testAiConfig, ...options.ai?.config },
        log: silentLogger,
        workerActive: options.ai?.workerActive ?? false,
      }),
      email: createEmailServices(
        { ...testEmailConfig, ...options.email?.config },
        {
          sender: options.email?.sender ?? null,
          dns: options.email?.dns ?? offlineResolver,
          inbox: options.email?.inbox ?? null,
        },
      ),
    },
  });
  const server: Server = createServer((req, res) => void handler(req, res));
  const port = await listenOnFetchablePort(server);
  return {
    url: `http://127.0.0.1:${port}`,
    db,
    limiter,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

/** Utente pronto all'uso (password già definitiva, non temporanea). */
export async function createTestUser(db: Db, input: { email: string; role?: Role; password?: string }) {
  const created = await createUser(db, {
    email: input.email,
    displayName: 'Utente di prova',
    role: input.role ?? 'sales',
  });
  if (input.password) {
    await db.query('UPDATE users SET password_hash = $2, must_change_password = false WHERE id = $1', [
      created.id,
      await hashPassword(input.password),
    ]);
  }
  return { id: created.id, password: input.password ?? created.temporaryPassword };
}

/** Client HTTP minimo per i test: conserva il cookie di sessione e invia l'origine corretta. */
export function client(baseUrl: string) {
  let cookie = '';
  return {
    get cookie() {
      return cookie;
    },
    async request(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
      const res = await fetch(baseUrl + path, {
        method,
        headers: {
          ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
          ...(method !== 'GET' ? { Origin: baseUrl } : {}),
          ...(cookie ? { Cookie: cookie } : {}),
          ...headers,
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
      const setCookie = res.headers.getSetCookie();
      for (const c of setCookie) {
        const pair = c.split(';')[0]!;
        cookie = pair.endsWith('=') ? '' : pair;
      }
      const text = await res.text();
      return { status: res.status, headers: res.headers, body: text ? JSON.parse(text) : null, setCookie };
    },
  };
}

/** DNS dei test: nessuna rete, ogni nome risulta inesistente (dominio del mittente non pronto). */
export const offlineResolver: DnsResolver = {
  resolveMx: () => Promise.reject(Object.assign(new Error('nessuna rete nei test'), { code: 'ENOTFOUND' })),
  resolveTxt: () => Promise.reject(Object.assign(new Error('nessuna rete nei test'), { code: 'ENOTFOUND' })),
  resolve4: () => Promise.reject(Object.assign(new Error('nessuna rete nei test'), { code: 'ENOTFOUND' })),
};

/** Invio email dei test: nessun server SMTP; i test passano un FakeEmailSender e la configurazione completa. */
export const testEmailConfig: EmailConfig = {
  smtp: null,
  fromAddress: null,
  fromName: 'Noventra',
  replyTo: null,
  senderAuthorized: false,
  dkimSelectors: null,
  timeoutMs: 5000,
  missing: ['SMTP_HOST', 'EMAIL_SENDER_AUTHORIZED=si'],
  imap: null,
  repliesWorker: false,
  repliesPollMs: 600_000,
};

/** Configurazione AI dei test: nessuna chiave, prezzi noti per verificare la stima dei costi. */
export const testAiConfig: AiConfig = {
  provider: null,
  apiKey: null,
  model: 'modello-di-prova',
  effort: 'medium',
  concurrency: 2,
  // margine per il server finto locale con molti file di test in parallelo (il test del timeout usa 300 ms)
  timeoutMs: 30_000,
  maxRetries: 0,
  worker: false,
  price: { inputPerMTok: 4, outputPerMTok: 20 },
  testBaseUrl: null,
  autoAssess: false,
  autoDailyLimit: 500,
};

/**
 * Porte che fetch() rifiuta per standard (Fetch, «bad ports»): se il sistema operativo ne assegna una, ogni richiesta
 * dei test fallisce con «bad port». Si chiede un'altra porta.
 */
const FETCH_BLOCKED_PORTS = new Set([
  1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77, 79, 87, 95, 101, 102, 103, 104, 109, 110,
  111, 113, 115, 117, 119, 123, 135, 137, 139, 143, 161, 179, 389, 427, 465, 512, 513, 514, 515, 526, 530, 531, 532,
  540, 548, 554, 556, 563, 587, 601, 636, 989, 990, 993, 995, 1719, 1720, 1723, 2049, 3659, 4045, 4190, 5060, 5061,
  6000, 6566, 6665, 6666, 6667, 6668, 6669, 6679, 6697, 10080,
]);

export async function listenOnFetchablePort(server: NetServer): Promise<number> {
  for (let attempt = 0; attempt < 20; attempt++) {
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    if (!FETCH_BLOCKED_PORTS.has(port)) return port;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  throw new Error('Nessuna porta utilizzabile da fetch() dopo 20 tentativi.');
}
