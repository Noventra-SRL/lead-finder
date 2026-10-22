-- Valutazione commerciale per ogni azienda: stato per azienda (impronta delle prove, coda, tentativi, lease) e
-- controllo della valutazione automatica. Solo aggiunte; il tipo di avvio «auto» si aggiunge sostituendo il vincolo.

-- Una riga per azienda, aggiornata dal server:
--  fingerprint      impronta delle prove attuali + configurazione + versione del prompt + modello (stessa formula della
--                   cache delle valutazioni): una valutazione è aggiornata solo se la sua cache_key è uguale;
--  queue_status     waiting = da valutare; running = in valutazione; done = valutazione aggiornata;
--                   failed = ultimo tentativo non riuscito (nuovo tentativo automatico entro un limite, poi a mano);
--  lease_*          chi la sta valutando e fino a quando: mai due valutazioni contemporanee della stessa azienda.
CREATE TABLE ai_business_states (
  business_id       uuid PRIMARY KEY REFERENCES businesses (id),
  fingerprint       text CHECK (length(fingerprint) = 64),
  checked_at        timestamptz,
  queue_status      text NOT NULL DEFAULT 'waiting' CHECK (queue_status IN ('waiting', 'running', 'done', 'failed')),
  attempts          integer NOT NULL DEFAULT 0,
  next_attempt_at   timestamptz,
  last_error_code   text,
  last_error        text CHECK (length(last_error) <= 500),
  lease_holder      text,
  lease_expires_at  timestamptz,
  updated_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ai_business_states_queue_idx ON ai_business_states (queue_status, next_attempt_at);
CREATE INDEX ai_business_states_checked_idx ON ai_business_states (checked_at NULLS FIRST);

-- Controllo della valutazione automatica (una sola riga): attiva o in pausa, pausa automatica per errori del fornitore.
CREATE TABLE ai_auto_control (
  id              smallint PRIMARY KEY CHECK (id = 1),
  enabled         boolean NOT NULL DEFAULT true,
  -- pausa decisa dal sistema (chiave non valida, limite di richieste): motivo e fino a quando
  paused_reason   text CHECK (length(paused_reason) <= 300),
  backoff_until   timestamptz,
  updated_by      uuid REFERENCES users (id),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
INSERT INTO ai_auto_control (id) VALUES (1);

ALTER TABLE ai_assessments DROP CONSTRAINT ai_assessments_trigger_check;
ALTER TABLE ai_assessments ADD CONSTRAINT ai_assessments_trigger_check CHECK (trigger IN ('manual', 'batch', 'auto'));
