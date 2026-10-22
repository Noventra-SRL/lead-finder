-- Fase 8 — flusso commerciale: priorità e motivo di annullamento dei follow-up, promemoria nell'applicazione,
-- filtri salvati. Solo aggiunte: i follow-up esistenti diventano priorità "media"; quelli annullati alla chiusura di
-- un'opportunità (Fase 7) sono riconosciuti dalla cronologia e marcati come tali.

ALTER TABLE crm_followups ADD COLUMN priority text NOT NULL DEFAULT 'media' CHECK (priority IN ('alta', 'media', 'bassa'));
-- perché è stato annullato: da una persona, oppure per la chiusura dell'opportunità (vinto, perso, non contattare)
ALTER TABLE crm_followups ADD COLUMN cancel_reason text CHECK (cancel_reason IN ('manual', 'opportunity_closed'));
UPDATE crm_followups f SET cancel_reason = CASE WHEN o.stage IN ('vinto', 'perso', 'non_contattare') THEN 'opportunity_closed' ELSE 'manual' END
  FROM crm_opportunities o WHERE o.id = f.opportunity_id AND f.status = 'cancelled';
ALTER TABLE crm_followups ADD CHECK ((status = 'cancelled') = (cancel_reason IS NOT NULL));
CREATE INDEX crm_followups_pending_due_idx ON crm_followups (due_date, due_time) WHERE status = 'pending';
CREATE INDEX crm_opportunities_updated_idx ON crm_opportunities (updated_at DESC);
CREATE INDEX crm_opportunities_closed_idx ON crm_opportunities (closed_at DESC) WHERE closed_at IS NOT NULL;

-- Promemoria nell'applicazione: uno per (utente, tipo, follow-up, scadenza), così lo stesso evento non si ripete;
-- un follow-up spostato a un'altra data è un evento nuovo.
-- resolved_at: il follow-up non è più in attesa, è stato spostato, oppure "in scadenza" è superato da "scaduto".
CREATE TABLE notifications (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        uuid NOT NULL REFERENCES users (id),
  kind           text NOT NULL CHECK (kind IN ('followup_due_soon', 'followup_overdue')),
  followup_id    uuid NOT NULL REFERENCES crm_followups (id),
  opportunity_id uuid NOT NULL REFERENCES crm_opportunities (id),
  due_date       date NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  read_at        timestamptz,
  resolved_at    timestamptz,
  UNIQUE (user_id, kind, followup_id, due_date)
);
CREATE INDEX notifications_user_idx ON notifications (user_id, created_at DESC) WHERE resolved_at IS NULL;

-- Filtri salvati: i CRITERI (parametri della ricerca), non un elenco congelato di aziende.
CREATE TABLE saved_filters (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users (id),
  scope       text NOT NULL CHECK (scope IN ('businesses', 'opportunities', 'followups')),
  name        text NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  query       text NOT NULL CHECK (length(query) <= 2000),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX saved_filters_name_idx ON saved_filters (user_id, scope, lower(name));
