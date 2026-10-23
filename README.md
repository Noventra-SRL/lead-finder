# Noventra Lead Finder

Piattaforma interna di Noventra per trovare, analizzare e qualificare potenziali clienti B2B in Italia, con un CRM integrato.
Priorità: evidenze verificabili, fonti aperte e tracciate, costi bassi, contatto deciso sempre da una persona.

Lo sviluppo procede per fasi verificate e approvate una alla volta. **Stato attuale: Fase 10 — qualità, sicurezza e preparazione al rilascio.**

| Fase | Modulo                                                | Stato                              |
| ---- | ----------------------------------------------------- | ---------------------------------- |
| 1    | Fondamenta (accesso, database, layout)                | completata                         |
| 2    | Scoperta aziende                                      | completata                         |
| 3    | Audit dei siti web                                    | completata                         |
| 4    | Punteggio dei lead                                    | completata                         |
| 5    | Abbinamento ai servizi                                | completata                         |
| 6    | Lead Hunter (ricerca per obiettivo, recapiti, export) | completata                         |
| 7    | CRM commerciale e pipeline di vendita                 | completata                         |
| 8    | Esportazioni, follow-up, promemoria, filtri, report   | completata                         |
| 9    | Email commerciali (modello, AI, invio confermato)     | completata                         |
| 10   | Qualità, sicurezza e preparazione al rilascio         | completata (vedi docs/rilascio.md) |

Nell'interfaccia i moduli non ancora sviluppati lo dichiarano apertamente: nessun dato dimostrativo, nessun controllo finto.

### Navigazione

Il menu ha quattro voci sotto «Principale»: **Dashboard** (`/`), **Trova aziende** (`/trova`), **Email commerciali**
(`/email`) e **Impostazioni** (`/impostazioni`). Il lavoro quotidiano è: trovare un'azienda, aprire il messaggio già
pronto con «Invia email», confermare e inviare (docs/email-commerciali.md, «Invio rapido»). In «Trova aziende» le
aziende sono organizzate per categoria (Farmacie, B&B e case vacanza, Ristoranti, Bar e caffetterie…), con i conteggi
reali e la ricerca di nuove aziende per categoria (docs/categorie.md).

La **Dashboard** mostra quattro numeri reali (aziende trovate, pronte da contattare, email inviate, in attesa di
risposta, ciascuno collegato alla lista corrispondente) e la tabella «Migliori prospect da contattare»: ricerca, città,
categoria, ordinamento e «Altri filtri» sono applicati dal server e restano nell'indirizzo della pagina; dalla riga si
apre il composer («Invia email»), la scheda («Dettagli») o «Gestisci contatto». Le aziende escluse o da non contattare
non compaiono.

Le altre sezioni restano con le stesse pagine, gli stessi indirizzi e gli stessi dati, raggiungibili dalle pagine e da
Impostazioni → «Strumenti avanzati»: Nuova ricerca di aziende (`/lead-hunter`, `/scoperta`), Database aziende
(`/aziende`), Trattative (`/pipeline`), Promemoria (`/promemoria`), Analisi dei siti web (`/audit`), Valutazione dei
potenziali clienti (`/analisi-ai`), Servizi Noventra (`/servizi`), Risultati e report (`/report`).

## Requisiti

- **Node.js 24 o successivo** (sviluppato con Node 26). Il server è TypeScript eseguito direttamente da Node, senza compilazione.
- **PostgreSQL 13 o successivo** solo in produzione (verificato con PostgreSQL 18). In sviluppo si usa PostgreSQL
  incorporato ([PGlite](https://pglite.dev)): nessuna installazione richiesta.
- Per i test end-to-end: **Google Chrome** installato (Playwright usa il Chrome di sistema, non scarica browser).
- Per `npm run test:postgres` su Windows x64 i binari ufficiali di PostgreSQL arrivano con `npm install`
  (dipendenza opzionale `@embedded-postgres/windows-x64`, ignorata sulle altre piattaforme). Altrove: imposta
  `TEST_DATABASE_URL` verso un PostgreSQL di prova (utente che può creare database) oppure installa il pacchetto
  dei binari della piattaforma con `npm install --no-save @embedded-postgres/<piattaforma>-<arch>`.

## Installazione

```bash
npm install
cp .env.example .env          # su Windows: copy .env.example .env
npm run db:migrate            # crea lo schema in .data/pglite
npm run user -- crea --email nome@noventra.it --nome "Nome Cognome" --ruolo admin
```

L'ultimo comando stampa **una sola volta** una password temporanea: al primo accesso l'app chiede di sostituirla.

Per la ricerca di aziende imposta in `.env` un server OpenStreetMap (Overpass API), ad esempio:

```bash
DISCOVERY_OVERPASS_URL=https://lz4.overpass-api.de/api/interpreter
DISCOVERY_CONTACT=https://www.noventra.it
```

Senza questa variabile l'app funziona, ma la ricerca è disattivata e lo dice chiaramente. Le istanze pubbliche sono
condivise e spesso sature: per un uso regolare serve un'istanza propria. Dettagli in [docs/scoperta.md](docs/scoperta.md).

## Sviluppo

Due terminali:

```bash
npm run dev:api    # API su http://127.0.0.1:8810 (si riavvia a ogni modifica di server/)
npm run dev        # interfaccia su http://localhost:5210 (inoltra /api all'API)
```

Apri http://localhost:5210.

> **PGlite accetta un solo processo alla volta.** Con l'API avviata, i comandi `db:*` e `user` si rifiutano di aprire il
> database (messaggio esplicito). Ferma l'API con **Ctrl+C** — mai terminando il processo con forza — e riprova.

### Comandi

| Comando                     | Cosa fa                                                                                                                                                             |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm run dev` / `dev:api`   | interfaccia (Vite) / API con riavvio automatico                                                                                                                     |
| `npm run build`             | controllo dei tipi e compilazione dell'interfaccia in `dist/`                                                                                                       |
| `npm run start:api`         | avvia il server; se esiste `dist/` serve anche l'interfaccia (un solo processo)                                                                                     |
| `npm run db:status`         | migrazioni applicate e da applicare                                                                                                                                 |
| `npm run db:migrate`        | applica le migrazioni mancanti                                                                                                                                      |
| `npm run user -- <comando>` | gestione utenti: `crea`, `elenco`, `reimposta`, `disattiva`, `riattiva`, `ruolo`                                                                                    |
| `npm run typecheck`         | TypeScript su interfaccia e server                                                                                                                                  |
| `npm run lint` / `format`   | ESLint / Prettier                                                                                                                                                   |
| `npm test`                  | test unitari, di integrazione e del programma reale (CLI e server) su PGlite                                                                                        |
| `npm run test:postgres`     | la stessa suite su un vero PostgreSQL con il driver di produzione; server avviato in modalità produzione                                                            |
| `npm run test:e2e`          | compila l'interfaccia e avvia il server reale (porta 8811, database `.data/e2e`); Playwright + Chrome, controlli di accessibilità (axe) e di errori/CSP nel browser |
| `npm run check`             | tipi + lint + formattazione + test (PGlite e PostgreSQL)                                                                                                            |
| `npm run test:live`         | facoltativo: due richieste piccole a un server Overpass reale (`LIVE_OVERPASS_URL=… npm run test:live`)                                                             |
| `npm run geo:update`        | rigenera `server/geo/istat.json` dall'elenco ufficiale ISTAT dei comuni                                                                                             |

Esempi di gestione utenti:

```bash
npm run user -- elenco
npm run user -- crea --email anna@noventra.it --nome "Anna Bianchi"            # ruolo predefinito: sales
npm run user -- reimposta --email anna@noventra.it   # nuova password temporanea, chiude le sue sessioni
npm run user -- disattiva --email anna@noventra.it   # blocca l'accesso e chiude le sessioni
npm run user -- ruolo --email anna@noventra.it --ruolo admin
```

L'ultimo amministratore attivo non può essere disattivato né declassato.

## Variabili d'ambiente

Tutte sono validate all'avvio: un valore non valido ferma il server con un messaggio che nomina la variabile (mai il valore).
L'elenco commentato è in [`.env.example`](.env.example).

| Variabile               | Predefinito           | Note                                                                                                                      |
| ----------------------- | --------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `NODE_ENV`              | (sviluppo)            | `production` in produzione, **impostata nell'ambiente del servizio, non in `.env`** (Vite la leggerebbe)                  |
| `DATABASE_URL`          | —                     | obbligatoria in produzione (`postgres://…`); se vuota in sviluppo → PGlite                                                |
| `DATABASE_SSL`          | —                     | `require` per TLS verificato verso un PostgreSQL gestito                                                                  |
| `PGLITE_DATA_DIR`       | `.data/pglite`        | solo sviluppo                                                                                                             |
| `API_HOST` / `API_PORT` | `127.0.0.1` / `8810`  |                                                                                                                           |
| `APP_ORIGIN`            | —                     | obbligatoria e `https://` in produzione: unica origine ammessa per le modifiche                                           |
| `TRUST_PROXY`           | —                     | `1` solo dietro un proxy affidabile (IP da `X-Forwarded-For`)                                                             |
| `LOG_LEVEL`             | `debug` / `info`      | `debug`, `info`, `warn`, `error`                                                                                          |
| `SESSION_IDLE_HOURS`    | `12`                  | inattività massima prima della disconnessione                                                                             |
| `SESSION_MAX_DAYS`      | `7`                   | durata massima assoluta di una sessione                                                                                   |
| `DISCOVERY_*`           | vedi docs/scoperta.md | server Overpass, recapito, intervallo tra richieste, tentativi, limiti per ricerca, cache, esecuzione                     |
| `AUDIT_*`               | vedi docs/audit.md    | pagine per sito, tempi, dimensioni, porte, ritmo per sito, parallelismo, ripetizioni, esecuzione                          |
| `SCORING_WORKER`        | `on`                  | ricalcoli dei punteggi in background in questo processo (pesi e fasce: Impostazioni, non variabili)                       |
| `PAGESPEED_API_KEY`     | —                     | facoltativa: misure PageSpeed Insights; resta sul server, mai esposta                                                     |
| `HUNTER_WORKER`         | `on`                  | coordinatore delle ricerche di lead in questo processo (vedi docs/lead-hunter.md)                                         |
| `REMINDERS_WORKER`      | `on`                  | aggiornamento dei promemoria dei follow-up ogni 5 minuti in questo processo (docs/flusso-commerciale.md)                  |
| `SMTP_*`, `EMAIL_*`     | —                     | invio delle email commerciali: server SMTP, mittente, autorizzazione (docs/email-commerciali.md)                          |
| `AI_API_KEY`            | —                     | facoltativa: valutazione commerciale con AI (Anthropic); resta sul server. Altre `AI_*` in docs/valutazione-ai.md         |
| `GOOGLE_PLACES_API_KEY` | —                     | facoltativa: ricerca con Google Maps (Places API New); resta sul server. Altre `GOOGLE_PLACES_*` in docs/google-places.md |
| `AI_AUTO_ASSESS`        | `on`                  | valutazione automatica di ogni azienda; `AI_AUTO_DAILY_LIMIT` (500) limita le valutazioni nelle 24 ore                    |

## Salute del servizio

- `GET /api/health` — il processo risponde (per il supervisore).
- `GET /api/health/ready` — database raggiungibile e schema aggiornato; altrimenti `503`.
- Dashboard → sezione _Sistema_: latenza del database, migrazioni, versione, utenti e sessioni (utenti autenticati).

## Documentazione

- [docs/rilascio.md](docs/rilascio.md) — produzione, variabili, integrazioni, backup e ripristino, controlli, sicurezza, limiti.
- [docs/architettura.md](docs/architettura.md) — struttura, scelte tecniche, dipendenze, sicurezza, limiti noti.
- [docs/scoperta.md](docs/scoperta.md) — scoperta di aziende: fornitore, regole d'uso, categorie, deduplica, job, licenze.
- [docs/lead-hunter.md](docs/lead-hunter.md) — Lead Hunter: ricerca per obiettivo, settori, recapiti, esportazione CSV, esclusione, privacy.
- [docs/categorie.md](docs/categorie.md) — categorie di «Trova aziende»: catalogo, classificazione con le prove, conteggi, ricerca per categoria.
- [docs/google-places.md](docs/google-places.md) — Google Maps (Places API): configurazione, costi, condizioni d'uso, deduplica; email dai siti e contattabilità.
- [docs/crm.md](docs/crm.md) — CRM: opportunità, pipeline e regole, attività, follow-up, numeri della dashboard.
- [docs/flusso-commerciale.md](docs/flusso-commerciale.md) — esportazioni CSV/Excel, follow-up, promemoria, filtri salvati, report commerciali.
- [docs/email-commerciali.md](docs/email-commerciali.md) — email commerciali: modello ufficiale, personalizzazione AI, bozze, invio SMTP confermato, CRM.
- [docs/valutazione-ai.md](docs/valutazione-ai.md) — valutazione commerciale con AI: fornitore, costi, formula, penalità, affidabilità, cache, lotti.
- [docs/servizi.md](docs/servizi.md) — servizi di Noventra e abbinamento: catalogo verificato, formula, stati, lista breve, revisioni.
- [docs/punteggio.md](docs/punteggio.md) — punteggio dei lead: formula, dimensioni, affidabilità, stati e fasce, configurazione.
- [docs/audit.md](docs/audit.md) — audit dei siti: protezione SSRF, comportamento verso i siti, stati, catalogo dei rilievi, PageSpeed.
- [docs/api.md](docs/api.md) — tutte le rotte dell'API.

## Struttura

```
server/            API Node (TypeScript eseguito da Node)
  config.ts        variabili d'ambiente validate (zod)
  logger.ts        registro centralizzato con oscuramento dei campi sensibili
  db/              client (pg / PGlite), migrazioni versionate, CLI
  auth/            password Argon2id, sessioni, limiti di tentativi, utenti, CLI
  http/            router, errori uniformi, rotte, file statici con CSP
  geo/             comuni, province e regioni ISTAT (dataset versionato)
  discovery/       scoperta: fornitori (osm/), deduplica, job, worker, anagrafica
  audit/           audit dei siti: richieste sicure (net/), robots, analisi HTML, rilievi, PageSpeed, job, worker
  matching/        abbinamento ai servizi: catalogo versionato, motore deterministico, revisioni
  scoring/         punteggio dei lead: configurazione versionata, motore deterministico, istantanee, ricalcoli
  jobs/            parti comuni dei job (messaggi)
src/               interfaccia React (italiano)
  styles/          design system: valori, base, componenti, layout
  components/      componenti condivisi e struttura dell'app
  pages/           pagine
e2e/               test end-to-end Playwright
scripts/           strumenti (aggiornamento del dataset ISTAT)
docs/              documentazione tecnica
```
