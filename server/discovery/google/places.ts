import { fold, geo, type Municipality } from '../../geo/geo.ts';
import { normalizePhone } from '../contacts.ts';
import type { CategoryId } from '../categories.ts';
import { realClock, type Clock } from '../osm/overpass.ts';
import { sectorById, SECTORS } from '../sectors.ts';
import {
  ProviderError,
  type DiscoveryProvider,
  type DiscoveryUnitSpec,
  type ProviderInfo,
  type ProviderRecord,
  type RetryInfo,
  type UnitResult,
} from '../types.ts';
import { normalizeWebsite } from '../website.ts';
import { GOOGLE_QUERIES } from './queries.ts';

/*
 * Google Maps Platform — Places API (New), Text Search (https://developers.google.com/maps/documentation/places/web-service/text-search).
 * Uso autorizzato con una chiave del progetto Google Cloud di Noventra (GOOGLE_PLACES_API_KEY), mai inviata al browser.
 *
 *  - una ricerca per settore e per comune: «farmacia a Napoli (NA)», lingua italiana, regione IT, tipo di luogo quando
 *    è esatto (GOOGLE_QUERIES); fino a GOOGLE_PLACES_MAX_PAGES pagine da 20 risultati (nextPageToken, massimo 3);
 *  - si chiedono solo i campi necessari (FieldMask): id, nome, indirizzo, posizione, sito, telefono, tipi, stato;
 *  - nessuna email da Google (non la fornisce): l'email si cerca poi sul sito dell'azienda (server/enrichment);
 *  - attività chiuse definitivamente: scartate;
 *  - limite giornaliero di richieste (GOOGLE_PLACES_DAILY_LIMIT, contato nel database): oltre, la ricerca si ferma e
 *    lo dichiara; errori 429/5xx ritentati con attesa crescente; chiave non valida o API non abilitata: errore chiaro.
 * Google non garantisce di restituire tutte le attività di un'area: i risultati non sono un censimento completo.
 * Condizioni d'uso: l'identificativo del luogo (place ID) si può conservare; gli altri contenuti di Google hanno limiti
 * di conservazione (vedi docs/google-places.md).
 */

export const GOOGLE_PROVIDER = 'google';

export interface GooglePlacesConfig {
  apiKey: string | null;
  /** https://places.googleapis.com, oppure un server finto locale nei test. */
  baseUrl: string;
  maxPages: number;
  timeoutMs: number;
  maxRetries: number;
  minIntervalMs: number;
}

/** Contatore delle richieste del giorno (nel database): false se il limite è raggiunto. */
export interface UsageBudget {
  take(provider: string): Promise<boolean>;
  limit: number;
}

const FIELD_MASK = [
  'places.id',
  'places.displayName',
  'places.formattedAddress',
  'places.addressComponents',
  'places.location',
  'places.websiteUri',
  'places.nationalPhoneNumber',
  'places.internationalPhoneNumber',
  'places.types',
  'places.primaryType',
  'places.businessStatus',
  'places.googleMapsUri',
  'nextPageToken',
].join(',');

export const GOOGLE_SETUP_HINT =
  'Google Places non è configurato. Crea una chiave API in un progetto Google Cloud con fatturazione attiva, abilita ' +
  '«Places API (New)», limita la chiave a quella API e al server, impostala in GOOGLE_PLACES_API_KEY nel file .env e ' +
  'riavvia l’API.';

const ATTRIBUTION = {
  text: 'Dati di Google Maps',
  url: 'https://www.google.com/maps',
  license: 'Termini di servizio di Google Maps Platform',
  licenseUrl: 'https://cloud.google.com/maps-platform/terms',
};

interface AddressComponent {
  longText?: string;
  shortText?: string;
  types?: string[];
}

interface Place {
  id?: string;
  displayName?: { text?: string };
  formattedAddress?: string;
  addressComponents?: AddressComponent[];
  location?: { latitude?: number; longitude?: number };
  websiteUri?: string;
  nationalPhoneNumber?: string;
  internationalPhoneNumber?: string;
  types?: string[];
  primaryType?: string;
  businessStatus?: string;
  googleMapsUri?: string;
}

const abortError = () => new ProviderError('aborted', 'Ricerca interrotta.');

const component = (p: Place, type: string) => p.addressComponents?.find((c) => c.types?.includes(type))?.longText;

/** Comune ISTAT del luogo: nome del comune nei componenti dell'indirizzo, cercato prima nella provincia della ricerca. */
export function municipalityOf(p: Place, searched: Municipality): string | null {
  const name = component(p, 'administrative_area_level_3') ?? component(p, 'locality');
  if (!name) return null;
  const f = fold(name);
  const same = (m: Municipality) => fold(m.name) === f || (m.altName ? fold(m.altName) === f : false);
  if (same(searched)) return searched.code;
  const inProvince = geo().municipalitiesOf(searched.provinceCode).find(same);
  if (inProvince) return inProvince.code;
  // altrove in Italia: solo se il nome è unico (comuni omonimi in province diverse restano non determinati)
  const all = geo()
    .search(name, 50)
    .filter((a) => a.type === 'municipality' && fold(a.name) === f);
  return all.length === 1 ? all[0]!.code : null;
}

/** Record del motore di scoperta da un luogo Google; null se manca il nome o l'attività è chiusa definitivamente. */
export function placeToRecord(p: Place, sectorId: string, searched: Municipality): ProviderRecord | null {
  const name = p.displayName?.text?.trim().slice(0, 200);
  if (!p.id || !name || p.businessStatus === 'CLOSED_PERMANENTLY') return null;
  const sector = sectorById(sectorId)!;
  const site = normalizeWebsite(p.websiteUri ?? null);
  const address = {
    street: component(p, 'route')?.slice(0, 200) ?? null,
    housenumber: component(p, 'street_number')?.slice(0, 20) ?? null,
    postcode: component(p, 'postal_code')?.slice(0, 10) ?? null,
    city: (component(p, 'locality') ?? component(p, 'administrative_area_level_3'))?.slice(0, 100) ?? null,
  };
  const phone = normalizePhone(p.nationalPhoneNumber ?? p.internationalPhoneNumber ?? null);
  const sourceTags: Record<string, string> = { name };
  if (p.primaryType) sourceTags.google_primary_type = p.primaryType;
  if (p.types?.length) sourceTags.google_types = p.types.join(';').slice(0, 500);
  if (p.businessStatus) sourceTags.google_business_status = p.businessStatus;
  return {
    provider: GOOGLE_PROVIDER,
    ref: p.id.slice(0, 100),
    sourceUrl: p.googleMapsUri ?? `https://www.google.com/maps/place/?q=place_id:${encodeURIComponent(p.id)}`,
    name,
    category: sector.category,
    sector: sector.id,
    websiteUrl: site?.url ?? null,
    websiteDomain: site?.domain ?? null,
    websiteShared: site?.shared ?? false,
    address,
    municipalityCode: municipalityOf(p, searched),
    latitude: p.location?.latitude ?? null,
    longitude: p.location?.longitude ?? null,
    // Google non fornisce email: l'email si cerca solo sul sito dell'azienda
    contacts: { phone, email: null, emailKind: null },
    has: {
      website: site !== null,
      address: Boolean(address.street && (address.housenumber || address.postcode)),
      phone: phone !== null,
      email: false,
      openingHours: false,
    },
    sourceTags,
  };
}

export class GooglePlacesProvider implements DiscoveryProvider {
  private readonly config: GooglePlacesConfig;
  private readonly budget: UsageBudget | null;
  private readonly clock: Clock;
  private readonly fetchImpl: typeof fetch;
  private lastStart = 0;

  constructor(
    config: GooglePlacesConfig,
    deps: { budget?: UsageBudget | null; clock?: Clock; fetchImpl?: typeof fetch } = {},
  ) {
    this.config = config;
    this.budget = deps.budget ?? null;
    this.clock = deps.clock ?? realClock;
    this.fetchImpl = deps.fetchImpl ?? fetch;
  }

  info(): ProviderInfo {
    return {
      id: GOOGLE_PROVIDER,
      label: 'Google Maps (Places API)',
      configured: Boolean(this.config.apiKey),
      ...(this.config.apiKey ? {} : { setupHint: GOOGLE_SETUP_HINT }),
      endpointHost: new URL(this.config.baseUrl).host,
      attribution: ATTRIBUTION,
      supportsRadius: false,
      categories: [...new Set(SECTORS.map((s) => s.category))].map((id) => ({ id, coverage: 'buona' as const })),
    };
  }

  async fetchUnit(
    unit: DiscoveryUnitSpec,
    categories: CategoryId[],
    limitPerArea: number,
    signal: AbortSignal,
    onRetry?: (info: RetryInfo) => void,
    options: { sectors?: string[] } = {},
  ): Promise<UnitResult> {
    if (!this.config.apiKey) throw new ProviderError('not_configured', GOOGLE_SETUP_HINT);
    // settori richiesti; senza settori (ricerca per categorie), i settori di quelle categorie
    const sectors = options.sectors?.length
      ? options.sectors
      : SECTORS.filter((s) => categories.includes(s.category)).map((s) => s.id);
    const fetchedAt = new Date(this.clock.now());
    const records = new Map<string, ProviderRecord>();
    let requests = 0;
    for (const m of unit.municipalities) {
      const province = geo().province(m.provinceCode);
      for (const sectorId of sectors) {
        const q = GOOGLE_QUERIES[sectorId]!;
        const textQuery = `${q.text} a ${m.name}${province ? ` (${province.sigla})` : ''}`;
        let pageToken: string | undefined;
        let found = 0;
        let includedType = q.includedType;
        for (let page = 0; page < this.config.maxPages && found < limitPerArea; page++) {
          const { body, sent, typeRejected } = await this.search(
            { textQuery, includedType, pageToken, pageSize: Math.min(20, limitPerArea - found) },
            signal,
            onRetry,
          );
          requests += sent;
          // tipo di luogo non accettato dall'API: si ripete la stessa pagina con il solo testo
          if (typeRejected) {
            includedType = undefined;
            page--;
            continue;
          }
          for (const p of body.places ?? []) {
            const r = placeToRecord(p, sectorId, m);
            if (r && !records.has(r.ref)) {
              records.set(r.ref, r);
              found++;
            }
          }
          pageToken = body.nextPageToken;
          if (!pageToken) break;
        }
      }
    }
    return {
      records: [...records.values()],
      // Google non elenca i comuni: ogni comune cercato si considera trovato (i risultati possono essere incompleti)
      foundMunicipalities: unit.municipalities.map((m) => m.code),
      fromCache: false,
      fetchedAt,
      requests,
      sourceTimestamp: null,
    };
  }

  /** Una richiesta Text Search con nuovi tentativi per gli errori temporanei. */
  private async search(
    body: { textQuery: string; includedType?: string; pageToken?: string; pageSize: number },
    signal: AbortSignal,
    onRetry?: (info: RetryInfo) => void,
  ): Promise<{ body: { places?: Place[]; nextPageToken?: string }; sent: number; typeRejected: boolean }> {
    let sent = 0;
    for (let attempt = 0; ; attempt++) {
      if (signal.aborted) throw abortError();
      if (this.budget && !(await this.budget.take(GOOGLE_PROVIDER))) {
        const error = new ProviderError(
          'rate_limited',
          `Raggiunto il limite giornaliero di ${this.budget.limit} richieste a Google Places (GOOGLE_PLACES_DAILY_LIMIT): la ricerca riprende domani o con un limite più alto.`,
        );
        error.attempts = sent;
        throw error;
      }
      try {
        sent++;
        return { body: await this.post(body, signal), sent, typeRejected: false };
      } catch (error) {
        if (!(error instanceof ProviderError)) throw error;
        if (error.message === TYPE_REJECTED && body.includedType) return { body: {}, sent, typeRejected: true };
        const transient = error.kind === 'rate_limited' || error.kind === 'unavailable';
        if (!transient || !error.retryable || attempt >= this.config.maxRetries || signal.aborted) {
          error.attempts = sent;
          throw error;
        }
        const waitMs = Math.max(Math.min(2_000 * 2 ** attempt, 60_000), error.retryAfterMs ?? 0);
        onRetry?.({ attempt: attempt + 1, maxAttempts: this.config.maxRetries + 1, waitMs, reason: error.message });
        await this.clock.sleep(waitMs, signal);
      }
    }
  }

  private async post(
    query: { textQuery: string; includedType?: string; pageToken?: string; pageSize: number },
    signal: AbortSignal,
  ): Promise<{ places?: Place[]; nextPageToken?: string }> {
    const wait = this.lastStart + this.config.minIntervalMs - this.clock.now();
    if (wait > 0) await this.clock.sleep(wait, signal);
    this.lastStart = this.clock.now();
    const timeout = AbortSignal.timeout(this.config.timeoutMs);
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.config.baseUrl}/v1/places:searchText`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Goog-Api-Key': this.config.apiKey!,
          'X-Goog-FieldMask': FIELD_MASK,
        },
        body: JSON.stringify({
          textQuery: query.textQuery,
          languageCode: 'it',
          regionCode: 'IT',
          pageSize: query.pageSize,
          ...(query.includedType ? { includedType: query.includedType, strictTypeFiltering: true } : {}),
          ...(query.pageToken ? { pageToken: query.pageToken } : {}),
        }),
        signal: AbortSignal.any([signal, timeout]),
        redirect: 'error',
      });
    } catch (error) {
      if (signal.aborted) throw abortError();
      if (timeout.aborted)
        throw new ProviderError('unavailable', 'Google Places non ha risposto in tempo.', { retryable: true });
      throw new ProviderError('unavailable', `Google Places non raggiungibile (${(error as Error).message}).`, {
        retryable: true,
      });
    }
    const text = await res.text();
    if (text.length > 4 * 1024 * 1024) throw new ProviderError('too_large', 'Risposta di Google Places troppo grande.');
    let json: { error?: { message?: string; status?: string } } & { places?: Place[]; nextPageToken?: string };
    try {
      json = text ? JSON.parse(text) : {};
    } catch {
      throw new ProviderError('invalid_response', 'Risposta di Google Places non leggibile.');
    }
    if (res.ok) return json;
    // il messaggio di Google non contiene la chiave; lo si riporta solo in parte, per la diagnosi
    const detail = (json.error?.message ?? '').slice(0, 160);
    if (res.status === 429)
      throw new ProviderError('rate_limited', 'Quota o limite di richieste di Google Places raggiunto (HTTP 429).', {
        retryable: true,
        retryAfterMs: Number(res.headers.get('retry-after')) * 1000 || undefined,
      });
    if (res.status === 400 && query.includedType && /includedType|type/i.test(detail))
      throw new ProviderError('invalid_response', TYPE_REJECTED);
    if (res.status === 400)
      throw new ProviderError('invalid_response', `Richiesta rifiutata da Google Places: ${detail}`);
    if (res.status === 401 || res.status === 403)
      throw new ProviderError(
        'not_configured',
        `Google Places ha rifiutato la chiave API (HTTP ${res.status}): controlla che la chiave sia valida, che «Places API (New)» sia abilitata e che la fatturazione sia attiva.`,
      );
    throw new ProviderError('unavailable', `Risposta inattesa da Google Places (HTTP ${res.status}).`, {
      retryable: res.status >= 500,
    });
  }
}

const TYPE_REJECTED = 'Tipo di luogo non accettato da Google Places.';
