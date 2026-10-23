import { audit } from '../audit.ts';
import type { Db, Queryable } from '../db/client.ts';
import type { Logger } from '../logger.ts';
import { BUSINESS_CATEGORY_LABEL, type BusinessCategoryId } from './catalog.ts';
import { classifyBusiness, CLASSIFIER_VERSION, type Classification } from './classify.ts';

/*
 * Categoria principale salvata sull'azienda (businesses.primary_category e colonne collegate).
 *  - classifyOne: dopo ogni salvataggio della scoperta e nella classificazione delle aziende esistenti;
 *  - classifyPending: aziende mai classificate o classificate in automatico con regole precedenti, a blocchi; ogni
 *    blocco è indipendente, quindi un'interruzione (riavvio, errore) riprende da dove si era fermata;
 *  - setManualCategory: la scelta di una persona, che nessun ricalcolo sovrascrive (finché non la si toglie).
 * Nessuna operazione crea, unisce o cancella aziende.
 */

interface Row {
  id: string;
  name: string;
  sector: string | null;
  category: string | null;
  primary_category: BusinessCategoryId | null;
  category_status: string | null;
  category_source: string | null;
  category_evidence: string | null;
  category_version: number | null;
}

/** Tag delle fonti dell'azienda, la principale per ultima (prevale nell'unione). */
async function tagsOf(db: Queryable, id: string): Promise<Record<string, string> | null> {
  const { rows } = await db.query<{ tags: Record<string, string> | null }>(
    'SELECT tags FROM business_sources WHERE business_id = $1 ORDER BY is_primary ASC, first_seen_at ASC',
    [id],
  );
  if (!rows.length) return null;
  return Object.assign({}, ...rows.map((r) => r.tags ?? {})) as Record<string, string>;
}

async function write(db: Queryable, row: Row, c: Classification): Promise<boolean> {
  const same =
    row.primary_category === c.category &&
    row.category_status === c.status &&
    row.category_source === 'automatica' &&
    row.category_evidence === c.evidence &&
    row.category_version === CLASSIFIER_VERSION;
  if (same) return false;
  await db.query(
    `UPDATE businesses SET primary_category = $2, category_status = $3, category_source = 'automatica',
            category_evidence = $4, category_version = $5, category_updated_at = now() WHERE id = $1`,
    [row.id, c.category, c.status, c.evidence.slice(0, 300), CLASSIFIER_VERSION],
  );
  return true;
}

const SELECT = `SELECT id, name, sector, category, primary_category, category_status, category_source, category_evidence,
  category_version FROM businesses`;

/** Classifica un'azienda (se la categoria non è stata scelta a mano). true se la categoria salvata è cambiata. */
export async function classifyOne(db: Queryable, id: string): Promise<boolean> {
  const { rows } = await db.query<Row>(`${SELECT} WHERE id = $1`, [id]);
  const row = rows[0];
  if (!row || row.category_source === 'manuale') return false;
  return write(db, row, classifyBusiness({ ...row, tags: await tagsOf(db, id) }));
}

const PENDING_WHERE = `merged_into IS NULL AND (primary_category IS NULL
  OR (category_source = 'automatica' AND category_version IS DISTINCT FROM ${CLASSIFIER_VERSION}))`;

/** Aziende ancora da classificare (o da riclassificare con le regole attuali). */
export async function pendingClassification(db: Queryable): Promise<number> {
  const { rows } = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM businesses WHERE ${PENDING_WHERE}`);
  return rows[0]!.n;
}

/**
 * Classificazione delle aziende in attesa, a blocchi di `batchSize` (ognuno nella sua transazione).
 * `maxBatches` limita il lavoro di una chiamata; si riprende chiamandola di nuovo.
 */
export async function classifyPending(
  db: Db,
  opts: { batchSize?: number; maxBatches?: number; shouldStop?: () => boolean } = {},
): Promise<{ processed: number; changed: number; remaining: number }> {
  const batchSize = opts.batchSize ?? 200;
  let processed = 0;
  let changed = 0;
  for (let batch = 0; opts.maxBatches === undefined || batch < opts.maxBatches; batch++) {
    if (opts.shouldStop?.()) break;
    const done = await db.transaction(async (tx) => {
      const { rows } = await tx.query<Row>(
        `${SELECT} WHERE ${PENDING_WHERE} ORDER BY category_version NULLS FIRST, id LIMIT $1 FOR UPDATE SKIP LOCKED`,
        [batchSize],
      );
      for (const row of rows) {
        if (await write(tx, row, classifyBusiness({ ...row, tags: await tagsOf(tx, row.id) }))) changed++;
        processed++;
      }
      return rows.length;
    });
    if (done < batchSize) break;
  }
  return { processed, changed, remaining: await pendingClassification(db) };
}

/** Categoria scelta da una persona (category) oppure ritorno alla classificazione automatica (null). */
export async function setManualCategory(db: Db, id: string, category: BusinessCategoryId | null, userId: string) {
  return db.transaction(async (tx) => {
    const { rows } = await tx.query<Row & { merged_into: string | null }>(
      `${SELECT.replace('FROM', ', merged_into FROM')} WHERE id = $1 FOR UPDATE`,
      [id],
    );
    const row = rows[0];
    if (!row) return null;
    const before = { category: row.primary_category, source: row.category_source };
    if (category) {
      await tx.query(
        `UPDATE businesses SET primary_category = $2, category_status = 'classificata', category_source = 'manuale',
                category_evidence = 'Scelta da una persona', category_version = $3, category_updated_at = now()
          WHERE id = $1`,
        [id, category, CLASSIFIER_VERSION],
      );
    } else {
      await tx.query("UPDATE businesses SET category_source = 'automatica' WHERE id = $1", [id]);
      await classifyOne(tx, id);
    }
    const { rows: after } = await tx.query<{ primary_category: BusinessCategoryId; category_source: string }>(
      'SELECT primary_category, category_source FROM businesses WHERE id = $1',
      [id],
    );
    await audit(tx, {
      userId,
      action: category ? 'business.category_set' : 'business.category_automatic',
      entityType: 'business',
      entityId: id,
      details: {
        from: before.category ? BUSINESS_CATEGORY_LABEL[before.category] : null,
        to: BUSINESS_CATEGORY_LABEL[after[0]!.primary_category],
        source: after[0]!.category_source,
      },
    });
    return true;
  });
}

/**
 * Classificazione in sottofondo all'avvio del server: le aziende esistenti senza categoria (o calcolate con regole
 * precedenti) vengono classificate a blocchi, lasciando spazio alle richieste. Riprende da sola dopo un riavvio.
 */
export function startCategoryBackfill(db: Db, log: Logger) {
  let stopped = false;
  const run = async () => {
    try {
      let total = 0;
      for (;;) {
        if (stopped) return;
        const r = await classifyPending(db, { batchSize: 200, maxBatches: 1, shouldStop: () => stopped });
        total += r.processed;
        if (r.processed === 0 || r.remaining === 0) break;
        await new Promise((res) => setTimeout(res, 20));
      }
      if (total) log.info('categorie delle aziende aggiornate', { classified: total });
    } catch (error) {
      log.error('classificazione delle categorie interrotta: riprende al prossimo avvio', { error });
    }
  };
  const done = run();
  return {
    done,
    stop: async () => {
      stopped = true;
      await done;
    },
  };
}
