-- Integrazione da Harvey — sequenze di follow-up e risposte lette dalla casella (IMAP). Solo aggiunte.

-- Sequenze: il primo messaggio è il passo 1; i follow-up (passi 2 e 3) sono bozze create all'invio del passo
-- precedente, con una data prevista. Nessun invio automatico: ogni passo richiede la stessa conferma esplicita.
ALTER TABLE commercial_emails ADD COLUMN sequence_root_id uuid REFERENCES commercial_emails (id);
ALTER TABLE commercial_emails ADD COLUMN sequence_step smallint NOT NULL DEFAULT 1 CHECK (sequence_step BETWEEN 1 AND 3);
ALTER TABLE commercial_emails ADD COLUMN due_at timestamptz;
ALTER TABLE commercial_emails ADD CONSTRAINT commercial_emails_sequence_check
  CHECK ((sequence_step = 1) = (sequence_root_id IS NULL));
CREATE UNIQUE INDEX commercial_emails_sequence_step_idx ON commercial_emails (sequence_root_id, sequence_step)
  WHERE sequence_root_id IS NOT NULL;
-- rimbalzo ricevuto per questo messaggio: l'indirizzo non va più usato
ALTER TABLE commercial_emails ADD COLUMN bounced_at timestamptz;
-- risposta a un messaggio ricevuto (Message-ID): l'invio usa In-Reply-To per restare nello stesso thread
ALTER TABLE commercial_emails ADD COLUMN reply_to_message_id text CHECK (length(reply_to_message_id) <= 500);

-- Risposte: solo i messaggi della casella collegati a un'email commerciale inviata (stesso thread o stesso
-- indirizzo). La posta non collegata non viene salvata.
CREATE TABLE commercial_email_replies (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email_id           uuid NOT NULL REFERENCES commercial_emails (id),
  business_id        uuid NOT NULL REFERENCES businesses (id),
  -- Message-ID del messaggio ricevuto: lo stesso messaggio letto due volte non crea doppioni
  message_id         text NOT NULL UNIQUE CHECK (length(message_id) <= 500),
  from_address       text NOT NULL CHECK (length(from_address) <= 254),
  subject            text NOT NULL CHECK (length(subject) <= 300),
  -- testo senza le parti citate, accorciato: serve alla persona che risponde
  body               text NOT NULL CHECK (length(body) <= 5000),
  received_at        timestamptz NOT NULL,
  kind               text NOT NULL CHECK (kind IN ('reply', 'auto_reply', 'bounce')),
  category           text NOT NULL CHECK (category IN ('interessato', 'domanda', 'obiezione', 'non_interessato',
                                                     'fuori_ufficio', 'persona_sbagliata', 'disiscrizione',
                                                     'rimbalzo', 'altro')),
  -- chi ha deciso la categoria: regole del codice o AI
  classified_by      text NOT NULL CHECK (classified_by IN ('rules', 'ai')),
  summary            text CHECK (length(summary) <= 500),
  -- bozza di risposta proposta dall'AI: non viene mai inviata da sola
  suggested_reply    text CHECK (length(suggested_reply) <= 3000),
  handled_at         timestamptz,
  handled_by         uuid REFERENCES users (id),
  created_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX commercial_email_replies_business_idx ON commercial_email_replies (business_id, received_at DESC);
CREATE INDEX commercial_email_replies_open_idx ON commercial_email_replies (received_at DESC) WHERE handled_at IS NULL;

-- Stato della lettura della casella: ultimo UID letto per cartella (UIDVALIDITY cambiato = si riparte).
CREATE TABLE email_inbox_state (
  mailbox       text PRIMARY KEY,
  uid_validity  bigint NOT NULL,
  last_uid      bigint NOT NULL,
  last_run_at   timestamptz NOT NULL DEFAULT now(),
  last_error    text CHECK (length(last_error) <= 500)
);

ALTER TABLE crm_activities DROP CONSTRAINT crm_activities_type_check;
ALTER TABLE crm_activities ADD CONSTRAINT crm_activities_type_check
  CHECK (type IN ('call', 'contact_attempt', 'conversation', 'meeting', 'follow_up', 'proposal', 'note', 'stage_change',
                  'email_sent', 'email_reply'));
