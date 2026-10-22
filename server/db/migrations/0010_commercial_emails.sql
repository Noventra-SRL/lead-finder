-- Fase 9 — email commerciali: bozze, revisioni, tentativi di invio. Solo aggiunte; il tipo di attività del CRM
-- «email_sent» si aggiunge sostituendo il vincolo con uno più ampio (nessuna riga esistente cambia).

CREATE TABLE commercial_emails (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id              uuid NOT NULL REFERENCES businesses (id),
  opportunity_id           uuid REFERENCES crm_opportunities (id),
  -- chiave scelta dall'interfaccia alla creazione: ripetere la richiesta (ricarica, doppio clic) non crea doppioni
  create_request_id        uuid UNIQUE,
  recipient                text CHECK (length(recipient) <= 254),
  -- da dove viene l'indirizzo: fonte pubblica (OpenStreetMap) o inserito a mano; nessuno dei due è verificato
  recipient_source         text CHECK (recipient_source IN ('public_source', 'manual')),
  subject                  text NOT NULL CHECK (length(subject) <= 200),
  body                     text NOT NULL CHECK (length(body) <= 20000),
  template_id              text NOT NULL DEFAULT 'noventra_standard',
  mode                     text NOT NULL CHECK (mode IN ('standard', 'ai')),
  objective                text NOT NULL,
  tone                     text NOT NULL,
  service_id               text CHECK (service_id ~ '^[a-z][a-z0-9_]{1,40}$'),
  instructions             text CHECK (length(instructions) <= 1000),
  -- prove usate dalla generazione e note interne (fatti, deduzioni, incognite): MAI nel testo dell'email
  evidence                 jsonb NOT NULL DEFAULT '[]',
  internal_notes           jsonb,
  ai_model                 text,
  generated_at             timestamptz,
  -- il testo è stato modificato da una persona dopo l'ultima generazione: rigenerare richiede conferma
  edited_after_generation  boolean NOT NULL DEFAULT false,
  status                   text NOT NULL DEFAULT 'draft'
                           CHECK (status IN ('draft', 'review', 'ready', 'sending', 'sent', 'failed', 'archived')),
  -- stato prima dell'archiviazione (per il ripristino)
  archived_from            text,
  version                  integer NOT NULL DEFAULT 1,
  created_by               uuid NOT NULL REFERENCES users (id),
  updated_by               uuid REFERENCES users (id),
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now(),
  sending_started_at       timestamptz,
  -- «inviata» = accettata dal server di posta (SMTP 250): non prova la consegna nella casella del destinatario
  sent_at                  timestamptz,
  sent_by                  uuid REFERENCES users (id),
  sent_from                text,
  provider_message_id      text CHECK (length(provider_message_id) <= 500),
  last_error               text CHECK (length(last_error) <= 500),
  -- l'ultimo tentativo è fallito dopo l'invio del testo: il server potrebbe averlo accettato
  failure_uncertain        boolean NOT NULL DEFAULT false,
  CHECK ((status = 'sent') = (sent_at IS NOT NULL)),
  CHECK ((status = 'archived') = (archived_from IS NOT NULL))
);
CREATE INDEX commercial_emails_business_idx ON commercial_emails (business_id, updated_at DESC);
CREATE INDEX commercial_emails_opportunity_idx ON commercial_emails (opportunity_id, updated_at DESC)
  WHERE opportunity_id IS NOT NULL;
CREATE INDEX commercial_emails_status_idx ON commercial_emails (status, updated_at DESC);
CREATE INDEX commercial_emails_sent_idx ON commercial_emails (business_id, sent_at DESC) WHERE sent_at IS NOT NULL;

-- Revisioni: ogni testo generato o salvato; rigenerare non perde mai una versione precedente.
CREATE TABLE commercial_email_revisions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email_id    uuid NOT NULL REFERENCES commercial_emails (id),
  version     integer NOT NULL,
  subject     text NOT NULL,
  body        text NOT NULL,
  source      text NOT NULL CHECK (source IN ('template', 'ai', 'user')),
  created_by  uuid REFERENCES users (id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (email_id, version)
);

-- Tentativi di invio: uno per conferma (request_id scelto dall'interfaccia: la stessa conferma non invia due volte).
CREATE TABLE commercial_email_attempts (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email_id             uuid NOT NULL REFERENCES commercial_emails (id),
  request_id           uuid NOT NULL UNIQUE,
  user_id              uuid NOT NULL REFERENCES users (id),
  recipient            text NOT NULL,
  started_at           timestamptz NOT NULL DEFAULT now(),
  finished_at          timestamptz,
  outcome              text NOT NULL DEFAULT 'pending' CHECK (outcome IN ('pending', 'accepted', 'failed', 'uncertain')),
  provider_message_id  text,
  error                text CHECK (length(error) <= 500)
);
CREATE INDEX commercial_email_attempts_email_idx ON commercial_email_attempts (email_id, started_at DESC);

ALTER TABLE crm_activities DROP CONSTRAINT crm_activities_type_check;
ALTER TABLE crm_activities ADD CONSTRAINT crm_activities_type_check
  CHECK (type IN ('call', 'contact_attempt', 'conversation', 'meeting', 'follow_up', 'proposal', 'note', 'stage_change',
                  'email_sent'));
ALTER TABLE crm_activities ADD COLUMN email_id uuid REFERENCES commercial_emails (id);
