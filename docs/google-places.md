# Google Maps (Places API) ed email dai siti

«Trova aziende» può cercare nuove aziende anche con **Google Maps Platform — Places API (New)**, oltre che con
OpenStreetMap. Le email non vengono da Google, che non le fornisce: si cercano dopo, **solo sul sito di ogni azienda**.

## Configurazione richiesta

1. Un progetto Google Cloud con **fatturazione attiva**.
2. L'API **«Places API (New)»** abilitata nel progetto (non la «Places API» precedente).
3. Una **chiave API** creata nel progetto e limitata a «Places API (New)» e all'indirizzo IP del server
   (restrizioni dell'applicazione e dell'API nella console di Google Cloud).
4. Nel file `.env` del server:

   | Variabile                   | Valore predefinito | Significato                                                                  |
   | --------------------------- | ------------------ | ---------------------------------------------------------------------------- |
   | `GOOGLE_PLACES_API_KEY`     | —                  | La chiave; resta sul server, mai inviata al browser né scritta nei log       |
   | `GOOGLE_PLACES_MAX_PAGES`   | `3`                | Pagine da 20 risultati per ricerca (1–3; Google non ne restituisce più di 3) |
   | `GOOGLE_PLACES_DAILY_LIMIT` | `1000`             | Richieste al giorno (limite di spesa, contato nel database); `0` = nessuna   |

5. Riavvio dell'API. Nel dialogo «Cerca nuove …» la fonte «Google Maps (Places API)» risulta configurata.

Senza chiave la fonte compare come «non configurata», con queste istruzioni, e nessuna richiesta parte.

## Come funziona la ricerca

- La ricerca è la stessa pipeline di OpenStreetMap, con lo stesso coordinatore, gli stessi job riprendibili, gli
  stessi salvataggi a ogni area e la stessa deduplica. Cambia solo il fornitore.
- Per ogni settore della categoria e per ogni comune parte una ricerca Text Search, ad esempio «farmacia a Napoli
  (NA)», in lingua italiana e con regione IT.
  - Quando esiste un tipo di luogo esatto (`pharmacy`, `bed_and_breakfast`, `pizza_restaurant`…), viene usato come
    filtro: le corrispondenze sono in `server/discovery/google/queries.ts`.
  - Se Google rifiuta il tipo, la ricerca viene ripetuta con il solo testo.
- Si leggono fino a 3 pagine per ricerca, seguendo `nextPageToken`.
- Si chiedono solo questi campi: id, nome, indirizzo, posizione, sito, telefono, tipi, stato e link a Maps.
- Le attività chiuse definitivamente vengono scartate.
- Il comune ISTAT viene preso dall'indirizzo di Google. Se non è riconoscibile senza ambiguità, resta «non
  determinato»: nessun comune viene indovinato.
- Errori:
  - 429 e 5xx: nuovi tentativi con attesa crescente;
  - chiave rifiutata (401/403): messaggio chiaro;
  - limite giornaliero raggiunto: la ricerca si ferma e lo dichiara.
- **Google non garantisce di restituire tutte le attività di un'area.** I risultati di una ricerca non sono un
  censimento completo, e l'interfaccia non lo dichiara mai.

### Costi

Ogni pagina di Text Search con i campi sito e telefono è una richiesta a pagamento, fatturata da Google (SKU «Text
Search Enterprise»). Il prezzo dipende dal listino Google e dai crediti mensili del progetto. Una ricerca su una
provincia con un settore costa circa (comuni × pagine) richieste. Il limite giornaliero protegge da spese impreviste.

### Condizioni d'uso di Google: da valutare prima dell'uso in produzione

I Termini di servizio di Google Maps Platform limitano la **conservazione** dei contenuti di Google.

- L'identificativo del luogo (place ID) si può conservare senza limiti.
- Gli altri contenuti (nome, indirizzo, telefono, coordinate) in generale si possono tenere in cache solo per un
  periodo limitato (30 giorni per le coordinate) e non per costruire un database permanente indipendente da Google.

Questa applicazione conserva le aziende trovate, come chiede il requisito di non perdere dati. Per le aziende trovate
**solo** con Google, quindi, l'uso continuativo dei dati va verificato con i termini in vigore. Le opzioni sono:

- aggiornare periodicamente i dati dal place ID;
- confermarli da fonti proprie, come il sito dell'azienda (che è quello che fa l'arricchimento email);
- limitarne l'uso.

La decisione è di Noventra: l'applicazione non cancella nulla in automatico. Riferimenti:
https://cloud.google.com/maps-platform/terms e https://developers.google.com/maps/documentation/places/web-service/policies

## Deduplica

- Stessa fonte e stesso identificativo (per Google il place ID): è la stessa azienda, quindi la si aggiorna senza
  crearne un doppione.
- Stesso sito (dominio) entro 250 m: la nuova fonte viene collegata all'azienda esistente.
- **Fonte diversa** (es. OpenStreetMap e Google) con nome normalizzato identico, entro 150 m e senza numeri civici in
  contrasto: è la stessa attività, quindi la nuova fonte viene collegata.
- Due elementi della **stessa** fonte con lo stesso nome restano distinti e vanno in revisione.
- Sedi diverse con lo stesso dominio (catene) restano separate.

Quando una fonte viene collegata a un'azienda esistente, l'azienda mantiene il suo identificativo, la trattativa, le
email inviate, le valutazioni e la categoria scelta a mano. Si completano solo i campi vuoti: nulla viene sovrascritto.

## Email dai siti (arricchimento)

L'arricchimento usa l'audit dei siti già esistente (`server/audit`), quindi:

- lavora in sottofondo, un sito alla volta per host, con un intervallo minimo tra le richieste;
- rispetta robots.txt;
- è protetto dalle richieste verso indirizzi interni (SSRF): sono bloccati loopback, reti private, link-local e
  metadati cloud, e i redirect vengono ricontrollati;
- legge solo pagine http/https, con limiti di tempo, dimensione e numero di pagine;
- non esegue JavaScript;
- si ferma davanti a 401/403/429 e alle protezioni anti-bot;
- è riprendibile dopo un riavvio e non audita mai lo stesso sito due volte insieme.

Le pagine lette sono la principale e quelle interne più pertinenti: contatti, poi note legali e dati societari, poi
chi siamo (fino a `AUDIT_DEFAULT_PAGES`).

Regole sulle email (`server/enrichment/emails.ts`):

- **Cosa si legge.**
  - Si leggono solo gli indirizzi scritti nelle pagine: link `mailto:` e testo visibile (anche «info [at] dominio
    [dot] it»).
  - Script, stili e commenti vengono ignorati.
  - Gli indirizzi protetti contro la raccolta automatica non vengono decodificati.
- **Cosa non si fa mai.** Nessun indirizzo viene generato dal dominio (mai «info@dominio» se non è scritto).
- **Cosa si scarta.**
  - Segnaposto (`nome@tuodominio.it`, `example.com`), file (`logo@2x.png`), indirizzi tecnici (noreply, sentry, wix).
  - Gli indirizzi che sembrano personali (`nome.cognome@`), per minimizzazione dei dati come nella scoperta. Si
    conservano solo i generici (`info@`, `prenotazioni@`…) o quelli con il nome dell'attività.
- **Relazione con il sito.** Ogni indirizzo è classificato come:
  - stesso dominio;
  - casella gratuita;
  - PEC;
  - altro dominio, ad esempio l'agenzia che ha realizzato il sito.
- **Recapito scelto.**
  - Prima lo stesso dominio, poi la casella gratuita.
  - A parità vale l'ordine `info`, `contatti`, `commerciale`, `prenotazioni`, `segreteria` (`CONTACT_PREFERENCE`).
  - Mai una PEC né un altro dominio.
- **Conservazione.**
  - Ogni indirizzo è salvato in `website_emails` con la pagina, la prima e l'ultima data in cui è stato visto e
    l'audit. Non viene mai cancellato.
  - Il recapito dell'azienda (`businesses.email`) viene scritto **solo se è vuoto**. Se l'indirizzo già noto compare
    sul sito, ne guadagna solo la prova («pubblicata», con la pagina). Un recapito verificato o inserito a mano non
    viene mai toccato.
- **Punteggio.** La disponibilità dell'email è un attributo separato. Non cambia gli indicatori della fonte né il
  punteggio commerciale, la cui formula non cambia.

### Stati della contattabilità

| Stato                      | Quando                                                                                       |
| -------------------------- | -------------------------------------------------------------------------------------------- |
| Email verificata           | Confermata con una verifica affidabile (oggi nessuna verifica automatica: 0)                 |
| Email pubblicata sul sito  | Recapito scritto su una pagina del sito dell'azienda                                         |
| Email da verificare        | Indirizzo indicato dalla fonte (OpenStreetMap) o sul sito ma non adatto (PEC, altro dominio) |
| Sito ancora da controllare | Sito proprio non ancora controllato per le email                                             |
| Nessuna email trovata      | Pagine del sito controllate, nessun indirizzo dell'attività                                  |
| Sito non accessibile       | Sito irraggiungibile, bloccato, indirizzo non valido o controllo non riuscito                |
| Senza sito web             | Nessun sito proprio (o solo una pagina social o di una piattaforma)                          |

Nessun indirizzo diventa «verificato» per la sola presenza sul sito o per la sintassi corretta.

## «Trova aziende»

- **Filtro «Email»:** tutte, con email pubblicata sul sito, con email verificata, da verificare, senza email trovata,
  sito ancora da controllare, senza sito web, sito non accessibile.
- **Ordinamento predefinito «Priorità: aziende con email disponibile»:**
  1. email disponibile e punteggio commerciale ≥ 60;
  2. email disponibile e valutazione AI ancora da fare;
  3. email disponibile e punteggio più basso;
  4. sito senza email trovata;
  5. senza sito o sito non accessibile.

  A parità di fascia conta il punteggio commerciale. Restano anche gli ordinamenti per punteggio, nome, città,
  categoria, data di scoperta, stato della valutazione e ultimo contatto.

- **«Cerca le email sui siti»:** avvia il controllo dei siti non ancora controllati, con i filtri attivi (fino a
  `AUDIT_MAX_BUSINESSES_PER_JOB` per volta).
- **«Riprova i siti non accessibili»:** nuovo tentativo sui siti non accessibili. L'avanzamento è nella pagina
  della verifica.
- **Numeri della categoria:** si aggiungono «Email pubblicata sul sito» e «Siti da controllare».
- **Pagina della ricerca:** mostra la fonte e i conteggi delle email.
- **Scheda dell'azienda:** mostra la provenienza del recapito e tutte le email trovate sul sito, con la pagina.
- **Invio:** «Invia email» resta il composer esistente, con tutti i suoi controlli (destinatario valido, «non
  contattare», invio configurato). Durante la scoperta e l'arricchimento non parte nessuna email.

## Test

Tutti con servizi finti: nessuna richiesta a Google o a siti reali, nessuna email inviata.

- `server/enrichment/emails.test.ts` copre l'estrazione:
  - contatti e piè di pagina, `mailto:`, indirizzi scritti per esteso;
  - script e commenti ignorati;
  - segnaposto e file scartati;
  - nessun indirizzo dedotto;
  - relazione con il sito;
  - indirizzi personali esclusi;
  - scelta tra più indirizzi.
- `server/discovery/google/google.test.ts` copre Google, la pipeline e l'arricchimento:
  - conversione dei luoghi;
  - paginazione e FieldMask;
  - chiave mancante o rifiutata, 429/503 con nuovi tentativi, tipo rifiutato, limite giornaliero;
  - configurazione dei test;
  - ricerca per categoria con il worker reale;
  - azienda esistente con trattativa ed email arricchita senza doppioni né sovrascritture;
  - ricerca ripetuta senza doppioni;
  - arricchimento da un sito finto: provenienza, recapito, personali e altri domini esclusi, sito senza email,
    controllo ripetuto senza perdite;
  - filtri, priorità e conteggi.
- `server/audit/net/safeFetch.test.ts` (già esistente) copre la protezione SSRF, i redirect, i timeout, le risposte
  troppo grandi e gli indirizzi interni bloccati.
- `e2e/workflow-trova-google.spec.ts` copre:
  - la ricerca con la fonte Google dal dialogo fino ai risultati nella categoria;
  - l'email pubblicata sul sito finto della farmacia: filtro, priorità, scheda con la provenienza;
  - il nuovo tentativo sui siti non accessibili.
