-- Fase 2 — scoperta delle aziende: anagrafica, provenienza, possibili duplicati, job di ricerca, cache del fornitore.

-- Anagrafica delle aziende (un record per attività reale). I dati vengono solo dalle fonti collegate
-- (business_sources): nessun campo è dedotto. NULL = dato sconosciuto.
CREATE TABLE businesses (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name               text NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  -- nome normalizzato (minuscolo, senza accenti e punteggiatura) per ricerca e confronto dei duplicati
  search_name        text NOT NULL,
  category           text NOT NULL CHECK (length(category) BETWEEN 1 AND 40),
  website_url        text CHECK (length(website_url) <= 500),
  website_domain     text CHECK (length(website_domain) <= 253),
  -- dominio di una piattaforma condivisa (social, directory): non identifica l'attività
  website_shared     boolean NOT NULL DEFAULT false,
  address_street     text,
  address_housenumber text,
  address_postcode   text,
  address_city       text,
  -- codici ISTAT, valorizzati solo se risolti in modo affidabile (comune → provincia → regione)
  municipality_code  text CHECK (municipality_code ~ '^[0-9]{6}$'),
  province_code      text CHECK (province_code ~ '^[0-9]{3}$'),
  region_code        text CHECK (region_code ~ '^[0-9]{2}$'),
  -- denominazione ISTAT del comune (per ordinare e cercare per località), presente solo con il codice
  municipality_name  text,
  latitude           double precision CHECK (latitude BETWEEN -90 AND 90),
  longitude          double precision CHECK (longitude BETWEEN -180 AND 180),
  -- indicatori di completezza: la fonte riporta il dato (i recapiti in sé non vengono salvati)
  has_website        boolean NOT NULL DEFAULT false,
  has_address        boolean NOT NULL DEFAULT false,
  has_phone          boolean NOT NULL DEFAULT false,
  has_email          boolean NOT NULL DEFAULT false,
  has_opening_hours  boolean NOT NULL DEFAULT false,
  completeness       smallint NOT NULL CHECK (completeness BETWEEN 0 AND 5),
  -- unione confermata con un altro record: questo resta per la cronologia ma non compare negli elenchi
  merged_into        uuid REFERENCES businesses (id),
  first_seen_at      timestamptz NOT NULL,
  -- ultima volta in cui una fonte ha confermato i dati
  last_verified_at   timestamptz NOT NULL,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  CHECK (merged_into IS NULL OR merged_into <> id)
);
CREATE INDEX businesses_active_idx ON businesses (last_verified_at DESC) WHERE merged_into IS NULL;
CREATE INDEX businesses_category_idx ON businesses (category) WHERE merged_into IS NULL;
CREATE INDEX businesses_region_idx ON businesses (region_code, province_code, municipality_code) WHERE merged_into IS NULL;
CREATE INDEX businesses_province_idx ON businesses (province_code) WHERE merged_into IS NULL;
CREATE INDEX businesses_municipality_idx ON businesses (municipality_code) WHERE merged_into IS NULL;
CREATE INDEX businesses_domain_idx ON businesses (website_domain) WHERE merged_into IS NULL AND website_domain IS NOT NULL;
CREATE INDEX businesses_search_name_idx ON businesses (search_name);
CREATE INDEX businesses_position_idx ON businesses (latitude, longitude);

-- Provenienza: un record per elemento di una fonte (es. un nodo OpenStreetMap), collegato a un'azienda.
-- (provider, provider_ref) è univoco: ripetere una ricerca aggiorna, non duplica.
CREATE TABLE business_sources (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id     uuid NOT NULL REFERENCES businesses (id),
  provider        text NOT NULL CHECK (length(provider) BETWEEN 1 AND 40),
  provider_ref    text NOT NULL CHECK (length(provider_ref) BETWEEN 1 AND 100),
  source_url      text NOT NULL,
  license         text NOT NULL,
  -- fonte che determina i campi dell'azienda; le altre completano solo i dati mancanti
  is_primary      boolean NOT NULL DEFAULT false,
  -- dati normalizzati e tag originali selezionati (senza recapiti personali) all'ultima lettura
  data            jsonb NOT NULL,
  tags            jsonb NOT NULL,
  first_seen_at   timestamptz NOT NULL,
  last_seen_at    timestamptz NOT NULL,
  -- data dei dati della fonte all'ultima lettura (OSM: timestamp_osm_base del server), può essere molto precedente
  source_data_at  timestamptz,
  last_job_id     uuid,
  UNIQUE (provider, provider_ref)
);
CREATE INDEX business_sources_business_idx ON business_sources (business_id);

-- Possibili duplicati da verificare a mano. La coppia è ordinata (business_a < business_b) e univoca:
-- una coppia giudicata "distinta" non viene più proposta.
CREATE TABLE duplicate_candidates (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_a   uuid NOT NULL REFERENCES businesses (id),
  business_b   uuid NOT NULL REFERENCES businesses (id),
  reason       text NOT NULL,
  distance_m   integer,
  status       text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'merged', 'distinct', 'obsolete')),
  created_at   timestamptz NOT NULL DEFAULT now(),
  resolved_at  timestamptz,
  resolved_by  uuid REFERENCES users (id) ON DELETE SET NULL,
  CHECK (business_a < business_b),
  UNIQUE (business_a, business_b)
);
CREATE INDEX duplicate_candidates_pending_idx ON duplicate_candidates (created_at DESC) WHERE status = 'pending';
CREATE INDEX duplicate_candidates_b_idx ON duplicate_candidates (business_b);

-- Job di ricerca. Lo stato e l'avanzamento sono nel database: sopravvivono ai riavvii.
CREATE TABLE discovery_jobs (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_by          uuid REFERENCES users (id) ON DELETE SET NULL,
  provider            text NOT NULL,
  status              text NOT NULL DEFAULT 'pending'
                      CHECK (status IN ('pending', 'running', 'paused', 'completed', 'completed_with_warnings', 'failed', 'cancelled')),
  area_type           text NOT NULL CHECK (area_type IN ('italy', 'region', 'province', 'municipality')),
  area_code           text NOT NULL,
  area_name           text NOT NULL,
  radius_km           numeric(4, 1),
  categories          text[] NOT NULL CHECK (cardinality(categories) >= 1),
  max_results         integer NOT NULL CHECK (max_results >= 1),
  min_completeness    smallint NOT NULL DEFAULT 0 CHECK (min_completeness BETWEEN 0 AND 5),
  require_website     boolean NOT NULL DEFAULT false,
  -- impronta dei parametri: impedisce due job identici attivi nello stesso momento
  request_key         text NOT NULL,
  units_total         integer NOT NULL DEFAULT 0,
  units_done          integer NOT NULL DEFAULT 0,
  discovered          integer NOT NULL DEFAULT 0,
  inserted            integer NOT NULL DEFAULT 0,
  updated             integer NOT NULL DEFAULT 0,
  unchanged           integer NOT NULL DEFAULT 0,
  merged              integer NOT NULL DEFAULT 0,
  duplicates_skipped  integer NOT NULL DEFAULT 0,
  flagged_for_review  integer NOT NULL DEFAULT 0,
  skipped_incomplete  integer NOT NULL DEFAULT 0,
  requests_sent       integer NOT NULL DEFAULT 0,
  failed_requests     integer NOT NULL DEFAULT 0,
  limit_reached       boolean NOT NULL DEFAULT false,
  -- elenco limitato di avvisi ed errori leggibili: [{ "at", "level", "message" }]
  messages            jsonb NOT NULL DEFAULT '[]'::jsonb,
  cancel_requested    boolean NOT NULL DEFAULT false,
  pause_requested     boolean NOT NULL DEFAULT false,
  pause_reason        text,
  worker_id           text,
  heartbeat_at        timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  started_at          timestamptz,
  finished_at         timestamptz,
  updated_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX discovery_jobs_status_idx ON discovery_jobs (status, created_at);
CREATE INDEX discovery_jobs_created_idx ON discovery_jobs (created_at DESC);
CREATE UNIQUE INDEX discovery_jobs_active_request_key ON discovery_jobs (request_key)
  WHERE status IN ('pending', 'running', 'paused');

-- Unità di lavoro di un job (gruppi di comuni): sono il punto di ripresa dopo un'interruzione.
CREATE TABLE discovery_job_units (
  job_id            uuid NOT NULL REFERENCES discovery_jobs (id) ON DELETE CASCADE,
  seq               integer NOT NULL,
  municipality_codes text[] NOT NULL CHECK (cardinality(municipality_codes) >= 1),
  status            text NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending', 'running', 'done', 'failed', 'split', 'skipped')),
  attempts          integer NOT NULL DEFAULT 0,
  records_found     integer NOT NULL DEFAULT 0,
  missing_municipalities text[] NOT NULL DEFAULT '{}',
  from_cache        boolean NOT NULL DEFAULT false,
  -- data dei dati del server che ha risposto (i server pubblici possono usare copie vecchie di mesi)
  source_data_at    timestamptz,
  error             text,
  started_at        timestamptz,
  finished_at       timestamptz,
  PRIMARY KEY (job_id, seq)
);

-- Cache dei risultati normalizzati del fornitore (mai la risposta grezza).
CREATE TABLE provider_cache (
  key         text PRIMARY KEY,
  provider    text NOT NULL,
  payload     jsonb NOT NULL,
  fetched_at  timestamptz NOT NULL,
  expires_at  timestamptz NOT NULL
);
CREATE INDEX provider_cache_expires_idx ON provider_cache (expires_at);
