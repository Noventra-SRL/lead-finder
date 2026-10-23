import { audit } from '../audit.ts';
import { linkWebsite } from '../audit/store.ts';
import type { BusinessCategoryId } from '../categories/catalog.ts';
import { setManualCategory } from '../categories/store.ts';
import type { Db } from '../db/client.ts';
import { geo } from '../geo/geo.ts';
import { normalizePhone } from './contacts.ts';
import { JobError } from './jobs.ts';
import { searchName } from './store.ts';
import { normalizeWebsite } from './website.ts';

/*
 * Modifica manuale della scheda di un'azienda («Modifica» in «Apri scheda»). Aggiorna la riga esistente, mai una
 * nuova azienda; non tocca punteggi, audit, email, CRM, esclusione né divieto di contatto.
 *
 *  - solo i campi inviati cambiano; svuotare un campo che ha un valore richiede di indicarlo in `clear` (nessun
 *    valore viene cancellato per sbaglio da un campo vuoto);
 *  - `updatedAt` deve essere quello letto: se nel frattempo la scheda è cambiata la modifica viene rifiutata (409) e
 *    nulla viene sovrascritto;
 *  - email, telefono, fax e sito vengono normalizzati e validati; un'email inserita a mano è «inserita a mano, da
 *    verificare» (mai verificata), e il controllo del dominio ripartirà da solo;
 *  - un nuovo sito viene collegato come sito da controllare: gli audit del sito precedente restano nello storico;
 *  - i campi corretti a mano finiscono in `edited_fields`: una nuova lettura della fonte non li sovrascrive.
 */

export const OPERATING_STATUSES = ['attiva', 'chiusa_temporaneamente', 'chiusa_definitivamente'] as const;
export type OperatingStatus = (typeof OPERATING_STATUSES)[number];

export interface BusinessEdit {
  /** `updated_at` della scheda letta (ISO): protezione dalle sovrascritture. */
  updatedAt: string;
  name?: string;
  category?: BusinessCategoryId | null;
  operatingStatus?: OperatingStatus | null;
  email?: string | null;
  phone?: string | null;
  fax?: string | null;
  website?: string | null;
  street?: string | null;
  housenumber?: string | null;
  postcode?: string | null;
  city?: string | null;
  municipalityCode?: string | null;
  contactName?: string | null;
  contactRole?: string | null;
  notes?: string | null;
  /** Campi da svuotare esplicitamente (conferma dell'utente). */
  clear?: string[];
}

const EMAIL = /^[^\s@<>,;"()]+@[^\s@<>,;"()]+\.[a-z]{2,}$/i;
const POSTCODE = /^\d{5}$/;

interface Row {
  id: string;
  updated_at: Date;
  merged_into: string | null;
  primary_category: string | null;
  category_source: string | null;
  [column: string]: unknown;
}

/** Testo pulito: spazi ai bordi tolti, vuoto = null. */
const text = (v: string | null | undefined) => (v === undefined ? undefined : v === null ? null : v.trim() || null);

export async function editBusiness(db: Db, id: string, input: BusinessEdit, userId: string) {
  const fields: Record<string, string> = {};
  const clear = new Set(input.clear ?? []);

  // ---- normalizzazione e validazione (errori per campo, in italiano) ----
  const v = {
    name: text(input.name),
    email: text(input.email)
      ?.toLowerCase()
      .replace(/^mailto:/, ''),
    phone: text(input.phone),
    fax: text(input.fax),
    website: text(input.website),
    street: text(input.street),
    housenumber: text(input.housenumber),
    postcode: text(input.postcode),
    city: text(input.city),
    municipalityCode: text(input.municipalityCode),
    contactName: text(input.contactName),
    contactRole: text(input.contactRole),
    notes: input.notes === undefined ? undefined : input.notes === null ? null : input.notes.trim() || null,
    operatingStatus: input.operatingStatus,
  };
  if (input.name !== undefined && (!v.name || v.name.length < 2 || v.name.length > 200))
    fields.name = 'Il nome è obbligatorio (da 2 a 200 caratteri).';
  if (v.email && (!EMAIL.test(v.email) || v.email.length > 254))
    fields.email = 'Indirizzo email non valido (es. info@farmacia.it).';
  let phone: string | null | undefined = v.phone;
  if (v.phone) {
    phone = normalizePhone(v.phone);
    if (!phone) fields.phone = 'Numero di telefono non valido.';
  }
  let fax: string | null | undefined = v.fax;
  if (v.fax) {
    fax = normalizePhone(v.fax);
    if (!fax) fields.fax = 'Numero di fax non valido.';
  }
  const site = v.website ? normalizeWebsite(v.website) : null;
  if (v.website && !site) fields.website = 'Indirizzo web non valido (es. https://www.farmacia.it).';
  if (v.postcode && !POSTCODE.test(v.postcode)) fields.postcode = 'Il CAP è formato da 5 cifre.';
  const municipality = v.municipalityCode ? geo().municipality(v.municipalityCode) : null;
  if (v.municipalityCode && !municipality) fields.municipalityCode = 'Comune sconosciuto.';
  if (v.street && v.street.length > 200) fields.street = 'Via troppo lunga.';
  if (v.housenumber && v.housenumber.length > 20) fields.housenumber = 'Civico troppo lungo.';
  if (v.city && v.city.length > 120) fields.city = 'Località troppo lunga.';
  if (v.contactName && v.contactName.length > 120) fields.contactName = 'Al massimo 120 caratteri.';
  if (v.contactRole && v.contactRole.length > 80) fields.contactRole = 'Al massimo 80 caratteri.';
  if (v.notes && v.notes.length > 5000) fields.notes = 'Al massimo 5.000 caratteri.';
  if (Object.keys(fields).length)
    throw new JobError(400, 'VALIDATION_ERROR', 'Controlla i campi evidenziati.', undefined, { fields });

  const result = await db.transaction(async (tx) => {
    const { rows } = await tx.query<Row>('SELECT * FROM businesses WHERE id = $1 FOR UPDATE', [id]);
    const row = rows[0];
    if (!row) throw new JobError(404, 'NOT_FOUND', 'Azienda non trovata.');
    if (row.merged_into)
      throw new JobError(409, 'BUSINESS_MERGED', 'La scheda è stata unita a un’altra: modifica la scheda mantenuta.');
    if (new Date(row.updated_at).toISOString() !== new Date(input.updatedAt).toISOString())
      throw new JobError(
        409,
        'STALE',
        'La scheda è stata aggiornata nel frattempo (da un’altra persona o da una ricerca): ricarica per vedere i dati attuali. Le tue modifiche non sono state salvate.',
      );

    const set: Record<string, unknown> = {};
    const edited = new Set<string>();
    const changes: Record<string, [unknown, unknown]> = {};
    /** Imposta una colonna se cambia; un valore esistente si svuota solo se richiesto esplicitamente. */
    const put = (column: string, value: unknown, field: string, group?: string) => {
      const before = row[column] ?? null;
      if (value === undefined || before === value) return false;
      if (value === null && before !== null && !clear.has(field)) {
        fields[field] = 'Per svuotare questo campo conferma la cancellazione.';
        return false;
      }
      set[column] = value;
      changes[column] = [before, value];
      if (group) edited.add(group);
      return true;
    };

    if (v.name !== undefined && put('name', v.name, 'name', 'name')) set.search_name = searchName(v.name!);
    if (v.email !== undefined && put('email', v.email, 'email', 'email')) {
      // un recapito inserito a mano: dell'attività, da verificare, senza pagina di provenienza
      Object.assign(set, {
        email_kind: v.email ? 'generic' : null,
        email_source: v.email ? 'manuale' : null,
        email_status: v.email ? 'da_verificare' : null,
        email_source_url: null,
        email_found_at: v.email ? new Date() : null,
        has_email: Boolean(v.email),
      });
    }
    if (phone !== undefined && put('phone', phone, 'phone', 'phone')) set.has_phone = Boolean(phone);
    if (fax !== undefined) put('fax', fax, 'fax', 'fax');
    let websiteChanged = false;
    if (v.website !== undefined) {
      const url = site?.url ?? null;
      websiteChanged = put('website_url', url, 'website', 'website');
      if (websiteChanged)
        Object.assign(set, {
          website_domain: site?.domain ?? null,
          website_shared: site?.shared ?? false,
          has_website: Boolean(site),
        });
    }
    put('address_street', v.street, 'street', 'address');
    put('address_housenumber', v.housenumber, 'housenumber', 'address');
    put('address_postcode', v.postcode, 'postcode', 'address');
    put('address_city', v.city, 'city', 'address');
    if (edited.has('address')) set.has_address = Boolean((set.address_street ?? row.address_street) as string | null);
    if (
      v.municipalityCode !== undefined &&
      put('municipality_code', v.municipalityCode, 'municipalityCode', 'municipality')
    )
      Object.assign(set, {
        municipality_name: municipality?.altName ?? municipality?.name ?? null,
        province_code: municipality?.provinceCode ?? null,
        region_code: municipality?.regionCode ?? null,
      });
    put('contact_name', v.contactName, 'contactName');
    put('contact_role', v.contactRole, 'contactRole');
    put('notes', v.notes, 'notes');
    put('operating_status', v.operatingStatus, 'operatingStatus');
    if (Object.keys(fields).length)
      throw new JobError(400, 'VALIDATION_ERROR', 'Controlla i campi evidenziati.', undefined, { fields });

    if (!Object.keys(set).length) return { changed: [] as string[] };
    // completezza ricalcolata con gli stessi cinque indicatori della scoperta
    const has = (k: string) => Boolean(k in set ? set[k] : row[k]);
    set.completeness = ['has_website', 'has_address', 'has_phone', 'has_email', 'has_opening_hours'].filter(has).length;

    const entries = Object.entries(set);
    await tx.query(
      `UPDATE businesses SET ${entries.map(([k], i) => `${k} = $${i + 4}`).join(', ')},
              edited_fields = ARRAY(SELECT DISTINCT unnest(edited_fields || $2::text[]) ORDER BY 1),
              edited_at = now(), edited_by = $3, updated_at = now()
        WHERE id = $1`,
      [id, [...edited], userId, ...entries.map(([, value]) => value)],
    );
    // nuovo sito: collegato come sito da controllare (gli audit del sito precedente restano nello storico)
    if (websiteChanged) await linkWebsite(tx, id, (set.website_url as string | null) ?? null);
    await audit(tx, {
      userId,
      action: 'business.edited',
      entityType: 'business',
      entityId: id,
      details: { changes },
    });
    return { changed: Object.keys(changes) };
  });

  // categoria: stessa regola della scelta manuale esistente (null = classificazione automatica)
  if (input.category !== undefined) {
    const { rows } = await db.query<{ primary_category: string | null; category_source: string | null }>(
      'SELECT primary_category, category_source FROM businesses WHERE id = $1',
      [id],
    );
    const cur = rows[0]!;
    const differs =
      input.category === null ? cur.category_source === 'manuale' : cur.primary_category !== input.category;
    if (differs) {
      await setManualCategory(db, id, input.category, userId);
      result.changed.push('category');
    }
  }
  return result;
}
