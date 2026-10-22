-- Fase 5 — abbinamento ai servizi di Noventra: catalogo versionato, esecuzioni dell'abbinamento (storico), corrispondenze
-- per servizio, revisioni delle persone (solo aggiunte). Una corrispondenza indica una possibile pertinenza, non una
-- domanda confermata né un'intenzione di acquisto.

-- Catalogo dei servizi e regole di abbinamento: ogni modifica è una versione nuova; la più alta è attiva.
CREATE TABLE service_catalog_versions (
  version     integer PRIMARY KEY CHECK (version >= 1),
  catalog     jsonb NOT NULL,
  note        text CHECK (length(note) <= 300),
  created_by  uuid REFERENCES users (id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- Un'esecuzione dell'abbinamento per un'azienda: nuova solo se cambiano i dati in ingresso, il catalogo o le regole
-- (o su richiesta esplicita). "is_current" indica l'ultima.
CREATE TABLE service_match_runs (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id        uuid NOT NULL REFERENCES businesses (id),
  lead_score_id      uuid REFERENCES lead_scores (id),
  audit_id           uuid REFERENCES website_audits (id),
  catalog_version    integer NOT NULL REFERENCES service_catalog_versions (version),
  algorithm_version  integer NOT NULL,
  input_hash         text NOT NULL CHECK (length(input_hash) = 64),
  confidence_level   text NOT NULL CHECK (confidence_level IN ('high', 'medium', 'low')),
  trigger            text NOT NULL CHECK (trigger IN ('manual', 'audit', 'discovery', 'bulk')),
  requested_by       uuid REFERENCES users (id) ON DELETE SET NULL,
  is_current         boolean NOT NULL DEFAULT true,
  calculated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX service_match_runs_current_idx ON service_match_runs (business_id) WHERE is_current;
CREATE INDEX service_match_runs_history_idx ON service_match_runs (business_id, calculated_at DESC);

-- Corrispondenza azienda ↔ servizio in un'esecuzione, con prove, segnali e spiegazione.
CREATE TABLE service_matches (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id            uuid NOT NULL REFERENCES service_match_runs (id),
  business_id       uuid NOT NULL REFERENCES businesses (id),
  service_id        text NOT NULL CHECK (service_id ~ '^[a-z][a-z0-9_]{1,40}$'),
  status            text NOT NULL CHECK (status IN ('recommended', 'possible', 'needs_review', 'insufficient_evidence', 'not_relevant')),
  strength          text CHECK (strength IN ('recommended', 'possible')),
  score             smallint CHECK (score BETWEEN 0 AND 100),
  raw_score         numeric(5, 2) CHECK (raw_score BETWEEN 0 AND 100),
  confidence        smallint NOT NULL CHECK (confidence BETWEEN 0 AND 100),
  confidence_level  text NOT NULL CHECK (confidence_level IN ('high', 'medium', 'low')),
  completeness      smallint NOT NULL CHECK (completeness BETWEEN 0 AND 100),
  dedupe_group      text NOT NULL,
  dimensions        jsonb NOT NULL,
  evidence          jsonb NOT NULL,
  signals           jsonb NOT NULL,
  reasons           jsonb NOT NULL DEFAULT '[]'::jsonb,
  problem           text,
  explanation       text NOT NULL,
  next_step         text NOT NULL,
  -- copia dello stato dell'esecuzione: un solo abbinamento attuale per azienda e servizio
  is_current        boolean NOT NULL DEFAULT true,
  created_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (run_id, service_id),
  CHECK ((score IS NOT NULL) = (strength IS NOT NULL))
);
CREATE UNIQUE INDEX service_matches_current_idx ON service_matches (business_id, service_id) WHERE is_current;
CREATE INDEX service_matches_service_idx ON service_matches (service_id, status, score DESC) WHERE is_current;

-- Revisioni delle persone: accettato per la valutazione commerciale, archiviato (con motivo), da verificare a mano,
-- riaperto, nota. Solo aggiunte: lo stato attuale è l'ultima azione diversa da "note"; nulla viene cancellato.
CREATE TABLE service_match_reviews (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id  uuid NOT NULL REFERENCES businesses (id),
  service_id   text NOT NULL CHECK (service_id ~ '^[a-z][a-z0-9_]{1,40}$'),
  action       text NOT NULL CHECK (action IN ('accepted_for_review', 'dismissed', 'needs_review', 'reopened', 'note')),
  note         text CHECK (length(note) <= 1000),
  -- abbinamento a cui la persona ha risposto (null se il servizio non era abbinato in automatico)
  match_id     uuid REFERENCES service_matches (id),
  user_id      uuid REFERENCES users (id) ON DELETE SET NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  CHECK (action <> 'note' OR note IS NOT NULL)
);
CREATE INDEX service_match_reviews_idx ON service_match_reviews (business_id, service_id, created_at DESC);

-- I ricalcoli in blocco aggiornano anche gli abbinamenti: conteggio dedicato.
ALTER TABLE scoring_jobs ADD COLUMN matches_created integer NOT NULL DEFAULT 0;
