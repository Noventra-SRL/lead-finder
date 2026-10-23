import { audit } from '../audit.ts';
import { classifyOne } from '../categories/store.ts';
import type { Queryable } from '../db/client.ts';
import { fold, geo } from '../geo/geo.ts';
import { completenessOf, type ProviderRecord } from './types.ts';

/*
 * Salvataggio dei record dei fornitori con deduplica deterministica.
 *
 *  1. Stessa fonte e stesso identificativo (es. osm node/123): è lo stesso record → aggiornamento, mai un doppione.
 *  2. Stesso dominio del sito (non di una piattaforma condivisa) E vicinanza (≤ 250 m), oppure, solo se mancano le
 *     coordinate, stesso nome nello stesso comune: è la stessa attività descritta da un'altra fonte/elemento → la
 *     fonte si collega all'azienda esistente. Sedi distanti con lo stesso sito (catene) restano separate.
 *  3. Altrimenti: nuova azienda. Se c'è un'azienda con lo stesso nome (normalizzato) nelle vicinanze, o con lo
 *     stesso dominio nello stesso comune, le due restano separate e la coppia va in revisione manuale:
 *     un nome simile non basta per unire due attività.
 *
 * I campi dell'azienda vengono dalla fonte principale; le altre fonti completano solo i dati mancanti.
 * Ogni creazione, modifica e collegamento è registrato in audit_log con i valori precedenti.
 */

export const AUTO_MERGE_DISTANCE_M = 250;
export const REVIEW_SAME_NAME_DISTANCE_M = 500;
export const REVIEW_CONTAINED_NAME_DISTANCE_M = 100;
/** Stessa attività da fonti diverse (regola 2 bis): stesso nome normalizzato entro questa distanza. */
export const CROSS_PROVIDER_DISTANCE_M = 150;

export type SaveOutcome = 'inserted' | 'updated' | 'unchanged' | 'merged' | 'duplicate_skipped' | 'skipped_incomplete';

export interface SaveContext {
  jobId: string | null;
  fetchedAt: Date;
  /** Data dei dati della fonte che ha risposto (null se non dichiarata). */
  sourceDataAt: Date | null;
  minCompleteness: number;
  requireWebsite: boolean;
  /** Solo attività con un recapito da controllare: sito proprio o email indicata dalla fonte. */
  requireContact?: boolean;
  /** Record già visti in questo job (un elemento al confine tra due comuni compare due volte). */
  seen: Set<string>;
}

export interface SaveResult {
  outcome: SaveOutcome;
  businessId?: string;
  flaggedForReview: number;
}

const LEGAL_FORMS =
  /\b(s r l( s)?|srls?|s n c|snc|s a s|sas|s p a|spa|s c a r l|scarl|soc coop|societa cooperativa)\b/g;

/** Nome per ricerca e confronto: senza accenti, punteggiatura e forma giuridica. */
export function searchName(name: string): string {
  return fold(name).replace(LEGAL_FORMS, ' ').replace(/\s+/g, ' ').trim();
}

/** Distanza in metri tra due punti (formula dell'emisenoverso). */
export function distanceM(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad;
  const dLon = (b.lon - a.lon) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
  return Math.round(2 * 6_371_000 * Math.asin(Math.sqrt(h)));
}

/** Colonne dell'azienda determinate da un record: comune, provincia e regione solo dal codice ISTAT. */
function columnsOf(r: ProviderRecord) {
  const m = r.municipalityCode ? geo().municipality(r.municipalityCode) : null;
  return {
    name: r.name,
    search_name: searchName(r.name),
    category: r.category,
    sector: r.sector,
    phone: r.contacts.phone,
    email: r.contacts.email,
    email_kind: r.contacts.emailKind,
    fax: r.contacts.fax ?? null,
    phones_extra: r.contacts.phonesExtra?.length ? r.contacts.phonesExtra : null,
    website_url: r.websiteUrl,
    website_domain: r.websiteDomain,
    website_shared: r.websiteShared,
    address_street: r.address.street,
    address_housenumber: r.address.housenumber,
    address_postcode: r.address.postcode,
    address_city: r.address.city,
    municipality_code: m?.code ?? null,
    municipality_name: m?.name ?? null,
    province_code: m?.provinceCode ?? null,
    region_code: m?.regionCode ?? null,
    latitude: r.latitude,
    longitude: r.longitude,
    has_website: r.has.website,
    has_address: r.has.address,
    has_phone: r.has.phone,
    has_email: r.has.email,
    has_opening_hours: r.has.openingHours,
    completeness: completenessOf(r),
  };
}

type Columns = ReturnType<typeof columnsOf>;
type BusinessRow = Columns & { id: string };

const COLUMNS: (keyof Columns)[] = [
  'name',
  'search_name',
  'category',
  'sector',
  'phone',
  'email',
  'email_kind',
  'fax',
  'phones_extra',
  'website_url',
  'website_domain',
  'website_shared',
  'address_street',
  'address_housenumber',
  'address_postcode',
  'address_city',
  'municipality_code',
  'municipality_name',
  'province_code',
  'region_code',
  'latitude',
  'longitude',
  'has_website',
  'has_address',
  'has_phone',
  'has_email',
  'has_opening_hours',
  'completeness',
];

const SELECT_BUSINESS = `SELECT id, ${COLUMNS.join(', ')} FROM businesses`;

/** Valori diversi tra l'azienda salvata e quelli nuovi (per l'aggiornamento e la cronologia). */
function diff(current: Columns, next: Partial<Columns>) {
  const changes: Record<string, { from: unknown; to: unknown }> = {};
  for (const [k, v] of Object.entries(next) as [keyof Columns, unknown][]) {
    if (k === 'search_name') continue;
    const same =
      Array.isArray(v) || Array.isArray(current[k])
        ? JSON.stringify(current[k]) === JSON.stringify(v)
        : current[k] === v;
    if (!same) changes[k] = { from: current[k], to: v };
  }
  return changes;
}

/** Solo i campi oggi sconosciuti (null o indicatore falso): una fonte secondaria non sovrascrive mai. */
function fillMissing(current: Columns, candidate: Columns): Partial<Columns> {
  const out: Partial<Columns> = {};
  for (const k of COLUMNS) {
    if (k === 'name' || k === 'search_name' || k === 'category' || k === 'completeness') continue;
    const cur = current[k];
    const val = candidate[k];
    if ((cur === null || cur === false) && val !== null && val !== false) (out as Record<string, unknown>)[k] = val;
  }
  // il dominio e il suo indicatore "condiviso" vanno insieme all'URL
  if (out.website_url !== undefined) {
    out.website_domain = candidate.website_domain;
    out.website_shared = candidate.website_shared;
  }
  if (Object.keys(out).length) {
    const merged = { ...current, ...out };
    out.completeness = [
      merged.has_website,
      merged.has_address,
      merged.has_phone,
      merged.has_email,
      merged.has_opening_hours,
    ].filter(Boolean).length;
  }
  return out;
}

/** Aggiornamento dalla fonte principale: i recapiti non vengono mai persi né sostituiti se trovati altrove. */
async function keepContacts(tx: Queryable, current: BusinessRow, next: Columns): Promise<Partial<Columns>> {
  const out: Partial<Columns> = { ...next };
  for (const k of ['phone', 'fax', 'phones_extra'] as const) if (next[k] === null && current[k] !== null) delete out[k];
  if (next.website_url === null && current.website_url !== null)
    for (const k of ['website_url', 'website_domain', 'website_shared', 'has_website'] as const) delete out[k];
  const { rows } = await tx.query<{ email_source: string | null }>(
    'SELECT email_source FROM businesses WHERE id = $1',
    [current.id],
  );
  const ownEmail = rows[0]?.email_source === 'website' || rows[0]?.email_source === 'manuale';
  if ((next.email === null && current.email !== null) || ownEmail) {
    delete out.email;
    delete out.email_kind;
  }
  return out;
}

/** Campi corretti a mano (businesses.edited_fields) e colonne che una nuova lettura della fonte non sovrascrive. */
export const EDIT_PROTECTED: Record<string, string[]> = {
  name: ['name', 'search_name'],
  email: ['email', 'email_kind', 'has_email'],
  phone: ['phone', 'has_phone'],
  fax: ['fax'],
  website: ['website_url', 'website_domain', 'website_shared', 'has_website'],
  address: ['address_street', 'address_housenumber', 'address_postcode', 'address_city', 'has_address'],
  municipality: ['municipality_code', 'municipality_name', 'province_code', 'region_code'],
};

async function protectedColumns(tx: Queryable, businessId: string): Promise<Set<string>> {
  const { rows } = await tx.query<{ edited_fields: string[] | null }>(
    'SELECT edited_fields FROM businesses WHERE id = $1',
    [businessId],
  );
  return new Set((rows[0]?.edited_fields ?? []).flatMap((f) => EDIT_PROTECTED[f] ?? []));
}

async function updateBusiness(tx: Queryable, id: string, changes: Partial<Columns>, verifiedAt: Date) {
  const entries = Object.entries(changes);
  const sets = entries.map(([k], i) => `${k} = $${i + 3}`);
  await tx.query(
    `UPDATE businesses SET ${[...sets, 'last_verified_at = GREATEST(last_verified_at, $2)', 'updated_at = now()'].join(', ')} WHERE id = $1`,
    [id, verifiedAt, ...entries.map(([, v]) => v)],
  );
}

async function upsertSourceRow(
  tx: Queryable,
  r: ProviderRecord,
  businessId: string,
  primary: boolean,
  ctx: SaveContext,
) {
  const data = { ...r, sourceTags: undefined };
  await tx.query(
    `INSERT INTO business_sources (business_id, provider, provider_ref, source_url, license, is_primary, data, tags, first_seen_at, last_seen_at, last_job_id, source_data_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $9, $10, $11)`,
    [
      businessId,
      r.provider,
      r.ref,
      r.sourceUrl,
      licenseOf(r.provider),
      primary,
      JSON.stringify(data),
      JSON.stringify(r.sourceTags),
      ctx.fetchedAt,
      ctx.jobId,
      ctx.sourceDataAt,
    ],
  );
}

const licenseOf = (provider: string) => (provider === 'osm' ? 'ODbL 1.0 — © OpenStreetMap contributors' : provider);

/** Aziende attive vicine (riquadro di circa 600 m) o con lo stesso dominio. */
async function neighbours(tx: Queryable, c: Columns, excludeId: string | null): Promise<BusinessRow[]> {
  const parts: string[] = [];
  const params: unknown[] = [excludeId];
  if (c.latitude !== null && c.longitude !== null) {
    params.push(c.latitude - 0.006, c.latitude + 0.006, c.longitude - 0.008, c.longitude + 0.008);
    parts.push(`(latitude BETWEEN $2 AND $3 AND longitude BETWEEN $4 AND $5)`);
  }
  if (c.website_domain && !c.website_shared) {
    params.push(c.website_domain);
    parts.push(`(website_domain = $${params.length} AND NOT website_shared)`);
  }
  if (!parts.length) return [];
  const { rows } = await tx.query<BusinessRow>(
    `${SELECT_BUSINESS} WHERE merged_into IS NULL AND ($1::uuid IS NULL OR id <> $1) AND (${parts.join(' OR ')}) LIMIT 200`,
    params,
  );
  return rows;
}

const near = (a: Columns, b: Columns) =>
  a.latitude !== null && a.longitude !== null && b.latitude !== null && b.longitude !== null
    ? distanceM({ lat: a.latitude, lon: a.longitude }, { lat: b.latitude, lon: b.longitude })
    : null;

const sameDomain = (a: Columns, b: Columns) =>
  Boolean(a.website_domain && !a.website_shared && a.website_domain === b.website_domain && !b.website_shared);

/**
 * Salvataggio di un record con la categoria commerciale aggiornata: ogni azienda nuova, aggiornata o a cui è stata
 * collegata un'altra fonte viene (ri)classificata dalle sue prove (una categoria scelta a mano non cambia).
 */
export async function saveRecord(tx: Queryable, r: ProviderRecord, ctx: SaveContext): Promise<SaveResult> {
  const result = await saveRecordData(tx, r, ctx);
  if (result.businessId && result.outcome !== 'duplicate_skipped' && result.outcome !== 'skipped_incomplete') {
    await classifyOne(tx, result.businessId);
    await recordSourceEmail(tx, result.businessId, r, ctx.fetchedAt);
  }
  return result;
}

/**
 * Provenienza di un'email indicata dalla fonte della scoperta: la scheda della fonte (es. il nodo OpenStreetMap) e la
 * data in cui è stata letta. Solo se l'azienda ha un'email senza provenienza: un recapito trovato sul sito, inserito
 * a mano o già attribuito non cambia.
 */
async function recordSourceEmail(tx: Queryable, businessId: string, r: ProviderRecord, fetchedAt: Date) {
  if (r.provider !== 'osm' || !r.contacts.email) return;
  await tx.query(
    `UPDATE businesses SET email_source = 'osm', email_status = COALESCE(email_status, 'da_verificare'),
            email_source_url = $2, email_found_at = COALESCE(email_found_at, $3)
      WHERE id = $1 AND email = $4 AND email_source IS NULL`,
    [businessId, r.sourceUrl.slice(0, 600), fetchedAt, r.contacts.email],
  );
}

async function saveRecordData(tx: Queryable, r: ProviderRecord, ctx: SaveContext): Promise<SaveResult> {
  const key = `${r.provider}:${r.ref}`;
  if (ctx.seen.has(key)) return { outcome: 'duplicate_skipped', flaggedForReview: 0 };
  ctx.seen.add(key);
  if (completenessOf(r) < ctx.minCompleteness || (ctx.requireWebsite && !r.has.website))
    return { outcome: 'skipped_incomplete', flaggedForReview: 0 };
  // un sito su piattaforma condivisa (social, directory) non è un sito da controllare per le email
  if (ctx.requireContact && !(r.has.website && !r.websiteShared) && !r.contacts.email)
    return { outcome: 'skipped_incomplete', flaggedForReview: 0 };

  const next = columnsOf(r);
  const { rows: existing } = await tx.query<{
    id: string;
    business_id: string;
    is_primary: boolean;
    source_data_at: Date | null;
  }>(
    'SELECT id, business_id, is_primary, source_data_at FROM business_sources WHERE provider = $1 AND provider_ref = $2 FOR UPDATE',
    [r.provider, r.ref],
  );

  // 1. record già noto
  if (existing[0]) {
    const src = existing[0];
    // una copia dei dati più vecchia di quella già salvata (server pubblici con copie diverse) non torna indietro:
    // si registra solo che l'elemento è stato visto
    if (ctx.sourceDataAt && src.source_data_at && ctx.sourceDataAt.getTime() < new Date(src.source_data_at).getTime()) {
      await tx.query(
        'UPDATE business_sources SET last_seen_at = GREATEST(last_seen_at, $2), last_job_id = $3 WHERE id = $1',
        [src.id, ctx.fetchedAt, ctx.jobId],
      );
      return { outcome: 'unchanged', businessId: src.business_id, flaggedForReview: 0 };
    }
    await tx.query(
      `UPDATE business_sources SET data = $2, tags = $3, source_url = $4, last_seen_at = GREATEST(last_seen_at, $5), last_job_id = $6,
              source_data_at = COALESCE($7, source_data_at) WHERE id = $1`,
      [
        src.id,
        JSON.stringify({ ...r, sourceTags: undefined }),
        JSON.stringify(r.sourceTags),
        r.sourceUrl,
        ctx.fetchedAt,
        ctx.jobId,
        ctx.sourceDataAt,
      ],
    );
    const { rows } = await tx.query<BusinessRow>(`${SELECT_BUSINESS} WHERE id = $1 FOR UPDATE`, [src.business_id]);
    const current = rows[0]!;
    // la fonte principale aggiorna i dati dell'azienda, ma un recapito non viene mai cancellato da un valore vuoto e
    // un'email trovata sul sito o inserita a mano non viene sostituita dalla fonte; le altre fonti completano i vuoti
    const changesWanted = src.is_primary ? await keepContacts(tx, current, next) : fillMissing(current, next);
    const changes = diff(current, changesWanted);
    // i campi corretti a mano in «Modifica» restano quelli scelti dalla persona
    const locked = await protectedColumns(tx, current.id);
    for (const k of locked) delete (changes as Record<string, unknown>)[k];
    const update = Object.fromEntries(Object.keys(changes).map((k) => [k, changesWanted[k as keyof Columns]]));
    if (changes.name) update.search_name = next.search_name;
    await updateBusiness(tx, current.id, update, ctx.fetchedAt);
    if (Object.keys(changes).length) {
      await audit(tx, {
        userId: null,
        action: 'business.updated',
        entityType: 'business',
        entityId: current.id,
        details: { source: key, jobId: ctx.jobId, changes },
      });
      return { outcome: 'updated', businessId: current.id, flaggedForReview: 0 };
    }
    return { outcome: 'unchanged', businessId: current.id, flaggedForReview: 0 };
  }

  const candidates = await neighbours(tx, next, null);

  // 2. stessa attività già presente con lo stesso sito, nello stesso punto. Senza coordinate basta lo stesso nome
  // nello stesso comune; con coordinate distanti si tratta di sedi diverse (catene, farmacie comunali con un unico
  // sito): restano separate e la coppia va in revisione ("Stesso sito web nello stesso comune").
  let reason = 'stesso sito web e stessa posizione';
  let match = candidates.find((b) => {
    if (!sameDomain(next, b)) return false;
    const distance = near(next, b);
    if (distance !== null) return distance <= AUTO_MERGE_DISTANCE_M;
    return (
      b.search_name === next.search_name &&
      b.municipality_code !== null &&
      b.municipality_code === next.municipality_code
    );
  });
  // 2 bis. la stessa attività trovata da un'ALTRA fonte (es. OpenStreetMap e Google Maps), anche senza sito: nome
  // normalizzato identico, entro CROSS_PROVIDER_DISTANCE_M e numeri civici non in contrasto. Due elementi della stessa
  // fonte con lo stesso nome restano distinti (vanno in revisione, regola 3).
  if (!match) {
    const sameName = candidates.filter((b) => {
      const distance = near(next, b);
      return (
        b.search_name === next.search_name &&
        distance !== null &&
        distance <= CROSS_PROVIDER_DISTANCE_M &&
        !(b.address_housenumber && next.address_housenumber && b.address_housenumber !== next.address_housenumber)
      );
    });
    for (const b of sameName) {
      const { rows } = await tx.query(
        'SELECT 1 FROM business_sources WHERE business_id = $1 AND provider = $2 LIMIT 1',
        [b.id, r.provider],
      );
      if (!rows.length) {
        match = b;
        reason = `stesso nome a ${near(next, b)} m, trovata da un'altra fonte`;
        break;
      }
    }
  }
  if (match) {
    await upsertSourceRow(tx, r, match.id, false, ctx);
    const fill = fillMissing(match, next);
    await updateBusiness(tx, match.id, fill, ctx.fetchedAt);
    await audit(tx, {
      userId: null,
      action: 'business.source_linked',
      entityType: 'business',
      entityId: match.id,
      details: {
        source: key,
        jobId: ctx.jobId,
        reason,
        filled: Object.keys(fill),
      },
    });
    return { outcome: 'merged', businessId: match.id, flaggedForReview: 0 };
  }

  // 3. nuova azienda
  const values = COLUMNS.map((c) => next[c]);
  const { rows: inserted } = await tx.query<{ id: string }>(
    `INSERT INTO businesses (${COLUMNS.join(', ')}, first_seen_at, last_verified_at)
     VALUES (${COLUMNS.map((_, i) => `$${i + 1}`).join(', ')}, $${COLUMNS.length + 1}, $${COLUMNS.length + 1}) RETURNING id`,
    [...values, ctx.fetchedAt],
  );
  const id = inserted[0]!.id;
  await upsertSourceRow(tx, r, id, true, ctx);
  await audit(tx, {
    userId: null,
    action: 'business.created',
    entityType: 'business',
    entityId: id,
    details: { source: key, jobId: ctx.jobId },
  });

  let flagged = 0;
  for (const b of candidates) {
    const distance = near(next, b);
    let reason: string | null = null;
    const shorter = Math.min(b.search_name.length, next.search_name.length);
    if (b.search_name === next.search_name && distance !== null && distance <= REVIEW_SAME_NAME_DISTANCE_M)
      reason = 'Stesso nome a breve distanza';
    else if (
      shorter >= 8 &&
      (b.search_name.includes(next.search_name) || next.search_name.includes(b.search_name)) &&
      distance !== null &&
      distance <= REVIEW_CONTAINED_NAME_DISTANCE_M
    )
      reason = 'Nome simile nello stesso punto';
    else if (sameDomain(next, b) && b.municipality_code !== null && b.municipality_code === next.municipality_code)
      reason = 'Stesso sito web nello stesso comune';
    if (!reason) continue;
    const [a, c] = id < b.id ? [id, b.id] : [b.id, id];
    const { rows } = await tx.query(
      `INSERT INTO duplicate_candidates (business_a, business_b, reason, distance_m) VALUES ($1, $2, $3, $4)
       ON CONFLICT (business_a, business_b) DO NOTHING RETURNING id`,
      [a, c, reason, distance],
    );
    flagged += rows.length;
  }
  return { outcome: 'inserted', businessId: id, flaggedForReview: flagged };
}
