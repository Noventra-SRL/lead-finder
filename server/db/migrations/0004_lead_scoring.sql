-- Fase 4 — punteggio dei lead: configurazioni versionate, istantanee dei punteggi (storico, mai sovrascritto),
-- ricalcoli in blocco. Il punteggio è un criterio di priorità, non una probabilità di acquisto.

-- Configurazioni del punteggio: ogni modifica è una versione nuova; le precedenti restano per spiegare i punteggi storici.
-- La versione attiva è la più alta.
CREATE TABLE scoring_configs (
  version     integer PRIMARY KEY CHECK (version >= 1),
  config      jsonb NOT NULL,
  note        text CHECK (length(note) <= 300),
  created_by  uuid REFERENCES users (id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- Istantanee del punteggio di un'azienda. Una nuova riga solo se i dati in ingresso (o la configurazione) cambiano,
-- oppure su richiesta esplicita; "is_current" indica l'ultima, usata da elenchi e filtri.
CREATE TABLE lead_scores (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id        uuid NOT NULL REFERENCES businesses (id),
  audit_id           uuid REFERENCES website_audits (id),
  website_id         uuid REFERENCES websites (id),
  algorithm_version  integer NOT NULL,
  config_version     integer NOT NULL REFERENCES scoring_configs (version),
  -- impronta dei dati in ingresso + versioni: uguale = nessun ricalcolo necessario
  input_hash         text NOT NULL CHECK (length(input_hash) = 64),
  status             text NOT NULL CHECK (status IN ('ranked', 'needs_review', 'insufficient_data', 'not_suitable')),
  score              smallint CHECK (score BETWEEN 0 AND 100),
  raw_score          numeric(5, 2) CHECK (raw_score BETWEEN 0 AND 100),
  band               text CHECK (band IN ('A', 'B', 'C', 'low')),
  confidence         smallint NOT NULL CHECK (confidence BETWEEN 0 AND 100),
  confidence_level   text NOT NULL CHECK (confidence_level IN ('high', 'medium', 'low')),
  completeness       smallint NOT NULL CHECK (completeness BETWEEN 0 AND 100),
  breakdown          jsonb NOT NULL,
  explanation        text NOT NULL,
  next_step          text NOT NULL,
  trigger            text NOT NULL CHECK (trigger IN ('manual', 'audit', 'discovery', 'bulk')),
  requested_by       uuid REFERENCES users (id) ON DELETE SET NULL,
  is_current         boolean NOT NULL DEFAULT true,
  calculated_at      timestamptz NOT NULL DEFAULT now(),
  -- un punteggio presentato ha sempre una fascia; dati insufficienti o settore escluso: nessun punteggio
  CHECK ((status IN ('ranked', 'needs_review')) = (score IS NOT NULL AND band IS NOT NULL))
);
CREATE UNIQUE INDEX lead_scores_current_idx ON lead_scores (business_id) WHERE is_current;
CREATE INDEX lead_scores_history_idx ON lead_scores (business_id, calculated_at DESC);
CREATE INDEX lead_scores_rank_idx ON lead_scores (status, band, score DESC) WHERE is_current;
CREATE INDEX lead_scores_audit_idx ON lead_scores (audit_id);

-- Ricalcoli in blocco, eseguiti in background a lotti (cursore sull'id dell'azienda: riprendibili dopo un riavvio).
CREATE TABLE scoring_jobs (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_by        uuid REFERENCES users (id) ON DELETE SET NULL,
  status            text NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending', 'running', 'completed', 'failed', 'cancelled')),
  -- {"kind":"all"} | {"kind":"businesses","ids":[...]} | {"kind":"discovery_job","jobId":"..."}
  scope             jsonb NOT NULL,
  force             boolean NOT NULL DEFAULT false,
  trigger           text NOT NULL CHECK (trigger IN ('manual', 'discovery', 'bulk')),
  cursor            uuid,
  total             integer NOT NULL DEFAULT 0,
  processed         integer NOT NULL DEFAULT 0,
  created_count     integer NOT NULL DEFAULT 0,
  unchanged_count   integer NOT NULL DEFAULT 0,
  error             text,
  cancel_requested  boolean NOT NULL DEFAULT false,
  worker_id         text,
  heartbeat_at      timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  started_at        timestamptz,
  finished_at       timestamptz
);
CREATE INDEX scoring_jobs_status_idx ON scoring_jobs (status, created_at);
