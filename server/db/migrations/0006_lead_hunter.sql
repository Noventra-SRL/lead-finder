-- Fase 6 — Lead Hunter: settori, recapiti pubblici, esclusioni, ricerche nazionali per obiettivo.
-- Solo aggiunte: i dati esistenti restano validi (settore e recapiti vuoti finché una nuova ricerca non li legge).

-- Settore (catalogo server/discovery/sectors.ts) e recapiti PUBBLICI dell'attività indicati dalla fonte.
-- L'email si conserva solo se generica (info@…); un indirizzo che sembra personale non viene salvato.
ALTER TABLE businesses ADD COLUMN sector text CHECK (sector ~ '^[a-z][a-z_]{1,40}$');
ALTER TABLE businesses ADD COLUMN phone text CHECK (length(phone) <= 30);
ALTER TABLE businesses ADD COLUMN email text CHECK (length(email) <= 120);
ALTER TABLE businesses ADD COLUMN email_kind text CHECK (email_kind IN ('generic', 'personal'));
-- Esclusione dalla ricerca di lead e dal contatto (richiesta dell'azienda o scelta commerciale): il record resta,
-- così una nuova ricerca non lo ripropone.
ALTER TABLE businesses ADD COLUMN excluded_at timestamptz;
ALTER TABLE businesses ADD COLUMN excluded_reason text CHECK (length(excluded_reason) <= 300);
ALTER TABLE businesses ADD COLUMN excluded_by uuid REFERENCES users (id) ON DELETE SET NULL;
CREATE INDEX businesses_sector_idx ON businesses (sector) WHERE merged_into IS NULL;
CREATE INDEX businesses_excluded_idx ON businesses (excluded_at) WHERE excluded_at IS NOT NULL;

-- Ricerche di lead: obiettivo, area, settori, opzioni; piano delle province e cursore per riprendere.
CREATE TABLE hunt_runs (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_by          uuid REFERENCES users (id) ON DELETE SET NULL,
  status              text NOT NULL DEFAULT 'pending'
                      CHECK (status IN ('pending', 'running', 'paused', 'completed', 'completed_with_warnings', 'failed', 'cancelled')),
  target              integer NOT NULL CHECK (target BETWEEN 1 AND 10000),
  area_type           text NOT NULL CHECK (area_type IN ('italy', 'region', 'province', 'municipality')),
  area_code           text NOT NULL,
  area_name           text NOT NULL,
  sectors             text[] NOT NULL CHECK (cardinality(sectors) >= 1),
  -- { minScore, websitePreference, excludeKnown, audit }
  options             jsonb NOT NULL,
  -- aree in ordine di esecuzione (province alternate tra le regioni) e posizione raggiunta
  plan                jsonb NOT NULL,
  cursor              integer NOT NULL DEFAULT 0,
  current_job_id      uuid REFERENCES discovery_jobs (id),
  current_audit_job_id uuid REFERENCES audit_jobs (id),
  phase               text NOT NULL DEFAULT 'discovery' CHECK (phase IN ('discovery', 'audit', 'done')),
  messages            jsonb NOT NULL DEFAULT '[]'::jsonb,
  pause_requested     boolean NOT NULL DEFAULT false,
  cancel_requested    boolean NOT NULL DEFAULT false,
  pause_reason        text,
  worker_id           text,
  heartbeat_at        timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  started_at          timestamptz,
  finished_at         timestamptz,
  updated_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX hunt_runs_status_idx ON hunt_runs (status, created_at);

-- Aziende raccolte da una ricerca (collegamento, non copia): nuove o già presenti nel database.
CREATE TABLE hunt_run_businesses (
  run_id            uuid NOT NULL REFERENCES hunt_runs (id),
  business_id       uuid NOT NULL REFERENCES businesses (id),
  discovery_job_id  uuid REFERENCES discovery_jobs (id),
  -- azienda creata da questa ricerca (non già nel database prima del suo inizio)
  is_new            boolean NOT NULL,
  linked_at         timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (run_id, business_id)
);
CREATE INDEX hunt_run_businesses_business_idx ON hunt_run_businesses (business_id);

-- Ricerche per settori: settori richiesti e limite per settore e per comune; job creati da una ricerca di lead.
ALTER TABLE discovery_jobs ADD COLUMN sectors text[] NOT NULL DEFAULT '{}';
ALTER TABLE discovery_jobs ADD COLUMN limit_per_sector smallint CHECK (limit_per_sector BETWEEN 1 AND 100);
ALTER TABLE discovery_jobs ADD COLUMN hunt_run_id uuid REFERENCES hunt_runs (id);
ALTER TABLE audit_jobs ADD COLUMN hunt_run_id uuid REFERENCES hunt_runs (id);
CREATE INDEX discovery_jobs_hunt_idx ON discovery_jobs (hunt_run_id) WHERE hunt_run_id IS NOT NULL;
CREATE INDEX audit_jobs_hunt_idx ON audit_jobs (hunt_run_id) WHERE hunt_run_id IS NOT NULL;
