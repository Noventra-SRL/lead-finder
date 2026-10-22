-- Fase 1 — fondamenta: utenti interni, sessioni, registro delle attività.

-- Utenti interni di Noventra. Nessuna registrazione pubblica: gli account si creano solo da riga di comando.
-- Ruoli: admin (configurazione, regole, utenti) e sales (team commerciale).
CREATE TABLE users (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email                 text NOT NULL CHECK (email = lower(email) AND length(email) BETWEEN 3 AND 254),
  display_name          text NOT NULL CHECK (length(display_name) BETWEEN 1 AND 120),
  role                  text NOT NULL CHECK (role IN ('admin', 'sales')),
  password_hash         text NOT NULL,
  -- password temporanea (creata o reimpostata da CLI): va cambiata al primo accesso
  must_change_password  boolean NOT NULL DEFAULT true,
  disabled_at           timestamptz,
  last_login_at         timestamptz,
  password_changed_at   timestamptz NOT NULL DEFAULT now(),
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX users_email_key ON users (email);

-- Sessioni: l'id è lo SHA-256 del token del cookie; il token in chiaro non viene mai salvato.
-- expires_at scorre con l'attività (inattività massima); absolute_expires_at è il limite che non si sposta.
CREATE TABLE sessions (
  id                   text PRIMARY KEY CHECK (length(id) = 64),
  user_id              uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  created_at           timestamptz NOT NULL DEFAULT now(),
  last_seen_at         timestamptz NOT NULL DEFAULT now(),
  expires_at           timestamptz NOT NULL,
  absolute_expires_at  timestamptz NOT NULL,
  user_agent           text NOT NULL DEFAULT '' CHECK (length(user_agent) <= 200)
);
CREATE INDEX sessions_user_idx ON sessions (user_id);
CREATE INDEX sessions_expires_idx ON sessions (expires_at);

-- Registro delle attività (sicurezza e, nelle fasi successive, CRM). Solo aggiunte: nessuna modifica dei record.
-- details non contiene mai password, token o segreti.
CREATE TABLE audit_log (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  occurred_at  timestamptz NOT NULL DEFAULT now(),
  user_id      uuid REFERENCES users (id) ON DELETE SET NULL,
  action       text NOT NULL CHECK (length(action) BETWEEN 1 AND 80),
  entity_type  text,
  entity_id    text,
  details      jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX audit_log_occurred_idx ON audit_log (occurred_at DESC);
CREATE INDEX audit_log_user_idx ON audit_log (user_id, occurred_at DESC);
CREATE INDEX audit_log_entity_idx ON audit_log (entity_type, entity_id);
