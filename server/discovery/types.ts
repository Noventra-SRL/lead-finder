import type { CategoryId } from './categories.ts';
import type { Municipality } from '../geo/geo.ts';

/*
 * Contratto tra il motore di scoperta e i fornitori di dati. Il motore (job, deduplica, salvataggio, API)
 * conosce solo questi tipi; ogni fornitore (oggi OpenStreetMap via Overpass) li implementa nella propria cartella.
 */

/** Record di un'attività già normalizzato dal fornitore: solo dati presenti nella fonte, mai dedotti. */
export interface ProviderRecord {
  provider: string;
  /** Identificatore stabile nel fornitore (OSM: "node/123", "way/456"). */
  ref: string;
  /** Pagina pubblica del record presso la fonte. */
  sourceUrl: string;
  name: string;
  category: CategoryId;
  /** Settore più specifico (catalogo dei settori, Fase 6); null se nessun settore corrisponde. */
  sector: string | null;
  /** URL assoluto http(s) del sito, se la fonte lo indica. */
  websiteUrl: string | null;
  /** Dominio del sito senza "www.", minuscolo. */
  websiteDomain: string | null;
  /** Il dominio è di una piattaforma condivisa (social, directory, costruttori di siti): non identifica l'attività. */
  websiteShared: boolean;
  address: { street: string | null; housenumber: string | null; postcode: string | null; city: string | null };
  /** Codice ISTAT del comune in cui la fonte colloca l'elemento; null se non determinato. */
  municipalityCode: string | null;
  latitude: number | null;
  longitude: number | null;
  /**
   * Recapiti PUBBLICI dell'attività indicati dalla fonte (Fase 6). L'email si conserva solo se generica (info@,
   * prenotazioni@…): un indirizzo che sembra personale non viene salvato, si registra solo che esiste.
   */
  contacts: { phone: string | null; email: string | null; emailKind: 'generic' | 'personal' | null };
  /** Indicatori di completezza: la fonte riporta questi dati. */
  has: { website: boolean; address: boolean; phone: boolean; email: boolean; openingHours: boolean };
  /** Tag originali selezionati per la provenienza (senza recapiti personali). */
  sourceTags: Record<string, string>;
}

export const completenessOf = (r: Pick<ProviderRecord, 'has'>) => Object.values(r.has).filter(Boolean).length;
export const COMPLETENESS_MAX = 5;

/** Unità di lavoro: un gruppo di comuni (con raggio opzionale attorno a un singolo comune). */
export interface DiscoveryUnitSpec {
  municipalities: Municipality[];
  radiusKm?: number;
}

export interface UnitResult {
  records: ProviderRecord[];
  /** Codici ISTAT dei comuni trovati presso la fonte (gli altri sono segnalati come mancanti). */
  foundMunicipalities: string[];
  fromCache: boolean;
  /** Momento in cui i dati sono stati letti dalla fonte (diverso da "adesso" se arrivano dalla cache). */
  fetchedAt: Date;
  /** Richieste effettivamente inviate al fornitore (0 se dalla cache). */
  requests: number;
  /** Data dei dati della fonte che ha risposto (ISO), se dichiarata: può essere molto precedente a fetchedAt. */
  sourceTimestamp: string | null;
}

export type ProviderErrorKind =
  'not_configured' | 'rate_limited' | 'unavailable' | 'too_large' | 'timeout' | 'invalid_response' | 'aborted';

/** Errore del fornitore: tipo, messaggio leggibile in italiano e se ha senso riprovare. */
export class ProviderError extends Error {
  readonly kind: ProviderErrorKind;
  readonly retryable: boolean;
  /** Attesa suggerita dal fornitore (Retry-After), in millisecondi. */
  readonly retryAfterMs?: number;
  /** Richieste inviate (tentativi compresi) prima di arrendersi: alimenta il contatore delle richieste fallite. */
  attempts = 1;
  constructor(kind: ProviderErrorKind, message: string, options: { retryable?: boolean; retryAfterMs?: number } = {}) {
    super(message);
    this.kind = kind;
    this.retryable = options.retryable ?? false;
    this.retryAfterMs = options.retryAfterMs;
  }
}

export interface ProviderInfo {
  id: string;
  label: string;
  configured: boolean;
  /** Messaggio da mostrare se non è configurato (cosa fare). */
  setupHint?: string;
  /** Host dell'endpoint (mai credenziali). */
  endpointHost?: string;
  attribution: { text: string; url: string; license: string; licenseUrl: string };
  supportsRadius: boolean;
  categories: { id: CategoryId; coverage: 'buona' | 'parziale' | 'limitata'; note?: string }[];
}

export interface DiscoveryProvider {
  info(): ProviderInfo;
  /**
   * Cerca le attività delle categorie richieste in un'unità. Al massimo `limitPerArea` elementi per comune.
   * Deve rispettare `signal` (annullamento) e non lanciare errori diversi da ProviderError per problemi della fonte.
   */
  fetchUnit(
    unit: DiscoveryUnitSpec,
    categories: CategoryId[],
    limitPerArea: number,
    signal: AbortSignal,
    /** Chiamata prima di ogni nuovo tentativo dopo un errore temporaneo del fornitore. */
    onRetry?: (info: RetryInfo) => void,
    /** Ricerca per settori (Fase 6): selettori dei settori e limite PER SETTORE e per comune. */
    options?: { sectors?: string[] },
  ): Promise<UnitResult>;
}

export interface RetryInfo {
  /** Tentativo appena fallito (1 = il primo). */
  attempt: number;
  maxAttempts: number;
  waitMs: number;
  reason: string;
}
