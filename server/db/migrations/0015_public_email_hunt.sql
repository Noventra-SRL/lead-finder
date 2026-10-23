-- Ricerca di aziende con email pubblica. Solo aggiunte e completamenti: nessuna riga cancellata, nessun recapito
-- esistente sostituito.

-- Ricerche che salvano solo attività con un recapito da controllare: sito proprio o email indicata dalla fonte.
ALTER TABLE discovery_jobs ADD COLUMN require_contact boolean NOT NULL DEFAULT false;

-- Controllo del dominio dell'email (DNS, nessun messaggio inviato):
--  mx      il dominio dichiara server di posta (record MX)
--  a_only  nessun MX ma il dominio esiste (la posta può essere consegnata all'indirizzo del dominio)
--  none    il dominio non esiste o non può ricevere posta
--  error   controllo non riuscito (rete, tempo scaduto): da ripetere
-- Un dominio valido NON prova che la casella esista né che il messaggio venga consegnato.
ALTER TABLE businesses ADD COLUMN email_domain_status text CHECK (email_domain_status IN ('mx', 'a_only', 'none', 'error'));
ALTER TABLE businesses ADD COLUMN email_domain_checked_at timestamptz;
-- l'indirizzo a cui si riferisce il controllo: se il recapito cambia, il controllo non vale più
ALTER TABLE businesses ADD COLUMN email_domain_checked_for text CHECK (length(email_domain_checked_for) <= 254);

-- Email indicate dalla fonte della scoperta dopo la migrazione 0013 erano salvate senza provenienza: la provenienza
-- è la scheda della fonte principale (es. il nodo OpenStreetMap), con la data in cui l'azienda è stata trovata.
UPDATE businesses b SET email_source = 'osm', email_status = COALESCE(b.email_status, 'da_verificare'),
       email_source_url = COALESCE(b.email_source_url, s.source_url), email_found_at = COALESCE(b.email_found_at, b.first_seen_at)
  FROM business_sources s
 WHERE s.business_id = b.id AND s.is_primary AND s.provider = 'osm' AND b.email IS NOT NULL AND b.email_source IS NULL;
-- email già attribuite alla fonte (migrazione 0013) senza la pagina della scheda
UPDATE businesses b SET email_source_url = s.source_url
  FROM business_sources s
 WHERE s.business_id = b.id AND s.is_primary AND s.provider = 'osm' AND b.email_source = 'osm'
   AND b.email_source_url IS NULL;

CREATE INDEX businesses_email_domain_pending_idx ON businesses (email_domain_checked_at) WHERE email IS NOT NULL;
