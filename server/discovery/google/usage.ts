import type { Queryable } from '../../db/client.ts';
import type { UsageBudget } from './places.ts';

/*
 * Limite giornaliero di richieste a un fornitore a pagamento, contato nel database (vale anche dopo un riavvio e con
 * più processi): una richiesta parte solo se il contatore del giorno (ora italiana) è sotto il limite.
 */
export function dbUsageBudget(db: Queryable, limit: number): UsageBudget {
  return {
    limit,
    async take(provider: string) {
      if (limit <= 0) return false;
      const { rows } = await db.query<{ requests: number }>(
        `INSERT INTO provider_usage (provider, day, requests)
         VALUES ($1, (now() AT TIME ZONE 'Europe/Rome')::date, 1)
         ON CONFLICT (provider, day) DO UPDATE SET requests = provider_usage.requests + 1
           WHERE provider_usage.requests < $2
         RETURNING requests`,
        [provider, limit],
      );
      return rows.length > 0;
    },
  };
}

/** Richieste già usate oggi (per mostrarle nell'interfaccia). */
export async function usageToday(db: Queryable, provider: string): Promise<number> {
  const { rows } = await db.query<{ requests: number }>(
    "SELECT requests FROM provider_usage WHERE provider = $1 AND day = (now() AT TIME ZONE 'Europe/Rome')::date",
    [provider],
  );
  return rows[0]?.requests ?? 0;
}
