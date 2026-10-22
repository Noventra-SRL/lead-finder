import { AiWorker } from './ai/jobs.ts';
import { AutoAssessor } from './ai/queue.ts';
import { createProvider } from './ai/provider.ts';
import { createAiServices } from './ai/services.ts';
import { existsSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { policyFor } from './audit/jobs.ts';
import { PageSpeedProvider } from './audit/performance/pagespeed.ts';
import { AuditWorker } from './audit/worker.ts';
import { createScoringJob, ScoringWorker } from './scoring/jobs.ts';
import { HuntWorker } from './hunter/worker.ts';
import { ReminderWorker } from './workflow/reminders.ts';
import { RepliesWorker } from './email/replies.ts';
import { createEmailServices } from './email/sender.ts';
import { recoverStaleSends } from './email/store.ts';
import { activeCatalog } from './matching/store.ts';
import { activeConfig, rescoreAfterAudit } from './scoring/store.ts';
import { deleteExpiredSessions } from './auth/sessions.ts';
import { ConfigError, describeDatabase, loadConfig } from './config.ts';
import { DatabaseLockedError, openDatabase, type Db } from './db/client.ts';
import { assertMigrated } from './db/migrate.ts';
import { dbCache, purgeExpiredCache } from './discovery/cache.ts';
import { OverpassProvider, overpassUserAgent } from './discovery/osm/overpass.ts';
import { DiscoveryWorker } from './discovery/worker.ts';
import { createApp } from './http/app.ts';
import { createStaticHandler } from './http/static.ts';
import { createLogger } from './logger.ts';

/*
 * Avvio del server: configurazione validata → database → controllo delle migrazioni → HTTP.
 * Il server non applica migrazioni da solo: parte solo su uno schema aggiornato ("npm run db:migrate").
 * Se esiste dist/ (interfaccia compilata), la serve dallo stesso processo.
 * Arresto ordinato con Ctrl+C / SIGTERM: smette di accettare connessioni, poi chiude il database.
 */

const bootLog = createLogger({ level: 'info', format: process.env.NODE_ENV === 'production' ? 'json' : 'pretty' });

let config;
try {
  config = loadConfig();
} catch (error) {
  bootLog.error(
    error instanceof ConfigError ? error.message : `Configurazione non leggibile: ${(error as Error).message}`,
  );
  process.exit(1);
}

const log = createLogger({ level: config.logLevel, format: config.env === 'production' ? 'json' : 'pretty' });
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };

let opened: Db | undefined;
try {
  opened = await openDatabase(config.database);
  await assertMigrated(opened);
} catch (error) {
  const message =
    error instanceof DatabaseLockedError ? error.message : `Database non disponibile: ${(error as Error).message}`;
  log.error(message, { database: describeDatabase(config.database) });
  await opened?.close().catch(() => undefined);
  process.exit(1);
}
const db: Db = opened;

const provider = new OverpassProvider(
  {
    endpoint: config.discovery.overpassUrl,
    userAgent: overpassUserAgent(pkg.version, config.discovery.contact),
    minIntervalMs: config.discovery.minIntervalMs,
    timeoutSeconds: config.discovery.queryTimeoutSeconds,
    maxsizeBytes: 512 * 1024 * 1024,
    maxRetries: config.discovery.maxRetries,
    maxResponseBytes: 64 * 1024 * 1024,
    cacheTtlMs: config.discovery.cacheTtlMs,
  },
  { cache: dbCache(db) },
);
// punteggi dei lead: configurazione attiva verificata all'avvio (la prima volta registra i valori predefiniti)
await activeConfig(db);
await activeCatalog(db);
const scoringWorker = config.scoring.worker ? new ScoringWorker(db, { log }) : null;
scoringWorker?.start();
const worker = config.discovery.worker
  ? new DiscoveryWorker(db, provider, {
      log,
      staleDataDays: config.discovery.staleDataDays,
      // a ricerca terminata, i punteggi delle aziende viste vengono aggiornati in background
      onFinished: async (jobId) => {
        await createScoringJob(db, { scope: { kind: 'discovery_job', jobId }, trigger: 'discovery' }, null);
        scoringWorker?.wake();
      },
    })
  : null;
if (worker) await worker.start();
const auditPolicy = policyFor(config.audit, pkg.version);
const performance = config.audit.pagespeedApiKey
  ? new PageSpeedProvider(
      {
        apiKey: config.audit.pagespeedApiKey,
        enabled: config.audit.pagespeedEnabled,
        endpoint: 'https://www.googleapis.com/pagespeedonline/v5/runPagespeed',
        timeoutMs: 90_000,
        maxRetries: 2,
        minIntervalMs: 1_500,
        cacheTtlMs: 24 * 60 * 60 * 1000,
      },
      { cache: dbCache(db) },
    )
  : null;
const auditWorker = config.audit.worker
  ? new AuditWorker(db, {
      log,
      config: config.audit,
      policy: auditPolicy,
      performance,
      onItemDone: async (businessId) => void (await rescoreAfterAudit(db, businessId)),
    })
  : null;
if (auditWorker) await auditWorker.start();
// ricerche di lead (Fase 6): coordinano scoperta e audit, nello stesso processo dei rispettivi esecutori
const huntWorker =
  config.hunter.worker && worker
    ? new HuntWorker(db, {
        log,
        discovery: {
          config: config.discovery,
          providerId: provider.info().id,
          configured: () => provider.info().configured,
          wake: () => worker.wake(),
        },
        audit: { config: config.audit, policy: auditPolicy, wake: () => auditWorker?.wake() },
      })
    : null;
huntWorker?.start();
// promemoria dei follow-up (in scadenza e scaduti) nell'applicazione: regole fisse, nessun messaggio verso l'esterno
const reminderWorker = config.reminders.worker ? new ReminderWorker(db, log) : null;
reminderWorker?.start();
// valutazione commerciale con AI: chiave solo sul server; senza chiave resta il punteggio a regole come riserva
const aiProvider = createProvider(config.ai);
const aiWorker = config.ai.worker ? new AiWorker(db, { provider: aiProvider, config: config.ai, log }) : null;
aiWorker?.start();
// valutazione commerciale di ogni azienda: impronte delle prove (sempre) e coda automatica (con il fornitore)
// (con AI_AUTO_ASSESS=off restano le impronte e gli stati, senza chiamate al modello)
const autoAssessor = new AutoAssessor(db, {
  provider: aiProvider,
  config: config.ai,
  log,
  dailyLimit: config.ai.autoDailyLimit,
});
autoAssessor.start();
const aiServices = createAiServices(db, {
  provider: aiProvider,
  config: config.ai,
  log,
  workerActive: aiWorker !== null,
  wake: () => aiWorker?.wake(),
});
if (!aiProvider)
  log.warn('valutazione commerciale AI non configurata: imposta AI_API_KEY (resta il punteggio a regole)');
if (!config.discovery.overpassUrl) log.warn('scoperta di aziende non configurata: imposta DISCOVERY_OVERPASS_URL');
// email commerciali: invio SMTP solo con configurazione completa; le bozze funzionano comunque
const emailServices = createEmailServices(config.email, { log });
const recovered = await recoverStaleSends(db);
if (recovered) log.warn('invii di email interrotti segnati come «esito incerto»', { count: recovered });
if (!emailServices.sender) log.warn('invio email non configurato: imposta SMTP_HOST (vedi .env.example)');
// verifica della connessione SMTP e controllo DNS del mittente in background (nessun messaggio inviato);
// nei test nessuna rete verso DNS esterni
else {
  void emailServices.verify();
  if (config.env !== 'test') void emailServices.checkDomain();
}
// lettura delle risposte (IMAP, sola lettura) in background: rimbalzi, «non contattatemi», bozze di risposta
const repliesWorker =
  emailServices.inbox && config.email.imap && config.email.repliesWorker
    ? new RepliesWorker(db, emailServices.inbox, {
        ai: () => aiServices.provider,
        log,
        mailbox: config.email.imap.mailbox,
      })
    : null;
repliesWorker?.start(config.email.repliesPollMs);
if (!emailServices.inbox) log.info('lettura delle risposte non configurata: imposta IMAP_HOST (vedi .env.example)');

const api = createApp(db, {
  log,
  state: {
    startedAt: new Date(),
    version: pkg.version,
    config,
    discovery: { provider, config: config.discovery, wake: () => worker?.wake(), workerActive: worker !== null },
    audit: {
      config: config.audit,
      policy: auditPolicy,
      performance,
      wake: () => auditWorker?.wake(),
      workerActive: auditWorker !== null,
    },
    scoring: { wake: () => scoringWorker?.wake(), workerActive: scoringWorker !== null },
    hunter: { wake: () => huntWorker?.wake(), workerActive: huntWorker !== null },
    ai: aiServices,
    email: emailServices,
  },
});
const distDir = fileURLToPath(new URL('../dist/', import.meta.url));
const serveStatic = existsSync(distDir) ? createStaticHandler(distDir, { hsts: config.security.secureCookies }) : null;

const server = createServer((req, res) => {
  // tutto ciò che sta sotto /api è dell'API, anche se non esiste (404 JSON, mai la pagina dell'app)
  if (/^\/api(\/|\?|$)/.test(req.url ?? '') || !serveStatic || !serveStatic(req, res)) {
    void api(req, res);
  }
});
server.requestTimeout = 30_000;
server.headersTimeout = 15_000;

const cleanup = setInterval(
  () => {
    deleteExpiredSessions(db)
      .then((n) => n && log.debug('sessioni scadute eliminate', { count: n }))
      .catch((error) => log.warn('pulizia delle sessioni non riuscita', { error }));
    purgeExpiredCache(db)
      .then((n) => n && log.debug('cache del fornitore ripulita', { count: n }))
      .catch((error) => log.warn('pulizia della cache non riuscita', { error }));
  },
  60 * 60 * 1000,
);
cleanup.unref();

server.listen(config.port, config.host, () => {
  log.info('server avviato', {
    url: `http://${config.host}:${config.port}`,
    env: config.env,
    database: describeDatabase(config.database),
    frontend: serveStatic ? 'dist/' : 'non servito (usa npm run dev)',
    scoperta: config.discovery.overpassUrl ? new URL(config.discovery.overpassUrl).host : 'non configurata',
    prestazioni: performance?.configured ? 'PageSpeed Insights' : 'non configurate',
  });
});

server.on('error', async (error: NodeJS.ErrnoException) => {
  log.error(error.code === 'EADDRINUSE' ? `La porta ${config.port} è già in uso.` : 'Errore del server HTTP', {
    error,
  });
  await db.close().catch(() => undefined);
  process.exit(1);
});

let stopping = false;
async function shutdown(signal: string) {
  if (stopping) return;
  stopping = true;
  log.info('arresto in corso', { signal });
  clearInterval(cleanup);
  const force = setTimeout(() => {
    log.warn('arresto forzato dopo 10 secondi');
    process.exit(1);
  }, 10_000);
  force.unref();
  server.close(async () => {
    try {
      // la ricerca e la verifica in corso vengono interrotte e restano riprendibili (in pausa per interruzione)
      await huntWorker?.stop();
      await Promise.all([
        worker?.stop(),
        auditWorker?.stop(),
        scoringWorker?.stop(),
        aiWorker?.stop(),
        autoAssessor.stop(),
        reminderWorker?.stop(),
        repliesWorker?.stop(),
        aiServices.idle(),
      ]);
      await db.close();
      log.info('database chiuso, arresto completato');
      process.exit(0);
    } catch (error) {
      log.error('chiusura del database non riuscita', { error });
      process.exit(1);
    }
  });
  server.closeIdleConnections();
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('unhandledRejection', (reason) => log.error('promessa rifiutata non gestita', { error: reason }));
