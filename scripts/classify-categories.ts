import { BUSINESS_CATEGORY_LABEL, type BusinessCategoryId } from '../server/categories/catalog.ts';
import { classifyPending } from '../server/categories/store.ts';
import { loadConfig } from '../server/config.ts';
import { openDatabase } from '../server/db/client.ts';

/*
 * npm run categories:classify — classifica le aziende senza categoria (o calcolate con regole precedenti) e stampa i
 * conteggi reali per categoria. Lo stesso lavoro lo fa il server all'avvio, in sottofondo; questo comando serve per
 * farlo subito e vederne il risultato. Riprendibile: un'interruzione lascia classificate le aziende già fatte.
 * Con il server avviato il database incorporato è bloccato: fermalo prima.
 */

const db = await openDatabase(loadConfig().database);
try {
  const r = await classifyPending(db, { batchSize: 200 });
  console.log(`Aziende classificate in questa esecuzione: ${r.processed} (aggiornate: ${r.changed}).`);
  const { rows } = await db.query<{ category: BusinessCategoryId | null; status: string | null; n: number }>(
    `SELECT primary_category AS category, category_status AS status, count(*)::int AS n FROM businesses
      WHERE merged_into IS NULL GROUP BY 1, 2 ORDER BY 3 DESC`,
  );
  const by = new Map<string, { total: number; review: number }>();
  for (const x of rows) {
    const key = x.category ?? '—';
    const cur = by.get(key) ?? { total: 0, review: 0 };
    cur.total += x.n;
    if (x.status === 'da_verificare') cur.review += x.n;
    by.set(key, cur);
  }
  console.table(
    [...by].map(([id, v]) => ({
      categoria: id === '—' ? 'Non ancora classificate' : BUSINESS_CATEGORY_LABEL[id as BusinessCategoryId],
      aziende: v.total,
      'da verificare': v.review,
    })),
  );
  console.log(`Ancora da classificare: ${r.remaining}.`);
} finally {
  await db.close();
}
