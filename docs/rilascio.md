# Rilascio, esercizio e ripristino

Guida per installare, avviare in produzione, aggiornare, controllare e ripristinare Noventra Lead Finder.
Nulla qui è già configurato su un server reale: sono i passi da eseguire.

## Requisiti

- Node.js 24 o successivo (sviluppato e verificato con Node 26).
- PostgreSQL 13 o successivo in produzione (verificato con PostgreSQL 18). In sviluppo basta PGlite (incorporato).
- Un proxy HTTPS davanti all'applicazione (nginx, Caddy, un bilanciatore del cloud): l'app ascolta in HTTP su
  `API_HOST:API_PORT` e in produzione richiede `APP_ORIGIN` con `https://`.
- Facoltativi ma necessari per tutte le funzioni:
  - chiave Anthropic (`AI_API_KEY`) per la valutazione commerciale e le email personalizzate;
  - un server SMTP autorizzato per il mittente (`SMTP_*`, `EMAIL_*`) per inviare le email;
  - un'istanza Overpass (`DISCOVERY_OVERPASS_URL`) per la ricerca di aziende;
  - una chiave PageSpeed (`PAGESPEED_API_KEY`) per le prestazioni dei siti.

## Sviluppo

```sh
npm install
cp .env.example .env          # poi compila i valori che servono (mai versionare .env)
npm run db:migrate            # applica le migrazioni al database di sviluppo (PGlite in .data/pglite)
npm run user -- crea --email nome@azienda.it --nome "Nome Cognome" --ruolo admin
npm run dev:api               # API su http://127.0.0.1:8810
npm run dev                   # interfaccia con Vite (ricarica automatica)
```

`npm run start:api` dopo `npm run build` serve API e interfaccia compilata dalla stessa origine (come in produzione).

## Produzione

1. **Database.** Crea un database PostgreSQL e un utente con i permessi sullo schema. Imposta `DATABASE_URL`
   (`DATABASE_SSL=require` per un PostgreSQL gestito con TLS).
2. **Ambiente del servizio** (non nel file `.env` del repository):
   - `NODE_ENV=production`;
   - `APP_ORIGIN=https://lead.esempio.it`;
   - `TRUST_PROXY=1` se il proxy imposta `X-Forwarded-For`;
   - `API_HOST=127.0.0.1` se il proxy è sulla stessa macchina;
   - le chiavi e le credenziali dei servizi esterni.

   In produzione il server si rifiuta di partire con `DATABASE_URL` assente, `APP_ORIGIN` non HTTPS o SMTP senza
   cifratura.

3. **Build:** `npm ci && npm run build` (controllo dei tipi dell'interfaccia e compilazione in `dist/`).
4. **Migrazioni:** `npm run db:migrate` prima di ogni avvio dopo un aggiornamento. Il server **non migra da solo**:
   all'avvio controlla lo schema e si ferma se mancano migrazioni. Le migrazioni sono solo aggiuntive (un test vieta
   `DROP TABLE`/`DROP COLUMN`), ognuna in una transazione con lock e checksum registrato. `npm run db:status` mostra lo
   stato.
5. **Primo amministratore:** `npm run user -- crea --email … --nome … --ruolo admin`. La password temporanea va cambiata
   al primo accesso.
6. **Avvio:** `npm run start:api` sotto un gestore di processi (systemd, pm2, il servizio del cloud) con riavvio
   automatico. Esempio di unità systemd:

   ```ini
   [Service]
   WorkingDirectory=/opt/noventra-lead-finder
   EnvironmentFile=/etc/noventra-lead-finder.env
   Environment=NODE_ENV=production
   ExecStart=/usr/bin/node server/index.ts
   Restart=on-failure
   ```

   L'arresto (SIGTERM) chiude le richieste, mette in pausa i lavori in corso e chiude il database; i lavori riprendono
   al riavvio.

7. **Sonde:** `GET /api/health` (processo vivo) e `GET /api/health/ready` (database raggiungibile, migrazioni
   applicate). Non espongono dati.
8. **Un solo processo per i lavori in background.** Con più istanze, lascia `DISCOVERY_WORKER`, `AUDIT_WORKER`,
   `HUNTER_WORKER`, `AI_WORKER` e `REMINDERS_WORKER` a `on` in una sola istanza. Ogni istanza aggiorna comunque le
   impronte delle valutazioni (gratis, idempotente).

## Variabili d'ambiente

L'elenco completo, con i valori predefiniti, è in `.env.example`; un test verifica che documenti ogni variabile letta
dal server.

| Gruppo          | Obbligatorie in produzione                                                              | Note                                                                                                                                               |
| --------------- | --------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| Base            | `NODE_ENV=production`, `DATABASE_URL`, `APP_ORIGIN` (https)                             | `API_HOST`, `API_PORT`, `TRUST_PROXY`, `LOG_LEVEL`, `SESSION_*` facoltative                                                                        |
| Ricerca aziende | `DISCOVERY_OVERPASS_URL`, `DISCOVERY_CONTACT`                                           | istanza Overpass propria consigliata; altre `DISCOVERY_*` facoltative                                                                              |
| Audit dei siti  | —                                                                                       | `AUDIT_*` facoltative; `PAGESPEED_API_KEY` per le prestazioni                                                                                      |
| Valutazione AI  | `AI_API_KEY`                                                                            | `AI_MODEL`, `AI_EFFORT`, `AI_CONCURRENCY`, `AI_AUTO_ASSESS`, `AI_AUTO_DAILY_LIMIT`, `AI_PROVIDER`, `AI_PRICE_*`                                    |
| Email           | `SMTP_HOST`, `SMTP_USER`, `SMTP_PASS` (o `SMTP_PASSWORD`), `EMAIL_SENDER_AUTHORIZED=si` | `SMTP_PORT`, `SMTP_SECURE` (o `SMTP_SECURITY`), `EMAIL_SENDER*` (o `EMAIL_FROM_*`), `EMAIL_REPLY_TO` — Google Workspace: docs/email-commerciali.md |

Variabili **solo per i test** (rifiutate fuori da `NODE_ENV=test`): `AI_TEST_BASE_URL`, `AUDIT_TEST_LOOPBACK_PORTS`.
Con `NODE_ENV=test` il server rifiuta anche SMTP non locali e chiavi AI senza il server finto: i test non possono
inviare email reali né fare chiamate a pagamento.

## Integrazioni esterne

| Servizio                 | Quando serve                                  | Cosa configurare                                                                          | Senza                                                            |
| ------------------------ | --------------------------------------------- | ----------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| OpenStreetMap / Overpass | Ricerca di aziende (Trova aziende)            | `DISCOVERY_OVERPASS_URL` (istanza propria per l'uso regolare), `DISCOVERY_CONTACT`        | Nessuna nuova azienda; il resto funziona                         |
| Anthropic (Claude)       | Valutazione commerciale, email personalizzate | `AI_API_KEY`; costi: `AI_AUTO_DAILY_LIMIT` (500 valutazioni ogni 24 ore)                  | Stati «Da valutare» e punteggio a regole come riserva dichiarata |
| SMTP del dominio         | Invio delle email commerciali                 | `SMTP_*`; SPF/DKIM del dominio per `EMAIL_FROM_ADDRESS`, poi `EMAIL_SENDER_AUTHORIZED=si` | Bozze, generazione e copia funzionano; invio disattivato         |
| Google PageSpeed         | Prestazioni nell'audit                        | `PAGESPEED_API_KEY`, `AUDIT_PAGESPEED=on`                                                 | Audit senza prestazioni (dichiarato)                             |

## Backup e ripristino

I backup contengono dati di aziende e utenti: conservali cifrati, con accesso limitato, e mai nel repository
(`backups/` è escluso).

### PostgreSQL (produzione)

```sh
# backup (formato custom, compresso): pianificalo almeno ogni notte e prima di ogni aggiornamento
pg_dump --format=custom --no-owner --file=leadfinder-$(date +%F).dump "$DATABASE_URL"

# ripristino in un database NUOVO, poi puntare DATABASE_URL al nuovo database
createdb leadfinder_ripristino
pg_restore --no-owner --dbname=leadfinder_ripristino leadfinder-AAAA-MM-GG.dump
DATABASE_URL=postgres://…/leadfinder_ripristino npm run db:status
DATABASE_URL=postgres://…/leadfinder_ripristino npm run db:check
```

### PGlite (sviluppo o installazione su una sola macchina)

```sh
npm run db:backup                     # server fermo: backups/pglite-AAAAMMGG-HHMMSS.tar.gz
npm run db:restore -- --from backups/pglite-….tar.gz --to .data/ripristino
PGLITE_DATA_DIR=.data/ripristino npm run db:check
```

Il backup rifiuta di partire con il server acceso (copia incoerente). Il ripristino crea solo una cartella nuova e
rifiuta di sovrascriverne una esistente. Il percorso completo (backup → ripristino → controllo) è stato provato sul
database di sviluppo il 22/10/2026: 1334 aziende, migrazione 0011, nessuna incoerenza.

### Aggiornamento sicuro

1. Backup.
2. `npm ci && npm run build`.
3. `npm run db:migrate`.
4. Riavvio.
5. `npm run db:check`, oppure `/api/health/ready`.

Per tornare indietro: ripristino del backup e versione precedente del codice (le migrazioni non hanno «down»).

## Controlli

| Comando            | Cosa verifica                                                                                                         |
| ------------------ | --------------------------------------------------------------------------------------------------------------------- |
| `npm run check`    | Tipi, lint, formattazione, test su PGlite e su PostgreSQL reale (binari incorporati o `TEST_DATABASE_URL`)            |
| `npm run test:e2e` | Il programma reale nel browser (Chrome di sistema) con server finti: Overpass, siti, AI, SMTP                         |
| `npm run db:check` | Controllo di integrità in sola lettura del database configurato (duplicati, riferimenti, CRM, email, lavori bloccati) |
| `npm audit`        | Vulnerabilità note delle dipendenze                                                                                   |

I test usano database dedicati: PGlite in memoria, oppure database creati ed eliminati con nome casuale. Non
toccano mai il database di sviluppo o di produzione, non inviano email reali e non fanno chiamate AI a pagamento.

## Sicurezza (riepilogo)

- **Sessioni:** cookie HttpOnly, SameSite=Strict, Secure in produzione; token salvati solo come hash. Password con
  Argon2id e limiti di tentativi.
- **Accessi:** ogni rotta richiede una sessione tranne accesso, stato della sessione e sonde (verificato su tutte le
  rotte da un test). Configurazioni riservate agli amministratori.
- **Richieste da altri siti:** origine controllata su ogni scrittura (CSRF), nessun CORS. CSP stretta, `X-Frame-Options:
DENY`, `nosniff`, HSTS in produzione.
- **SQL e interfaccia:** solo query parametrizzate o con elenchi chiusi (verificato con una scansione di tutte le query).
  React senza HTML grezzo.
- **Audit dei siti:** protezione SSRF.
  - Solo http/https.
  - Reti private, loopback, link-local e metadati cloud bloccati.
  - DNS validato alla connessione; ogni redirect ricontrollato.
  - Porte ammesse, dimensioni e tempi limitati.
- **Esportazioni:** formule neutralizzate in CSV; in XLSX il testo non è mai una formula.
- **Email:**
  - conferma esplicita;
  - «non contattare» controllato sul server;
  - una sola spedizione per conferma (`requestId`) e per email (stato atomico);
  - nessun tracciamento.
- **Segreti:** solo sul server. Il registro nasconde i campi sensibili; nessun segreto nell'interfaccia compilata
  (verificato) né nelle risposte dell'API.

## Limiti noti e rischi residui

- I limiti di tentativi sono in memoria (per istanza): con più istanze serve anche un limite sul proxy.
- Overpass pubblico: capacità non garantita, risultati a volte incompleti; serve un'istanza propria per l'uso regolare.
- La valutazione AI è un indicatore di priorità, non una probabilità validata; costi a carico della chiave configurata.
- «Inviata» significa accettata dal server SMTP, non consegnata. Nessuna gestione automatica di rimbalzi e
  disiscrizioni: una richiesta di non essere contattati va registrata a mano («Escludi dalla prospezione»).
- Le esportazioni costruiscono il file in memoria (massimo 10.000 righe per file).
- PGlite accetta un solo processo per cartella: in produzione si usa PostgreSQL.
