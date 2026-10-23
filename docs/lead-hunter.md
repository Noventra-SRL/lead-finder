# Lead Hunter (Fase 6)

Il Lead Hunter coordina i moduli già esistenti verso un obiettivo numerico: trova aziende in un'area e in un insieme
di settori, le salva una per una, verifica i loro siti, calcola punteggio e servizi consigliati e le ordina.
Non introduce una nuova fonte di dati: usa la scoperta (Fase 2), l'audit (Fase 3), il punteggio (Fase 4) e
l'abbinamento ai servizi (Fase 5).

**L'obiettivo (predefinito 1.000 aziende) è un traguardo, non una promessa.** Se in un'area le fonti non contengono
abbastanza aziende che soddisfano i criteri, la ricerca termina dichiarando quante ne ha trovate
("Obiettivo non raggiunto: X aziende su T…"). Nessuna azienda, sito, recapito o rilievo viene inventato per
raggiungerlo.

## Flusso

1. **Configurazione** (`/lead-hunter`): obiettivo (1–10.000), area (tutta Italia, regione, provincia, comune),
   settori, criteri: tipo di aziende di interesse (tutte, senza sito proprio indicato, con problemi del sito
   documentati), punteggio minimo, solo aziende nuove, verifica automatica dei siti.
2. **Piano**: l'area diventa un elenco di province. Le province sono **alternate tra le regioni** (una per regione a
   turno), così una ricerca su tutta Italia non si esaurisce nelle prime regioni.
3. **Scoperta**: una provincia alla volta, con un job di scoperta della Fase 2 (stesse regole verso il server
   Overpass: intervallo minimo, tentativi con attesa crescente, cache, limiti per richiesta). Ogni settore ha un
   **limite per comune** (da 1 a 20, calcolato dalla quota della provincia): i settori facili da trovare non
   riempiono l'obiettivo da soli. Le aziende salvate vengono collegate alla ricerca (`hunt_run_businesses`), con
   l'indicazione "nuova" o "già presente".
   - **Quota per provincia**: l'obiettivo restante diviso tra le regioni ancora da visitare (su tutta Italia), o tra
     le province restanti (su una regione), con un margine del 10%. Così il primo giro tocca tutte le 20 regioni.
   - **Richieste leggere**: ogni richiesta copre al massimo 5 comuni, con il **capoluogo per primo**; per ogni comune
     l'area viene letta una volta per chiave OSM (`amenity`, `shop`, `office`, `craft`, `tourism`, `healthcare`,
     `leisure`) e i settori filtrano poi quell'insieme. Una query con un'area letta per ogni selettore di ogni settore
     (circa 100 letture per comune) veniva interrotta dal server pubblico: nessuna azienda salvata.
   - Quando la quota è raggiunta le richieste restanti della provincia sono saltate ("limite raggiunto").
4. **Verifica dei siti** (se attiva): i siti propri non ancora verificati vengono messi in coda a gruppi di 100,
   **un job di audit alla volta**, con il ritmo per sito e le protezioni SSRF della Fase 3.
5. **Punteggio e servizi**: calcolati alla fine di ogni job di scoperta e di audit, come per le ricerche manuali.
6. **Fine**: la scoperta si ferma quando le aziende che soddisfano i criteri raggiungono l'obiettivo, oppure quando
   le candidate arrivano a 3 volte l'obiettivo (il punteggio non è ancora noto per tutte), oppure quando le province
   sono finite.

Una sola ricerca di lead può essere attiva alla volta (409 `HUNT_ACTIVE`): i server pubblici di OpenStreetMap vanno
usati con moderazione.

### Conteggio verso l'obiettivo

Un'azienda "soddisfa i criteri" se è collegata alla ricerca, non è esclusa dalla prospezione e rispetta i criteri
scelti:

- **senza sito proprio indicato**: la fonte non indica un sito, oppure indica solo una pagina su piattaforma condivisa
  (assenza non verificata: OpenStreetMap può non conoscere un sito esistente);
- **con problemi del sito documentati**: sito raggiungibile con almeno un rilievo grave o almeno 3 rilievi utili
  nell'ultimo audit;
- **punteggio minimo**: conta solo dopo il calcolo; un'azienda senza punteggio non conta.
- **solo aziende con un'email pubblica** (`options.publicEmail`): l'azienda ha un'email dell'attività trovata in una
  fonte pubblica, con la pagina di provenienza: indicata dalla scheda OpenStreetMap (`email_source = osm`, link al
  nodo) oppure scritta sul suo sito (`website`, link alla pagina). Un'email inserita a mano non conta.

### Ricerche di aziende con email pubblica

- **Scoperta**: la query chiede alla fonte solo le attività con un sito o un'email nei tag
  (`[~"^(website|contact:website|url|email|contact:email)$"~"."]`), così il limite per comune non viene consumato da
  attività senza recapiti; il salvataggio scarta comunque quelle senza sito proprio né email (solo una pagina social
  non basta).
- **Email dalla fonte**: si conservano gli indirizzi generici (info@, prenotazioni@…) e quelli con il nome
  dell'attività nella parte locale (almeno due parole significative del nome: «pizzeriadamario@…» per «Pizzeria da
  Mario» sì, «mario.rossi@…» no). Gli indirizzi che sembrano personali non vengono mai salvati.
- **Email dai siti**: le verifiche dei siti girano insieme alla scoperta (prima i siti delle aziende ancora senza
  email), leggono le pagine di contatto nel rispetto di robots.txt e dei limiti per sito, e salvano l'indirizzo con la
  pagina. Le misure di velocità sono disattivate per non rallentarle.
- **Quando fermarsi**: la scoperta si ferma quando le aziende con email più quelle attese dai siti ancora da
  controllare (quota misurata sui siti già controllati di questa ricerca, 30% finché ne sono stati controllati meno di 20) raggiungono l'obiettivo, oppure quando le candidate arrivano a 8 volte l'obiettivo, oppure quando le aree sono
  finite. La ricerca termina dopo l'ultima verifica e dichiara il numero reale.
- **Verifica dell'email**: il dominio viene controllato via DNS (MX, altrimenti A/AAAA) da un processo in sottofondo;
  nessun messaggio di prova viene inviato. Livelli mostrati nella scheda: pubblicata in una fonte pubblica, dominio che
  riceve posta, consegna verificata (mai automatica). Un dominio valido non prova che la casella esista.
- Trovare un'email pubblica **non autorizza** l'invio di comunicazioni commerciali: l'invio resta manuale, con la
  conferma e i controlli di «non contattare».

Tutti i numeri mostrati (raccolte, nuove, siti, verifiche, punteggi, distribuzione) sono letti dal database a ogni
richiesta: non sono contatori separati che possano divergere dai dati.

## Pausa, ripresa, annullamento, riavvio

- **Pausa**: ferma la scoperta dopo la richiesta in corso e mette in pausa il job attivo. **Ripresa**: riparte dalla
  stessa provincia (il job viene ripreso, non ricreato).
- **Annullamento**: interrompe il job di scoperta e quello di audit in corso; le aziende già raccolte restano.
- **Riavvio del server**: lo stato è tutto nel database (cursore delle province, job correnti). Una ricerca rimasta
  "in corso" senza battito per 60 secondi viene ripresa dal coordinatore; i job interrotti vengono ripresi.
- **Errori del fornitore**: una provincia con richieste non riuscite termina "con avvisi" e la ricerca prosegue con
  le altre; il messaggio lo dichiara. Senza server configurato la ricerca si sospende.
- **Verifiche non riuscite**: "Ripeti le verifiche non riuscite" rimette in coda solo le aziende la cui verifica è
  fallita.

## Settori

45 settori in 7 gruppi (turismo e ospitalità; ristorazione e alimentari; commercio al dettaglio; servizi
professionali; edilizia, produzione e B2B; salute, benessere e cura della persona; formazione e altri servizi),
definiti in `server/discovery/sectors.ts`. Ogni settore:

- corrisponde a una categoria esistente (usata da punteggio e abbinamento ai servizi);
- elenca i tag OpenStreetMap che lo identificano (validati all'avvio);
- dichiara la **copertura** su OpenStreetMap: _buona_, _parziale_ o _limitata_. I settori a copertura limitata (studi
  professionali, imprese edili, ingrosso, formazione…) sono poco mappati: restano selezionabili ma non sono scelti
  per impostazione predefinita, e l'interfaccia lo indica.

L'ordine dei settori conta per la classificazione (es. le pizzerie prima dei ristoranti; i "negozi specializzati"
raccolgono il resto del commercio).

## Recapiti

Dalla Fase 6 si conservano i **recapiti pubblici dell'attività** indicati dalla fonte:

- **telefono** (`phone`, `contact:phone`, `mobile`…): il primo valore, ripulito, se ha da 6 a 15 cifre;
- **email solo se generica** (`info@`, `prenotazioni@`, `segreteria@`, `amministrazione@`…). Un indirizzo che sembra
  personale (`nome.cognome@`) **non viene salvato**: si registra solo che la fonte ne indica uno, e la scheda lo dice.

Nessun recapito viene dedotto, completato o generato (nessun indirizzo "probabile" costruito dal dominio). I tag
originali conservati per la provenienza continuano a escludere telefono ed email.

## Elenco, filtri ed esportazione

L'elenco dei lead (`/aziende`) ha i filtri per ricerca di lead (`hunt`), settore, recapiti (con telefono, con
telefono o email generica), esclusione e **varietà**: "al massimo N per settore" (e `maxPerRegion` nell'API) limita
quante aziende di ogni settore compaiono, **senza modificare i punteggi**.

**Esportazione CSV** (`GET /api/businesses/export` con gli stessi filtri dell'elenco, oppure
`POST /api/businesses/export` con `{ ids }` per le aziende selezionate):

- UTF-8 con BOM, separatore `;`, righe CRLF: si apre correttamente in Excel in italiano;
- colonne: azienda, settore, categoria, indirizzo, CAP, comune, provincia, regione, sito, stato del sito, ultimo
  audit, rilievi utili, punteggio, fascia, stato del punteggio, affidabilità, spiegazione, servizi consigliati,
  telefono, email generica, fonte, riferimento e data di conferma della fonte;
- **protezione dall'iniezione di formule**: una cella che inizia con `=`, `+`, `-`, `@`, tabulazione o a capo viene
  preceduta da `'`;
- al massimo 5.000 righe per file (header `X-Export-Truncated: true` e avviso nell'interfaccia se il limite taglia);
- solo dati già visibili nell'applicazione; le aziende escluse non sono esportate, salvo filtro esplicito o
  selezione diretta delle aziende;
- ogni esportazione è registrata nel registro delle attività (`leads.exported`: utente, righe, filtri) ed è limitata
  a 30 all'ora per utente.

## Esclusione dalla prospezione

Dalla scheda di un'azienda: "Escludi dalla prospezione", con motivo facoltativo (es. già cliente, ha chiesto di non
essere contattata). L'azienda resta nel database e nella provenienza delle ricerche, ma non compare negli elenchi,
nelle esportazioni e nel conteggio verso gli obiettivi; può essere reinclusa. Entrambe le azioni sono registrate
(`business.excluded`, `business.included`).

## Configurazione

| Variabile       | Predefinito | Note                                                                                               |
| --------------- | ----------- | -------------------------------------------------------------------------------------------------- |
| `HUNTER_WORKER` | `on`        | coordinatore delle ricerche di lead in questo processo (richiede anche i worker di scoperta/audit) |

Il resto dipende dalle variabili della scoperta (`DISCOVERY_*`, in particolare `DISCOVERY_OVERPASS_URL`) e
dell'audit (`AUDIT_*`). Nessuna API a pagamento è necessaria.

### Tempi realistici

Con il server Overpass pubblico e l'intervallo predefinito di 10 secondi tra le richieste, una provincia richiede in
genere circa un minuto (una o due richieste da 30–60 s); una ricerca su tutta Italia per 1.000 aziende richiede
quindi decine di minuti, più il tempo delle verifiche dei siti (ritmo per sito della Fase 3), che procedono in
parallelo alla scoperta e non la bloccano. I server pubblici rispondono spesso 502, 504 o 429: la richiesta viene
ripetuta con attesa crescente (15 s, 30 s, 60 s); l'ultimo avviso compare nella pagina della ricerca.

Le richieste restano **una alla volta**: i server Overpass pubblici assegnano pochi posti per indirizzo IP e sono
già sovraccarichi (molte risposte 502). Più richieste in parallelo verso lo stesso server non aumenterebbero la
velocità e violerebbero le regole d'uso. Per andare più veloci serve un server Overpass proprio
(`DISCOVERY_OVERPASS_URL`, con `DISCOVERY_MIN_INTERVAL_MS` più basso). Overpass non ha paginazione: le richieste
troppo ampie vengono divise in due automaticamente.

## Privacy e uso dei dati

- I dati provengono da OpenStreetMap (ODbL 1.0, attribuzione obbligatoria) e dai siti delle aziende stesse.
- Molte imprese individuali coincidono con persone fisiche: per questo si conservano solo recapiti dell'attività,
  le email personali non vengono salvate e ogni contatto resta una decisione di una persona.
- **Un recapito pubblico non è un consenso a ricevere comunicazioni commerciali.** Il Lead Hunter non scrive né invia
  messaggi. Prima di usare i dati (anche esportati) per contatti commerciali vanno verificati base giuridica (GDPR,
  legittimo interesse documentato), informativa, opposizioni (Registro pubblico delle opposizioni per le telefonate)
  e norme sulle comunicazioni elettroniche: va fatto rivedere a un consulente. Il sistema non garantisce che i dati
  raccolti siano utilizzabili per ogni finalità di marketing.

## Test

- `npm test` / `npm run test:postgres` (`server/hunter/hunter.test.ts`): catalogo e query dei settori, recapiti,
  piano delle aree, area esaurita, deduplica e "solo aziende nuove", obiettivo raggiunto, filtro per settore ed
  esclusione, pausa/ripresa/annullamento, ripresa dopo riavvio, errori del fornitore, coda delle verifiche,
  punteggio minimo, validazione dell'API, elenco, varietà ed esclusione, CSV (BOM, formule, email personali). Server
  Overpass finto locale: nessuna richiesta verso Internet, nessun credito consumato.
- `npm run test:e2e` (`e2e/workflow-lead-hunter.spec.ts`): configurazione, ricerca per obiettivo fino al
  completamento, distribuzione, esportazione con download reale, filtri, recapiti, esclusione e reinclusione,
  accessibilità, telefono.
