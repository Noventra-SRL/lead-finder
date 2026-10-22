import { describeDatabase } from '../../config.ts';
import { listUsers } from '../../auth/users.ts';
import { migrationStatus } from '../../db/migrate.ts';
import { ok, type Context, type Route } from '../core.ts';

/*
 * Salute e stato del sistema.
 *  GET /api/health         vivacità del processo (nessun accesso al database): per il supervisore dei processi
 *  GET /api/health/ready   prontezza: database raggiungibile e schema aggiornato, altrimenti 503
 *  GET /api/system/status  stato dettagliato per la dashboard (utenti autenticati)
 *  GET /api/users          elenco degli utenti interni (solo amministratori, sola lettura)
 * Le sonde pubbliche non espongono versioni, percorsi o dettagli dell'infrastruttura.
 */

const READY_TIMEOUT_MS = 3_000;

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function checkDatabase(ctx: Context) {
  const started = performance.now();
  await withTimeout(ctx.db.query('SELECT 1'), READY_TIMEOUT_MS);
  const latencyMs = Math.round(performance.now() - started);
  const migrations = await withTimeout(migrationStatus(ctx.db), READY_TIMEOUT_MS);
  return { latencyMs, migrations };
}

export const systemRoutes: Route[] = [
  {
    method: 'GET',
    pattern: /^\/api\/health$/,
    access: 'public',
    logLevel: 'debug',
    async handle() {
      return ok({ status: 'ok' });
    },
  },
  {
    method: 'GET',
    pattern: /^\/api\/health\/ready$/,
    access: 'public',
    logLevel: 'debug',
    async handle(ctx) {
      try {
        const { migrations } = await checkDatabase(ctx);
        if (migrations.pending.length)
          return { status: 503, body: { status: 'not_ready', reason: 'migrations_pending' } };
        return ok({ status: 'ready' });
      } catch (error) {
        ctx.log.warn('prontezza: database non raggiungibile', { error });
        return { status: 503, body: { status: 'not_ready', reason: 'database_unavailable' } };
      }
    },
  },
  {
    method: 'GET',
    pattern: /^\/api\/system\/status$/,
    async handle(ctx) {
      const { latencyMs, migrations } = await checkDatabase(ctx);
      const counts = await ctx.db.query<{ users: number; active_sessions: number }>(
        `SELECT (SELECT count(*)::int FROM users WHERE disabled_at IS NULL) AS users,
                (SELECT count(*)::int FROM sessions WHERE expires_at > now()) AS active_sessions`,
      );
      const { config, startedAt, version } = ctx.state;
      return ok({
        version,
        environment: config.env,
        node: process.version,
        startedAt: startedAt.toISOString(),
        uptimeSeconds: Math.round((Date.now() - startedAt.getTime()) / 1000),
        database: {
          description: describeDatabase(config.database),
          kind: config.database.kind,
          latencyMs,
          migrationsApplied: migrations.applied,
          migrationsPending: migrations.pending,
        },
        counts: { activeUsers: counts.rows[0]!.users, activeSessions: counts.rows[0]!.active_sessions },
      });
    },
  },
  {
    method: 'GET',
    pattern: /^\/api\/users$/,
    access: 'admin',
    async handle(ctx) {
      return ok({ users: await listUsers(ctx.db) });
    },
  },
];
