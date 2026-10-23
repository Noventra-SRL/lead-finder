-- Parafarmacie in una categoria commerciale propria (prima erano tra i negozi). Solo l'insieme dei valori ammessi
-- cambia: la riclassificazione delle aziende classificate in automatico la fa il classificatore (versione 5) in
-- sottofondo; le categorie scelte a mano non cambiano.
ALTER TABLE businesses DROP CONSTRAINT businesses_primary_category_check;
ALTER TABLE businesses ADD CONSTRAINT businesses_primary_category_check CHECK (primary_category IN (
  'farmacie', 'parafarmacie', 'bnb_case_vacanza', 'hotel_ricettive', 'ristoranti', 'bar_caffetterie', 'pizzerie',
  'parrucchieri_barbieri', 'centri_estetici', 'palestre_fitness', 'studi_medici', 'studi_professionali', 'negozi',
  'agenzie_immobiliari', 'officine', 'altre_attivita'));
