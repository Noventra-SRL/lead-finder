-- Modifica manuale della scheda azienda. Solo aggiunte: nessuna riga cancellata, nessun dato esistente cambiato.
--  contact_name / contact_role  referente o titolare, se noto (inserito da una persona)
--  notes                        note interne sull'azienda
--  operating_status             stato dell'attività indicato da una persona (NULL = non verificato)
--  edited_fields                campi corretti a mano: una nuova lettura della fonte non li sovrascrive
ALTER TABLE businesses ADD COLUMN contact_name text CHECK (length(contact_name) <= 120);
ALTER TABLE businesses ADD COLUMN contact_role text CHECK (length(contact_role) <= 80);
ALTER TABLE businesses ADD COLUMN notes text CHECK (length(notes) <= 5000);
ALTER TABLE businesses ADD COLUMN operating_status text CHECK (operating_status IN (
  'attiva', 'chiusa_temporaneamente', 'chiusa_definitivamente'));
ALTER TABLE businesses ADD COLUMN edited_fields text[] NOT NULL DEFAULT '{}';
ALTER TABLE businesses ADD COLUMN edited_at timestamptz;
ALTER TABLE businesses ADD COLUMN edited_by uuid REFERENCES users (id) ON DELETE SET NULL;
