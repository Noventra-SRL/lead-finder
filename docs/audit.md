# Audit dei siti web (Fase 3)

Il modulo esamina dall'esterno, come farebbe un visitatore, il sito pubblico indicato dalla fonte per ogni azienda:
disponibilità, HTTPS, SEO tecnica, indicatori mobile, prestazioni (se configurate), contenuti utili al contatto e
opportunità tipiche del settore. Ogni rilievo ha un codice stabile, un'evidenza verificabile, una gravità, un grado di
affidabilità e un intervento suggerito. **Non è un test di sicurezza** e non assegna un punteggio al lead: il punteggio
arriva con la Fase 4 e userà la sintesi strutturata salvata qui.

## Architettura

```
server/audit/
  net/address.ts        indirizzi pubblici ammessi (blocchi privati, loopback, link-local, multicast, riservati, metadati cloud)
  net/safeFetch.ts      richieste HTTP sicure: DNS validato e "fissato", redirect manuali, limiti di tempo e dimensione
  url.ts                indirizzo del sito dell'azienda e chiave del sito (lo stesso sito scritto in modi diversi)
  robots.ts             robots.txt secondo RFC 9309
  html.ts               lettura dell'HTML (parse5, nessun JavaScript eseguito) → misure
  signals.ts            contenuti rilevati (contatti, orari, prenotazioni, menu, catalogo…)
  findings.ts           catalogo dei rilievi (codici stabili, testi, interventi, area di servizio Noventra)
  checks.ts             regole: misure → rilievi; sintesi strutturata per la Fase 4
  engine.ts             un audit: robots → pagina principale (con varianti) → HTTPS → sitemap → pagine interne → prestazioni
  performance/pagespeed.ts  Google PageSpeed Insights v5 (facoltativo)
  store.ts              salvataggio in una transazione e letture (storico, dettaglio, filtri)
  jobs.ts, worker.ts    verifiche (job) con coda nel database, pausa, ripresa, annullamento, recupero dopo un riavvio
server/http/routes/audits.ts  API
src/pages/Audit*.tsx          interfaccia (verifiche, esito, dettaglio per azienda)
```

Le verifiche usano la stessa architettura dei job di scoperta: righe di PostgreSQL prese con `FOR UPDATE SKIP LOCKED`,
battito periodico, riprendibili dopo un riavvio (`paused` con motivo `interrupted`). Dentro una verifica si esaminano
fino a `AUDIT_CONCURRENCY` aziende in parallelo, mai due volte lo stesso sito contemporaneamente.

## Sicurezza delle richieste (SSRF)

L'audit scarica pagine da indirizzi scritti da terzi (OpenStreetMap): la protezione da SSRF è un requisito di rilascio.

- Solo `http:` e `https:`; niente credenziali nell'URL; solo le porte di `AUDIT_ALLOWED_PORTS` (80 e 443).
- Nomi rifiutati prima del DNS: `localhost`, `*.local`, `*.internal`, `*.localhost`, nomi senza punto, nomi dei
  servizi di metadati cloud.
- **Ogni** indirizzo restituito dal DNS deve essere pubblico (IPv4 e IPv6, compresi IPv4 incorporati in `::ffff:`,
  NAT64 `64:ff9b::/96` e 6to4 `2002::/16`). Bloccati: privati, loopback, link-local, CGNAT, multicast, riservati,
  documentazione, benchmark, `169.254.169.254` e simili.
- La connessione usa **l'indirizzo appena validato** (risoluzione e connessione nello stesso passaggio): un DNS che
  cambia risposta tra controllo e connessione (DNS rebinding) non può portare a un indirizzo interno.
- Redirect seguiti a mano, al massimo `AUDIT_MAX_REDIRECTS`, e ogni destinazione è ricontrollata da capo.
- Tempo massimo di connessione (`AUDIT_CONNECT_TIMEOUT_MS`) e totale (`AUDIT_REQUEST_TIMEOUT_MS`); risposta limitata a
  `AUDIT_MAX_RESPONSE_KB` **anche dopo la decompressione** (gzip, deflate, brotli: niente "bombe" di compressione).
- Si accettano solo HTML, testo e XML; nessun file viene scaricato o eseguito, nessun JavaScript eseguito.
- Nessun cookie, credenziale o intestazione interna inviati; nessuna intestazione della risposta registrata oltre a
  un elenco ristretto di intestazioni tecniche (mai `Set-Cookie`).
- Verifica TLS sempre attiva: un certificato non valido è un rilievo (`SEC_TLS_ERROR`), mai un motivo per disattivarla.

Unica eccezione, solo per i test: `AUDIT_TEST_LOOPBACK_PORTS` permette di raggiungere i siti finti su `127.0.0.1`
alle porte indicate. È accettata **solo con `NODE_ENV=test`**: in sviluppo e in produzione la sua presenza ferma
l'avvio con un errore di configurazione.

## Comportamento verso i siti

- User-Agent identificabile: `NoventraLeadFinder-Audit/<versione> (+<AUDIT_CONTACT o DISCOVERY_CONTACT>)`.
- `robots.txt` letto per primo e rispettato (RFC 9309): gruppo specifico `NoventraLeadFinder` o `*`, regola più
  lunga, `Allow` a parità. Risposta 4xx = nessuna restrizione; 5xx o irraggiungibile = nessuna pagina letta.
- Una richiesta ogni `AUDIT_HOST_INTERVAL_MS` per sito (anche tra verifiche parallele), o il `Crawl-delay` dichiarato
  se più lungo. Con 429 o 503 la lettura si ferma e l'audit risulta parziale.
- Pagine per sito: `AUDIT_DEFAULT_PAGES` (3), modificabile per verifica fino a `AUDIT_MAX_PAGES`. Oltre alla
  principale si scelgono pagine interne utili (contatti, servizi, prenotazioni, menu, chi siamo…).
- Nessun tentativo di superare CAPTCHA, login, paywall o protezioni anti-bot; nessuna rotazione di proxy. Un sito che
  nega l'accesso (401, 403, 429, pagine di verifica anti-bot) risulta **"Accesso negato al controllo"**, non "rotto".
- Un sito già verificato da meno di `AUDIT_REAUDIT_HOURS` ore con la stessa configurazione non viene riletto: si
  riusa l'audit esistente, salvo richiesta esplicita ("Ripeti l'audit").

## Stati

Lo stato del sito (`websiteStatus`) distingue sempre i casi:

| Stato          | Significato                                                                   |
| -------------- | ----------------------------------------------------------------------------- |
| `not_checked`  | sito indicato ma mai verificato                                               |
| `not_found`    | nessun sito proprio (assente, o solo un profilo social/una directory)         |
| `valid`        | raggiungibile                                                                 |
| `redirected`   | raggiungibile, ma l'indirizzo porta a un altro dominio                        |
| `unreachable`  | DNS o connessione non riusciti, anche dopo un nuovo tentativo                 |
| `timeout`      | nessuna risposta entro il tempo massimo                                       |
| `blocked`      | il sito nega l'accesso al controllo (o robots.txt lo vieta)                   |
| `invalid_url`  | indirizzo indicato dalla fonte non valido                                     |
| `audit_failed` | errore interno dell'audit (il sito conserva l'ultimo esito valido, se esiste) |

L'esito dell'audit (`runStatus`) è `completed`, `partial` (alcuni controlli non completati: limiti elencati
nell'audit) o `failed` (errore interno, registrato nello storico).

## Leggere i rilievi

- **Gravità**: `high` (impedisce o compromette l'uso del sito), `medium` (problema concreto e visibile), `low`
  (miglioramento), `info` (informazione utile, nessun problema).
- **Affidabilità**: `high` (osservato direttamente), `medium` (dedotto da più indizi), `low` (indizio singolo o
  misura unica, da confermare).
- **Osservazione**: `missing` (assente nelle pagine esaminate: potrebbe esistere altrove), `problem`,
  `not_inspected` (non è stato possibile verificarlo), `info`.
- **Indicatori mobile** e **di sicurezza** sono letti dal codice della pagina: non sono una prova su dispositivi reali
  né un test di sicurezza. Privacy e cookie: si segnala solo se un link o un banner non vengono rilevati, **mai un
  giudizio di conformità**.
- Le misure conservate non contengono recapiti: di telefono ed email si registra solo se sono presenti.

### Catalogo dei rilievi

Codici stabili (non vengono rinominati: la Fase 4 li userà). Soglie principali: risposta lenta oltre 1,5 s al primo
byte; certificato in scadenza entro 21 giorni; prestazioni con punteggio sotto 90 (alta gravità sotto 50), LCP oltre
2,5 s (4 s), CLS oltre 0,1 (0,25), INP oltre 200 ms (500 ms). Testi completi e interventi in `server/audit/findings.ts`.

#### Disponibilità

| Codice                        | Gravità | Rilievo                                    | Area di servizio             |
| ----------------------------- | ------- | ------------------------------------------ | ---------------------------- |
| `AVAIL_UNREACHABLE`           | high    | Sito non raggiungibile                     | Server, Hosting & Assistenza |
| `AVAIL_TIMEOUT`               | high    | Il sito non risponde in tempo              | Server, Hosting & Assistenza |
| `AVAIL_HTTP_ERROR`            | high    | La pagina principale restituisce un errore | Server, Hosting & Assistenza |
| `AVAIL_BLOCKED`               | info    | Accesso limitato dal sito                  | —                            |
| `AVAIL_NOT_HTML`              | medium  | La pagina principale non è HTML            | Sviluppo Siti Web            |
| `AVAIL_REDIRECT_CHAIN`        | low     | Catena di redirect lunga                   | SEO Optimization             |
| `AVAIL_REDIRECT_OTHER_DOMAIN` | info    | L’indirizzo porta a un altro dominio       | —                            |
| `AVAIL_SLOW_RESPONSE`         | low     | Risposta del server lenta                  | Server, Hosting & Assistenza |

#### Sicurezza

| Codice                    | Gravità | Rilievo                                  | Area di servizio             |
| ------------------------- | ------- | ---------------------------------------- | ---------------------------- |
| `SEC_NO_HTTPS`            | high    | HTTPS non disponibile                    | Server, Hosting & Assistenza |
| `SEC_TLS_ERROR`           | high    | Certificato HTTPS non valido             | Server, Hosting & Assistenza |
| `SEC_CERT_EXPIRING`       | medium  | Certificato HTTPS in scadenza            | Server, Hosting & Assistenza |
| `SEC_HTTP_NOT_REDIRECTED` | medium  | La versione HTTP non reindirizza a HTTPS | Server, Hosting & Assistenza |
| `SEC_MIXED_CONTENT`       | medium  | Contenuti non sicuri in pagine HTTPS     | Sviluppo Siti Web            |
| `SEC_INSECURE_FORM`       | medium  | Modulo che invia dati in chiaro          | Sviluppo Siti Web            |
| `SEC_HEADERS_MISSING`     | info    | Intestazioni di sicurezza assenti        | Server, Hosting & Assistenza |

#### SEO tecnica

| Codice                         | Gravità | Rilievo                                      | Area di servizio                           |
| ------------------------------ | ------- | -------------------------------------------- | ------------------------------------------ |
| `SEO_MISSING_TITLE`            | high    | Titolo della pagina assente                  | SEO Optimization                           |
| `SEO_TITLE_LENGTH`             | low     | Titolo troppo corto o troppo lungo           | SEO Optimization                           |
| `SEO_MISSING_META_DESCRIPTION` | medium  | Meta description assente                     | SEO Optimization                           |
| `SEO_META_DESCRIPTION_LENGTH`  | low     | Meta description troppo corta o troppo lunga | SEO Optimization                           |
| `SEO_MISSING_H1`               | medium  | Nessun titolo principale (H1)                | SEO Optimization                           |
| `SEO_MULTIPLE_H1`              | low     | Più titoli principali (H1)                   | SEO Optimization                           |
| `SEO_NOINDEX`                  | high    | La pagina chiede di non essere indicizzata   | SEO Optimization                           |
| `SEO_ROBOTS_DISALLOW_ALL`      | high    | robots.txt blocca l’intero sito              | SEO Optimization                           |
| `SEO_CANONICAL_MISSING`        | low     | URL canonico non indicato                    | SEO Optimization                           |
| `SEO_CANONICAL_OTHER_HOST`     | medium  | URL canonico su un altro dominio             | SEO Optimization                           |
| `SEO_MISSING_LANG`             | low     | Lingua della pagina non dichiarata           | SEO Optimization                           |
| `SEO_IMAGES_MISSING_ALT`       | low     | Immagini senza testo alternativo             | SEO Optimization                           |
| `SEO_NO_SITEMAP`               | low     | Sitemap non trovata                          | SEO Optimization                           |
| `SEO_NO_STRUCTURED_DATA`       | low     | Dati strutturati dell’attività assenti       | GEO (visibilità nei motori di risposta AI) |
| `SEO_INVALID_JSON_LD`          | low     | Dati strutturati non leggibili               | SEO Optimization                           |
| `SEO_NO_OPEN_GRAPH`            | info    | Anteprima per i social non configurata       | Digital Marketing                          |
| `SEO_BROKEN_INTERNAL_LINKS`    | medium  | Link interni non funzionanti                 | Sviluppo Siti Web                          |
| `SEO_THIN_CONTENT`             | low     | Poco testo nella pagina principale           | SEO Optimization                           |

#### Mobile

| Codice                        | Gravità | Rilievo                                         | Area di servizio            |
| ----------------------------- | ------- | ----------------------------------------------- | --------------------------- |
| `MOBILE_NO_VIEWPORT`          | high    | Pagina non configurata per i dispositivi mobili | Sviluppo Siti Web           |
| `MOBILE_VIEWPORT_FIXED`       | medium  | Viewport a larghezza fissa                      | Sviluppo Siti Web           |
| `MOBILE_ZOOM_DISABLED`        | low     | Zoom disattivato sui dispositivi mobili         | Web Design & Brand Identity |
| `MOBILE_FIXED_WIDTH`          | low     | Elementi a larghezza fissa                      | Web Design & Brand Identity |
| `MOBILE_LEGACY_LAYOUT`        | medium  | Tecniche di impaginazione superate              | Sviluppo Siti Web           |
| `MOBILE_IMAGES_NO_DIMENSIONS` | info    | Immagini senza dimensioni dichiarate            | Sviluppo Siti Web           |

#### Prestazioni

| Codice           | Gravità | Rilievo                                          | Area di servizio  |
| ---------------- | ------- | ------------------------------------------------ | ----------------- |
| `PERF_LOW_SCORE` | medium  | Punteggio prestazioni basso                      | Sviluppo Siti Web |
| `PERF_LCP_SLOW`  | medium  | Contenuto principale lento a comparire (LCP)     | Sviluppo Siti Web |
| `PERF_CLS_HIGH`  | medium  | La pagina si sposta durante il caricamento (CLS) | Sviluppo Siti Web |
| `PERF_INP_SLOW`  | medium  | Risposta lenta alle interazioni (INP)            | Sviluppo Siti Web |

#### Contenuti

| Codice                        | Gravità | Rilievo                                   | Area di servizio            |
| ----------------------------- | ------- | ----------------------------------------- | --------------------------- |
| `CONTENT_NO_CONTACT`          | medium  | Contatti non rilevati                     | Web Design & Brand Identity |
| `CONTENT_NO_ADDRESS`          | low     | Indirizzo non rilevato                    | Web Design & Brand Identity |
| `CONTENT_NO_CTA`              | low     | Inviti all’azione non rilevati            | Web Design & Brand Identity |
| `CONTENT_NO_SERVICES`         | low     | Servizi o prodotti non presentati         | Web Design & Brand Identity |
| `CONTENT_NO_PRIVACY_LINK`     | low     | Link all’informativa privacy non rilevato | Sviluppo Siti Web           |
| `CONTENT_NO_COOKIE_INDICATOR` | info    | Informativa o banner cookie non rilevati  | Sviluppo Siti Web           |
| `CONTENT_NO_SOCIAL`           | info    | Nessun collegamento ai social             | Digital Marketing           |
| `CONTENT_JS_RENDERED`         | info    | Contenuti generati da JavaScript          | —                           |
| `CONTENT_PLATFORM`            | info    | Piattaforma del sito riconosciuta         | —                           |

#### Settore

| Codice                          | Gravità | Rilievo                                        | Area di servizio              |
| ------------------------------- | ------- | ---------------------------------------------- | ----------------------------- |
| `IND_NO_OPENING_HOURS`          | low     | Orari di apertura non rilevati                 | Web Design & Brand Identity   |
| `IND_NO_ONLINE_BOOKING`         | low     | Prenotazione online non rilevata               | Gestionali Web & CRM          |
| `IND_HOTEL_NO_DIRECT_BOOKING`   | medium  | Prenotazione diretta non rilevata              | Gestionali Web & CRM          |
| `IND_HOTEL_NO_ROOMS`            | low     | Informazioni sulle camere non rilevate         | Web Design & Brand Identity   |
| `IND_RESTAURANT_NO_MENU`        | medium  | Menù non rilevato                              | Web Design & Brand Identity   |
| `IND_RESTAURANT_NO_RESERVATION` | low     | Prenotazione o ordinazione online non rilevate | Gestionali Web & CRM          |
| `IND_NO_CATALOG`                | low     | Catalogo prodotti non rilevato                 | E-commerce (Shopify, Magento) |
| `IND_NO_ECOMMERCE`              | low     | Vendita online non rilevata                    | E-commerce (Shopify, Magento) |
| `IND_NO_APPOINTMENT`            | low     | Richiesta di appuntamento non rilevata         | Gestionali Web & CRM          |
| `IND_GYM_NO_SCHEDULE`           | low     | Corsi o orari non rilevati                     | Web Design & Brand Identity   |

I rilievi di settore dipendono dalla categoria dell'azienda (ad esempio menù e prenotazioni per la ristorazione,
prenotazione diretta e camere per gli hotel, orari e catalogo per farmacie e negozi). Le aree di servizio sono quelle
pubblicate su [noventra.it](https://www.noventra.it/); la Fase 5 le renderà configurabili.

## Prestazioni (PageSpeed Insights)

Facoltative: senza `PAGESPEED_API_KEY` gli audit sono completi per tutto il resto e dichiarano il limite
("Prestazioni non misurate"). Con la chiave:

- la chiave resta sul server: mai nell'interfaccia, nelle risposte dell'API, nei log o nei messaggi d'errore;
- richieste una alla volta, con intervallo minimo, tempo massimo di 90 s e due nuovi tentativi su errori temporanei;
- risultati in cache per 24 ore per URL e strategia (`mobile` e/o `desktop`, `AUDIT_PAGESPEED_STRATEGIES`);
- quota esaurita (HTTP 429): nessuna nuova richiesta per un'ora, l'audit risulta parziale con il motivo;
- **laboratorio e utenti reali sono sempre separati**: i valori di laboratorio sono una simulazione Lighthouse, quelli
  reali (CrUX) la media di 28 giorni, con l'indicazione se riguardano la pagina o l'intero sito. Un valore assente
  resta assente: mai uno zero al suo posto.

## Dati salvati (migrazione 0003)

| Tabella               | Contenuto                                                                                         |
| --------------------- | ------------------------------------------------------------------------------------------------- |
| `websites`            | un sito (chiave: host senza `www.` + percorso), stato attuale, URL finale, ultimo audit           |
| `business_websites`   | collegamento azienda → sito, o stato `not_found` / `invalid_url` con il motivo                    |
| `website_audits`      | storico: un audit per riga, configurazione, sintesi strutturata, limiti, conteggi, tempi          |
| `website_audit_pages` | pagine lette: esito HTTP, redirect, tempi, dimensione, TLS, misure (senza recapiti)               |
| `audit_findings`      | rilievi, unici per audit + codice + pagina                                                        |
| `audit_performance`   | misure PageSpeed per audit e strategia, oppure l'errore                                           |
| `audit_jobs`          | verifiche: stato, impostazioni, avanzamento, messaggi                                             |
| `audit_job_items`     | aziende di una verifica; un'azienda non può essere in coda due volte con la stessa configurazione |

La sintesi (`website_audits.summary`) è il dato pensato per la Fase 4: stato del sito, HTTPS, pagine esaminate,
robots e sitemap, viewport, piattaforma, contenuti rilevati (sì/no), conteggi dei rilievi per gravità, area e
servizio, prestazioni mobile/desktop e limiti.

## Uso

1. Database lead → filtro **Audit del sito: "Sito proprio non ancora verificato"** → seleziona le aziende →
   **Avvia audit dei selezionati**; oppure dalla scheda di un'azienda, **Avvia l'audit del sito**.
2. La pagina della verifica mostra avanzamento ed esito per azienda e permette pausa, ripresa e annullamento;
   le verifiche non riuscite per errore interno si ripetono con "Ripeti le verifiche non riuscite".
3. L'esito di un audit raccoglie sintesi, rilievi filtrabili per gravità e area, prestazioni, contenuti rilevati,
   pagine lette e limiti. La scheda dell'azienda conserva lo storico.

Limiti per utente: 3 verifiche attive, 30 avvii o riprese all'ora, `AUDIT_MAX_BUSINESSES_PER_JOB` aziende per
verifica.

## Test

- `npm test` / `npm run test:postgres`: richieste sicure (SSRF: indirizzi privati, IPv6 e IPv4 incorporati, DNS che
  risolve verso indirizzi interni, redirect verso indirizzi interni, porte, dimensione, decompressione, timeout, TLS
  non valido), robots, audit completi contro **siti finti locali** (pagine "di Prova"), PageSpeed con risposte
  registrate (quota, timeout, cache, chiave mai esposta), verifiche dall'inizio alla fine con il worker reale (stesso
  sito condiviso, audit recente riusato, ripetizione forzata, errore interno e ripresa, pausa, annullamento, recupero
  dopo un riavvio) e l'API (accesso, validazione, filtri, doppioni, limiti).
- `npm run test:e2e`: tre aziende di prova collegate a siti finti locali, dalla selezione nel database lead all'esito,
  con axe-core su ogni schermata, desktop e telefono.
- `LIVE_AUDIT_URL=https://example.com/ npm run test:live`: prova dal vivo **solo su un dominio di prova controllato**
  (example.com è riservato dallo IANA a questo uso), mai sul sito di un'azienda; con `LIVE_PAGESPEED_KEY` misura
  anche una pagina con PageSpeed Insights. Non fa parte della suite normale.

## Limiti noti

- Nessun JavaScript eseguito: i siti costruiti interamente nel browser mostrano poco contenuto (rilievo
  `CONTENT_JS_RENDERED`) e alcuni elementi possono risultare "non rilevati".
- Indicatori mobile statici: nessuna prova visiva su un vero browser o dispositivo.
- Un controllo singolo può cogliere un problema temporaneo: gli stati `unreachable` e `timeout` invitano a ripetere.
- Gli intervalli tra le richieste valgono per processo: con più istanze dell'API lasciare `AUDIT_WORKER=on` in una sola.
- PageSpeed Insights non è stato verificato dal vivo in sviluppo senza una chiave (la quota pubblica senza chiave era
  esaurita): il formato delle risposte è verificato con risposte registrate; la prova dal vivo è pronta in
  `server/audit/audit.live.ts`.
