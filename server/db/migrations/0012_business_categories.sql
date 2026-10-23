-- Categorie commerciali di «Trova aziende»: una categoria principale per ogni azienda, scelta tra un insieme
-- controllato (server/categories/catalog.ts), con lo stato e la prova della classificazione. Solo aggiunte: la
-- categoria interna della scoperta (category) e il settore del Lead Hunter (sector) restano come sono.
--
--  primary_category   identificativo canonico; NULL finché la classificazione non è stata eseguita
--  category_status    classificata = prova sufficiente; da_verificare = prova debole o assente (una persona decide)
--  category_source    automatica = dalle regole (si aggiorna con nuove prove o nuove regole); manuale = scelta da una
--                     persona (nessun ricalcolo automatico la sovrascrive)
--  category_evidence  da dove viene la categoria, es. «OpenStreetMap: amenity=pharmacy»
--  category_version   versione delle regole che l'ha calcolata: una versione nuova riclassifica solo le automatiche
ALTER TABLE businesses ADD COLUMN primary_category text CHECK (primary_category IN (
  'farmacie', 'bnb_case_vacanza', 'hotel_ricettive', 'ristoranti', 'bar_caffetterie', 'pizzerie',
  'parrucchieri_barbieri', 'centri_estetici', 'palestre_fitness', 'studi_medici', 'studi_professionali', 'negozi',
  'agenzie_immobiliari', 'officine', 'altre_attivita'));
ALTER TABLE businesses ADD COLUMN category_status text CHECK (category_status IN ('classificata', 'da_verificare'));
ALTER TABLE businesses ADD COLUMN category_source text CHECK (category_source IN ('automatica', 'manuale'));
ALTER TABLE businesses ADD COLUMN category_evidence text CHECK (length(category_evidence) <= 300);
ALTER TABLE businesses ADD COLUMN category_version smallint;
ALTER TABLE businesses ADD COLUMN category_updated_at timestamptz;
ALTER TABLE businesses ADD CONSTRAINT businesses_category_complete CHECK (
  primary_category IS NULL OR (category_status IS NOT NULL AND category_source IS NOT NULL));

CREATE INDEX businesses_primary_category_idx ON businesses (primary_category) WHERE merged_into IS NULL;
-- aziende ancora da classificare o calcolate con regole precedenti (ripresa della classificazione)
CREATE INDEX businesses_category_pending_idx ON businesses (category_version NULLS FIRST)
  WHERE merged_into IS NULL AND (category_source IS NULL OR category_source = 'automatica');

-- ricerca avviata da una categoria di «Trova aziende» (facoltativa: le ricerche per settori restano come sono)
ALTER TABLE hunt_runs ADD COLUMN category text CHECK (category ~ '^[a-z][a-z_]{1,40}$');
