-- Esclusione dalla prospezione con motivo, divieto di contatto separato, recapiti aggiuntivi. Solo aggiunte: nessuna
-- riga esistente viene cancellata. L'esclusione resta businesses.excluded_at (già rispettata da elenchi, conteggi,
-- esportazioni, ricerche e invii); qui si aggiunge il motivo codificato.
ALTER TABLE businesses ADD COLUMN exclusion_code text CHECK (exclusion_code IN (
  'nessun_contatto', 'contatti_non_validi', 'rifiuto_commerciale', 'attivita_chiusa', 'non_pertinente', 'duplicato',
  'altro'));
-- le esclusioni già presenti avevano solo un testo libero: diventano «altro», con il testo come nota
UPDATE businesses SET exclusion_code = 'altro' WHERE excluded_at IS NOT NULL AND exclusion_code IS NULL;

-- Divieto di contatto: l'azienda ha rifiutato comunicazioni commerciali. È distinto dall'esclusione: resta anche se
-- l'azienda torna tra i potenziali clienti o viene ritrovata da una ricerca. Lo revoca solo un amministratore, con
-- un motivo registrato.
--  do_not_contact_scope  tutti = ogni canale (predefinito, il più prudente); email; telefono
ALTER TABLE businesses ADD COLUMN do_not_contact_at timestamptz;
ALTER TABLE businesses ADD COLUMN do_not_contact_scope text CHECK (do_not_contact_scope IN ('tutti', 'email', 'telefono'));
ALTER TABLE businesses ADD COLUMN do_not_contact_note text CHECK (length(do_not_contact_note) <= 300);
ALTER TABLE businesses ADD COLUMN do_not_contact_by uuid REFERENCES users (id) ON DELETE SET NULL;
ALTER TABLE businesses ADD CONSTRAINT businesses_do_not_contact_complete CHECK (
  do_not_contact_at IS NULL OR do_not_contact_scope IS NOT NULL);
CREATE INDEX businesses_do_not_contact_idx ON businesses (do_not_contact_at) WHERE do_not_contact_at IS NOT NULL;

-- recapiti aggiuntivi indicati dalla fonte: fax e altri numeri di telefono (mai dedotti)
ALTER TABLE businesses ADD COLUMN fax text CHECK (length(fax) <= 30);
ALTER TABLE businesses ADD COLUMN phones_extra text[] CHECK (cardinality(phones_extra) <= 5);
