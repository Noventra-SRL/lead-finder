import { HAS_EMAIL_SQL, CONTACT_STATUS_SQL } from '../crm/contactStatus.ts';
import { CONTACTABILITY_SQL } from '../enrichment/contactability.ts';
import type { Queryable } from '../db/client.ts';
import { listQuery, type BusinessFilters } from '../discovery/businesses.ts';
import { BUSINESS_CATEGORIES, type BusinessCategoryId } from './catalog.ts';

/*
 * Conteggi per categoria, con gli STESSI filtri dell'elenco (stessa listQuery): il numero accanto a «Farmacie» è
 * quello che si ottiene aprendo «Farmacie» con quei filtri. Una riga per azienda (unite escluse), quindi «Tutte le
 * aziende» è la somma delle categorie più quelle non ancora classificate, senza doppioni.
 *
 *  total       aziende
 *  website     con un sito proprio (non solo una pagina social o di una piattaforma)
 *  email       con un'email generica pubblica disponibile (indicata dalla fonte: NON verificata)
 *  assessed    con una valutazione commerciale AI
 *  ready       pronte da contattare: mai contattate, con email disponibile
 *  contacted   già contattate (email accettata o contatto registrato nel CRM), in qualsiasi fase successiva
 *  review      con la categoria da verificare
 *  published   con un recapito email scritto sul sito dell'azienda (o verificato)
 *  toEnrich    con un sito proprio non ancora controllato per le email
 */

export interface CategoryCounts {
  total: number;
  website: number;
  email: number;
  assessed: number;
  ready: number;
  contacted: number;
  review: number;
  published: number;
  toEnrich: number;
}

const ZERO: CategoryCounts = {
  total: 0,
  website: 0,
  email: 0,
  assessed: 0,
  ready: 0,
  contacted: 0,
  review: 0,
  published: 0,
  toEnrich: 0,
};

export async function categoryCounts(db: Queryable, filters: Omit<BusinessFilters, 'businessCategory'>) {
  const { from, whereSql, params } = listQuery({ ...filters, businessCategory: undefined });
  const { rows } = await db.query<CategoryCounts & { id: BusinessCategoryId | null }>(
    `SELECT x.id, count(*)::int AS total,
            count(*) FILTER (WHERE x.website)::int AS website,
            count(*) FILTER (WHERE x.email)::int AS email,
            count(*) FILTER (WHERE x.assessed)::int AS assessed,
            count(*) FILTER (WHERE x.cs = 'da_contattare' AND x.email)::int AS ready,
            count(*) FILTER (WHERE x.cs IN ('in_attesa', 'in_trattativa', 'cliente', 'perso'))::int AS contacted,
            count(*) FILTER (WHERE x.review)::int AS review,
            count(*) FILTER (WHERE x.ct IN ('pubblicata', 'verificata'))::int AS published,
            count(*) FILTER (WHERE x.ct = 'da_arricchire')::int AS "toEnrich"
       FROM (SELECT b.primary_category AS id, (b.has_website AND NOT b.website_shared) AS website, (${CONTACTABILITY_SQL}) AS ct,
                    ${HAS_EMAIL_SQL} AS email, aa.id IS NOT NULL AS assessed, (${CONTACT_STATUS_SQL}) AS cs,
                    b.category_status = 'da_verificare' AS review
               FROM ${from} WHERE ${whereSql}) x
      GROUP BY x.id`,
    params,
  );
  const by = new Map(rows.map((r) => [r.id, r]));
  const pick = (r: CategoryCounts | undefined): CategoryCounts =>
    r
      ? {
          total: r.total,
          website: r.website,
          email: r.email,
          assessed: r.assessed,
          ready: r.ready,
          contacted: r.contacted,
          review: r.review,
          published: r.published,
          toEnrich: r.toEnrich,
        }
      : { ...ZERO };
  const all = { ...ZERO };
  for (const r of rows) for (const k of Object.keys(ZERO) as (keyof CategoryCounts)[]) all[k] += r[k];
  return {
    all,
    categories: BUSINESS_CATEGORIES.map((c) => ({ id: c.id, counts: pick(by.get(c.id)) })),
    // aziende non ancora classificate (classificazione in corso): comprese in «Tutte le aziende»
    pending: by.get(null)?.total ?? 0,
  };
}

/** Aziende escluse e con divieto di contatto, con gli stessi filtri (per «Aziende escluse» e i conteggi separati). */
export async function statusCounts(db: Queryable, filters: Omit<BusinessFilters, 'businessCategory'>) {
  const count = async (f: BusinessFilters) => {
    const { from, whereSql, params } = listQuery(f);
    const { rows } = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${from} WHERE ${whereSql}`, params);
    return rows[0]!.n;
  };
  const base = { ...filters, businessCategory: undefined, contactStatus: undefined } as BusinessFilters;
  return {
    excluded: await count({ ...base, excluded: 'only' }),
    doNotContact: await count({ ...base, excluded: 'include', doNotContact: true }),
  };
}
