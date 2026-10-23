-- Modelli email per categoria (Farmacube per le farmacie): la bozza registra la versione del testo ufficiale usato.
-- Solo un'aggiunta: le bozze esistenti restano sul modello standard, versione 1.
ALTER TABLE commercial_emails ADD COLUMN template_version integer NOT NULL DEFAULT 1 CHECK (template_version >= 1);
ALTER TABLE commercial_emails ADD CONSTRAINT commercial_emails_template_known
  CHECK (template_id IN ('noventra_standard', 'farmacube'));
