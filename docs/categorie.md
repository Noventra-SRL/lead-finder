# Categorie di «Trova aziende»

«Trova aziende» (`/trova`) organizza le aziende per **categoria commerciale**. A sinistra c'è l'elenco delle categorie
con il numero reale di aziende; su telefono diventa una striscia scorrevole. Scegliendo una categoria si vedono subito
le sue aziende, i suoi numeri e il pulsante per cercarne di nuove. Categoria, filtri, ordinamento e pagina restano
nell'indirizzo, quindi si cambia categoria senza cambiare pagina e i filtri restano.

## Categorie

Identificativi canonici (`server/categories/catalog.ts`) ed etichette italiane:

| Identificativo          | Etichetta                     | Comprende                                                                   |
| ----------------------- | ----------------------------- | --------------------------------------------------------------------------- |
| —                       | Tutte le aziende              | Ogni azienda una sola volta                                                 |
| `farmacie`              | Farmacie                      | Farmacie con dispensazione di farmaci                                       |
| `parafarmacie`          | Parafarmacie                  | Parafarmacie, senza dispensazione di farmaci con ricetta                    |
| `bnb_case_vacanza`      | B&B e case vacanza            | Bed and breakfast, affittacamere, appartamenti e case vacanza, chalet       |
| `hotel_ricettive`       | Hotel e strutture ricettive   | Hotel e motel, agriturismi, ostelli, campeggi                               |
| `ristoranti`            | Ristoranti                    | Ristoranti, trattorie, osterie, fast food                                   |
| `bar_caffetterie`       | Bar e caffetterie             | Bar, caffetterie, pub, gelaterie                                            |
| `pizzerie`              | Pizzerie                      | Locali indicati dalla fonte come pizzeria (cucina o nome)                   |
| `parrucchieri_barbieri` | Parrucchieri e barbieri       | Parrucchieri e barbieri                                                     |
| `centri_estetici`       | Centri estetici               | Centri estetici, unghie, massaggi, centri benessere e spa                   |
| `palestre_fitness`      | Palestre e centri fitness     | Palestre, centri fitness e sportivi                                         |
| `studi_medici`          | Studi medici e dentistici     | Studi dentistici e medici, poliambulatori, fisioterapisti, laboratori, vet. |
| `studi_professionali`   | Studi professionali           | Commercialisti, avvocati e notai, architetti, ingegneri, consulenti         |
| `negozi`                | Negozi e attività commerciali | Commercio al dettaglio, concessionari compresi                              |
| `agenzie_immobiliari`   | Agenzie immobiliari           | Agenzie immobiliari                                                         |
| `officine`              | Officine e autofficine        | Autofficine, gommisti, officine per moto                                    |
| `altre_attivita`        | Altre attività                | Tutto il resto, e le aziende con prove insufficienti («da verificare»)      |

## Dati

La categoria è salvata sull'azienda (migrazione `0012_business_categories.sql`) ed è stabile tra un riavvio e l'altro:

- `primary_category`: la categoria principale. Ogni azienda ne ha una sola e non viene mai duplicata.
- `category_status`: `classificata` quando la prova è sufficiente, `da_verificare` quando è debole o contraddittoria.
- `category_source`: `automatica` (calcolata dalle regole) oppure `manuale` (scelta da una persona).
- `category_evidence`: la prova che l'ha decisa, ad esempio «OpenStreetMap: amenity=restaurant, cuisine=pizza».
- `category_version`: la versione delle regole che l'ha calcolata.

La categoria interna della scoperta (`category`) e il settore del Lead Hunter (`sector`) non cambiano: restano come
dato d'origine e il punteggio continua a usarli.

## Classificazione

Le regole sono in `server/categories/classify.ts`: deterministiche, senza chiamate esterne e senza AI. Ogni
categoria proviene da dati già salvati, in quest'ordine:

1. **Tag della fonte** (OpenStreetMap: amenity, tourism, shop, office, healthcare, leisure, craft, cuisine). Il
   risultato è «classificata».
2. **Settore del Lead Hunter**, se porta a una sola categoria. Il risultato è «classificata».
3. **Categoria interna della scoperta**, se porta a una sola categoria. Il risultato è «classificata».
4. **Parole del nome** (ad esempio «Pizzeria», «B&B», «Trattoria»): sono solo un indizio, quindi «da verificare».
5. In mancanza di tutto questo: «Altre attività», «da verificare».

Casi particolari:

- Le strutture ricettive non sono tutte B&B:
  - guest house, affittacamere, appartamenti e chalet vanno in «B&B e case vacanza»;
  - hotel, motel, ostelli, campeggi e agriturismi vanno in «Hotel e strutture ricettive»;
  - un hotel con «B&B» nel nome è un B&B, tranne la catena «B&B Hotels».
- Pizzerie: un ristorante con cucina «pizza» o con «pizzeria» nel nome.
- Le parafarmacie (senza dispensazione, o «parafarmacia» nel nome) hanno una categoria propria, «Parafarmacie»
  (regole versione 5; prima erano tra i negozi). Se la fonte dice «senza dispensazione» ma il nome dice «Farmacia»,
  le prove sono in contrasto: «Parafarmacie», da verificare. Le altre attività sanitarie non sono mai farmacie.
- I concessionari d'auto sono negozi, non officine.

**Quando viene calcolata.**

- _Aziende nuove o aggiornate:_ la scoperta classifica ogni azienda che salva, che sia nuova, aggiornata o
  collegata a un'altra fonte.
- _Aziende esistenti:_ il server le classifica all'avvio, in sottofondo e a blocchi di 200. Ogni blocco è una
  transazione: se il lavoro si interrompe, riparte da dove era rimasto. Si può anche lanciare a mano, a server
  fermo, con `npm run categories:classify`, che stampa i conteggi per categoria.
- _Regole cambiate:_ si aumenta `CLASSIFIER_VERSION`, e vengono riclassificate solo le aziende con categoria
  automatica.

**Correzione manuale.** Dalla scheda dell'azienda («Correggi la categoria») una persona può scegliere la categoria.
La scelta viene registrata (`business.category_set`) e nessun ricalcolo la sovrascrive. «Torna alla classificazione
automatica» la rimette alle regole (`business.category_automatic`).

## Numeri per categoria

`GET /api/businesses/categories` accetta gli stessi filtri dell'elenco e applica la stessa query, quindi ogni numero è
quello che si ottiene aprendo la categoria con quei filtri.

| Numero               | Significato                                                                     |
| -------------------- | ------------------------------------------------------------------------------- |
| Aziende              | Aziende della categoria (duplicati uniti esclusi)                               |
| Con sito proprio     | Sito indicato dalla fonte che non è solo una pagina social o di una piattaforma |
| Con email            | Email generica pubblica indicata dalla fonte (non verificata)                   |
| Valutate con AI      | Con una valutazione commerciale AI                                              |
| Pronte da contattare | Mai contattate, con email disponibile                                           |
| Già contattate       | Email accettata dal server di posta o contatto registrato nel CRM               |

«Tutte le aziende» è la somma delle categorie più le aziende non ancora classificate: non ci sono doppioni. Filtri,
ordinamento (punteggio commerciale, nome, città, stato della valutazione, ultimo contatto) e paginazione sono tutti
eseguiti dal server.

## Cercare nuove aziende di una categoria

«Cerca nuove farmacie» (e il pulsante equivalente per ogni categoria) avvia una ricerca del Lead Hunter con i settori
della categoria. La richiesta è `POST /api/hunter/runs { category, area, target, options }`: i settori li decide il
server. La pipeline è quella già esistente:

- usa Overpass/OpenStreetMap, con limiti per richiesta, tentativi ripetuti e ripresa dopo un'interruzione;
- salva le aziende man mano e le deduplica tra categorie e tra ricerche diverse (la stessa fonte resta una sola
  azienda);
- non crea nessuna azienda o email inventata.

La pagina della ricerca mostra l'avanzamento reale e i risultati per categoria (nuove e già presenti), oltre alle
richieste non riuscite. Se il fornitore non risponde, la ricerca lo dichiara.

Una ricerca di una categoria può trovare anche attività vicine: cercando «case vacanza» compaiono anche ostelli e
campeggi. Ognuna riceve comunque la categoria indicata dalle sue prove. Durante una ricerca non viene inviata nessuna
email.

## Test

- `server/categories/categories.test.ts` copre:
  - catalogo e regole: ogni categoria, i dati ambigui o mancanti, la catena «B&B Hotels», le prove in contrasto;
  - salvataggio e classificazione persistente;
  - classificazione delle aziende esistenti a blocchi, con un'interruzione e la ripresa;
  - nuove regole e scelta manuale;
  - ricerca per categoria con la pipeline reale e un server Overpass finto, senza doppioni tra categorie e ricerche;
  - conteggi coerenti con l'elenco, ordinamenti e paginazione, API e validazione.
- `e2e/workflow-trova-categorie.spec.ts` copre:
  - conteggi uguali all'API e cambio di categoria che mantiene i filtri;
  - stato vuoto;
  - «Cerca nuovi parrucchieri e barbieri» fino al risultato nella categoria, con «Invia email» disattivato senza
    email;
  - correzione manuale;
  - telefono.
