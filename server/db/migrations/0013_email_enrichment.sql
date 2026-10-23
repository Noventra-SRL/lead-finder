-- Arricchimento email dai siti e scoperta con più fornitori (OpenStreetMap, Google Places). Solo aggiunte: nessuna
-- tabella o riga esistente viene cancellata; le email già presenti restano e ricevono solo la loro provenienza.

-- Email scritte sulle pagine di un sito (lette dall'audit): una riga per indirizzo e sito, mai cancellata. Se un
-- controllo successivo non lo trova più, la riga resta con l'ultima data in cui era presente (last_seen_at).
--  relation  same_domain = dominio del sito; free_provider = casella gratuita (gmail, libero…); pec = posta
--            certificata (non è un recapito commerciale); other_domain = altro dominio (es. chi ha realizzato il sito)
--  via       mailto = link mailto:; text = scritto nel testo della pagina
CREATE TABLE website_emails (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  website_id      uuid NOT NULL REFERENCES websites (id),
  email           text NOT NULL CHECK (length(email) BETWEEN 6 AND 120),
  relation        text NOT NULL CHECK (relation IN ('same_domain', 'free_provider', 'pec', 'other_domain')),
  via             text NOT NULL CHECK (via IN ('mailto', 'text')),
  page_url        text NOT NULL CHECK (length(page_url) <= 600),
  first_seen_at   timestamptz NOT NULL,
  last_seen_at    timestamptz NOT NULL,
  last_audit_id   uuid REFERENCES website_audits (id),
  UNIQUE (website_id, email)
);
CREATE INDEX website_emails_website_idx ON website_emails (website_id);

-- quando le pagine del sito sono state controllate per le email (NULL = mai, anche se il sito era già stato verificato
-- prima di questa funzione) e quante pagine sono state lette in quell'occasione
ALTER TABLE websites ADD COLUMN emails_checked_at timestamptz;
ALTER TABLE websites ADD COLUMN emails_pages_checked smallint;

-- recapito email dell'azienda (businesses.email): da dove viene e quanto è affidabile.
--  email_source  osm = indicato dalla fonte della scoperta; website = scritto sul sito dell'azienda; manuale = inserito
--                da una persona
--  email_status  pubblicata = scritto su una pagina del sito dell'azienda; da_verificare = plausibile ma senza quella
--                prova; verificata = confermato con una verifica affidabile (mai per la sola presenza sul sito)
ALTER TABLE businesses ADD COLUMN email_source text CHECK (email_source IN ('osm', 'website', 'manuale'));
ALTER TABLE businesses ADD COLUMN email_status text CHECK (email_status IN ('pubblicata', 'verificata', 'da_verificare'));
ALTER TABLE businesses ADD COLUMN email_source_url text CHECK (length(email_source_url) <= 600);
ALTER TABLE businesses ADD COLUMN email_found_at timestamptz;
UPDATE businesses SET email_source = 'osm', email_status = 'da_verificare', email_found_at = first_seen_at
 WHERE email IS NOT NULL AND email_source IS NULL;

-- fornitore della ricerca di lead (le ricerche esistenti sono tutte OpenStreetMap)
ALTER TABLE hunt_runs ADD COLUMN provider text NOT NULL DEFAULT 'osm' CHECK (provider IN ('osm', 'google'));

-- richieste ai fornitori a pagamento per giorno (limite di spesa giornaliero, es. GOOGLE_PLACES_DAILY_LIMIT)
CREATE TABLE provider_usage (
  provider  text NOT NULL,
  day       date NOT NULL,
  requests  integer NOT NULL DEFAULT 0 CHECK (requests >= 0),
  PRIMARY KEY (provider, day)
);
