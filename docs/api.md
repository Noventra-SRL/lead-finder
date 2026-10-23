# API di Lead Finder

Tutte le rotte sono sotto `/api`, rispondono in JSON e non vanno mai in cache. Convenzioni:

- **Autenticazione**: cookie di sessione `nlf_session` (HttpOnly). Ogni rotta richiede una sessione valida, salvo
  quelle indicate come _pubblica_. Con una password temporanea si accede solo alle rotte segnate _(anche con password
  temporanea)_. _Solo amministratori_: ruolo `admin`.
- **Modifiche** (POST): corpo JSON (max 64 KB), solo dall'origine dell'app (`Origin` o `Sec-Fetch-Site: same-origin`).
- **Errori**: `{ "error": { "code", "message", "fields"?, "data"? }, "requestId" }` con messaggi in italiano.
  `fields` contiene un messaggio per campo (validazione); `requestId` collega l'errore al registro del server.
- **Paginazione**: `page` (da 1) e `pageSize` (1–100, predefinito 25); risposta `{ items, total, page, pageSize }`.
- Codici comuni: 400 `VALIDATION_ERROR`, 401 `UNAUTHENTICATED`/`SESSION_EXPIRED`, 403 `FORBIDDEN`/`FORBIDDEN_ORIGIN`/
  `PASSWORD_CHANGE_REQUIRED`, 404 `NOT_FOUND`, 409 conflitto di stato, 429 `RATE_LIMITED` (con `Retry-After`),
  503 `DATABASE_UNAVAILABLE`/`PROVIDER_NOT_CONFIGURED`.

## Salute e sistema

| Metodo e percorso        | Accesso             | Descrizione                                                                                     |
| ------------------------ | ------------------- | ----------------------------------------------------------------------------------------------- |
| `GET /api/health`        | pubblica            | Il processo risponde: `{ status: "ok" }`.                                                       |
| `GET /api/health/ready`  | pubblica            | Database raggiungibile e schema aggiornato: `{ status: "ready" }`, altrimenti 503 con `reason`. |
| `GET /api/system/status` | sessione            | Versione, ambiente, latenza del database, migrazioni, utenti e sessioni attive.                 |
| `GET /api/users`         | solo amministratori | Elenco degli utenti interni (sola lettura).                                                     |

## Accesso

| Metodo e percorso                       | Accesso                       | Descrizione                                                                                                                                    |
| --------------------------------------- | ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/auth/session`                 | pubblica                      | Sempre 200: `{ user }` oppure `{ user: null, expired? }`.                                                                                      |
| `POST /api/auth/login`                  | pubblica                      | `{ email, password }` → cookie di sessione e `{ user }`. 401 `INVALID_CREDENTIALS` (stesso messaggio per email inesistente e password errata). |
| `POST /api/auth/logout`                 | anche con password temporanea | Chiude la sessione sul server (204).                                                                                                           |
| `GET /api/auth/me`                      | anche con password temporanea | Utente della sessione.                                                                                                                         |
| `POST /api/auth/password`               | anche con password temporanea | `{ currentPassword, newPassword }`; chiude le altre sessioni.                                                                                  |
| `GET /api/auth/sessions`                | sessione                      | Sessioni attive dell'utente.                                                                                                                   |
| `POST /api/auth/sessions/revoke-others` | sessione                      | Chiude le altre sessioni: `{ closed }`.                                                                                                        |

## Geografia (codici ISTAT)

| Metodo e percorso                             | Descrizione                                                                                      |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `GET /api/geo/regions`                        | Regioni `{ code, name }` e fonte del dataset (ISTAT, CC BY 4.0).                                 |
| `GET /api/geo/regions/:code/provinces`        | Province, città metropolitane e unità sovracomunali della regione `{ code, name, sigla, kind }`. |
| `GET /api/geo/provinces/:code/municipalities` | Comuni `{ code, name, altName? }`.                                                               |
| `GET /api/geo/search?q=`                      | Aree per nome (2–80 caratteri, senza accenti): `{ areas: [{ type, code, name, context }] }`.     |

## Scoperta

| Metodo e percorso                                      | Descrizione                                                                                                          |
| ------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------- |
| `GET /api/discovery/meta`                              | Fornitore (`configured`, `setupHint`, host, attribuzione), categorie con copertura e note, limiti, fonte geografica. |
| `GET /api/discovery/stats`                             | Statistiche reali: aziende, con sito, duplicati da verificare, per categoria e regione, ultima ricerca.              |
| `POST /api/discovery/jobs`                             | Avvia una ricerca (201 `{ job }`). Limite: 20 creazioni/riprese all'ora per utente.                                  |
| `GET /api/discovery/jobs?status=all\|active\|finished` | Elenco delle ricerche (paginato).                                                                                    |
| `GET /api/discovery/jobs/:id`                          | `{ job, units }`: stato, avanzamento, contatori, messaggi e unità di lavoro.                                         |
| `POST /api/discovery/jobs/:id/pause`                   | In coda → in pausa; in corso → pausa richiesta (si ferma entro pochi secondi).                                       |
| `POST /api/discovery/jobs/:id/cancel`                  | Annulla (i dati già salvati restano). 409 `INVALID_STATE` se già terminata.                                          |
| `POST /api/discovery/jobs/:id/resume`                  | In pausa → in coda; con errori → ripete solo le unità non riuscite.                                                  |

Corpo di `POST /api/discovery/jobs`:

```json
{
  "area": { "type": "municipality", "code": "058003" },
  "radiusKm": 5,
  "categories": ["farmacie", "parafarmacie"],
  "maxResults": 200,
  "minCompleteness": 0,
  "requireWebsite": false
}
```

- `area.type`: `italy` (code `IT`), `region` (2 cifre), `province` (3 cifre, codice UTS), `municipality` (6 cifre).
- `radiusKm` (0,5–30) solo con un comune. `categories`: identificativi da `GET /api/discovery/meta`.
- Errori specifici: 503 `PROVIDER_NOT_CONFIGURED`, 400 `UNKNOWN_AREA`, `RADIUS_NEEDS_MUNICIPALITY`, `AREA_TOO_LARGE`,
  `TOO_MANY_RESULTS`; 409 `DUPLICATE_JOB` con `data.jobId` della ricerca identica attiva; 429 `TOO_MANY_ACTIVE_JOBS`,
  `QUEUE_FULL`, `RATE_LIMITED`.

Stati del job: `pending`, `running`, `paused` (`pauseReason`: `manual`, `interrupted`, `not_configured`), `completed`,
`completed_with_warnings`, `failed`, `cancelled`. Contatori: `discovered` (elementi restituiti dalla fonte),
`inserted`, `updated`, `unchanged`, `merged` (collegati a un'azienda esistente), `duplicatesSkipped` (ripetuti nella
stessa ricerca), `flaggedForReview`, `skippedIncomplete`, `requestsSent`, `failedRequests`.

## Anagrafica

| Metodo e percorso                              | Descrizione                                                                                                              |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `GET /api/businesses`                          | Elenco filtrato, ordinato e paginato (vedi parametri).                                                                   |
| `GET /api/businesses/:id`                      | Scheda: dati, indirizzo, posizione, fonti (con licenza e tag conservati), possibili duplicati, cronologia, `mergedInto`. |
| `GET /api/duplicates?status=pending\|resolved` | Coppie di possibili duplicati (paginato).                                                                                |
| `POST /api/duplicates/:id/merge`               | `{ keep: <id azienda> }`: unisce, mantenendo l'azienda indicata. 409 `ALREADY_RESOLVED`.                                 |
| `POST /api/duplicates/:id/distinct`            | Segna le due aziende come distinte (la coppia non verrà riproposta).                                                     |
| `POST /api/businesses/:id/exclusion`           | `{ excluded, reason? }` (motivo max 300 caratteri): esclude o reinclude l'azienda nella prospezione. → `{ business }`.   |
| `GET /api/businesses/export`                   | CSV con gli stessi filtri e ordinamento di `GET /api/businesses` (senza paginazione). Vedi sotto.                        |
| `POST /api/businesses/export`                  | `{ ids (1–1.000), format?, fields?, name? }`: aziende selezionate, escluse comprese.                                     |
| `GET /api/businesses/categories`               | Categorie commerciali con etichette e conteggi reali (stessi filtri dell'elenco): `{ all, pending, categories }`.        |
| `PUT /api/businesses/:id/category`             | `{ category }`: categoria scelta da una persona; `{ category: null }` torna alla classificazione automatica.             |

Categorie (docs/categorie.md): `GET /api/businesses` accetta anche `businessCategory` (un identificativo canonico,
oppure `pending` per le aziende non ancora classificate) e `categoryReview=1` (solo le categorie da verificare);
ordinamenti aggiuntivi `city` e `assessment` (stato della valutazione). `POST /api/hunter/runs` accetta `category` al
posto di `sectors`: i settori della ricerca sono quelli della categoria.

Google Maps ed email dai siti (docs/google-places.md):

- `POST /api/hunter/runs` accetta `provider` (`osm` predefinito, `google`); `GET /api/hunter/meta` elenca le fonti in
  `providers` (`id`, `label`, `configured`, `setupHint`), mai le chiavi.
- `GET /api/businesses` accetta `contactability` (uno o più tra `verificata`, `pubblicata`, `da_verificare`,
  `da_arricchire`, `nessuna_email`, `sito_non_accessibile`, `senza_sito`), gli ordinamenti `priority` («Priorità:
  aziende con email disponibile») e `businessCategory`; ogni azienda ha `emailInfo` (stato, provenienza, pagina, data);
  la scheda ha `websiteEmails` (indirizzi trovati sul sito, con pagina e date).
- `GET /api/businesses/categories`: i conteggi includono `published` (email pubblicata sul sito) e `toEnrich` (siti
  da controllare).
- `POST /api/enrichment/start` `{ scope: 'pending' | 'retry', filters }`: controllo in sottofondo dei siti non ancora
  controllati, o nuovo tentativo su quelli non accessibili, per le aziende dei filtri indicati (query string di
  «Trova aziende»); → `{ job, queued, alreadyQueued }` (job di audit).

Parametri di `GET /api/businesses`: `q` (nome, dominio o comune, max 100 caratteri), `region`, `province`,
`municipality` (codici ISTAT), `category` (uno o più id separati da virgola), `website` (`any`, `yes`, `own` = sito
proprio, `no`), `audit` (`unaudited` = sito proprio mai verificato, `audited`, `unavailable` = irraggiungibile,
non risponde, bloccato o URL non valido, `failed` = verifica non riuscita, `no_website`), `minCompleteness` (0–5),
`review=1` (solo con duplicati da verificare), `job` (aziende viste dall'ultima esecuzione di una ricerca), `sort`
(`name`, `municipality`, `category`, `completeness`, `verified`, `discovered`, `audited` = data dell'ultimo audit),
`dir` (`asc`, `desc`), `page`, `pageSize`. Punteggio dei lead: `priority` (uno o più tra `A`, `B`, `C`, `low` — solo
classificati — `needs_review`, `insufficient_data`, `not_suitable`, `unscored`), `minScore` (0–100), `confidence`
(`high`, `medium`, `low`), `audit=problems` (sito raggiungibile con rilievi gravi), `sort=score` o `sort=confidence`
(senza punteggio in fondo).

Ogni azienda contiene anche `lead`: `{ scoreId, status, score, band, confidence, completeness, nextStep, calculatedAt,
outdated }` oppure `null` se il punteggio non è mai stato calcolato.

Abbinamento ai servizi (Fase 5): `service` (id del servizio: solo le aziende per cui è proposto e non archiviato),
`minMatch` (0–100), `matchStatus` (uno o più tra `recommended`, `possible`, `needs_review`, `insufficient_evidence`,
`not_relevant`, `accepted_for_review`, `dismissed`), `sort=match` (corrispondenza del servizio filtrato, altrimenti la
migliore proponibile; indipendente da `sort=score`). Ogni azienda dell'elenco contiene `services: { primary, matchScore }`
(`primary`: primo servizio della lista breve con `serviceId`, `name`, `score`, `status`, `review`, `others`).

Ogni azienda (elenco e scheda) contiene `audit`: `{ websiteStatus, lastAuditAt, lastAuditId, runStatus,
actionableFindings, performanceScore }` (`performanceScore` = punteggio PageSpeed mobile 0–100 dell'ultimo audit,
`null` se non misurato). Stati del sito: vedi [audit.md](audit.md#stati).

Lead Hunter (Fase 6): `hunt` (aziende collegate a una ricerca di lead), `sector` (uno o più id del catalogo dei
settori), `excluded` (`hide` predefinito, `only`, `include`), `contact` (`phone`, `any` = telefono o email generica),
`maxPerSector` e `maxPerRegion` (1–1000: al massimo N aziende per settore o regione, scelte nell'ordinamento
richiesto; i punteggi non cambiano). Ogni azienda contiene `sector` (`{ id, label }` o `null`), `contacts`
(`{ phone, email, emailKind }`: `email` solo se generica; `emailKind: 'personal'` indica che la fonte riporta
un'email personale, non salvata) ed `excluded` (`{ at, reason }` o `null`); la scheda contiene anche `hunts`
(ricerche di lead che l'hanno raccolta).

Esportazioni (Fase 8, vedi [flusso-commerciale.md](flusso-commerciale.md#esportazioni)): parametri comuni
`format` (`csv` predefinito, `xlsx`), `fields` (id delle colonne separati da virgola, da `GET /api/exports/columns`;
400 se sconosciute), `name` (prima parte del nome del file). CSV UTF-8 con BOM, separatore `;`, righe CRLF, celle che
iniziano con `= + - @`, tabulazione o a capo precedute da `'`; al massimo 10.000 righe lette a blocchi. Header
`Content-Disposition` (`<nome>_noventra_AAAA-MM-GG.csv|xlsx`), `X-Export-Rows`, `X-Export-Truncated`. 30 esportazioni
all'ora per utente; ognuna è registrata (`leads.exported`).

## Lead Hunter

Flusso, criteri, limiti e privacy in [lead-hunter.md](lead-hunter.md).

| Metodo e percorso                        | Descrizione                                                                                                                                                                     |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/hunter/meta`                   | Settori (id, nome, gruppo, categoria, copertura, nota), gruppi, valori predefiniti, `limits.maxTarget`, stato del fornitore, `workerActive`.                                    |
| `POST /api/hunter/runs`                  | `{ target, area: { type, code }, sectors, options? }` con `options` = `{ minScore, websitePreference: any\|no_website\|website_issues, excludeKnown, audit }`. 201 → dettaglio. |
| `GET /api/hunter/runs`                   | Ricerche di lead (paginato), ciascuna con `progress`.                                                                                                                           |
| `GET /api/hunter/runs/:id`               | `{ run, progress, currentJob, distribution: { sectors, regions }, top }` (`top`: 10 migliori per punteggio, al massimo 2 per settore).                                          |
| `POST /api/hunter/runs/:id/pause`        | Pausa (dopo la richiesta in corso). 409 `INVALID_STATE` se terminata.                                                                                                           |
| `POST /api/hunter/runs/:id/resume`       | Ripresa dalla provincia corrente.                                                                                                                                               |
| `POST /api/hunter/runs/:id/cancel`       | Annullamento (anche dei job di scoperta e audit in corso); i dati raccolti restano.                                                                                             |
| `POST /api/hunter/runs/:id/retry-audits` | Rimette in coda le verifiche dei siti non riuscite. → `{ resumed, ...dettaglio }`.                                                                                              |

Errori: 409 `HUNT_ACTIVE` (una ricerca di lead è già attiva; `data.jobId` = la sua id), 400 `UNKNOWN_SECTOR`,
`UNKNOWN_AREA`, 503 `PROVIDER_NOT_CONFIGURED`. Creazioni e comandi: 30 all'ora per utente.

`progress`: `discovered`, `newBusinesses`, `alreadyKnown`, `duplicatesAvoided`, `requests`, `failedRequests`,
`failedAreas`, `linked` (aziende collegate), `linkedNew`, `excluded`, `websites` (`found`, `missing`, `verified`,
`unverified`, `unreachable`, `invalid`), `audits` (`completed`, `pending`, `failed`), `scored`, `ranked`,
`qualified` (aziende che soddisfano i criteri, conteggiate verso l'obiettivo), `remaining`, `targetReached`.

## Audit dei siti

Descrizione del modulo, stati e catalogo dei rilievi in [audit.md](audit.md).

| Metodo e percorso                                   | Descrizione                                                                                                                             |
| --------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/audits/meta`                              | Limiti, impostazioni predefinite, `performance.configured` (mai la chiave), catalogo dei rilievi e aree di servizio.                    |
| `POST /api/audits/jobs`                             | Avvia la verifica di più aziende (201 `{ job, queued, alreadyQueued }`).                                                                |
| `POST /api/businesses/:id/audit`                    | Avvia la verifica di un'azienda (stesso corpo, senza `businessIds`).                                                                    |
| `GET /api/audits/jobs?status=all\|active\|finished` | Elenco delle verifiche (paginato).                                                                                                      |
| `GET /api/audits/jobs/:id`                          | `{ job, items }`: stato, avanzamento (`total`, `done`, `failed`, `skipped`), messaggi, esito per azienda.                               |
| `POST /api/audits/jobs/:id/pause`                   | In coda → in pausa; in corso → pausa richiesta (l'azienda in esame torna in coda).                                                      |
| `POST /api/audits/jobs/:id/cancel`                  | Annulla: le aziende non verificate escono dalla coda, gli audit completati restano. 409 `INVALID_STATE` se già terminata.               |
| `POST /api/audits/jobs/:id/resume`                  | In pausa → in coda; terminata con errori → ripete solo le aziende non riuscite.                                                         |
| `GET /api/businesses/:id/audits`                    | `{ website, items, total, page, pageSize }`: sito collegato (stato, motivo, URL finale) e storico degli audit.                          |
| `GET /api/businesses/:id/audits/latest`             | Ultimo audit completo (come sotto, più `website`). 404 `NO_AUDIT` se mai verificato.                                                    |
| `GET /api/audits/:id`                               | `{ audit, businesses, findings, pages, performance }`. Filtri: `severity`, `category` (elenchi separati da virgola), `actionable=1\|0`. |

Corpo di `POST /api/audits/jobs`:

```json
{ "businessIds": ["<uuid>", "<uuid>"], "maxPages": 3, "performance": true, "force": false }
```

- `maxPages` (1–10, limitato da `AUDIT_MAX_PAGES`), `performance` (ignorato se PageSpeed non è configurato),
  `force` (ripete anche i siti verificati di recente con la stessa configurazione).
- Le aziende già in coda con la stessa configurazione in un'altra verifica non vengono accodate di nuovo
  (`alreadyQueued`); se lo sono tutte: 409 `DUPLICATE_JOB` con `data.jobId`.
- Errori specifici: 400 `TOO_MANY_BUSINESSES`; 404 `UNKNOWN_BUSINESS` (inesistente o unita a un'altra);
  429 `TOO_MANY_ACTIVE_JOBS` (3 verifiche attive per utente) e `RATE_LIMITED` (30 avvii o riprese all'ora).

Esito per azienda (`items[].status`): `pending`, `running`, `done`, `skipped` (audit recente dello stesso sito
riusato, `outcome: "recent"`), `failed` (errore interno, ripetibile), `cancelled`. `outcome` riporta lo stato del
sito (`valid`, `unreachable`, `not_found`…).

Rilievo (`findings[]`): `code`, `category` (`availability`, `security`, `seo`, `mobile`, `performance`, `content`,
`industry`), `severity` (`info`, `low`, `medium`, `high`), `observation`, `title`, `explanation`, `evidence`, `page`,
`confidence` (`low`, `medium`, `high`), `actionable`, `remediation`, `service` (area di servizio Noventra o `null`),
`detectedAt`.

## Punteggio dei lead

Modello, formula e configurazione in [punteggio.md](punteggio.md). Il punteggio è un criterio di priorità, non una
probabilità di acquisto.

| Metodo e percorso                                    | Descrizione                                                                                                                                                    |
| ---------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/scoring/config`                            | Configurazione attiva (`active`: versione, valori, autore, nota), valori iniziali, versioni precedenti, cataloghi.                                             |
| `POST /api/scoring/config/validate`                  | _Solo amministratori._ `{ config }` → `{ valid, errors }` senza salvare.                                                                                       |
| `PUT /api/scoring/config`                            | _Solo amministratori._ `{ config, note? }`: nuova versione. 400 `INVALID_CONFIG` con `fields` per percorso (es. `weights.technical`).                          |
| `GET /api/scoring/stats`                             | Punteggi attuali per stato e fascia, aziende senza punteggio, punteggi su una configurazione precedente.                                                       |
| `POST /api/businesses/:id/score`                     | Calcola il punteggio (`{ force: true }` per una nuova istantanea anche a dati invariati). → `{ created, score }`.                                              |
| `GET /api/businesses/:id/score`                      | `{ score }` attuale con `breakdown` e `outdated` (motivi per ricalcolarlo); `{ score: null }` se mai calcolato.                                                |
| `GET /api/businesses/:id/scores`                     | Storico delle istantanee (paginato, senza dettaglio).                                                                                                          |
| `GET /api/scores/:id`                                | Un'istantanea con dettaglio.                                                                                                                                   |
| `POST /api/scoring/jobs`                             | Ricalcolo in background: `{ scope: "businesses", businessIds, force? }`, oppure `{ scope: "all" }` (solo amministratori; 409 `DUPLICATE_JOB` se già in corso). |
| `GET /api/scoring/jobs`, `GET /api/scoring/jobs/:id` | Ricalcoli recenti / stato e avanzamento (`total`, `processed`, `created`, `unchanged`).                                                                        |
| `POST /api/scoring/jobs/:id/cancel`                  | Annulla (in coda: subito; in corso: al termine del lotto).                                                                                                     |

Istantanea (`score`): `status` (`ranked`, `needs_review`, `insufficient_data`, `not_suitable`), `score` (0–100 o
`null`), `rawScore`, `band` (`A`, `B`, `C`, `low` o `null`), `confidence` `{ value, level }`, `completeness`,
`explanation`, `nextStep`, `algorithmVersion`, `configVersion`, `auditId`, `trigger` (`manual`, `audit`, `discovery`,
`bulk`), `calculatedAt`, `isCurrent`; `breakdown`: `dimensions` (valore, peso, peso effettivo, contributo, base),
`confidence` e `completeness` con componenti, `signals` (`positive`, `negative`, `unknown`; ognuno `kind: fact|inference`
e riferimenti all'audit), `topFindings`, `capabilities`, `services`, `reasons`, `evidence`.

Limiti: 300 calcoli singoli ogni 15 minuti e 20 ricalcoli in blocco all'ora per utente.

## Servizi e abbinamento

Catalogo, formula, stati e revisioni in [servizi.md](servizi.md). Una corrispondenza è una possibile pertinenza da
verificare, non una domanda confermata.

| Metodo e percorso                                     | Descrizione                                                                                                                                                                                                         |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/services`                                   | Catalogo attivo (versione, pesi, soglie, lista breve) con, per servizio, quante aziende lo hanno proposto (consigliato, possibile, da verificare; archiviati esclusi).                                              |
| `GET /api/services/:id`                               | Un servizio. 404 `UNKNOWN_SERVICE`.                                                                                                                                                                                 |
| `GET /api/services/:id/businesses`                    | Aziende per cui il servizio è proposto: stessi filtri, ordinamento e paginazione di `GET /api/businesses`.                                                                                                          |
| `GET /api/service-catalog`                            | Catalogo completo (regole), valori iniziali, versioni, vocabolari (settori, capacità, rilievi, segnali).                                                                                                            |
| `POST /api/service-catalog/validate`                  | _Solo amministratori._ `{ catalog }` → `{ valid, errors }`.                                                                                                                                                         |
| `PUT /api/service-catalog`                            | _Solo amministratori._ `{ catalog, note? }`: nuova versione. 400 `INVALID_CATALOG` con `fields` per percorso.                                                                                                       |
| `GET /api/businesses/:id/services`                    | `{ catalogVersion, run, shortlist, matches, manualServices }`: lista breve (id ordinati), corrispondenze con prove, segnali, problema, spiegazione, verifica e revisione; servizi solo a colloquio; `run.outdated`. |
| `POST /api/businesses/:id/services/recalculate`       | Ricalcola punteggio e abbinamento (`{ force: true }` per un'esecuzione nuova anche a dati invariati). → come sopra più `created`.                                                                                   |
| `GET /api/businesses/:id/services/history`            | Esecuzioni precedenti con i servizi proposti (paginato).                                                                                                                                                            |
| `POST /api/businesses/:id/services/:serviceId/review` | `{ action, note? }`: `accepted_for_review`, `dismissed` (nota = motivo, facoltativo), `needs_review`, `reopened`, `note` (nota obbligatoria). Solo aggiunte.                                                        |

I ricalcoli in blocco usano `POST /api/scoring/jobs`: punteggi e abbinamenti vengono aggiornati insieme; il job riporta
`progress.matchesCreated`.

## CRM

Regole, fasi e definizioni dei numeri in [crm.md](crm.md). Tutte le rotte richiedono una sessione.

| Metodo e percorso                            | Descrizione                                                                                                                                            |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `GET /api/crm/meta`                          | Fasi (con `closed`), priorità, tipi di attività (con `manual`), responsabili (utenti attivi), servizi del catalogo attivo, `today` (ora italiana).     |
| `GET /api/crm/dashboard`                     | Conteggi per fase, follow-up di oggi/scaduti/prossimi, valore stimato della pipeline aperta e delle vinte (`euro: null` se nessun valore inserito).    |
| `GET /api/crm/opportunities`                 | Elenco paginato. Vedi parametri.                                                                                                                       |
| `GET /api/crm/board`                         | Kanban: per ogni fase `total` e le prime `perStage` (1–50, predefinito 20) opportunità; stessi filtri dell'elenco.                                     |
| `POST /api/crm/opportunities`                | `{ businessId, stage?, priority?, ownerId?, estimatedValue?, services?, notes? }` (fase iniziale solo aperta). 201 → scheda.                           |
| `POST /api/crm/opportunities/bulk`           | `{ businessIds }` (1–500) → `{ created, skipped, failed }` con il motivo di ciascuna azienda saltata o non riuscita.                                   |
| `GET /api/crm/opportunities/:id`             | `{ opportunity, activities, followUps, otherOpportunities, today }`.                                                                                   |
| `PATCH /api/crm/opportunities/:id`           | `{ priority?, ownerId?, estimatedValue?, services?, notes? }`: campi commerciali (la fase non cambia).                                                 |
| `POST /api/crm/opportunities/:id/stage`      | `{ stage, lostReason?, note? }`: cambio di fase registrato nella cronologia. → scheda più `cancelledFollowUps`.                                        |
| `POST /api/crm/opportunities/:id/activities` | `{ type, occurredAt, summary, notes? }` (tipi manuali; data non futura).                                                                               |
| `PATCH /api/crm/activities/:id`              | Modifica di un'attività manuale: solo l'autore o un amministratore (403 altrimenti); i cambi di fase non si modificano (409 `NOT_EDITABLE`).           |
| `POST /api/crm/opportunities/:id/followups`  | `{ description, dueDate (AAAA-MM-GG, non passata), dueTime? (HH:MM), notes?, priority? }`. 409 `OPPORTUNITY_CLOSED` se chiusa.                         |
| `POST /api/businesses/:id/followups`         | Come sopra più `createOpportunity?`: usa l'opportunità aperta; senza, 409 `NO_OPEN_OPPORTUNITY` (o la crea «Da qualificare» se `true`).                |
| `GET /api/crm/followups`                     | `status=pending\|completed\|cancelled\|all`, `due=overdue\|today\|soon\|later\|upcoming`, `priority`, `stage`, `owner=me\|<id>`, `business`; paginato. |
| `PATCH /api/crm/followups/:id`               | Modifica di un follow-up in attesa (una nuova data non può essere passata).                                                                            |
| `POST /api/crm/followups/:id/complete`       | `{ note? }`: completa e registra un'attività «Follow-up»; la fase non cambia.                                                                          |
| `POST /api/crm/followups/:id/cancel`         | Annulla un follow-up in attesa (`cancelReason: manual`; alla chiusura dell'opportunità `opportunity_closed`).                                          |
| `GET /api/crm/opportunities/export`          | Stessi filtri dell'elenco; `groupByStage=1` (XLSX: un foglio per fase). Parametri di esportazione comuni.                                              |
| `GET /api/crm/followups/export`              | Stessi filtri di `GET /api/crm/followups`.                                                                                                             |
| `GET /api/crm/activities/export`             | Cronologia: `from`, `to` (date italiane), `type` (uno o più), `business`.                                                                              |
| `GET /api/exports/columns`                   | Catalogo delle colonne di ogni elenco esportabile (`id`, `label`, `default`) e `limit`.                                                                |

Parametri di `GET /api/crm/opportunities` e `GET /api/crm/board`: tutti i filtri sull'azienda di `GET /api/businesses`
(`q`, territorio, `sector`, `category`, `minScore`, `priority` = fascia del punteggio, `website`, `audit`, `service`…;
qui le aziende escluse sono incluse per impostazione predefinita), più `stage` (una o più fasi), `crmPriority`,
`owner` (`me`, `none` o id), `followUp` (`overdue`, `today`, `upcoming`, `none`), `state` (`open` predefinito,
`closed`, `all`), `sort` (`activity`, `due`, `score`, `created`, `value`, `stage`, `name`), `dir`, `page`, `pageSize`.

Errori: 404 `NOT_FOUND`, `BUSINESS_NOT_FOUND`; 409 `OPPORTUNITY_EXISTS` (`data.opportunityId`), `BUSINESS_EXCLUDED`,
`BUSINESS_MERGED` (`data.mergedInto`), `SAME_STAGE`, `NOT_PENDING`, `OPPORTUNITY_CLOSED`, `NOT_EDITABLE`;
400 `VALIDATION_ERROR`, `LOST_REASON_REQUIRED`, `DATE_IN_PAST`, `UNKNOWN_SERVICE`, `UNKNOWN_OWNER`; 403 `FORBIDDEN`.

`GET /api/businesses` e la scheda contengono `crm` (`{ opportunityId, stage, open }` o `null`) e accettano il filtro
`crm` (`none` = senza opportunità aperta, `open`, `any`).

## Flusso commerciale (Fase 8)

Definizioni in [flusso-commerciale.md](flusso-commerciale.md). Tutte le rotte richiedono una sessione; promemoria e
filtri salvati sono personali (quelli di altri utenti risultano inesistenti, 404).

| Metodo e percorso                  | Descrizione                                                                                                         |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `GET /api/notifications`           | `unread=1`, `limit` (1–100) → `{ items, unread, unreadOverdue, today }`: promemoria aperti con follow-up e azienda. |
| `POST /api/notifications/:id/read` | Segna come letto.                                                                                                   |
| `POST /api/notifications/read-all` | Segna tutti come letti → `{ marked }`.                                                                              |
| `GET /api/saved-filters`           | `scope?`, `counts=0\|1` → filtri con `valid`, `invalidReason`, `count` (risultati di oggi).                         |
| `POST /api/saved-filters`          | `{ scope, name, query }`. 409 `DUPLICATE_NAME`, `DUPLICATE_FILTER`, `TOO_MANY_FILTERS`; 400 `INVALID_FILTER`.       |
| `PATCH /api/saved-filters/:id`     | `{ name }`.                                                                                                         |
| `DELETE /api/saved-filters/:id`    | Elimina il filtro (non tocca i dati).                                                                               |
| `GET /api/reports`                 | `period=7d\|30d\|90d\|month\|prev_month\|all` (predefinito `30d`): prospezione, CRM, andamento, osservazioni.       |

`GET /api/home` contiene anche `workflow`: follow-up scaduti e in scadenza, prospect prioritari fuori dal CRM,
opportunità aggiornate e chiuse di recente, filtri salvati dell'utente.

## Email commerciali (Fase 9)

Regole in [email-commerciali.md](email-commerciali.md). Tutte le rotte richiedono una sessione. Solo
`POST /api/emails/:id/send` invia, e solo con la conferma esplicita.

| Metodo e percorso               | Descrizione                                                                                                                                                                                                 |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/emails/meta`          | Modello ufficiale, modalità, obiettivi, toni, stati, `aiConfigured`, stato dell'invio, `reviewCount`.                                                                                                       |
| `GET /api/emails`               | `status` (o `all`, archiviate escluse), `q`, `business`, `opportunity`, `sort` (`updated`, `created`, `sent`, `business`, `status`), `dir`, paginato, `counts`.                                             |
| `POST /api/emails`              | `{ requestId, businessId, opportunityId? }`: bozza dal modello standard (201; la stessa richiesta ripetuta → 200 con la stessa bozza).                                                                      |
| `GET /api/emails/:id`           | `{ email, business, opportunity, objectives, catalog, history, revisions, attempts }`. Nessuna chiamata AI.                                                                                                 |
| `GET /api/emails/:id/evidence`  | Prove disponibili per la personalizzazione.                                                                                                                                                                 |
| `PATCH /api/emails/:id`         | `{ version, recipient?, subject?, body?, objective?, tone?, serviceId?, instructions?, status?: draft\|ready }`. 409 `STALE_VERSION`, `NOT_EDITABLE`.                                                       |
| `POST /api/emails/:id/generate` | `{ version, mode: standard\|ai, objective, tone, serviceId?, instructions?, overwrite }`. 409 `EDITS_WOULD_BE_LOST`; 503 `AI_NOT_CONFIGURED`; 422/429/502 `AI_FAILED`.                                      |
| `POST /api/emails/:id/archive`  | `{ version }`. `POST …/restore` ripristina lo stato precedente.                                                                                                                                             |
| `GET /api/emails/:id/precheck`  | `{ canSend, blockers, warnings, recipientState, needsOpportunity, from }`.                                                                                                                                  |
| `POST /api/emails/:id/send`     | `{ requestId, version, reviewed: true, lawful: true, acceptUncertain? }` → `outcome` (`accepted`, `failed`, `uncertain`), `repeated` e la scheda. 409 `CANNOT_SEND`, `SEND_CONFLICT`, `UNCERTAIN_PREVIOUS`. |
| `GET /api/email/status`         | Stato della configurazione: `state`, `label`, `canSend`, `explanation`, `from`, `missing` (nomi delle variabili, mai i valori), `lastCheck`.                                                                |
| `POST /api/email/verify`        | _Solo amministratori._ Verifica connessione e autenticazione SMTP senza inviare.                                                                                                                            |

## Valutazione commerciale AI

Formula, penalità, cache e costi in [valutazione-ai.md](valutazione-ai.md). Tutte le rotte richiedono una sessione; la
chiave del fornitore non compare mai nelle risposte.

| Metodo e percorso                               | Descrizione                                                                                                                     |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/ai/status`                            | `configured`, `provider`, `model`, `effort`, `price`, `state` (`available`, `error`, `not_configured`), ultimo esito, conteggi. |
| `GET /api/ai/config`                            | Configurazione attiva (pesi, penalità, gravità, fasce, soglie) con etichette e motivazioni delle penalità.                      |
| `POST /api/ai/config/validate`                  | _Solo amministratori._ `{ config }` → `{ valid, errors }`.                                                                      |
| `PUT /api/ai/config`                            | _Solo amministratori._ `{ config, note? }`: nuova versione. 400 `INVALID_CONFIG` con `fields`.                                  |
| `GET /api/businesses/:id/assessment`            | `{ current, lastFailure, history, reviews, running, configured, lastError }`: valutazione con componenti, penalità, prove.      |
| `POST /api/businesses/:id/assessment`           | `{ force? }`: avvia la valutazione in background → 202. 503 `AI_NOT_CONFIGURED`, 409 `ALREADY_RUNNING`, 429 `AI_BUSY`.          |
| `POST /api/businesses/:id/assessment/review`    | `{ assessmentId, verdict: inaccurate\|confirmed\|note, note? }` (nota obbligatoria tranne per `confirmed`).                     |
| `POST /api/ai/estimate`                         | `{ businessIds (1–500), force? }` → `{ total, cached, missing, toAssess, estimatedCostUsd, basis, configured }`.                |
| `POST /api/ai/jobs`                             | `{ businessIds (1–500), force? }`: lotto esplicito. 409 `AI_JOB_ACTIVE` se un lotto è già attivo.                               |
| `GET /api/ai/jobs` · `GET /api/ai/jobs/:id`     | Lotti con conteggi (`pending`, `assessed`, `cached`, `skipped`, `failed`), token e costo; dettaglio con l'esito per azienda.    |
| `POST /api/ai/jobs/:id/{pause\|resume\|cancel}` | Controllo del lotto.                                                                                                            |

Ogni azienda di `GET /api/businesses` (e delle schede, del CRM) contiene `commercial`: `{ source: 'ai'|'rules', score,
band, confidence, acquisition, serviceFit, needsReview, exclusion, assessedAt, outdated }` oppure `null`. Parametri
aggiuntivi: `minCommercial`/`maxCommercial` (intervallo, es. una fascia), `aiStatus` (`assessed`, `not_assessed`,
`needs_review`, `failed`, `excluded`), `aiConfidence`, `minAcquisition`, `minServiceFit`, `sort=commercial|acquisition|serviceFit`.
Limiti: 60 valutazioni singole e 30 operazioni sui lotti all'ora per utente.
