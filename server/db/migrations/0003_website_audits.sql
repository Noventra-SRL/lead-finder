-- Fase 3 — audit dei siti web: siti, collegamento aziende → sito, storico degli audit, pagine, rilievi, prestazioni,
-- job di audit. Gli audit non si sovrascrivono: ogni esecuzione è una riga nuova; il sito punta all'ultima.

-- Siti da analizzare. La chiave (host senza "www." + percorso) riconosce lo stesso sito scritto in modi diversi:
-- più aziende con lo stesso sito condividono gli stessi audit.
CREATE TABLE websites (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  site_key         text NOT NULL UNIQUE CHECK (length(site_key) BETWEEN 3 AND 600),
  url              text NOT NULL CHECK (length(url) <= 600),
  host             text NOT NULL,
  status           text NOT NULL DEFAULT 'not_checked'
                   CHECK (status IN ('not_checked', 'valid', 'redirected', 'unreachable', 'timeout', 'blocked', 'invalid_url', 'audit_failed')),
  status_reason    text,
  final_url        text,
  last_audit_id    uuid,
  last_checked_at  timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

-- Collegamento azienda → sito. website_id è NULL quando la fonte non indica un sito proprio ('not_found') o l'indirizzo
-- non è valido ('invalid_url'); in quel caso lo stato è qui, altrimenti è quello del sito.
CREATE TABLE business_websites (
  business_id   uuid PRIMARY KEY REFERENCES businesses (id),
  website_id    uuid REFERENCES websites (id),
  original_url  text,
  status        text CHECK (status IN ('not_found', 'invalid_url')),
  status_reason text,
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CHECK ((website_id IS NULL) = (status IS NOT NULL))
);
CREATE INDEX business_websites_website_idx ON business_websites (website_id);

-- Job di audit (stessa architettura dei job di scoperta: stati, battito, pausa, ripresa dopo un riavvio).
CREATE TABLE audit_jobs (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_by        uuid REFERENCES users (id) ON DELETE SET NULL,
  status            text NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending', 'running', 'paused', 'completed', 'completed_with_warnings', 'failed', 'cancelled')),
  settings          jsonb NOT NULL,
  config_key        text NOT NULL,
  -- ripetere l'audit anche se ce n'è uno recente con la stessa configurazione
  force             boolean NOT NULL DEFAULT false,
  items_total       integer NOT NULL DEFAULT 0,
  items_done        integer NOT NULL DEFAULT 0,
  items_failed      integer NOT NULL DEFAULT 0,
  items_skipped     integer NOT NULL DEFAULT 0,
  messages          jsonb NOT NULL DEFAULT '[]'::jsonb,
  cancel_requested  boolean NOT NULL DEFAULT false,
  pause_requested   boolean NOT NULL DEFAULT false,
  pause_reason      text,
  worker_id         text,
  heartbeat_at      timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  started_at        timestamptz,
  finished_at       timestamptz,
  updated_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_jobs_status_idx ON audit_jobs (status, created_at);
CREATE INDEX audit_jobs_created_idx ON audit_jobs (created_at DESC);

-- Esecuzioni dell'audit di un sito (storico completo).
CREATE TABLE website_audits (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  website_id        uuid NOT NULL REFERENCES websites (id),
  business_id       uuid REFERENCES businesses (id),
  job_id            uuid REFERENCES audit_jobs (id) ON DELETE SET NULL,
  run_status        text NOT NULL CHECK (run_status IN ('completed', 'partial', 'failed')),
  website_status    text NOT NULL
                    CHECK (website_status IN ('valid', 'redirected', 'unreachable', 'timeout', 'blocked', 'invalid_url', 'audit_failed')),
  original_url      text NOT NULL,
  final_url         text,
  audit_version     integer NOT NULL,
  config_key        text NOT NULL,
  settings          jsonb NOT NULL,
  summary           jsonb NOT NULL DEFAULT '{}'::jsonb,
  limitations       jsonb NOT NULL DEFAULT '[]'::jsonb,
  error             text,
  pages_inspected   integer NOT NULL DEFAULT 0,
  findings_count    integer NOT NULL DEFAULT 0,
  actionable_count  integer NOT NULL DEFAULT 0,
  started_at        timestamptz NOT NULL,
  finished_at       timestamptz NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX website_audits_website_idx ON website_audits (website_id, created_at DESC);
CREATE INDEX website_audits_job_idx ON website_audits (job_id);
ALTER TABLE websites ADD CONSTRAINT websites_last_audit_fk FOREIGN KEY (last_audit_id) REFERENCES website_audits (id);

-- Pagine esaminate in un audit, con le misure oggettive (nessun recapito personale).
CREATE TABLE website_audit_pages (
  audit_id       uuid NOT NULL REFERENCES website_audits (id) ON DELETE CASCADE,
  seq            integer NOT NULL,
  role           text NOT NULL CHECK (role IN ('home', 'extra')),
  requested_url  text NOT NULL,
  final_url      text NOT NULL,
  status_code    integer,
  content_type   text,
  bytes          integer NOT NULL DEFAULT 0,
  truncated      boolean NOT NULL DEFAULT false,
  ttfb_ms        integer,
  total_ms       integer,
  redirects      jsonb NOT NULL DEFAULT '[]'::jsonb,
  headers        jsonb NOT NULL DEFAULT '{}'::jsonb,
  tls            jsonb,
  measurements   jsonb,
  error          jsonb,
  PRIMARY KEY (audit_id, seq)
);

-- Rilievi: un solo rilievo per codice e pagina in ogni audit.
CREATE TABLE audit_findings (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  audit_id     uuid NOT NULL REFERENCES website_audits (id) ON DELETE CASCADE,
  code         text NOT NULL CHECK (code ~ '^[A-Z][A-Z0-9_]{2,60}$'),
  category     text NOT NULL CHECK (category IN ('availability', 'security', 'seo', 'mobile', 'performance', 'content', 'industry')),
  severity     text NOT NULL CHECK (severity IN ('info', 'low', 'medium', 'high')),
  observation  text NOT NULL CHECK (observation IN ('missing', 'problem', 'not_inspected', 'info')),
  title        text NOT NULL,
  explanation  text NOT NULL,
  evidence     jsonb NOT NULL DEFAULT '{}'::jsonb,
  page_url     text NOT NULL DEFAULT '',
  confidence   text NOT NULL CHECK (confidence IN ('high', 'medium', 'low')),
  actionable   boolean NOT NULL,
  remediation  text NOT NULL,
  service      text,
  detected_at  timestamptz NOT NULL,
  UNIQUE (audit_id, code, page_url)
);
CREATE INDEX audit_findings_code_idx ON audit_findings (code);
CREATE INDEX audit_findings_category_idx ON audit_findings (audit_id, category, severity);

-- Risultati del fornitore di prestazioni (facoltativo), per strategia.
CREATE TABLE audit_performance (
  id                  bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  audit_id            uuid NOT NULL REFERENCES website_audits (id) ON DELETE CASCADE,
  provider            text NOT NULL,
  strategy            text NOT NULL CHECK (strategy IN ('mobile', 'desktop')),
  status              text NOT NULL CHECK (status IN ('ok', 'error')),
  url                 text NOT NULL,
  analyzed_at         timestamptz NOT NULL,
  lighthouse_version  text,
  lab                 jsonb,
  field               jsonb,
  error_kind          text,
  error_message       text,
  UNIQUE (audit_id, provider, strategy)
);

-- Aziende di un job di audit. Una stessa azienda non può essere in coda due volte con la stessa configurazione.
CREATE TABLE audit_job_items (
  job_id       uuid NOT NULL REFERENCES audit_jobs (id) ON DELETE CASCADE,
  seq          integer NOT NULL,
  business_id  uuid NOT NULL REFERENCES businesses (id),
  config_key   text NOT NULL,
  status       text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'running', 'done', 'skipped', 'failed', 'cancelled')),
  attempts     integer NOT NULL DEFAULT 0,
  audit_id     uuid REFERENCES website_audits (id),
  -- esito leggibile: stato del sito, motivo dello scarto o dell'errore
  outcome      text,
  error        text,
  started_at   timestamptz,
  finished_at  timestamptz,
  PRIMARY KEY (job_id, seq),
  UNIQUE (job_id, business_id)
);
CREATE UNIQUE INDEX audit_job_items_active_key ON audit_job_items (business_id, config_key) WHERE status IN ('pending', 'running');
CREATE INDEX audit_job_items_business_idx ON audit_job_items (business_id);
