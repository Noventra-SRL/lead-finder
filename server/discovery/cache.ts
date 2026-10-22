import type { Queryable } from '../db/client.ts';
import type { ProviderRecord } from './types.ts';

/*
 * Cache dei risultati dei fornitori (tabella provider_cache): una ricerca ripetuta entro la validità non
 * interroga di nuovo la fonte. Si conservano i record già normalizzati, mai la risposta grezza.
 */

export interface CachedUnit {
  records: ProviderRecord[];
  foundMunicipalities: string[];
  sourceTimestamp: string | null;
}

export interface ResultCache {
  get(key: string): Promise<{ value: CachedUnit; fetchedAt: Date } | null>;
  set(key: string, provider: string, value: CachedUnit, fetchedAt: Date, ttlMs: number): Promise<void>;
}

export function dbCache(db: Queryable): ResultCache {
  return {
    async get(key) {
      const { rows } = await db.query<{ payload: CachedUnit; fetched_at: Date }>(
        'SELECT payload, fetched_at FROM provider_cache WHERE key = $1 AND expires_at > now()',
        [key],
      );
      const row = rows[0];
      return row ? { value: row.payload, fetchedAt: new Date(row.fetched_at) } : null;
    },
    async set(key, provider, value, fetchedAt, ttlMs) {
      await db.query(
        `INSERT INTO provider_cache (key, provider, payload, fetched_at, expires_at) VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (key) DO UPDATE SET payload = EXCLUDED.payload, fetched_at = EXCLUDED.fetched_at, expires_at = EXCLUDED.expires_at`,
        [key, provider, JSON.stringify(value), fetchedAt, new Date(fetchedAt.getTime() + ttlMs)],
      );
    },
  };
}

/** Elimina le voci scadute (pulizia periodica). */
export async function purgeExpiredCache(db: Queryable): Promise<number> {
  const { rows } = await db.query<{ n: number }>(
    'WITH d AS (DELETE FROM provider_cache WHERE expires_at <= now() RETURNING 1) SELECT count(*)::int AS n FROM d',
  );
  return rows[0]?.n ?? 0;
}
