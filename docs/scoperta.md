# Scoperta di aziende (Fase 2)

Il modulo trova attività italiane da fonti aperte, le normalizza, le deduplica e le salva in PostgreSQL con la loro
provenienza. Oggi l'unico fornitore è **OpenStreetMap tramite Overpass API**; il motore è indipendente dal fornitore.

## Architettura

```
server/geo/                 geografia ISTAT (regioni, province/UTS, comuni) — dataset versionato
server/discovery/
  categories.ts             categorie interne (indipendenti dal fornitore)
  types.ts                  contratto fornitore ↔ motore (ProviderRecord, DiscoveryProvider, ProviderError)
  website.ts                normalizzazione dei siti, domini di piattaforme condivise
  osm/tags.ts               corrispondenza categorie ↔ tag OSM (filtro Overpass e classificatore dalla stessa fonte)
  osm/query.ts              query Overpass per un'unità (gruppo di comuni, raggio opzionale)
  osm/normalize.ts          risposta Overpass → ProviderRecord (validata con zod)
  osm/overpass.ts           client HTTP: coda, intervallo minimo, tentativi, limiti, cache
  cache.ts                  cache dei risultati normalizzati (tabella provider_cache)
  store.ts                  salvataggio con deduplica e cronologia
  jobs.ts                   job: pianificazione, limiti, stati, pausa/annullamento/ripresa, recupero
  worker.ts                 esecuzione dei job nel processo dell'API
  businesses.ts             elenco, scheda, revisione dei duplicati, statistiche
server/http/routes/discovery.ts   API (vedi docs/api.md)
src/pages/                  DiscoverPage, JobPage, LeadsPage, BusinessPage, DuplicatesPage
```

Per aggiungere un fornitore: implementare `DiscoveryProvider` (in una cartella propria), con la propria
corrispondenza delle categorie, e passarlo al worker. Jobs, deduplica, API e interfaccia non cambiano.

## Fornitore OpenStreetMap / Overpass

**Configurazione** (`.env`, vedi `.env.example`):

| Variabile                              | Predefinito               | Note                                                                                                                   |
| -------------------------------------- | ------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `DISCOVERY_OVERPASS_URL`               | —                         | Endpoint Overpass. **Vuoto = ricerca non disponibile**: l'interfaccia mostra le istruzioni, nessun dato finto.         |
| `DISCOVERY_CONTACT`                    | `https://www.noventra.it` | Recapito nello User-Agent (`NoventraLeadFinder/<versione> (+recapito)`).                                               |
| `DISCOVERY_MIN_INTERVAL_MS`            | `10000`                   | Intervallo minimo tra l'inizio di due richieste. Le richieste sono **sempre una alla volta**.                          |
| `DISCOVERY_QUERY_TIMEOUT_SECONDS`      | `180`                     | `[timeout:…]` della query; la connessione attende 30 s in più.                                                         |
| `DISCOVERY_MAX_RETRIES`                | `3`                       | Nuovi tentativi su 429/502/503/504 ed errori di rete: attese di 15, 30, 60 s (max 120 s), o `Retry-After` se maggiore. |
| `DISCOVERY_MUNICIPALITIES_PER_REQUEST` | `25`                      | Comuni (della stessa provincia) per richiesta.                                                                         |
| `DISCOVERY_MAX_UNITS_PER_JOB`          | `120`                     | Richieste massime per ricerca: oltre, la ricerca è rifiutata con un messaggio (scegliere un'area più piccola).         |
| `DISCOVERY_MAX_RESULTS_PER_JOB`        | `5000`                    | Massimo di aziende salvate per ricerca.                                                                                |
| `DISCOVERY_STALE_DATA_DAYS`            | `7`                       | Oltre questi giorni i dati del server sono segnalati come vecchi (avviso, ricerca «con avvisi»).                       |
| `DISCOVERY_CACHE_TTL_HOURS`            | `24`                      | La stessa query entro la validità non interroga di nuovo il server.                                                    |
| `DISCOVERY_WORKER`                     | `on`                      | Con più istanze dell'API lasciarlo `on` in una sola (vedi limiti).                                                     |

**Regole d'uso.** Le istanze pubbliche sono risorse condivise:

- `overpass-api.de`: circa 10.000 richieste e 1 GB al giorno; 429 se gli slot sono esauriti, 504 se il server è carico;
  la sua documentazione indica che i servizi automatici dovrebbero usare un'istanza propria. Durante lo sviluppo
  (21/10/2026) era spesso saturo (502/504).
- `overpass.private.coffee` (Private.coffee, associazione austriaca senza scopo di lucro): senza limiti dichiarati,
  chiede di avvisare prima di superare 10 richieste al secondo o 10 contemporanee, uno User-Agent significativo,
  l'attribuzione a OpenStreetMap e, per progetti commerciali, di valutare una donazione. Il 21/10/2026 era a tratti
  sovraccarica (risposte dopo 70 s, 502 dopo 4 minuti) e, soprattutto, **dietro lo stesso indirizzo rispondevano server
  con copie dei dati diverse e vecchie di mesi** (31/05 e 24/07/2026); uno dei due restituiva il comune ma nessuna
  attività, senza alcun avviso.
- `lz4.overpass-api.de`: mirror ufficiale di overpass-api.de (stesse regole d'uso), con dati aggiornati al minuto.
  È quello configurato per lo sviluppo e usato per la verifica dal vivo della Fase 2.

**Data dei dati.** Per ogni richiesta si registra la data dichiarata dal server (`osm3s.timestamp_osm_base`), visibile
nella ricerca e nella scheda dell'azienda. Oltre `DISCOVERY_STALE_DATA_DAYS` giorni la ricerca termina «con avvisi» e
lo spiega. Una copia dei dati più vecchia di quella già salvata non sovrascrive un'azienda.

**Nuovi tentativi visibili.** Ogni tentativo fallito (429, 502, 503, 504, tempo scaduto) compare nei messaggi della
ricerca con il motivo e l'attesa, ad esempio «Server OpenStreetMap occupato o sovraccarico (HTTP 502). Nuovo tentativo
tra 15 s (2 di 4)», e nel registro del server. Il contatore «richieste non riuscite» comprende anche i tentativi
falliti seguiti da un successo.

Nessun server pubblico garantisce disponibilità né risultati completi: un server lento o con dati incompleti può
restituire meno attività di quelle reali senza segnalarlo. Per l'uso regolare in Noventra va configurata un'istanza
Overpass propria (o un servizio dedicato): il codice non cambia, basta l'indirizzo. Le richieste di Lead Finder (una alla volta, ogni 10 s) restano comunque ben sotto i
limiti dichiarati.

**Query.** I comuni sono individuati dal tag `ref:ISTAT` dei confini amministrativi di livello 8 (verificato dal vivo:
il comune 058003 Albano Laziale restituisce le sue farmacie reali). Per ogni comune la risposta contiene l'area e poi
le attività: ogni attività è attribuita al suo comune, quindi a provincia e regione tramite la tabella ISTAT.
Un comune assente in OSM (es. codice cambiato di recente) produce un avviso esplicito, non "zero risultati".
Si chiedono solo elementi **con un nome**.

## Categorie e copertura

| Categoria                       | Tag OSM                                                                                                                                 | Copertura |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | --------- |
| Farmacie                        | `amenity=pharmacy` (senza `dispensing=no`), `healthcare=pharmacy`                                                                       | buona     |
| Parafarmacie                    | `amenity=pharmacy` + `dispensing=no`; `shop=chemist` / `shop=medical_supply` con "parafarm" nel nome                                    | parziale  |
| Hotel                           | `tourism=hotel\|motel\|hostel`                                                                                                          | buona     |
| B&B e strutture extralberghiere | `tourism=guest_house\|apartment\|chalet`                                                                                                | parziale  |
| Ristoranti e bar                | `amenity=restaurant\|cafe\|bar\|pub\|fast_food\|ice_cream`                                                                              | buona     |
| Studi medici e sanitari         | `amenity=dentist\|doctors\|clinic\|veterinary`, `healthcare=dentist\|doctor\|physiotherapist\|psychotherapist\|laboratory\|clinic`      | parziale  |
| Studi professionali             | `office=lawyer\|notary\|accountant\|tax_advisor\|architect\|engineer\|surveyor\|consulting\|insurance\|estate_agent\|financial_advisor` | limitata  |
| Palestre e benessere            | `leisure=fitness_centre\|sports_centre\|sauna`, `shop=beauty\|massage`                                                                  | buona     |
| Artigiani e servizi locali      | `craft=*`, `shop=hairdresser\|car_repair\|dry_cleaning\|laundry`, `amenity=car_wash\|driving_school`                                    | parziale  |
| Industria e produzione          | `man_made=works`, `industrial=*` (escluso `port`)                                                                                       | limitata  |
| Aziende e uffici                | `office=company\|it\|telecommunication\|advertising_agency\|travel_agent\|logistics`                                                    | limitata  |
| Negozi                          | `shop=*` (escluso `vacant`)                                                                                                             | buona     |

OSM è una base volontaria: "buona" non significa completa. Le note di copertura sono mostrate accanto a ogni
categoria nel modulo di ricerca. Nessun dato viene inventato per coprire le lacune.

## Normalizzazione e dati conservati

Per ogni attività: nome, categoria, sito (solo se indicato; si aggiunge `http://` se manca lo schema, si usa il primo
di più valori), indirizzo (via, civico, CAP, località come scritti nella fonte), comune/provincia/regione solo dal
codice ISTAT, coordinate, indicatori di completezza (sito, indirizzo, telefono, email, orari), fonte (`node/123`,
link al record OSM, licenza), date di prima acquisizione e di ultima verifica.

**Recapiti (dalla Fase 6):** si conservano il telefono dell'attività e l'email **solo se generica** (`info@`,
`prenotazioni@`…); un'email che sembra personale non viene salvata, si registra solo che la fonte ne indica una.
Nessun recapito viene dedotto o generato. Dettagli in [lead-hunter.md](lead-hunter.md#recapiti). Le aziende salvate
prima della Fase 6 hanno i recapiti vuoti finché una nuova ricerca non le aggiorna.

**Non vengono conservati** dati dei mappatori OSM. I tag originali conservati per la provenienza sono una selezione
(nome, marchio, categoria, indirizzo, sito, orari: mai telefono o email). Un sito su una piattaforma condivisa (Facebook, Instagram, Wix, TripAdvisor…) è segnato come tale e non
conta come "sito proprio".

## Deduplica

1. **Stesso record della fonte** (`provider` + `provider_ref`, vincolo univoco): aggiornamento, mai un doppione.
   Ripetere una ricerca è idempotente.
2. **Stesso dominio del sito** (non di piattaforma condivisa) **e** distanza ≤ 250 m (solo se mancano le coordinate:
   stesso nome normalizzato nello stesso comune): la nuova fonte si collega all'azienda esistente e ne completa i dati
   mancanti. Sedi distanti con lo stesso sito e la stessa insegna (catene, farmacie comunali) restano aziende
   distinte e vanno in revisione; fino alla Fase 6 venivano unite se il nome coincideva nello stesso comune.
3. **Altrimenti nuova azienda.** Se esiste un'azienda con lo stesso nome normalizzato entro 500 m, un nome che
   contiene l'altro entro 100 m, o lo stesso dominio nello stesso comune, le due **restano separate** e la coppia va
   in **revisione manuale** (Database lead → Possibili duplicati). Una persona sceglie se unirle (e quale mantenere) o
   segnarle come distinte; una coppia distinta non viene più proposta.

Unire non cancella nulla: l'azienda non mantenuta diventa un rimando (`merged_into`), le fonti passano a quella
mantenuta. Ogni creazione, aggiornamento (con valori precedenti e nuovi), collegamento e unione è in `audit_log`.

## Job di ricerca

- **Pianificazione**: l'area (Italia, regione, provincia, comune, comune + raggio) diventa un elenco di unità,
  ciascuna con fino a `DISCOVERY_MUNICIPALITIES_PER_REQUEST` comuni della stessa provincia.
- **Stati**: in coda → in corso → completata | completata con avvisi | non riuscita | annullata; in pausa (manuale,
  per interruzione del server, o per fornitore non configurato).
- **Avanzamento** per unità nel database: dopo un riavvio la ricerca risulta "interrotta, riprendibile" e riparte
  dalla prima unità non completata. Le unità completate e i loro dati restano.
- **Divisione**: se il server segnala una richiesta troppo ampia (tempo o memoria esauriti, risposta oltre 64 MB),
  l'unità viene divisa in due e le parti eseguite separatamente.
- **Errori**: un'unità non riuscita dopo i tentativi è registrata con il motivo; la ricerca prosegue e termina "con
  avvisi" (o "non riuscita" se nessuna unità è riuscita). "Ripeti le parti non riuscite" riesegue solo quelle.
  Zero risultati è un successo, distinto da un errore.
- **Limiti contro gli abusi**: ricerche identiche attive non duplicabili (409 con il link alla ricerca esistente);
  massimo 3 ricerche attive per utente e 10 in totale; 20 creazioni/riprese all'ora per utente; risultati e
  richieste massimi per ricerca. I job creati dal Lead Hunter (una provincia alla volta, con settori e limite per
  settore e comune) non contano nel limite per utente: il coordinatore ne tiene attivo uno solo.
- **Annullamento e pausa**: interrompono anche la richiesta in corso (entro il battito di 5 s); i dati già salvati
  restano.

## Licenze e attribuzione

- **OpenStreetMap** — © OpenStreetMap contributors, Open Database License (ODbL) 1.0. L'attribuzione è mostrata nelle
  pagine di ricerca, nel database e nelle schede. Il database delle aziende è un _derivative database_ ai sensi
  dell'ODbL: se venisse reso pubblico o condiviso con terzi, andrebbe offerto con la stessa licenza.
  **Da valutare con un consulente prima dell'uso in produzione** (anche per l'uso interno a scopo commerciale).
- **ISTAT** — codici e denominazioni dei comuni, CC BY 4.0 ("Codici statistici delle unità amministrative
  territoriali"; modifiche: selezione delle colonne e conversione in JSON). Aggiornamento: `npm run geo:update`.

## Privacy

I dati raccolti sono informazioni pubbliche sulle attività. Anche così, molte imprese individuali coincidono con
persone fisiche: per questo si conservano solo recapiti dell'attività (telefono, email generica), mai email personali,
e non esiste alcun invio automatico di messaggi. Un recapito pubblico non è un consenso al marketing: prima di usare
i dati per contatti commerciali vanno verificati base giuridica (GDPR), informativa e opposizioni (Registro pubblico
delle opposizioni per le telefonate), da far rivedere a un consulente. Vedi [lead-hunter.md](lead-hunter.md#privacy-e-uso-dei-dati).

## Test

- `npm test` / `npm run test:postgres`: categorie, query, normalizzazione, client (429/504/Retry-After, risposte non
  valide o troppo grandi, annullamento, cache), deduplica, job (tutte le transizioni), API (autorizzazione,
  validazione, filtri, paginazione, revisione), con un fornitore programmabile e un **server Overpass finto** locale
  (dati inventati "di Prova", identificativi da 9.000.000.000). Nessuna richiesta verso Internet.
- `npm run test:e2e`: il programma reale con il server Overpass finto: ricerca su un comune e su una provincia,
  ripetizione senza doppioni, revisione dei duplicati, errore del fornitore e ripresa, comune assente, filtri e
  paginazione, accessibilità.
- `LIVE_OVERPASS_URL=… npm run test:live`: due richieste piccole a un **server Overpass reale** (facoltativo).
