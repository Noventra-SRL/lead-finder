# Valutazione commerciale con AI

La valutazione commerciale stima quanto sia **realistico acquisire un'azienda come cliente pagante di Noventra**.
Non misura solo la qualità del sito: un sito vecchio non è di per sé un'opportunità, e un sito recente può esserlo se
c'è un bisogno concreto che Noventra sa risolvere.

È un aggiornamento del sistema di punteggio esistente, non un sistema parallelo:

- il **modello AI** valuta cinque componenti con spiegazioni e prove citate;
- il **server** valida la risposta e calcola il punteggio finale con una formula deterministica e configurabile,
  applica le penalità commerciali documentate, ricava l'affidabilità e le esclusioni;
- il **punteggio a regole** della Fase 4 resta come **riserva dichiarata** quando un'azienda non ha una valutazione AI
  (in elenco: «punteggio a regole (riserva)»), e resta sempre visibile nella scheda.

Il punteggio è una **stima per dare priorità**, non una probabilità di conversione: 80 non significa 80% di
probabilità di vincere il cliente. Una probabilità vera richiederebbe un modello statistico separato, addestrato e
validato su abbastanza esiti reali (vinte/perse) del CRM: oggi non esiste.

## Fornitore e configurazione

Le chiamate partono solo dal server, con l'SDK ufficiale di Anthropic (`@anthropic-ai/sdk`). La chiave non arriva mai
all'interfaccia, non compare nelle risposte dell'API (lo stato dice solo «configurata») e il registro la oscura.

| Variabile                                             | Predefinito       | Note                                                                       |
| ----------------------------------------------------- | ----------------- | -------------------------------------------------------------------------- |
| `AI_API_KEY` (oppure `ANTHROPIC_API_KEY`)             | —                 | chiave dell'API di Anthropic; senza chiave la valutazione AI è disattivata |
| `AI_PROVIDER`                                         | `anthropic`       | `none` disattiva l'AI anche con una chiave presente                        |
| `AI_MODEL`                                            | `claude-opus-5-5` | modello Claude; prezzi noti per Opus 5.5, Sonnet 5.5, Haiku 5.5, Fable 5.1 |
| `AI_EFFORT`                                           | `medium`          | `low`, `medium`, `high`: profondità del ragionamento (e costo)             |
| `AI_CONCURRENCY`                                      | `2`               | valutazioni contemporanee nei lotti (1–4)                                  |
| `AI_TIMEOUT_SECONDS`                                  | `120`             | tempo massimo per richiesta                                                |
| `AI_MAX_RETRIES`                                      | `3`               | ripetizioni con attesa crescente su 429, 5xx e rete (gestite dall'SDK)     |
| `AI_WORKER`                                           | `on`              | esecutore dei lotti in questo processo                                     |
| `AI_PRICE_INPUT_PER_MTOK`, `AI_PRICE_OUTPUT_PER_MTOK` | dal modello       | prezzi in USD per milione di token, per modelli senza prezzo noto          |

Richiesta al modello: risposta strutturata validata con uno schema (structured outputs), `fallbacks: "default"` (se il
modello rifiuta per una regola di sicurezza del fornitore, il server di Anthropic ripete su un modello di riserva
adatto). Senza chiave, o con il fornitore non raggiungibile, **nessun punteggio viene inventato**: l'interfaccia lo dice
e resta il punteggio a regole.

**L'AI è operativa solo dopo aver configurato una chiave reale e completato una valutazione reale.** I test automatici
usano un fornitore di prova e un server locale che parla il protocollo di Anthropic: non consumano crediti.

### Costi

Ogni valutazione è una chiamata a pagamento. Con `claude-opus-5-5` ($4 / $20 per milione di token in ingresso / uscita)
e una valutazione tipica di qualche migliaio di token in ingresso e uno-due migliaia in uscita (ragionamento compreso),
il costo è nell'ordine di qualche centesimo di dollaro per azienda; 1.000 aziende costano quindi decine di dollari.
Prima di ogni lotto l'interfaccia mostra **quante aziende vanno valutate, quante si riusano e il costo stimato** (dai
token medi delle valutazioni precedenti, o da una stima prudente se non ce ne sono); a lavoro finito mostra token e costo
reali. Il costo non viene stimato per modelli senza prezzo noto. Un modello più economico (`AI_MODEL=claude-sonnet-5-5`
o `claude-haiku-5-5`) o `AI_EFFORT=low` riducono il costo: la scelta è di chi gestisce il server.

## Contesto inviato al modello

Solo dati già nell'applicazione, numerati come prove che il modello deve citare:

| Prefisso | Contenuto                                                                                                                                                                       |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `B`      | nome, settore e categoria; comune, provincia, regione; **se** esistono telefono, email generica e orari; data di conferma della fonte                                           |
| `W`      | stato del sito: non indicato (assenza non verificata), solo piattaforma condivisa, verificato, non verificato, irraggiungibile (non prova che sia scadente), audit non riuscito |
| `A`, `F` | sintesi dell'ultimo audit (gravità, prestazioni mobile) e fino a 15 rilievi utili, con i testi del catalogo interno dei rilievi                                                 |
| `C`      | funzioni del sito rilevate dal punteggio a regole (presenti, assenti, non rilevate)                                                                                             |
| `S`      | abbinamenti proponibili con i servizi (Fase 5)                                                                                                                                  |
| `R`      | CRM: solo fasi ed esiti delle opportunità e «non contattare» — mai note o attività                                                                                              |

Più il catalogo attivo dei servizi di Noventra (id, nome, descrizione). **Non vengono inviati** numeri di telefono,
email, note del CRM o altri dati personali. Nessuna navigazione esterna.

**Difesa dalle istruzioni nascoste**: i testi esterni (nome dell'attività, percorsi delle pagine) sono ripuliti dai
caratteri di controllo, accorciati e passati dentro un blocco JSON delimitato; il prompt di sistema stabilisce che
qualsiasi istruzione nei dati è un dato da valutare. In ogni caso il modello non decide il totale: il server ricalcola
tutto e verifica le prove citate.

## Risposta del modello e validazione

Il modello restituisce (schema in `server/ai/prompt.ts`): id dell'azienda, sintesi, cinque componenti da 0 a 100 con
spiegazione e prove, segnali positivi e negativi, ostacoli (tipo, gravità, prove), servizi consigliati, fatti
verificati, deduzioni, informazioni sconosciute, stato dell'attività, affidabilità e prossimo passo di qualificazione.

Il server controlla: forma e tipi; intervalli 0–100; id dell'azienda; **servizi solo dal catalogo attivo**; prove
citate esistenti (quelle inventate sono tolte e segnalate); un «fatto verificato» senza prove diventa una deduzione;
un'attività «cessata» senza prove torna «sconosciuta». Se la risposta non è valida: **un secondo tentativo** con
l'elenco degli errori; se fallisce ancora la valutazione è segnata come non riuscita, la precedente valida resta in uso
e **nessun punteggio viene prodotto**.

## Formula

```
punteggio pesato = acquisizione × 40% + compatibilità servizi × 30% + miglioramento digitale × 15%
                   + attrattività commerciale × 10% + qualità delle prove × 5%
punteggio finale = punteggio pesato − penalità applicate, limitato tra 0 e 100
```

Pesi, penalità, fasce e soglie sono versionati nel database (`ai_scoring_configs`) e modificabili dagli amministratori
nella pagina **Analisi AI** senza toccare il codice; ogni valutazione ricorda la versione usata.

Correzioni del server prima della formula:

- **miglioramento digitale** sopra 70 solo con una prova verificata: un rilievo dell'audit, o un sito non indicato dalla
  fonte. Un sito irraggiungibile, bloccato o con audit fallito **non** prova un sito scadente; un sito non ancora
  verificato nemmeno. La correzione è mostrata («dal modello 90»).

### Penalità commerciali

| Penalità (punti a gravità alta)                    | Gruppo            | Motivo                                                               |
| -------------------------------------------------- | ----------------- | -------------------------------------------------------------------- |
| Ente pubblico o istituzione (20)                   | decisione esterna | gare e procedure formali rendono improbabile una vendita diretta     |
| Processo d'acquisto complesso (12)                 | decisione esterna | ciclo di vendita sproporzionato per l'agenzia                        |
| Franchising o sito gestito centralmente (15)       | decisione esterna | la sede locale di norma non sceglie il fornitore del sito            |
| Sito datato ma adeguato (10)                       | sito adeguato     | un sito vecchio che funziona non dà un motivo concreto per cambiarlo |
| Sito moderno e adeguato (12)                       | sito adeguato     | un investimento recente e funzionante riduce l'opportunità           |
| Bisogno non coperto dai servizi (20)               | servizi           | Noventra non offre una soluzione adatta                              |
| Già cliente — dal CRM (25)                         | relazione         | un cliente non è una nuova acquisizione senza un motivo preciso      |
| Persa di recente — dal CRM, ultimi 180 giorni (10) | relazione         | una trattativa chiusa da poco riduce le probabilità a breve          |

Regole: una penalità del modello si applica **solo con almeno una prova citata**; gravità media ×0,75, lieve ×0,5;
**dentro un gruppo si applica solo la penalità più alta** (lo stesso ostacolo di fondo non conta due volte, es. ente
pubblico e acquisti complessi); «già cliente» e «persa di recente» li ricava il server dal CRM. Ogni penalità
considerata è salvata con punti, esito ed eventuale motivo per cui non è stata applicata, e la scheda ne mostra
l'impatto.

**Esclusioni** (diverse da una priorità bassa): «non contattare» (esclusione della Fase 6 o fase del CRM) e «attività
cessata» (solo con prove). Il punteggio resta visibile nella scheda, ma l'azienda esce dalle classifiche, dalle fasce
e dagli ordinamenti per punteggio commerciale.

### Affidabilità

Separata dal punteggio. Il server confronta l'affidabilità dichiarata dal modello con un controllo oggettivo delle
prove (identità con comune e settore, sito verificato, audit completato, servizio con riscontro, dati della fonte
recenti) e tiene **la minore**: un sito non indicato non è un'assenza verificata e non aumenta l'affidabilità.
L'azienda va **qualificata a mano** (filtro «Da qualificare a mano») se: affidabilità bassa; punteggio da 60 con
affidabilità bassa; ostacoli rilevanti; compatibilità alta senza servizio indicato; servizi proposti senza riscontro
nell'abbinamento a regole.

### Fasce

80–100 Alta priorità commerciale · 60–79 Opportunità promettente · 40–59 Da qualificare · 20–39 Bassa priorità ·
0–19 Opportunità molto debole o non adatta. Configurabili; non indicano una conversione garantita.

## Cache e costi

Ogni valutazione ha un'impronta (SHA-256) di prove, catalogo, versione della configurazione, versione del prompt e
modello (esclusa l'età della conferma della fonte, che cambia ogni giorno). Una valutazione riuscita con la stessa
impronta **si riusa senza chiamare il modello**; cambia l'impronta se cambiano i dati dell'azienda, l'audit, gli
abbinamenti, il CRM, la configurazione, il prompt o il modello. Le pagine non chiamano mai il modello: mostrano le
valutazioni salvate. «Rivaluta con AI» rifà la valutazione su richiesta esplicita. Elenchi e schede segnalano una
valutazione «da aggiornare» quando l'impronta delle prove di oggi è diversa da quella della valutazione corrente.

## Valutazione di ogni azienda

Ogni azienda censita, già presente o appena trovata, riceve una valutazione commerciale senza essere aperta a mano
(`server/ai/queue.ts`, migrazione `0011_ai_assessment_queue.sql`). Stessa formula, stesse penalità, stesso punteggio
calcolato dal server: nessun sistema parallelo.

### Impronte e stati

- **Impronta per azienda** (`ai_business_states.fingerprint`), con la stessa formula della cache: prove, catalogo,
  configurazione, versione del prompt e modello. Si ricalcola quando cambiano azienda, sito o audit, servizi abbinati
  o CRM, configurazione o catalogo, e comunque ogni 24 ore, 200 aziende per giro.
- Il ricalcolo è gratuito (nessuna chiamata al modello) e funziona anche senza fornitore configurato.
- **Stato visibile**, separato da punteggio e affidabilità:

| Stato                    | Significato                                                                                                                                           |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| Da valutare              | Mai valutata.                                                                                                                                         |
| In valutazione           | Lease attivo in questo momento.                                                                                                                       |
| Valutata                 | La valutazione corrente ha l'impronta delle prove di oggi.                                                                                            |
| Valutazione incompleta   | Valutazione aggiornata ma con prove deboli o ostacoli: affidabilità bassa, `needs_review`. Il punteggio resta visibile con l'affidabilità dichiarata. |
| Da aggiornare            | Le prove sono cambiate dopo la valutazione: si mostra il punteggio precedente, segnalato.                                                             |
| Errore di valutazione    | L'ultimo tentativo non è riuscito.                                                                                                                    |
| Esclusa (non contattare) | Mai inviata al modello.                                                                                                                               |

### Coda automatica (`AutoAssessor`)

- Prende le aziende in questo ordine: mai valutate, poi da aggiornare, poi i nuovi tentativi.
- Una azienda il cui sito è in verifica attende la fine dell'audit, così non si paga una valutazione da rifare subito.
- Concorrenza `AI_CONCURRENCY`; si ferma mentre gira un lotto manuale.
- Limite di valutazioni automatiche nelle ultime 24 ore: `AI_AUTO_DAILY_LIMIT` (predefinito 500).
- Con `AI_AUTO_ASSESS=off` restano impronte e stati, senza chiamate al modello.
- **Lease per azienda**, valido anche per le valutazioni singole e i lotti: mai due valutazioni contemporanee della
  stessa azienda. Dopo un riavvio i lease scadono (10 minuti) e il lavoro riprende dal database.
- **Errori temporanei** (rete, tempo scaduto, risposta non valida): nuovi tentativi dopo 5 minuti, 30 minuti e 2 ore,
  poi solo a mano («Riprova le valutazioni non riuscite»).
- **Errori del fornitore** (chiave non valida, limite di richieste): la coda si sospende (15 minuti, o 2 per il
  limite di richieste) e l'azienda torna in attesa senza errori a suo carico.
- **Risultati vecchi**: un risultato diventa corrente solo se le prove non sono cambiate durante la chiamata e nessuna
  valutazione più recente è stata salvata. Altrimenti resta nello storico e l'azienda torna in coda.
- Ogni valutazione registra modello, versione del prompt, versione della configurazione, impronta, token, costo stimato
  e un errore sicuro da mostrare.

### Pannello e comandi

Il pannello «Valutazione di tutte le aziende» (pagina Valuta potenziali clienti, riepilogo in Trova aziende) mostra i
conteggi dal database:

- aziende uniche, valutabili, valutate e valutazioni incomplete, con la percentuale;
- da valutare, da aggiornare, in valutazione, errori, escluse;
- uso delle ultime 24 ore e costo stimato per completare.

Ogni conteggio apre l'elenco filtrato (filtro «Valutazione AI»).

Comandi disponibili:

- avvia o metti in pausa la valutazione automatica (amministratori);
- riprova le valutazioni non riuscite;
- rivaluta le aziende con dati cambiati (ricontrollo di tutte le impronte);
- per aziende precise, selezione nell'elenco e «Valuta con AI» (lotto manuale, al massimo 500 aziende, con stima del
  costo e conferma).

### API batch del fornitore

L'API Message Batches di Anthropic costa circa la metà ma restituisce i risultati fino a 24 ore dopo, e il flusso
attuale prevede una seconda richiesta per azienda quando la risposta non supera la validazione. Per ora quindi la
coda è asincrona e limitata. L'API batch resta un'ottimizzazione possibile per grandi recuperi, da valutare con i
costi reali.

## Revisione umana

Dalla scheda: «Segnala come imprecisa» (nota obbligatoria), «Confermata dopo la verifica», «Solo una nota». Le
revisioni sono salvate in `ai_assessment_reviews` e nel registro delle attività; **non modificano** la valutazione e non
addestrano il modello: servono a migliorare prompt, regole e configurazione in modo tracciabile. Lo storico delle
valutazioni (riuscite e non riuscite, con modello, versioni, costo e data) resta consultabile.

## Integrazione

Lo stesso punteggio commerciale (AI, altrimenti riserva a regole, con la fonte sempre indicata) è usato da: elenco del
Database lead (colonna, fasce, filtri per stato, affidabilità, acquisizione, compatibilità; ordinamenti), Lead Hunter
(criterio «punteggio minimo» e migliori opportunità), CRM (Kanban, elenco, ordinamento per punteggio). Restano distinti
e mostrati separatamente: punteggio commerciale AI, rilievi tecnici dell'audit, corrispondenza dei servizi (Fase 5),
priorità commerciale manuale, fase della pipeline. Un nuovo punteggio **non** cambia fase, priorità, note o attività del
CRM e non avvia nessun contatto.

## API

Vedi [api.md](api.md#valutazione-commerciale-ai).

## Test

`server/ai/ai.test.ts`: configurazione e chiavi mancanti, segreti mai esposti, risposta valida, JSON e schema non
validi con secondo tentativo, intervalli e pesi, formula, penalità e limiti, penalità non duplicate, siti vecchi
adeguati o con problemi verificati, enti pubblici, franchising, siti moderni, sito non indicato contro non verificato,
audit falliti e siti irraggiungibili, attività cessate, clienti e trattative perse dal CRM, non contattare, catalogo dei
servizi, affidabilità, cache e invalidazione, nessun dato personale inviato, istruzioni nascoste, SDK reale contro un
server finto (risposta strutturata, fallback, ripetizioni, tempo massimo, autenticazione), lotti con stima, pausa,
ripresa dopo interruzione, valutazione singola in background, revisione, integrazione con elenco e CRM.
`e2e/workflow-ai.spec.ts`: il flusso completo nell'interfaccia contro il server finto.
