import { z } from 'zod';

/*
 * Configurazione del server, letta dalle variabili d'ambiente e validata all'avvio con zod.
 * Un valore non valido ferma il processo con un messaggio che nomina la variabile, mai il suo valore
 * (DATABASE_URL contiene credenziali). L'elenco commentato delle variabili è in .env.example.
 */

export type DatabaseConfig =
  | { kind: 'postgres'; url: string; ssl: boolean }
  | { kind: 'pglite'; dataDir: string }
  /** Solo test: PostgreSQL incorporato in memoria. */
  | { kind: 'pglite-memory' };

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface SecurityConfig {
  /** Origine pubblica dell'interfaccia; se assente (sviluppo) vale l'origine della richiesta stessa. */
  appOrigin: string | null;
  /** Cookie solo su HTTPS (produzione). */
  secureCookies: boolean;
  trustProxy: boolean;
}

export interface SessionConfig {
  idleMs: number;
  maxMs: number;
}

export interface DiscoveryConfig {
  /** Endpoint Overpass API; null = scoperta non configurata (errore chiaro all'utente, nessun dato finto). */
  overpassUrl: string | null;
  /** Recapito nello User-Agent (email o URL), consigliato dalle regole d'uso dei server pubblici. */
  contact: string | null;
  minIntervalMs: number;
  queryTimeoutSeconds: number;
  maxRetries: number;
  municipalitiesPerRequest: number;
  maxUnitsPerJob: number;
  maxResultsPerJob: number;
  cacheTtlMs: number;
  /** Oltre quanti giorni i dati della fonte sono segnalati come vecchi. */
  staleDataDays: number;
  /** Elaborazione dei job in questo processo (disattivabile se si avviano più istanze dell'API). */
  worker: boolean;
  /** Google Maps Platform — Places API (New): facoltativo; la chiave resta sul server. */
  google: {
    apiKey: string | null;
    baseUrl: string;
    /** Pagine da 20 risultati per ricerca (massimo 3, limite dell'API). */
    maxPages: number;
    /** Richieste al giorno (limite di spesa): oltre, le ricerche si fermano e lo dichiarano. */
    dailyLimit: number;
  };
}

export interface AuditConfig {
  defaultPages: number;
  maxPages: number;
  requestTimeoutMs: number;
  connectTimeoutMs: number;
  maxResponseBytes: number;
  maxRedirects: number;
  allowedPorts: number[];
  hostIntervalMs: number;
  concurrency: number;
  reauditHours: number;
  maxBusinessesPerJob: number;
  contact: string | null;
  pagespeedApiKey: string | null;
  pagespeedEnabled: boolean;
  pagespeedStrategies: ('mobile' | 'desktop')[];
  worker: boolean;
  /** SOLO NODE_ENV=test: porte di 127.0.0.1 raggiungibili (siti finti dei test end-to-end). */
  testLoopbackPorts: number[];
}

export interface ServerConfig {
  env: 'development' | 'production' | 'test';
  host: string;
  port: number;
  logLevel: LogLevel;
  database: DatabaseConfig;
  security: SecurityConfig;
  sessions: SessionConfig;
  discovery: DiscoveryConfig;
  audit: AuditConfig;
  /** Ricalcoli in background dei punteggi dei lead (Fase 4). */
  scoring: { worker: boolean };
  /** Coordinatore delle ricerche di lead (Fase 6). */
  hunter: { worker: boolean };
  reminders: { worker: boolean };
  /** Valutazione commerciale con AI (server/ai). */
  ai: AiConfig;
  /** Invio delle email commerciali (server/email). */
  email: EmailConfig;
}

/**
 * Invio delle email commerciali via SMTP (Fase 9). Credenziali solo sul server: mai registrate, mai restituite.
 * `smtp: null` = invio non configurato (bozze e generazione restano disponibili, l'invio è disattivato).
 */
export interface EmailConfig {
  smtp: {
    host: string;
    port: number;
    /** tls = connessione cifrata dall'inizio (465); starttls = cifratura obbligatoria dopo la connessione (587). */
    security: 'tls' | 'starttls' | 'none';
    user: string | null;
    password: string | null;
  } | null;
  /** Mittente: l'amministratore deve averlo autorizzato sul server di posta (SPF/DKIM), vedi `senderAuthorized`. */
  fromAddress: string | null;
  fromName: string;
  replyTo: string | null;
  /** Dichiarazione dell'amministratore: il server SMTP può inviare da `fromAddress`. Senza, l'invio resta bloccato. */
  senderAuthorized: boolean;
  timeoutMs: number;
  /** Variabili mancanti per completare la configurazione (solo nomi, mai valori). */
  missing: string[];
}

export interface AiConfig {
  /** Fornitore del modello; null = valutazione AI non configurata (resta il punteggio di riserva). */
  provider: 'anthropic' | null;
  /** Chiave del fornitore: solo sul server, mai registrata né restituita dall'API. */
  apiKey: string | null;
  model: string;
  effort: 'low' | 'medium' | 'high';
  /** Valutazioni contemporanee nei lotti. */
  concurrency: number;
  timeoutMs: number;
  maxRetries: number;
  worker: boolean;
  /** Prezzi in USD per milione di token (stima dei costi); null = non noti. */
  price: { inputPerMTok: number; outputPerMTok: number } | null;
  /** SOLO NODE_ENV=test: indirizzo di un server finto locale con il protocollo del fornitore. */
  testBaseUrl: string | null;
  /** Valutazione automatica di ogni azienda (impronte sempre; chiamate al modello solo con il fornitore configurato). */
  autoAssess: boolean;
  /** Massimo di valutazioni automatiche nelle ultime 24 ore (controllo dei costi). */
  autoDailyLimit: number;
}

/** Prezzi pubblici dei modelli Claude (USD per milione di token) per la stima dei costi; altri modelli: da variabili. */
const KNOWN_PRICES: Record<string, { inputPerMTok: number; outputPerMTok: number }> = {
  'claude-opus-5-5': { inputPerMTok: 4, outputPerMTok: 20 },
  'claude-sonnet-5-5': { inputPerMTok: 2, outputPerMTok: 10 },
  'claude-haiku-5-5': { inputPerMTok: 0.1, outputPerMTok: 0.5 },
  'claude-fable-5-1': { inputPerMTok: 10, outputPerMTok: 50 },
};

export class ConfigError extends Error {}

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

/** Stringa vuota = variabile assente (in .env le variabili non usate restano "NOME="). */
const optional = <T extends z.ZodType>(schema: T) =>
  z.preprocess(
    (v) => (typeof v === 'string' && v.trim() === '' ? undefined : typeof v === 'string' ? v.trim() : v),
    schema.optional(),
  );

const origin = z
  .url({ protocol: /^https?$/, error: 'deve essere un indirizzo http:// o https://' })
  .refine(
    (v) => new URL(v).origin === v.replace(/\/$/, ''),
    'deve contenere solo protocollo e dominio, senza percorso',
  );

const envSchema = z.object({
  NODE_ENV: optional(z.enum(['development', 'production', 'test'])),
  DATABASE_URL: optional(z.string().regex(/^postgres(ql)?:\/\//, 'deve iniziare con postgres:// o postgresql://')),
  DATABASE_SSL: optional(z.enum(['require', 'disable'])),
  PGLITE_DATA_DIR: optional(z.string()),
  API_HOST: optional(z.string()),
  API_PORT: optional(z.coerce.number().int().min(1).max(65535)),
  APP_ORIGIN: optional(origin),
  TRUST_PROXY: optional(z.enum(['0', '1'])),
  LOG_LEVEL: optional(z.enum(['debug', 'info', 'warn', 'error'])),
  SESSION_IDLE_HOURS: optional(
    z.coerce
      .number()
      .min(0.25)
      .max(24 * 7),
  ),
  SESSION_MAX_DAYS: optional(z.coerce.number().min(1).max(90)),
  DISCOVERY_OVERPASS_URL: optional(
    z.url({ protocol: /^https?$/, error: 'deve essere un indirizzo http:// o https://' }).refine((v) => {
      const u = new URL(v);
      return !u.username && !u.password && !u.search && !u.hash;
    }, 'deve essere un indirizzo senza credenziali né parametri'),
  ),
  DISCOVERY_CONTACT: optional(z.string().max(200)),
  DISCOVERY_MIN_INTERVAL_MS: optional(z.coerce.number().int().min(0).max(600_000)),
  DISCOVERY_QUERY_TIMEOUT_SECONDS: optional(z.coerce.number().int().min(10).max(900)),
  DISCOVERY_MAX_RETRIES: optional(z.coerce.number().int().min(0).max(6)),
  DISCOVERY_MUNICIPALITIES_PER_REQUEST: optional(z.coerce.number().int().min(1).max(200)),
  DISCOVERY_MAX_UNITS_PER_JOB: optional(z.coerce.number().int().min(1).max(2000)),
  DISCOVERY_MAX_RESULTS_PER_JOB: optional(z.coerce.number().int().min(1).max(50_000)),
  DISCOVERY_CACHE_TTL_HOURS: optional(z.coerce.number().min(0).max(720)),
  DISCOVERY_STALE_DATA_DAYS: optional(z.coerce.number().int().min(1).max(3650)),
  DISCOVERY_WORKER: optional(z.enum(['on', 'off'])),
  AUDIT_DEFAULT_PAGES: optional(z.coerce.number().int().min(1).max(10)),
  AUDIT_MAX_PAGES: optional(z.coerce.number().int().min(1).max(10)),
  AUDIT_REQUEST_TIMEOUT_MS: optional(z.coerce.number().int().min(2000).max(60_000)),
  AUDIT_CONNECT_TIMEOUT_MS: optional(z.coerce.number().int().min(1000).max(30_000)),
  AUDIT_MAX_RESPONSE_KB: optional(z.coerce.number().int().min(64).max(10_240)),
  AUDIT_MAX_REDIRECTS: optional(z.coerce.number().int().min(0).max(10)),
  AUDIT_ALLOWED_PORTS: optional(
    z
      .string()
      .regex(/^\d{1,5}(,\d{1,5})*$/, 'elenco di porte separate da virgola (es. 80,443)')
      .transform((s) => s.split(',').map(Number))
      .refine((ports) => ports.every((p) => p >= 1 && p <= 65535), 'porta non valida'),
  ),
  AUDIT_HOST_INTERVAL_MS: optional(z.coerce.number().int().min(500).max(60_000)),
  AUDIT_CONCURRENCY: optional(z.coerce.number().int().min(1).max(8)),
  AUDIT_REAUDIT_HOURS: optional(
    z.coerce
      .number()
      .min(0)
      .max(24 * 90),
  ),
  AUDIT_MAX_BUSINESSES_PER_JOB: optional(z.coerce.number().int().min(1).max(2000)),
  AUDIT_CONTACT: optional(z.string().max(200)),
  PAGESPEED_API_KEY: optional(z.string().min(10).max(200)),
  AUDIT_PAGESPEED: optional(z.enum(['on', 'off'])),
  AUDIT_PAGESPEED_STRATEGIES: optional(z.enum(['mobile', 'desktop', 'mobile,desktop', 'desktop,mobile'])),
  AUDIT_WORKER: optional(z.enum(['on', 'off'])),
  SCORING_WORKER: optional(z.enum(['on', 'off'])),
  HUNTER_WORKER: optional(z.enum(['on', 'off'])),
  REMINDERS_WORKER: optional(z.enum(['on', 'off'])),
  AI_PROVIDER: optional(z.enum(['anthropic', 'none'])),
  AI_API_KEY: optional(z.string().min(20, 'chiave troppo corta').max(400)),
  ANTHROPIC_API_KEY: optional(z.string().min(20).max(400)),
  AI_MODEL: optional(z.string().regex(/^[a-z0-9][a-z0-9.-]{2,80}$/, 'identificativo del modello non valido')),
  AI_EFFORT: optional(z.enum(['low', 'medium', 'high'])),
  AI_CONCURRENCY: optional(z.coerce.number().int().min(1).max(4)),
  AI_TIMEOUT_SECONDS: optional(z.coerce.number().int().min(10).max(600)),
  AI_MAX_RETRIES: optional(z.coerce.number().int().min(0).max(5)),
  AI_WORKER: optional(z.enum(['on', 'off'])),
  AI_AUTO_ASSESS: optional(z.enum(['on', 'off'])),
  AI_AUTO_DAILY_LIMIT: optional(z.coerce.number().int().min(0).max(100_000)),
  AI_PRICE_INPUT_PER_MTOK: optional(z.coerce.number().min(0).max(1000)),
  AI_PRICE_OUTPUT_PER_MTOK: optional(z.coerce.number().min(0).max(1000)),
  AI_TEST_BASE_URL: optional(
    z.url({ protocol: /^http$/ }).refine((u) => new URL(u).hostname === '127.0.0.1', 'solo 127.0.0.1'),
  ),
  AUDIT_TEST_LOOPBACK_PORTS: optional(z.string().regex(/^\d{1,5}(,\d{1,5})*$/)),
  GOOGLE_PLACES_API_KEY: optional(z.string().min(20, 'chiave troppo corta').max(200)),
  GOOGLE_PLACES_MAX_PAGES: optional(z.coerce.number().int().min(1).max(3)),
  GOOGLE_PLACES_DAILY_LIMIT: optional(z.coerce.number().int().min(0).max(1_000_000)),
  GOOGLE_PLACES_TEST_BASE_URL: optional(
    z.url({ protocol: /^http$/ }).refine((u) => new URL(u).hostname === '127.0.0.1', 'solo 127.0.0.1'),
  ),
  SMTP_HOST: optional(z.string().regex(/^[A-Za-z0-9.-]{1,253}$/, 'nome host non valido')),
  SMTP_PORT: optional(z.coerce.number().int().min(1).max(65535)),
  SMTP_SECURITY: optional(z.enum(['tls', 'starttls', 'none'])),
  SMTP_USER: optional(z.string().max(320)),
  SMTP_PASSWORD: optional(z.string().max(1000)),
  EMAIL_FROM_ADDRESS: optional(z.email('indirizzo email non valido')),
  EMAIL_FROM_NAME: optional(z.string().regex(/^[^\r\n<>"]{1,80}$/, 'nome del mittente non valido')),
  EMAIL_REPLY_TO: optional(z.email('indirizzo email non valido')),
  EMAIL_SENDER_AUTHORIZED: optional(z.enum(['si', 'no'])),
  EMAIL_TIMEOUT_SECONDS: optional(z.coerce.number().int().min(5).max(120)),
  // nomi alternativi (convenzione di Google Workspace / nodemailer), equivalenti ai precedenti
  SMTP_SECURE: optional(z.enum(['true', 'false'], { error: 'usa true (porta 465) o false (STARTTLS, porta 587)' })),
  SMTP_PASS: optional(z.string().max(1000)),
  EMAIL_SENDER: optional(z.email('indirizzo email non valido')),
  EMAIL_SENDER_NAME: optional(z.string().regex(/^[^\r\n<>"]{1,80}$/, 'nome del mittente non valido')),
});

/** Stessa impostazione con due nomi: vale quella indicata; due valori diversi sono un errore (mai una scelta silenziosa). */
function alias<T>(a: string, va: T | undefined, b: string, vb: T | undefined): T | undefined {
  if (va !== undefined && vb !== undefined && va !== vb)
    throw new ConfigError(`${a} e ${b} indicano la stessa impostazione con valori diversi: tienine una sola.`);
  return va ?? vb;
}

/** Nomi di tutte le variabili lette dal server (documentate in .env.example, verificato da un test). */
export const ENV_VARIABLES = Object.keys(envSchema.shape);

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`);
    throw new ConfigError(`Configurazione non valida:\n${lines.join('\n')}`);
  }
  const e = parsed.data;
  const mode = e.NODE_ENV ?? 'development';

  let database: DatabaseConfig;
  if (e.DATABASE_URL) database = { kind: 'postgres', url: e.DATABASE_URL, ssl: e.DATABASE_SSL === 'require' };
  else if (mode === 'production')
    throw new ConfigError('In produzione DATABASE_URL è obbligatoria: il database incorporato è solo per lo sviluppo.');
  else database = { kind: 'pglite', dataDir: e.PGLITE_DATA_DIR ?? '.data/pglite' };

  const appOrigin = e.APP_ORIGIN ? new URL(e.APP_ORIGIN).origin : null;
  if (mode === 'production') {
    if (!appOrigin) throw new ConfigError('In produzione APP_ORIGIN è obbligatoria.');
    if (!appOrigin.startsWith('https://')) throw new ConfigError('In produzione APP_ORIGIN deve usare https://.');
  }

  const idleMs = (e.SESSION_IDLE_HOURS ?? 12) * HOUR;
  const maxMs = (e.SESSION_MAX_DAYS ?? 7) * DAY;
  if (idleMs > maxMs) throw new ConfigError('SESSION_IDLE_HOURS non può superare la durata massima SESSION_MAX_DAYS.');

  return {
    env: mode,
    host: e.API_HOST ?? '127.0.0.1',
    port: e.API_PORT ?? 8810,
    logLevel: e.LOG_LEVEL ?? (mode === 'production' ? 'info' : 'debug'),
    database,
    security: { appOrigin, secureCookies: mode === 'production', trustProxy: e.TRUST_PROXY === '1' },
    sessions: { idleMs, maxMs },
    discovery: {
      overpassUrl: e.DISCOVERY_OVERPASS_URL ?? null,
      contact: e.DISCOVERY_CONTACT ?? null,
      minIntervalMs: e.DISCOVERY_MIN_INTERVAL_MS ?? 10_000,
      queryTimeoutSeconds: e.DISCOVERY_QUERY_TIMEOUT_SECONDS ?? 180,
      maxRetries: e.DISCOVERY_MAX_RETRIES ?? 3,
      municipalitiesPerRequest: e.DISCOVERY_MUNICIPALITIES_PER_REQUEST ?? 25,
      maxUnitsPerJob: e.DISCOVERY_MAX_UNITS_PER_JOB ?? 120,
      maxResultsPerJob: e.DISCOVERY_MAX_RESULTS_PER_JOB ?? 5000,
      cacheTtlMs: (e.DISCOVERY_CACHE_TTL_HOURS ?? 24) * HOUR,
      staleDataDays: e.DISCOVERY_STALE_DATA_DAYS ?? 7,
      worker: (e.DISCOVERY_WORKER ?? 'on') === 'on',
      google: googleConfig(e, mode),
    },
    audit: auditConfig(e, mode),
    scoring: { worker: (e.SCORING_WORKER ?? 'on') === 'on' },
    hunter: { worker: (e.HUNTER_WORKER ?? 'on') === 'on' },
    reminders: { worker: (e.REMINDERS_WORKER ?? 'on') === 'on' },
    ai: aiConfig(e, mode),
    email: emailConfig(e, mode),
  };
}

function emailConfig(env: z.infer<typeof envSchema>, mode: ServerConfig['env']): EmailConfig {
  // SMTP_SECURE=false (STARTTLS sulla 587) / true (TLS diretto sulla 465) equivale a SMTP_SECURITY=starttls / tls
  const secure = env.SMTP_SECURE === undefined ? undefined : env.SMTP_SECURE === 'true' ? 'tls' : 'starttls';
  const host0 = env.SMTP_HOST ?? null;
  let password = alias('SMTP_PASSWORD', env.SMTP_PASSWORD, 'SMTP_PASS', env.SMTP_PASS);
  // password per le app di Google: mostrata a gruppi di 4 lettere separati da spazi, va usata senza spazi
  if (password && host0?.toLowerCase() === 'smtp.gmail.com' && /^[a-z]{4}( [a-z]{4}){3}$/i.test(password.trim()))
    password = password.replace(/\s+/g, '');
  const e = {
    ...env,
    SMTP_SECURITY: alias<'tls' | 'starttls' | 'none'>('SMTP_SECURITY', env.SMTP_SECURITY, 'SMTP_SECURE', secure),
    SMTP_PASSWORD: password,
    EMAIL_FROM_ADDRESS: alias('EMAIL_FROM_ADDRESS', env.EMAIL_FROM_ADDRESS, 'EMAIL_SENDER', env.EMAIL_SENDER),
    EMAIL_FROM_NAME: alias('EMAIL_FROM_NAME', env.EMAIL_FROM_NAME, 'EMAIL_SENDER_NAME', env.EMAIL_SENDER_NAME),
  };
  const host = e.SMTP_HOST ?? null;
  const security = e.SMTP_SECURITY ?? (e.SMTP_PORT === 465 ? 'tls' : 'starttls');
  const local = host === '127.0.0.1' || host === 'localhost' || host === '::1';
  // senza cifratura solo verso un server sulla stessa macchina (relay locale o server finto dei test)
  if (host && security === 'none' && !local)
    throw new ConfigError('SMTP_SECURITY=none è ammessa solo con SMTP_HOST locale (127.0.0.1): usa tls o starttls.');
  if (Boolean(e.SMTP_USER) !== Boolean(e.SMTP_PASSWORD))
    throw new ConfigError('SMTP_USER e SMTP_PASSWORD vanno impostate insieme.');
  // nei test nessuna email reale: solo un server SMTP finto sulla stessa macchina
  if (mode === 'test' && host && !local)
    throw new ConfigError('Con NODE_ENV=test l’invio email è ammesso solo verso un server SMTP locale (127.0.0.1).');
  if (mode === 'production' && host && security === 'none')
    throw new ConfigError('In produzione SMTP_SECURITY deve essere tls o starttls.');
  // staff@noventra.it è il mittente predefinito solo se un server di invio è configurato
  const fromAddress = e.EMAIL_FROM_ADDRESS ?? (host ? 'staff@noventra.it' : null);
  const missing = [
    ...(host ? [] : ['SMTP_HOST']),
    ...(host && !e.SMTP_USER && !local ? ['SMTP_USER', 'SMTP_PASSWORD'] : []),
    ...(e.EMAIL_SENDER_AUTHORIZED === 'si' ? [] : ['EMAIL_SENDER_AUTHORIZED=si']),
  ];
  return {
    smtp: host
      ? {
          host,
          port: e.SMTP_PORT ?? (security === 'tls' ? 465 : security === 'none' ? 25 : 587),
          security,
          user: e.SMTP_USER ?? null,
          password: e.SMTP_PASSWORD ?? null,
        }
      : null,
    fromAddress,
    fromName: e.EMAIL_FROM_NAME ?? 'Noventra',
    replyTo: e.EMAIL_REPLY_TO ?? null,
    senderAuthorized: e.EMAIL_SENDER_AUTHORIZED === 'si',
    timeoutMs: (e.EMAIL_TIMEOUT_SECONDS ?? 30) * 1000,
    missing,
  };
}

function aiConfig(e: z.infer<typeof envSchema>, mode: ServerConfig['env']): AiConfig {
  // come AUDIT_TEST_LOOPBACK_PORTS: un indirizzo del fornitore diverso esiste solo nei test (server finto locale)
  if (e.AI_TEST_BASE_URL && mode !== 'test')
    throw new ConfigError('AI_TEST_BASE_URL è ammessa solo con NODE_ENV=test.');
  const apiKey = e.AI_API_KEY ?? e.ANTHROPIC_API_KEY ?? null;
  // nei test nessuna chiamata a pagamento: con una chiave serve il server finto locale
  if (mode === 'test' && apiKey && e.AI_PROVIDER !== 'none' && !e.AI_TEST_BASE_URL)
    throw new ConfigError(
      'Con NODE_ENV=test la valutazione AI usa solo il server finto locale (AI_TEST_BASE_URL): nessuna chiamata reale.',
    );
  // con una chiave il fornitore predefinito è Anthropic; AI_PROVIDER=none la disattiva esplicitamente
  const provider = e.AI_PROVIDER === 'none' ? null : apiKey ? 'anthropic' : null;
  const model = e.AI_MODEL ?? 'claude-opus-5-5';
  const price =
    e.AI_PRICE_INPUT_PER_MTOK !== undefined && e.AI_PRICE_OUTPUT_PER_MTOK !== undefined
      ? { inputPerMTok: e.AI_PRICE_INPUT_PER_MTOK, outputPerMTok: e.AI_PRICE_OUTPUT_PER_MTOK }
      : (KNOWN_PRICES[model] ?? null);
  return {
    provider,
    apiKey: provider ? apiKey : null,
    model,
    effort: e.AI_EFFORT ?? 'medium',
    concurrency: e.AI_CONCURRENCY ?? 2,
    timeoutMs: (e.AI_TIMEOUT_SECONDS ?? 120) * 1000,
    maxRetries: e.AI_MAX_RETRIES ?? 3,
    worker: (e.AI_WORKER ?? 'on') === 'on',
    price,
    testBaseUrl: e.AI_TEST_BASE_URL ?? null,
    autoAssess: (e.AI_AUTO_ASSESS ?? 'on') === 'on',
    autoDailyLimit: e.AI_AUTO_DAILY_LIMIT ?? 500,
  };
}

function googleConfig(e: z.infer<typeof envSchema>, mode: ServerConfig['env']): DiscoveryConfig['google'] {
  // nei test solo il server finto locale: nessuna richiesta (né spesa) verso Google
  if (e.GOOGLE_PLACES_TEST_BASE_URL && mode !== 'test')
    throw new ConfigError('GOOGLE_PLACES_TEST_BASE_URL è ammessa solo con NODE_ENV=test.');
  if (mode === 'test' && e.GOOGLE_PLACES_API_KEY && !e.GOOGLE_PLACES_TEST_BASE_URL)
    throw new ConfigError(
      'Con NODE_ENV=test Google Places usa solo il server finto locale (GOOGLE_PLACES_TEST_BASE_URL): nessuna chiamata reale.',
    );
  return {
    apiKey: e.GOOGLE_PLACES_API_KEY ?? null,
    baseUrl: e.GOOGLE_PLACES_TEST_BASE_URL ?? 'https://places.googleapis.com',
    maxPages: e.GOOGLE_PLACES_MAX_PAGES ?? 3,
    dailyLimit: e.GOOGLE_PLACES_DAILY_LIMIT ?? 1000,
  };
}

function auditConfig(e: z.infer<typeof envSchema>, mode: ServerConfig['env']): AuditConfig {
  // l'unica eccezione alla protezione SSRF esiste solo nei test: altrove la sua presenza è un errore di configurazione
  if (e.AUDIT_TEST_LOOPBACK_PORTS && mode !== 'test')
    throw new ConfigError('AUDIT_TEST_LOOPBACK_PORTS è ammessa solo con NODE_ENV=test (siti finti dei test).');
  const maxPages = e.AUDIT_MAX_PAGES ?? 10;
  const defaultPages = e.AUDIT_DEFAULT_PAGES ?? 3;
  if (defaultPages > maxPages) throw new ConfigError('AUDIT_DEFAULT_PAGES non può superare AUDIT_MAX_PAGES.');
  return {
    defaultPages,
    maxPages,
    requestTimeoutMs: e.AUDIT_REQUEST_TIMEOUT_MS ?? 15_000,
    connectTimeoutMs: e.AUDIT_CONNECT_TIMEOUT_MS ?? 8_000,
    maxResponseBytes: (e.AUDIT_MAX_RESPONSE_KB ?? 3072) * 1024,
    maxRedirects: e.AUDIT_MAX_REDIRECTS ?? 5,
    allowedPorts: e.AUDIT_ALLOWED_PORTS ?? [80, 443],
    hostIntervalMs: e.AUDIT_HOST_INTERVAL_MS ?? 2_000,
    concurrency: e.AUDIT_CONCURRENCY ?? 2,
    reauditHours: e.AUDIT_REAUDIT_HOURS ?? 24,
    maxBusinessesPerJob: e.AUDIT_MAX_BUSINESSES_PER_JOB ?? 200,
    contact: e.AUDIT_CONTACT ?? e.DISCOVERY_CONTACT ?? null,
    pagespeedApiKey: e.PAGESPEED_API_KEY ?? null,
    pagespeedEnabled: (e.AUDIT_PAGESPEED ?? 'on') === 'on' && Boolean(e.PAGESPEED_API_KEY),
    pagespeedStrategies: (e.AUDIT_PAGESPEED_STRATEGIES ?? 'mobile').split(',') as ('mobile' | 'desktop')[],
    worker: (e.AUDIT_WORKER ?? 'on') === 'on',
    testLoopbackPorts: e.AUDIT_TEST_LOOPBACK_PORTS ? e.AUDIT_TEST_LOOPBACK_PORTS.split(',').map(Number) : [],
  };
}

/** Valori predefiniti per i test (PageSpeed non configurato). */
export const defaultAudit: AuditConfig = {
  defaultPages: 3,
  maxPages: 10,
  requestTimeoutMs: 15_000,
  connectTimeoutMs: 8_000,
  maxResponseBytes: 3 * 1024 * 1024,
  maxRedirects: 5,
  allowedPorts: [80, 443],
  hostIntervalMs: 2_000,
  concurrency: 2,
  reauditHours: 24,
  maxBusinessesPerJob: 200,
  contact: null,
  pagespeedApiKey: null,
  pagespeedEnabled: false,
  pagespeedStrategies: ['mobile'],
  worker: true,
  testLoopbackPorts: [],
};

/** Valori predefiniti per i test (nessun endpoint: la scoperta va configurata esplicitamente). */
export const defaultDiscovery: DiscoveryConfig = {
  overpassUrl: null,
  contact: null,
  minIntervalMs: 10_000,
  queryTimeoutSeconds: 180,
  maxRetries: 3,
  municipalitiesPerRequest: 25,
  maxUnitsPerJob: 120,
  maxResultsPerJob: 5000,
  cacheTtlMs: 24 * HOUR,
  staleDataDays: 7,
  worker: true,
  google: { apiKey: null, baseUrl: 'https://places.googleapis.com', maxPages: 3, dailyLimit: 1000 },
};

/** Configurazione per test e sviluppo: origine dalla richiesta, cookie anche su http. */
export const developmentSecurity: SecurityConfig = { appOrigin: null, secureCookies: false, trustProxy: false };
export const defaultSessions: SessionConfig = { idleMs: 12 * HOUR, maxMs: 7 * DAY };

/** Descrizione sicura per log e stato del sistema: tipo di database e host, mai credenziali. */
export function describeDatabase(db: DatabaseConfig): string {
  if (db.kind === 'pglite') return `PostgreSQL incorporato (PGlite) in ${db.dataDir}`;
  if (db.kind === 'pglite-memory') return 'PostgreSQL incorporato (PGlite) in memoria';
  try {
    const u = new URL(db.url);
    return `PostgreSQL su ${u.hostname}${u.port ? `:${u.port}` : ''}${u.pathname}${db.ssl ? ' (TLS)' : ''}`;
  } catch {
    return 'PostgreSQL (indirizzo non leggibile)';
  }
}
