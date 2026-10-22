import type { Db, Queryable } from '../db/client.ts';
import { JobError } from '../discovery/jobs.ts';

/*
 * Filtri salvati (Fase 8): per utente, per elenco (aziende, opportunità, follow-up). Si salvano i CRITERI della ricerca
 * (parametri dell'indirizzo), mai un elenco congelato di aziende: riaprendo un filtro si vedono i risultati di oggi.
 * Nomi unici per utente ed elenco (senza distinzione tra maiuscole e minuscole); due filtri con gli stessi criteri
 * non vengono creati di nascosto.
 */

export type SavedFilterScope = 'businesses' | 'opportunities' | 'followups';

/** Parametri che non sono criteri: paginazione. */
const NOT_CRITERIA = new Set(['page', 'pageSize']);

/** Criteri in forma canonica (chiavi ordinate, senza paginazione né valori vuoti). */
export function canonicalQuery(query: string): string {
  const params = new URLSearchParams(query);
  const entries = [...params.entries()].filter(([k, v]) => !NOT_CRITERIA.has(k) && v !== '');
  entries.sort(([a], [b]) => a.localeCompare(b));
  return new URLSearchParams(entries).toString();
}

interface Row {
  id: string;
  scope: SavedFilterScope;
  name: string;
  query: string;
  created_at: Date;
  updated_at: Date;
}

const out = (r: Row) => ({
  id: r.id,
  scope: r.scope,
  name: r.name,
  query: r.query,
  createdAt: new Date(r.created_at).toISOString(),
  updatedAt: new Date(r.updated_at).toISOString(),
});

export async function listSavedFilters(db: Queryable, userId: string, scope?: SavedFilterScope) {
  const { rows } = await db.query<Row>(
    `SELECT * FROM saved_filters WHERE user_id = $1 ${scope ? 'AND scope = $2' : ''} ORDER BY scope, lower(name)`,
    scope ? [userId, scope] : [userId],
  );
  return rows.map(out);
}

export async function createSavedFilter(
  db: Db,
  userId: string,
  input: { scope: SavedFilterScope; name: string; query: string },
) {
  const query = canonicalQuery(input.query);
  return db.transaction(async (tx) => {
    const { rows: same } = await tx.query<{ name: string }>(
      'SELECT name FROM saved_filters WHERE user_id = $1 AND scope = $2 AND query = $3',
      [userId, input.scope, query],
    );
    if (same[0])
      throw new JobError(
        409,
        'DUPLICATE_FILTER',
        `Questi criteri sono già salvati come «${same[0].name}».`,
        undefined,
        {
          name: same[0].name,
        },
      );
    const { rows: name } = await tx.query(
      'SELECT 1 FROM saved_filters WHERE user_id = $1 AND scope = $2 AND lower(name) = lower($3)',
      [userId, input.scope, input.name],
    );
    if (name[0])
      throw new JobError(409, 'DUPLICATE_NAME', 'Hai già un filtro con questo nome.', undefined, { field: 'name' });
    const { rows } = await tx.query<Row>(
      'INSERT INTO saved_filters (user_id, scope, name, query) VALUES ($1, $2, $3, $4) RETURNING *',
      [userId, input.scope, input.name.trim(), query],
    );
    return out(rows[0]!);
  });
}

async function own(db: Queryable, userId: string, id: string) {
  const { rows } = await db.query<Row>('SELECT * FROM saved_filters WHERE id = $1 AND user_id = $2', [id, userId]);
  // un filtro di un altro utente risulta inesistente
  if (!rows[0]) throw new JobError(404, 'NOT_FOUND', 'Filtro salvato non trovato.');
  return rows[0];
}

export async function renameSavedFilter(db: Db, userId: string, id: string, name: string) {
  const f = await own(db, userId, id);
  const { rows: clash } = await db.query(
    'SELECT 1 FROM saved_filters WHERE user_id = $1 AND scope = $2 AND lower(name) = lower($3) AND id <> $4',
    [userId, f.scope, name, id],
  );
  if (clash[0])
    throw new JobError(409, 'DUPLICATE_NAME', 'Hai già un filtro con questo nome.', undefined, { field: 'name' });
  const { rows } = await db.query<Row>(
    'UPDATE saved_filters SET name = $2, updated_at = now() WHERE id = $1 RETURNING *',
    [id, name.trim()],
  );
  return out(rows[0]!);
}

export async function deleteSavedFilter(db: Db, userId: string, id: string) {
  await own(db, userId, id);
  await db.query('DELETE FROM saved_filters WHERE id = $1', [id]);
}

export { own as getSavedFilter };
