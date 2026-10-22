-- Fase 7 — CRM commerciale: opportunità, attività, follow-up.
-- Solo aggiunte: nessuna tabella o colonna esistente cambia. Un'opportunità fa sempre riferimento a un'azienda
-- esistente (businesses): i dati dell'azienda non vengono copiati.

-- Fasi della pipeline (server/crm/model.ts). Chiuse: vinto, perso, non_contattare.
-- Al massimo un'opportunità aperta per azienda (indice parziale); le chiuse restano come storico e si possono
-- riaprire, oppure si può crearne una nuova, solo se l'azienda non ne ha già una aperta.
CREATE TABLE crm_opportunities (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id            uuid NOT NULL REFERENCES businesses (id),
  stage                  text NOT NULL DEFAULT 'da_qualificare'
                         CHECK (stage IN ('da_qualificare', 'da_contattare', 'primo_contatto', 'in_attesa', 'interessato',
                                          'appuntamento', 'preventivo', 'negoziazione', 'vinto', 'perso', 'non_contattare')),
  -- priorità commerciale decisa da una persona: distinta dal punteggio del lead (Fase 4) e dalla corrispondenza dei servizi (Fase 5)
  priority               text NOT NULL DEFAULT 'media' CHECK (priority IN ('alta', 'media', 'bassa')),
  owner_id               uuid REFERENCES users (id) ON DELETE SET NULL,
  -- valore stimato in centesimi di euro (facoltativo, mai calcolato dal sistema)
  estimated_value_cents  bigint CHECK (estimated_value_cents BETWEEN 0 AND 100000000000),
  notes                  text CHECK (length(notes) <= 5000),
  lost_reason            text CHECK (length(lost_reason) BETWEEN 1 AND 500),
  closed_at              timestamptz,
  last_activity_at       timestamptz NOT NULL DEFAULT now(),
  created_by             uuid REFERENCES users (id) ON DELETE SET NULL,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  CHECK (stage <> 'perso' OR lost_reason IS NOT NULL),
  CHECK ((stage IN ('vinto', 'perso', 'non_contattare')) = (closed_at IS NOT NULL))
);
CREATE UNIQUE INDEX crm_opportunities_one_open_idx ON crm_opportunities (business_id)
  WHERE stage NOT IN ('vinto', 'perso', 'non_contattare');
CREATE INDEX crm_opportunities_business_idx ON crm_opportunities (business_id, created_at DESC);
CREATE INDEX crm_opportunities_stage_idx ON crm_opportunities (stage, last_activity_at DESC);
CREATE INDEX crm_opportunities_owner_idx ON crm_opportunities (owner_id) WHERE owner_id IS NOT NULL;

-- Servizi proposti, scelti dal catalogo attivo di Noventra (Fase 5).
CREATE TABLE crm_opportunity_services (
  opportunity_id  uuid NOT NULL REFERENCES crm_opportunities (id),
  service_id      text NOT NULL CHECK (service_id ~ '^[a-z][a-z0-9_]{1,40}$'),
  added_at        timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (opportunity_id, service_id)
);

-- Cronologia commerciale: attività registrate da una persona e cambi di fase. Nessuna attività automatica inventata.
CREATE TABLE crm_activities (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  opportunity_id  uuid NOT NULL REFERENCES crm_opportunities (id),
  type            text NOT NULL CHECK (type IN ('call', 'contact_attempt', 'conversation', 'meeting', 'follow_up',
                                                'proposal', 'note', 'stage_change')),
  occurred_at     timestamptz NOT NULL,
  summary         text NOT NULL CHECK (length(summary) BETWEEN 1 AND 300),
  notes           text CHECK (length(notes) <= 5000),
  from_stage      text,
  to_stage        text,
  user_id         uuid REFERENCES users (id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  edited_by       uuid REFERENCES users (id) ON DELETE SET NULL,
  CHECK ((type = 'stage_change') = (to_stage IS NOT NULL))
);
CREATE INDEX crm_activities_opportunity_idx ON crm_activities (opportunity_id, occurred_at DESC);

-- Follow-up: prossime azioni con scadenza (data, ora facoltativa, ora italiana).
-- La "prossima azione" di un'opportunità è il follow-up in attesa con la scadenza più vicina.
CREATE TABLE crm_followups (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  opportunity_id  uuid NOT NULL REFERENCES crm_opportunities (id),
  description     text NOT NULL CHECK (length(description) BETWEEN 1 AND 300),
  due_date        date NOT NULL,
  due_time        time,
  notes           text CHECK (length(notes) <= 2000),
  status          text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'completed', 'cancelled')),
  completed_at    timestamptz,
  completed_by    uuid REFERENCES users (id) ON DELETE SET NULL,
  cancelled_at    timestamptz,
  created_by      uuid REFERENCES users (id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CHECK ((status = 'completed') = (completed_at IS NOT NULL)),
  CHECK ((status = 'cancelled') = (cancelled_at IS NOT NULL))
);
CREATE INDEX crm_followups_due_idx ON crm_followups (status, due_date, due_time);
CREATE INDEX crm_followups_opportunity_idx ON crm_followups (opportunity_id, status, due_date);
