# Punteggio dei lead (Fase 4)

Il punteggio ordina le aziende per **quanto sembrano adatte ai servizi di Noventra secondo le prove raccolte**
(dati della fonte pubblica e audit del sito). È un **criterio di priorità**, non una previsione: non stima la
probabilità che un'azienda acquisti, il suo fatturato o il suo budget. Un punteggio alto indica un'opportunità
promettente e documentata, da verificare da una persona prima di qualsiasi contatto.

> Il punteggio del lead indica la priorità dell'azienda; la pertinenza dei singoli servizi è un calcolo separato
> (Fase 5, [servizi.md](servizi.md)) che usa l'affidabilità delle prove ma non il punteggio.

## Architettura

```
server/scoring/
  config.ts     modello configurabile: schema zod, valori iniziali, versione dell'algoritmo
  engine.ts     funzione pura scoreLead(input, configurazione, data) → risultato spiegato
  store.ts      configurazioni versionate, lettura a lotti dei dati, istantanee, storico, statistiche
  jobs.ts       ricalcoli in background (scoring_jobs) e relativo esecutore
server/http/routes/scoring.ts   API
src/components/LeadScorePanel.tsx, ScoringSettings.tsx, ScoreControls.tsx   interfaccia
```

Il calcolo è **deterministico** e **locale**: nessun servizio esterno, nessun modello di linguaggio. Con gli stessi
dati, la stessa configurazione e lo stesso giorno di calcolo il risultato è identico (verificato dai test).

Quando si aggiorna:

- dopo ogni audit, per tutte le aziende che condividono quel sito;
- al termine di ogni ricerca, per le aziende viste dalla ricerca (job in background);
- su richiesta: dalla scheda ("Ricalcola il punteggio"), per le aziende selezionate nel database lead, o per tutte
  (solo amministratori, dalle Impostazioni).

Se i dati in ingresso non sono cambiati non si crea una nuova istantanea (salvo ricalcolo esplicito). Un punteggio
che potrebbe non riflettere più i dati (configurazione nuova, audit più recente, dati dell'azienda cambiati) è
segnalato come "da aggiornare".

## Formula

Cinque dimensioni, ciascuna con un valore da 0 a 100:

| Dimensione                 | Peso iniziale | Cosa misura                                                                                  |
| -------------------------- | ------------: | -------------------------------------------------------------------------------------------- |
| Problemi tecnici del sito  |            30 | rilievi utili dell'ultimo audit (disponibilità, sicurezza, SEO tecnica, mobile, prestazioni) |
| Capacità digitali mancanti |            25 | capacità pertinenti al settore non presenti (prenotazioni, menù, catalogo, contatti…)        |
| Opportunità di settore     |            15 | pertinenza del settore, **solo** per i servizi sostenuti da una lacuna osservata             |
| Qualità delle prove        |            15 | affidabilità delle prove (vedi sotto)                                                        |
| Indicatori commerciali     |            15 | segnali osservabili e prudenti (attività confermata, offerta chiara, contatti pubblici…)     |

```
punteggio grezzo = Σ (valore_dimensione × peso) / Σ pesi delle dimensioni con prove
punteggio        = arrotondamento del punteggio grezzo (intero 0–100)
```

Una dimensione **senza prove è "sconosciuta"**: non vale né 0 né 100, viene esclusa e i pesi delle altre sono
riproporzionati. Quanto manca si vede nella **completezza dei dati**, calcolata a parte.

### A. Problemi tecnici

- Ogni rilievo utile vale i punti della sua gravità (alta 30, media 15, bassa 5, informativa 0) per il fattore di
  affidabilità (alta 1, media 0,75, bassa 0,5). I rilievi "non verificabili" e quelli non utili non contano.
- **Raggruppamento**: i rilievi dello stesso problema di fondo (ad esempio meta description assente, anteprima social
  assente e titolo troppo lungo sono tutti "metadati") valgono quanto il più forte, più il 25% degli altri, al massimo
  quanto un problema grave. Lo stesso rilievo su più pagine è un solo problema (le pagine servono come conferma).
- 80 punti corrispondono al 100% della dimensione.
- Un sito **irraggiungibile una volta** non è valutato (stato sconosciuto, da ripetere). Un sito irraggiungibile in
  **2 audit consecutivi** è un problema ripetuto (valore 75). Un sito che **nega l'accesso** non è mai "assente".

### B. Capacità digitali

Per ogni settore sono configurate le capacità pertinenti e la loro importanza (ad esempio: hotel → prenotazione
diretta, camere; ristoranti → menù, prenotazione o ordinazione; studi sanitari → appuntamenti; industria → catalogo,
richiesta di preventivo). Le capacità non pertinenti non penalizzano mai: un'industria non perde punti per l'assenza di
prenotazioni, uno studio professionale per l'assenza di vendita online.

Stati di una capacità:

| Stato          | Significato                                                                             | Peso della lacuna |
| -------------- | --------------------------------------------------------------------------------------- | ----------------: |
| `present`      | rilevata                                                                                |                 0 |
| `missing`      | assente in modo **misurato** (es. viewport mobile nel codice della pagina principale)   |               1,0 |
| `not_detected` | cercata nelle pagine esaminate e non trovata: potrebbe esistere altrove                 |               0,6 |
| `unknown`      | non valutabile (nessun audit, sito non raggiungibile, contenuti generati da JavaScript) |           esclusa |
| non pertinente | non prevista per il settore                                                             |           esclusa |

Il **sito proprio** è `present` se l'audit lo ha raggiunto, `not_detected` se la fonte non ne indica uno o indica solo un
profilo social. **L'assenza del sito non è mai considerata confermata**: OpenStreetMap non è un elenco completo.

### C. Opportunità di settore

Ogni settore ha una pertinenza di base (0–100) e un elenco di servizi di Noventra pertinenti (dalle aree pubblicate su
noventra.it). Il valore è `pertinenza di base × (importanza dei servizi sostenuti da prove / importanza totale)`: un
servizio è "sostenuto" solo se un rilievo o una lacuna osservata vi è collegato. **Il settore da solo vale 0.**

### D. Qualità delle prove e affidabilità

L'affidabilità (0–100) è **separata dal punteggio di opportunità** ed è mostrata a parte (alta ≥ 70, media ≥ 45, bassa):

| Componente | Punti | Come si ottiene                                                                              |
| ---------- | ----: | -------------------------------------------------------------------------------------------- |
| audit      |    35 | audit completo di un sito raggiungibile (parziale 20; problema ripetuto 20; non raggiunto 5) |
| freschezza |    25 | audit entro 30 giorni (12 fino a 120; poi 0)                                                 |
| rilievi    |    20 | quota dei punti tecnici che viene da rilievi ad alta affidabilità                            |
| fonte      |    10 | comune ISTAT noto (5) e attività confermata dalla fonte nell'ultimo anno (5)                 |
| conferme   |    10 | pagina interna esaminata oltre alla principale (5); stesso problema su più pagine (5)        |

Esaminare più pagine **non** aumenta l'affidabilità oltre la seconda: conta l'attendibilità, non la quantità.
Lo stesso valore è usato come quarta dimensione del punteggio (peso 15).

### E. Indicatori commerciali

Solo segnali osservabili: attività riconfermata di recente dalla fonte, sito ufficiale attivo, servizi o prodotti
presentati, canale di contatto aziendale pubblico, processo di prenotazione o vendita online già presente
(migliorabile), problema digitale specifico e documentato. Un indicatore non verificabile è **sconosciuto**, non
negativo; con meno di 4 punti di peso verificabili la dimensione è sconosciuta. Non si stimano fatturato, dimensioni,
budget o difficoltà economiche; il numero di sedi non è disponibile in modo affidabile e resta sconosciuto. Nessun
dato personale e nessuna caratteristica sensibile entrano nel calcolo.

## Completezza dei dati

Indica quanta parte delle prove necessarie è disponibile (0–100): audit (40), capacità del settore valutate (25), dati
della fonte (20, in proporzione ai 5 indicatori di completezza), comune noto (15).

## Stati e fasce

| Stato               | Quando                                                                                        | Punteggio mostrato                         |
| ------------------- | --------------------------------------------------------------------------------------------- | ------------------------------------------ |
| `ranked`            | prove sufficienti                                                                             | sì, con fascia                             |
| `needs_review`      | opportunità almeno C ma affidabilità < 45, oppure possibile duplicato in sospeso              | sì, "da verificare"                        |
| `insufficient_data` | completezza < 55, oppure dimensioni con prove < 50% del peso totale                           | no (valore provvisorio solo nel dettaglio) |
| `not_suitable`      | **solo** per i settori esclusi esplicitamente nella configurazione (nessuno per impostazione) | no                                         |

| Fascia         | Punteggio | Azione suggerita                              |
| -------------- | --------: | --------------------------------------------- |
| Priorità A     |    80–100 | rivedere le prove e dare priorità al contatto |
| Priorità B     |     60–79 | esaminare le prove e valutare un contatto     |
| Priorità C     |     40–59 | approfondire prima di decidere                |
| Priorità bassa |      0–39 | nessuna azione: prove attuali deboli          |

Un punteggio basso non significa "azienda non adatta" e nessuna azienda viene scartata: senza prove il risultato è
"dati insufficienti", con il passo successivo (avviare l'audit, ripeterlo, verificare se esiste un sito).

## Spiegazione e dettaglio salvati

Ogni istantanea (`lead_scores`) conserva: punteggio e punteggio grezzo, fascia, stato, versione dell'algoritmo e della
configurazione, valore e peso effettivo di ogni dimensione, completezza e affidabilità con le loro componenti,
segnali a favore, a sfavore e sconosciuti (ognuno marcato come **fatto** osservato o **deduzione**), problemi
principali con i codici dei rilievi e l'audit da cui provengono, capacità valutate, servizi sostenuti da prove, data
di calcolo e prossimo passo. La spiegazione è composta solo da questi dati: nessuna frase generica.

## Configurazione

La configurazione attiva è nel database (`scoring_configs`, una riga per versione; la più alta è attiva). Alla prima
esecuzione viene registrata quella iniziale del codice (`server/scoring/config.ts`) come versione 1.

- **Impostazioni → Punteggio dei lead**: tutti vedono pesi, fasce e soglie; gli amministratori modificano pesi, fasce,
  soglie delle prove e freschezza nel modulo, e il resto (gruppi di rilievi, capacità e servizi per settore,
  indicatori commerciali, settori esclusi) nel JSON completo. "Verifica" controlla senza salvare.
- Ogni salvataggio crea una **nuova versione** con nota e autore (registro delle attività). I punteggi esistenti restano
  con la loro versione e risultano "da aggiornare"; il ricalcolo generale li porta sulla versione attiva. Le istantanee
  precedenti non vengono mai modificate.
- Regole di validazione: pesi tra 0 e 1000 con almeno uno positivo; fasce decrescenti (A > B > C); freschezza "superata"
  oltre quella "recente"; ogni rilievo in un solo gruppo; regole per tutti i settori; un servizio per ogni capacità;
  nessun campo sconosciuto.
- Via API: `PUT /api/scoring/config` con `{ "config": { … }, "note": "…" }` (solo amministratori).

Cambiare la versione dell'**algoritmo** (`SCORING_ALGORITHM_VERSION`) è una modifica del codice: va fatta quando
cambia il significato del calcolo, così i punteggi storici restano distinguibili.

## API

Vedi [api.md](api.md#punteggio-dei-lead). L'elenco dei lead con filtri e ordinamento per punteggio è
`GET /api/businesses`.

## Test

- `npm test` / `npm run test:postgres`: motore (intervallo 0–100, determinismo, normalizzazione dei pesi, configurazioni
  non valide, dimensioni sconosciute, dati insufficienti, affidabilità e freschezza, raggruppamento dei rilievi,
  gravità, pertinenza di settore, "assente" contro "non rilevato" e "sconosciuto", sito irraggiungibile contro assente,
  confini delle fasce, spiegazioni); persistenza (istantanee senza doppioni, storico, ricalcolo dopo un audit o un
  cambio dei dati, nuove versioni della configurazione, calcoli contemporanei, 450 aziende a lotti con un numero fisso
  di query, job interrotto e ripreso); API (accesso, permessi di amministratore, filtri, ordinamento, paginazione).
- `npm run test:e2e`: punteggi calcolati automaticamente dopo gli audit dei siti finti, elenco, scheda, dati
  insufficienti, configurazione da amministratore e ricalcolo generale, desktop e telefono con axe-core.

## Limiti noti

- Il modello è un'euristica con pesi iniziali ragionati, **non validata statisticamente** su esiti commerciali reali:
  i pesi vanno rivisti con l'esperienza (la cronologia delle versioni lo permette).
- L'assenza di un sito non può essere confermata con le fonti attuali: queste aziende restano "dati insufficienti"
  finché una persona non verifica.
- Le capacità si vedono solo nelle pagine esaminate (3 per sito) e senza eseguire JavaScript.
- Le prestazioni contano solo se PageSpeed Insights è configurato (Fase 3).
- I ricalcoli dopo una ricerca riguardano le aziende viste da quella ricerca; il passare del tempo (prove che
  invecchiano) aggiorna il punteggio al ricalcolo successivo, segnalato come "da aggiornare" solo per configurazione,
  audit o dati cambiati.
