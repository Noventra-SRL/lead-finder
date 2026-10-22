-- Valutazione commerciale con AI: il modello valuta cinque componenti con prove; il server calcola il punteggio
-- finale con una formula deterministica e configurabile, applica le penalità commerciali documentate e conserva
-- tutto (anche i tentativi falliti). Solo aggiunte: punteggi della Fase 4, audit e CRM restano invariati; il
-- punteggio della Fase 4 resta come riserva dichiarata quando una valutazione AI non c'è.

-- Configurazione versionata: pesi delle componenti, penalità, fasce (server/ai/config.ts).
CREATE TABLE ai_scoring_configs (
  version     integer PRIMARY KEY,
  config      jsonb NOT NULL,
  note        text CHECK (length(note) <= 300),
  created_by  uuid REFERENCES users (id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- Valutazioni: una riga per tentativo. is_current = l'ultima riuscita dell'azienda (una sola).
-- Un tentativo fallito non sostituisce mai la valutazione valida precedente.
CREATE TABLE ai_assessments (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id             uuid NOT NULL REFERENCES businesses (id),
  status                  text NOT NULL CHECK (status IN ('succeeded', 'failed')),
  is_current              boolean NOT NULL DEFAULT false,
  -- impronta di prove + configurazione + prompt + modello: uguale = la valutazione si riusa
  cache_key               text NOT NULL CHECK (length(cache_key) = 64),
  provider                text NOT NULL,
  model                   text NOT NULL,
  prompt_version          integer NOT NULL,
  config_version          integer NOT NULL REFERENCES ai_scoring_configs (version),
  -- contesto inviato al modello (prove numerate) e risposta validata
  context                 jsonb NOT NULL,
  output                  jsonb,
  components              jsonb,
  weighted_score          numeric(5, 2) CHECK (weighted_score BETWEEN 0 AND 100),
  penalties               jsonb,
  adjustments             jsonb,
  final_score             smallint CHECK (final_score BETWEEN 0 AND 100),
  band                    text,
  confidence_level        text CHECK (confidence_level IN ('high', 'medium', 'low')),
  needs_review            boolean NOT NULL DEFAULT false,
  -- esclusione dalle classifiche dei prospect: non contattare, attività cessata
  exclusion               text CHECK (exclusion IN ('do_not_contact', 'inactive')),
  input_tokens            integer,
  output_tokens           integer,
  cost_usd                numeric(10, 5),
  attempts                smallint NOT NULL DEFAULT 1,
  duration_ms             integer,
  error_code              text,
  error_message           text CHECK (length(error_message) <= 500),
  trigger                 text NOT NULL CHECK (trigger IN ('manual', 'batch')),
  requested_by            uuid REFERENCES users (id) ON DELETE SET NULL,
  created_at              timestamptz NOT NULL DEFAULT now(),
  CHECK ((status = 'succeeded') = (final_score IS NOT NULL)),
  CHECK (NOT is_current OR status = 'succeeded')
);
CREATE UNIQUE INDEX ai_assessments_current_idx ON ai_assessments (business_id) WHERE is_current;
CREATE INDEX ai_assessments_history_idx ON ai_assessments (business_id, created_at DESC);
CREATE INDEX ai_assessments_rank_idx ON ai_assessments (final_score DESC) WHERE is_current;
CREATE INDEX ai_assessments_cache_idx ON ai_assessments (business_id, cache_key) WHERE status = 'succeeded';

-- Revisione umana: valutazione segnalata come imprecisa, verificata, con nota. Solo aggiunte, tracciabili.
CREATE TABLE ai_assessment_reviews (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  assessment_id  uuid NOT NULL REFERENCES ai_assessments (id),
  business_id    uuid NOT NULL REFERENCES businesses (id),
  verdict        text NOT NULL CHECK (verdict IN ('inaccurate', 'confirmed', 'note')),
  note           text CHECK (length(note) <= 2000),
  user_id        uuid REFERENCES users (id) ON DELETE SET NULL,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ai_assessment_reviews_business_idx ON ai_assessment_reviews (business_id, created_at DESC);

-- Valutazioni in blocco, avviate esplicitamente da una persona: elenco limitato di aziende, un elemento per azienda
-- (riprendibili dopo un riavvio, con pausa e annullamento).
CREATE TABLE ai_jobs (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_by         uuid REFERENCES users (id) ON DELETE SET NULL,
  status             text NOT NULL DEFAULT 'pending'
                     CHECK (status IN ('pending', 'running', 'paused', 'completed', 'completed_with_warnings', 'failed', 'cancelled')),
  force              boolean NOT NULL DEFAULT false,
  total              integer NOT NULL CHECK (total BETWEEN 1 AND 500),
  estimated_cost_usd numeric(10, 4),
  messages           jsonb NOT NULL DEFAULT '[]'::jsonb,
  pause_requested    boolean NOT NULL DEFAULT false,
  cancel_requested   boolean NOT NULL DEFAULT false,
  pause_reason       text,
  worker_id          text,
  heartbeat_at       timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now(),
  started_at         timestamptz,
  finished_at        timestamptz,
  updated_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ai_jobs_status_idx ON ai_jobs (status, created_at);

CREATE TABLE ai_job_items (
  job_id         uuid NOT NULL REFERENCES ai_jobs (id),
  seq            integer NOT NULL,
  business_id    uuid NOT NULL REFERENCES businesses (id),
  status         text NOT NULL DEFAULT 'pending'
                 CHECK (status IN ('pending', 'running', 'assessed', 'cached', 'skipped', 'failed')),
  assessment_id  uuid REFERENCES ai_assessments (id),
  attempts       smallint NOT NULL DEFAULT 0,
  error          text CHECK (length(error) <= 500),
  finished_at    timestamptz,
  PRIMARY KEY (job_id, seq)
);
CREATE INDEX ai_job_items_pending_idx ON ai_job_items (job_id, status, seq);
