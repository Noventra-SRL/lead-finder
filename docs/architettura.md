# Architettura di Lead Finder

Documento tecnico, aggiornato alla **Fase 5 (Abbinamento ai servizi)**. Va tenuto allineato al codice a ogni fase.
I moduli sono descritti in dettaglio in [scoperta.md](scoperta.md), [audit.md](audit.md), [punteggio.md](punteggio.md) e [servizi.md](servizi.md); le rotte in [api.md](api.md).

## Panoramica

Un solo servizio Node serve l'API (`/api/*`) e, in produzione, l'interfaccia compilata (`dist/`) dalla stessa origine.
Nessun microservizio, nessuna coda esterna: i lavori lunghi (ricerche di aziende, audit dei siti, ricalcoli dei
punteggi) sono righe di PostgreSQL elaborate dal processo stesso (`server/discovery/worker.ts`,
`server/audit/worker.ts`, `server/scoring/jobs.ts`), riprendibili dopo un riavvio. Il punteggio si calcola in locale,
senza servizi esterni. Il Lead Hunter (`server/hunter/worker.ts`) non esegue lavoro proprio: crea e coordina job di
scoperta e di audit verso un obiettivo, un passo idempotente alla volta.

```
Browser ──HTTPS──▶ Node (server/index.ts)
                    ├─ /api/*  → router (server/http/app.ts) → rotte → PostgreSQL
                    └─ altro   → dist/ (index.html per le pagine dell'app), CSP stretta
```

## Scelte tecniche

| Area        | Scelta                                                                    | Perché                                                                                                            |
| ----------- | ------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Runtime     | Node ≥ 24, TypeScript eseguito direttamente                               | nessun passaggio di compilazione per il server; `erasableSyntaxOnly` garantisce che il codice sia eseguibile così |
| HTTP        | `node:http` con router minimo                                             | poche rotte, controllo completo su sicurezza ed errori, zero dipendenze                                           |
| Validazione | zod 4                                                                     | variabili d'ambiente, corpi e parametri delle richieste con messaggi per campo                                    |
| Database    | PostgreSQL (`pg`) in produzione, PGlite in sviluppo e test                | stesso motore SQL ovunque; sviluppo senza installazioni; test isolati in memoria                                  |
| Migrazioni  | file SQL versionati + checksum                                            | leggibili, revisionabili; un file già applicato non si può modificare                                             |
| Password    | Argon2id (`@node-rs/argon2`)                                              | raccomandazione OWASP, binari precompilati                                                                        |
| Interfaccia | React 19, React Router 8, Vite 8                                          | richiesto; nessuna libreria di componenti: design system proprio in CSS                                           |
| Font        | IBM Plex Sans / Condensed / Mono (`@fontsource`)                          | serviti dalla stessa origine (CSP), nessuna richiesta a terzi                                                     |
| Test        | Vitest (unità, integrazione, processi reali), Playwright + axe-core (e2e) | stessa suite su PGlite e su PostgreSQL reale; e2e sul programma reale con CSP di produzione                       |
| Qualità     | ESLint 10 + typescript-eslint, Prettier                                   | **TypeScript è fermo alla 6.0**: typescript-eslint non supporta ancora la 7                                       |

### Dipendenze

Esecuzione: `react`, `react-dom`, `react-router`, `zod`, `pg`, `@electric-sql/pglite`, `@node-rs/argon2`, `parse5`
(lettura dell'HTML dei siti, conforme allo standard, senza eseguire script), tre pacchetti `@fontsource`.
Sviluppo: `typescript`, `vite`, `@vitejs/plugin-react`, `vitest`, `@playwright/test`, `@axe-core/playwright`, `eslint` e plugin, `prettier`, tipi.
Opzionale (solo test): `@embedded-postgres/windows-x64`, binari ufficiali di PostgreSQL 18 per `npm run test:postgres`
su Windows. È una dipendenza opzionale perché è legata alla piattaforma: su Linux/macOS npm la ignora (in produzione
si può installare con `npm ci --omit=optional`). Il suo script di installazione è bloccato da npm ed è superfluo
su Windows (ricrea solo collegamenti simbolici, la cui lista è vuota).

## Database

Schema della Fase 1 (`server/db/migrations/0001_foundation.sql`):

- `users`: utenti interni; email in minuscolo e univoca; ruoli `admin` e `sales`; `must_change_password` per le password temporanee; disattivazione senza cancellazione.
- `sessions`: id = SHA-256 del token del cookie (il token non viene mai salvato); scadenza per inattività (`expires_at`) e limite assoluto (`absolute_expires_at`).
- `audit_log`: registro delle attività, solo in aggiunta; userà anche il CRM. Mai password o token nei dettagli.

Schema della Fase 2 (`0002_discovery.sql`): `businesses` (anagrafica con codici ISTAT, indicatori di completezza,
`merged_into` per le unioni), `business_sources` (provenienza, univoca per fornitore e identificativo),
`duplicate_candidates` (coppie da revisionare), `discovery_jobs` e `discovery_job_units` (ricerche e loro
avanzamento), `provider_cache` (risultati normalizzati con scadenza).

Schema della Fase 6 (`0006_lead_hunter.sql`): `businesses` riceve settore, recapiti pubblici (telefono, email solo
generica, tipo di email indicata) ed esclusione dalla prospezione (data, motivo, utente); `hunt_runs` (ricerche di
lead: obiettivo, area, settori, criteri, piano delle province, cursore, job correnti, messaggi, pausa/annullamento,
battito) e `hunt_run_businesses` (aziende collegate a una ricerca, con "nuova o già presente"); `discovery_jobs` e
`audit_jobs` ricevono `hunt_run_id`, `discovery_jobs` anche settori e limite per settore. Solo aggiunte.

Schema della Fase 7 (`0007_crm.sql`): `crm_opportunities` (riferimento all'azienda, fase, priorità, responsabile,
valore in centesimi, note, chiusura; indice unico parziale: una sola opportunità aperta per azienda),
`crm_opportunity_services`, `crm_activities` (cronologia), `crm_followups` (scadenze). Dettagli in [crm.md](crm.md).

Valutazione commerciale con AI (`0008_ai_assessment.sql`): `ai_scoring_configs` (pesi, penalità, fasce versionati),
`ai_assessments` (una riga per tentativo: contesto inviato, risposta validata, componenti, penalità, punteggio, costo;
`is_current` = ultima riuscita), `ai_assessment_reviews` (revisioni umane), `ai_jobs` e `ai_job_items` (lotti
riprendibili). Il modello valuta, il server calcola: vedi [valutazione-ai.md](valutazione-ai.md).

Schema della Fase 8 (`0009_workflow.sql`): `crm_followups` riceve `priority` e `cancel_reason` (`manual` o
`opportunity_closed`, vincolo: presente solo se annullato); indici per i follow-up in attesa per scadenza e per le
opportunità aggiornate e chiuse; `notifications` (promemoria, univoci per utente, tipo, follow-up e scadenza) e
`saved_filters` (criteri per utente ed elenco, nome unico senza distinzione di maiuscole). Solo aggiunte. I promemoria
sono aggiornati da `server/workflow/reminders.ts` (`ReminderWorker`, ogni 5 minuti nel processo): vedi
[flusso-commerciale.md](flusso-commerciale.md).

Schema della Fase 9 (`0010_commercial_emails.sql`): `commercial_emails` (azienda, opportunità, destinatario e sua
origine, oggetto, testo, modalità, obiettivo, tono, prove e note interne, stato, versione, esito dell'invio),
`commercial_email_revisions` (ogni testo generato o salvato), `commercial_email_attempts` (un tentativo per conferma,
`request_id` univoco); `crm_activities` riceve il tipo `email_sent` e `email_id`. L'invio usa `server/email/sender.ts`
(adattatore SMTP con nodemailer): vedi [email-commerciali.md](email-commerciali.md).

Regole delle migrazioni: nomi `NNNN_descrizione.sql`, ognuna in una transazione con lock consultivo, checksum registrato.
Non esistono migrazioni "down" e un test vieta `DROP TABLE`/`DROP COLUMN`. Il server non migra da solo: all'avvio
verifica che lo schema sia aggiornato e altrimenti si ferma. La lettura dello stato (avvio, sonda di prontezza,
dashboard) è in sola lettura: solo `db:migrate` crea la tabella `schema_migrations`.
Requisito: PostgreSQL 13 o successivo (`gen_random_uuid()` nel nucleo); verificato su PostgreSQL 18.4.

**PGlite:** un solo processo per cartella dei dati. `server/db/client.ts` crea un file di blocco `<cartella>.lock`
con il PID; un secondo processo riceve un errore esplicito invece di corrompere il database.

## Autenticazione e autorizzazione

- Nessuna registrazione pubblica: gli account si creano solo con `npm run user -- crea`, con password temporanea
  (20 caratteri casuali) mostrata una volta e da cambiare al primo accesso. Finché non viene cambiata, il server
  accetta solo profilo, cambio password e uscita (`403 PASSWORD_CHANGE_REQUIRED`).
- Password nuove: almeno 12 caratteri, non un solo carattere ripetuto, non contenenti la parte locale dell'email.
- Cookie `nlf_session`: HttpOnly, `SameSite=Strict`, `Path=/api`, `Secure` in produzione. Nessun token in JavaScript o localStorage.
- Sessioni: 12 ore di inattività (rinnovo al più una volta al minuto), 7 giorni al massimo; uscita e cambio
  password le chiudono sul server; disattivare un utente chiude tutte le sue sessioni.
- Errori di accesso identici per email inesistente e password errata, con verifica Argon2 fittizia (tempi uguali).
- Limiti di tentativi: 30 richieste di accesso per IP in 15 minuti; 6 errori per email in 15 minuti; 10 cambi password per utente.
- Ogni rotta richiede una sessione salvo dichiarazione esplicita (`access: 'public'`); un test verifica che le rotte
  pubbliche siano solo `GET /api/health`, `GET /api/health/ready`, `GET /api/auth/session`, `POST /api/auth/login`.
  Le rotte `access: 'admin'` sono riservate agli amministratori.
- `GET /api/auth/session` risponde sempre 200 (`{ user }` o `{ user: null, expired? }`): all'apertura dell'app un
  visitatore non autenticato non genera errori nel browser; un cookie non più valido viene cancellato e l'interfaccia
  mostra "La sessione è scaduta".

## Protezioni HTTP

- Richieste che modificano dati: solo dall'origine dell'app (`Origin` o `Sec-Fetch-Site: same-origin`), solo JSON, massimo 64 KB.
- Nessuna intestazione CORS. `Cache-Control: no-store`, `nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer` su ogni risposta API.
- Pagine: Content-Security-Policy senza script o stili inline né risorse esterne. Per questo Vite è configurato con
  `assetsInlineLimit: 0` (niente `data:` URI) e l'interfaccia non usa attributi `style`.
- Errori uniformi `{ error: { code, message, fields? }, requestId }`: mai stack, SQL o dettagli interni al client.
  Il `requestId` collega l'errore visto dall'utente alla riga del registro.
- In produzione `Strict-Transport-Security: max-age=31536000` su pagine e API (non in sviluppo, che è su http).
- File statici: nessun percorso può uscire da `dist/` (anche con `..` codificati); un file con estensione inesistente
  dà 404 e non la pagina dell'app; tutto ciò che sta sotto `/api` risponde sempre l'API (JSON).
- Timeout HTTP: 15 s per le intestazioni, 30 s per la richiesta; 15 s per singola query su PostgreSQL.

## Registro

`server/logger.ts`: JSON su una riga in produzione, testo leggibile in sviluppo. Ogni richiesta registra metodo,
percorso, stato, durata, id della richiesta e id dell'utente. I campi con nomi sensibili (password, token, cookie,
segreti, `DATABASE_URL`, id di sessione) sono oscurati a qualsiasi profondità; gli errori sono ridotti a nome,
messaggio e codice. ESLint vieta `console` nel server, tranne nelle CLI.

## Test

- `npm test` (PGlite): configurazione, registro, migrazioni (ordine, checksum, atomicità, concorrenza, sola lettura
  dello stato), vincoli dello schema, persistenza su disco e blocco tra processi, utenti, accesso, sessioni, protezione
  delle rotte, CSRF, limiti, errori, salute, intestazioni di produzione, file statici, formattazione. Più il
  **programma reale** (`server/process.test.ts`): CLI `db:*` e `user` e `server/index.ts` avviati come processi
  (configurazione non valida, schema non migrato, avvio, accesso, blocco del secondo processo, riavvio con dati intatti).
- `npm run test:postgres`: la stessa suite su un **vero PostgreSQL** con il driver `pg` di produzione; ogni file di
  test ha un database dedicato, eliminato alla fine. Il test dei processi avvia il server in **modalità produzione**
  (`DATABASE_URL`, `APP_ORIGIN` https, cookie `Secure`, HSTS, registro JSON). Senza `TEST_DATABASE_URL` il cluster
  di prova è creato con `initdb`/`pg_ctl` in una cartella temporanea solo su 127.0.0.1 e arrestato in modo pulito.
- `npm run test:e2e`: `npm run build` e poi il server reale (`e2e/start.ts` → `server/index.ts`) con interfaccia
  compilata, CSP di produzione e database PGlite `.data/e2e` ricreato a ogni esecuzione; Chrome di sistema, desktop
  e mobile. Ogni flusso fallisce se il browser registra errori (comprese violazioni della CSP e risposte HTTP ≥ 400
  non previste) e ogni schermata è verificata con axe-core (WCAG 2.1 A e AA).

## Limiti noti

- I limiti di tentativi sono in memoria: con più istanze del server serve il limite del proxy o un archivio condiviso.
- Gli utenti si gestiscono solo da riga di comando; nell'interfaccia gli amministratori li vedono in sola lettura.
- Nessun recupero password via email (nessun servizio email configurato, per scelta): la reimposta l'amministratore.
- Su Windows non esiste un arresto "gentile" di un processo dall'esterno: `npm run dev:api` (modalità `--watch`)
  riavvia il server terminandolo. Per PGlite equivale a un'interruzione improvvisa, da cui PostgreSQL si riprende
  con il registro delle transazioni (verificato), ma per fermare l'API a mano usa sempre Ctrl+C.
- Distribuzione, backup e ripristino (provati): [rilascio.md](rilascio.md).
- Promemoria solo nell'applicazione (nessuna email, SMS o notifica del browser); il loro aggiornamento periodico gira
  nel processo: con più istanze lasciare `REMINDERS_WORKER=on` in una sola.
- Email commerciali: «Inviata» = accettata dal server SMTP, non consegnata; nessun tracciamento, nessun invio massivo
  o automatico. Senza credenziali SMTP e senza `EMAIL_SENDER_AUTHORIZED=si` l'invio resta disattivato.
- Esportazioni: al massimo 10.000 righe per file e 1.000 aziende selezionate; i file sono prodotti in memoria.
- Scoperta: le ricerche sono eseguite da un solo processo alla volta per job; con più istanze dell'API l'intervallo
  minimo tra le richieste vale per istanza: lasciare `DISCOVERY_WORKER=on` in una sola.
- Scoperta: le istanze Overpass pubbliche sono spesso sature e non garantiscono capacità; un server lento o
  sovraccarico può restituire risultati incompleti senza segnalarlo (vedi scoperta.md). Per l'uso regolare serve
  un'istanza propria.
- Scoperta: la copertura di OpenStreetMap varia per categoria e territorio; studi professionali e industrie sono
  poco rappresentati. La ricerca per testo nel database usa `LIKE` (adeguata a decine di migliaia di righe).
- Audit: nessun JavaScript eseguito e indicatori mobile solo statici; i limiti di ritmo per sito valgono per processo
  (lasciare `AUDIT_WORKER=on` in una sola istanza). Dettagli in [audit.md](audit.md#limiti-noti).
- Punteggio: euristica configurabile, non validata statisticamente su esiti commerciali; l'assenza di un sito non è
  confermabile con le fonti attuali. Dettagli in [punteggio.md](punteggio.md#limiti-noti).
- Abbinamento ai servizi: regole configurabili, non validate su esiti commerciali; i servizi senza prove automatiche
  (app, AI, marketing, pubblicità) sono solo a colloquio. Dettagli in [servizi.md](servizi.md#limiti-noti).
- Lead Hunter: una ricerca di lead attiva alla volta, coordinata da un solo processo (`HUNTER_WORKER=on` in una sola
  istanza); i tempi dipendono dal server Overpass e dal ritmo dell'audit. L'obiettivo può non essere raggiunto se la
  fonte non contiene abbastanza aziende: viene dichiarato. Dettagli in [lead-hunter.md](lead-hunter.md).
