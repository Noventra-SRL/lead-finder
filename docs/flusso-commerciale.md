# Flusso commerciale (Fase 8)

Esportazioni, follow-up, promemoria, filtri salvati e report commerciali. Tutto è calcolato dal server con regole
fisse sulle righe del database: nessuna chiamata AI per contare, nessun messaggio inviato alle aziende, nessuna
opportunità spostata in automatico a «Vinto» o «Perso».

## Esportazioni

| Elenco      | Dove                                                              | Rotta                               |
| ----------- | ----------------------------------------------------------------- | ----------------------------------- |
| Aziende     | Aziende (filtri attuali o selezionate), Lead Hunter, Home, Report | `GET/POST /api/businesses/export`   |
| Opportunità | CRM › Elenco, Report (anche raggruppate per fase)                 | `GET /api/crm/opportunities/export` |
| Follow-up   | CRM › Follow-up, Report (scaduti)                                 | `GET /api/crm/followups/export`     |
| Attività    | CRM › Elenco, Report                                              | `GET /api/crm/activities/export`    |

- Il pulsante **Esporta** apre un dialogo: formato (CSV o Excel `.xlsx`), colonne (predefinite, tutte o a scelta;
  catalogo in `GET /api/exports/columns`), per le opportunità «Raggruppa per fase» (in Excel un foglio per fase).
- Si esportano **tutte** le righe dei filtri attuali, non solo la pagina visibile, lette a blocchi di 1.000; limite
  10.000 righe per file (oltre: le prime 10.000 e l'avviso `X-Export-Truncated: true`). Selezione: al massimo 1.000
  aziende.
- Intestazioni in italiano; CSV UTF-8 con BOM, separatore `;`, righe CRLF; celle che iniziano con `= + - @`,
  tabulazione o a capo precedute da `'` (protezione dalle formule). In Excel il testo è sempre testo («inline
  string»): una cella non viene mai interpretata come formula. Caratteri di controllo rimossi.
- Nome del file: `<elenco>_noventra_AAAA-MM-GG.<csv|xlsx>` (data italiana), es. `prospect_noventra_2026-10-22.csv`.
- Nessun dato riservato: nessuna password, sessione, chiave o email personale (solo email generiche pubbliche, come in
  anagrafica). Responsabile e autore sono nomi visualizzati degli utenti, mai le loro email.
- Elenco vuoto: file con le sole intestazioni (e un foglio «Nessun risultato» in Excel).
- Ogni esportazione è registrata (`leads.exported`: elenco, formato, righe, colonne, filtri). 30 esportazioni all'ora
  per utente.
- Il file XLSX è scritto senza librerie (`server/exports/xlsx.ts`: ZIP senza compressione con CRC verificati); è stato
  aperto con Microsoft Excel 16 durante la verifica.

## Follow-up

Ogni follow-up appartiene a un'opportunità: titolo (azione), descrizione facoltativa, scadenza (data, ora facoltativa,
ora italiana), priorità (alta, media, bassa), stato (Da fare, Completato, Annullato), autore, date.

- Si creano dalla scheda dell'opportunità e dalla **scheda dell'azienda**: se l'azienda non ha un'opportunità aperta,
  l'interfaccia chiede conferma e la aggiunge al CRM in «Da qualificare» (il server rifiuta con 409
  `NO_OPEN_OPPORTUNITY` senza `createOpportunity: true`). Un'azienda esclusa dalla prospezione non può riceverne.
- CRM › Follow-up: scadenza (tutti, scaduti, oggi, prossimi 7 giorni, più avanti), stato, priorità, fase
  dell'opportunità, solo le mie; completa, sposta, annulla; link all'opportunità e all'azienda.
- **Completare non cambia la fase** dell'opportunità (registra un'attività «Follow-up»).
- **Chiusura dell'opportunità** (vinto, perso, non contattare): i follow-up in attesa non vengono cancellati ma
  **annullati con motivo «Opportunità chiusa»** (`cancel_reason = 'opportunity_closed'`), distinto dall'annullamento
  di una persona (`manual`). Restano nello storico ed esportabili.
- Scaduto = in attesa con scadenza prima di oggi; i follow-up con la sola data non diventano scaduti durante il giorno.

## Promemoria (nell'applicazione)

- Tipi: **in scadenza** (oggi o domani) e **scaduto**; destinatario il responsabile dell'opportunità, altrimenti chi
  ha creato il follow-up (solo utenti attivi).
- Un promemoria per (utente, tipo, follow-up, scadenza): lo stesso evento non si ripete mai. Spostare la scadenza chiude
  il promemoria vecchio e ne crea uno per la nuova data; riportarla a una data già avuta riapre quel promemoria, di
  nuovo da leggere. Completare o annullare il follow-up lo chiude; «in scadenza» si chiude quando diventa «scaduto».
- Aggiornamento: nel server ogni 5 minuti (`ReminderWorker`, `REMINDERS_WORKER=on`) e alla lettura dei promemoria al
  più una volta al minuto per processo, subito dopo qualsiasi modifica del CRM. Aprire le pagine **non** crea
  promemoria nuovi per eventi già registrati.
- Interfaccia: «Promemoria» nella barra laterale (numero da leggere, in rosso se ci sono scaduti, riletto ogni 2 minuti
  e a ogni cambio di pagina) e la pagina `/promemoria` (segna come letto, segna tutti).

Limiti dichiarati: **nessuna email, SMS, WhatsApp o notifica del browser**; a applicazione chiusa non arriva nulla.
Con più istanze del server lasciare `REMINDERS_WORKER=on` in una sola (gli inserimenti sono comunque idempotenti).

## Filtri salvati

- Per utente e per elenco (aziende, opportunità, follow-up). Si salvano i **criteri** (parametri della ricerca, senza
  paginazione, in ordine canonico), mai un elenco di aziende: riaprendo un filtro i risultati sono quelli di oggi.
- Salva, apri, rinomina, elimina (con conferma). Nomi unici per elenco senza distinzione di maiuscole (409
  `DUPLICATE_NAME`); gli stessi criteri non si salvano due volte (409 `DUPLICATE_FILTER` con il nome esistente).
- L'elenco mostra il numero di risultati calcolato adesso. Criteri diventati non validi (un parametro rimosso, un
  settore o una fase che non esiste più) sono segnalati con il motivo e non si aprono. Al massimo 30 filtri per elenco.
- Le scorciatoie compaiono anche nella home.

## Report commerciali (`/report`)

Periodi: ultimi 7, 30, 90 giorni, questo mese, mese precedente, tutto il periodo — in ora italiana, dal primo giorno
incluso al giorno dopo l'ultimo escluso.

| Misura                    | Definizione                                                                                      |
| ------------------------- | ------------------------------------------------------------------------------------------------ |
| Nuove aziende             | aziende (non unite) con prima rilevazione nel periodo                                            |
| Fascia più alta           | aziende non escluse con punteggio commerciale nella prima fascia, su quelle con un punteggio     |
| Siti verificati           | aziende con un audit completato o parziale                                                       |
| Valutate con l'AI         | aziende con una valutazione AI riuscita                                                          |
| Settori, regioni          | aziende per settore (o per categoria se senza settore, indicate «solo categoria») e per regione  |
| Opportunità attive        | oggi, in una fase aperta                                                                         |
| Create, vinte, perse      | create nel periodo; vinte e perse **chiuse** nel periodo                                         |
| Tasso di vittoria         | vinte ÷ (vinte + perse) nel periodo; **non calcolato** se non ci sono chiusure                   |
| Valore vinto, in pipeline | somma dei valori stimati inseriti a mano; «—» se nessuna opportunità ne ha uno                   |
| Tempo medio di chiusura   | media dei giorni tra creazione e chiusura delle vinte e perse nel periodo, **solo con almeno 3** |
| Follow-up                 | scaduti e in scadenza nei prossimi 7 giorni (oggi), completati nel periodo                       |

Grafici: barre per fasce, settori, regioni e fasi; andamento per giorno, settimana o mese con quattro grafici
affiancati sulla **stessa scala** (aziende censite, opportunità create, vinte, perse), con lettura al passaggio del
mouse e tabella dei dati. Osservazioni: frasi costruite solo dai numeri (nessuna deduzione di cause).

## Home

Widget sintetici: follow-up scaduti e dei prossimi 7 giorni, prospect della fascia più alta non ancora nel CRM,
opportunità aggiornate di recente, vinte e perse di recente, filtri salvati, «Esporta i prospect prioritari» e
collegamento ai report.

## Automazioni

Solo regole deterministiche: promemoria, chiusura dei follow-up all'uscita dalla pipeline, conteggi. Nessuna
automazione invia messaggi, cambia la fase di un'opportunità o crea dati sulle aziende.

## Test

- `server/workflow/workflow.test.ts`: esportazioni (intestazioni, BOM, filtri, tutte le righe a blocchi, troncamento,
  colonne scelte e sconosciute, elenco vuoto, formule, XLSX con CRC e fogli per fase, sessione obbligatoria),
  follow-up (dalla scheda azienda, filtri, spostamento, completamento senza cambio di fase, motivi di annullamento),
  promemoria (destinatario, nessun doppione, chiusura, nuova data, ritorno alla stessa data, sola lettura dei propri),
  filtri salvati (criteri, conteggi, doppioni, rinomina, eliminazione, altri utenti, criteri obsoleti), report
  (periodi, tasso di vittoria, chiusure fuori periodo, tempo medio, nessun dato), home.
- `e2e/workflow-flusso.spec.ts`: follow-up dalla scheda azienda con conferma, filtri e spostamento, esportazione CSV,
  filtri salvati, promemoria, report ed esportazione Excel per fase, telefono; accessibilità con axe.
