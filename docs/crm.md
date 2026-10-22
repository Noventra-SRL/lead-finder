# CRM commerciale (Fase 7)

Il CRM trasforma le aziende scoperte e qualificate in opportunità commerciali da seguire: fase della pipeline,
priorità, valore stimato, servizi proposti, attività registrate e follow-up. Nessun contatto parte in automatico:
ogni passo lo decide e lo registra una persona.

## Modello dei dati (`0007_crm.sql`)

| Tabella                    | Contenuto                                                                                                                                                             |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `crm_opportunities`        | azienda (`business_id`, riferimento a `businesses`), fase, priorità, responsabile, valore stimato in centesimi, note, motivo della perdita, chiusura, ultima attività |
| `crm_opportunity_services` | servizi proposti, scelti dal catalogo attivo di Noventra (Fase 5)                                                                                                     |
| `crm_activities`           | cronologia: attività registrate dal team e cambi di fase                                                                                                              |
| `crm_followups`            | prossime azioni con scadenza (data e ora facoltativa), stato in attesa / completato / annullato                                                                       |

I dati dell'azienda (nome, indirizzo, sito, recapiti, audit, punteggio, servizi consigliati) **non vengono copiati**:
il CRM li legge dalle tabelle esistenti. Le note commerciali restano nel CRM, separate dai dati pubblici dell'azienda.

### Regole

- **Una sola opportunità aperta per azienda** (indice unico parziale). Le opportunità chiuse restano come storico.
- Dopo la chiusura si può **riaprire** l'opportunità (scegliendo una fase aperta) oppure **crearne una nuova**, solo se
  l'azienda non ne ha un'altra aperta.
- Tra le fasi aperte ci si sposta liberamente: una trattativa reale può saltare passaggi.
- **Perso** richiede il motivo. Chiudere (Vinto, Perso, Non contattare) annulla i follow-up in attesa; il numero
  annullato è scritto nella cronologia.
- **Non contattare** esclude anche l'azienda dalla prospezione (Fase 6): non compare negli elenchi, nelle
  esportazioni e nelle nuove ricerche di lead. Per riaprire bisogna prima reincludere l'azienda dalla sua scheda.
- Un'azienda esclusa non può diventare una nuova opportunità; un'azienda unita a un'altra (duplicato) rimanda a quella
  mantenuta. Quando una persona unisce due duplicati, le opportunità passano all'azienda mantenuta, tranne il caso
  di due opportunità aperte: la scheda dell'opportunità lo segnala e una persona decide quale chiudere.
- Nessun lavoro automatico (scoperta, audit, ricalcolo del punteggio o dei servizi) modifica fase, priorità, valore,
  note, attività o follow-up.

## Pipeline

Da qualificare → Da contattare → Primo contatto effettuato → In attesa di risposta → Interessato → Call o
appuntamento fissato → Preventivo inviato → Negoziazione → **Vinto** / **Perso** / **Non contattare**.

Le fasi sono definite in `server/crm/model.ts` (stessa lista dei vincoli della migrazione) e arrivano all'interfaccia
da `/api/crm/meta`. Ogni cambio di fase crea un'attività "Cambio di fase" (da → a, con motivo o nota) e una voce
`crm.stage_changed` nel registro delle attività.

## Uso

1. **Aggiungere aziende**: dal _Database lead_ (anche filtrato per ricerca di lead, settore, territorio, punteggio,
   sito, «Non ancora nel CRM») seleziona le aziende e scegli **Aggiungi al CRM**: il riepilogo dice quante sono state
   aggiunte, quante saltate (già con un'opportunità aperta, escluse) e quante non riuscite. Oppure, dalla scheda di
   un'azienda, **Aggiungi al CRM** (se ha già un'opportunità aperta compare il collegamento per aprirla).
2. **Pipeline** (`/pipeline`): numeri della situazione e Kanban per fase. Ogni scheda mostra settore, comune e
   regione, punteggio del lead, priorità, servizi proposti (o consigliati), valore, prossima azione e ultima
   attività; i follow-up scaduti sono segnalati con un bordo e con la parola «Scaduto». Si sposta una scheda con il
   menu **Sposta in** (anche da tastiera e su telefono) o trascinandola su un'altra fase; chiudere chiede conferma.
3. **Scheda dell'opportunità** (`/pipeline/:id`): stato commerciale (fase, priorità, responsabile, valore, servizi,
   note), prossime azioni (crea, completa, sposta, annulla), cronologia (registra e modifica le attività), dati
   dell'azienda, rilievi dell'ultimo audit, punteggio del lead con spiegazione e servizi consigliati.
4. **Elenco** (`/pipeline/elenco`): ricerca per nome, comune o dominio; filtri per fase, stato, priorità, prossima
   azione, responsabile, territorio, settore, punteggio, sito, audit, servizio; ordinamento per ultima attività,
   scadenza, punteggio, creazione, valore, fase, nome. I filtri restano nell'indirizzo della pagina.
5. **Follow-up** (`/pipeline/follow-up`): filtri per scadenza, stato, priorità e fase, «Solo le mie opportunità»;
   completa, sposta, annulla; esportazione e filtri salvati. Dalla Fase 8 i follow-up hanno una priorità e si creano
   anche dalla scheda dell'azienda; promemoria e report in [flusso-commerciale.md](flusso-commerciale.md).

Le attività registrate a mano si modificano solo da chi le ha registrate o da un amministratore; i cambi di fase non
si modificano. Un'attività non può avere una data futura (per il futuro si pianifica un follow-up); un follow-up non
può avere una scadenza passata (una scadenza già superata può restare com'è).

## Numeri della dashboard

Tutti contati sulle righe del database, a ogni richiesta.

| Numero                 | Definizione                                                                                |
| ---------------------- | ------------------------------------------------------------------------------------------ |
| Opportunità aperte     | tutte tranne Vinto, Perso, Non contattare                                                  |
| Da qualificare         | opportunità ora nella fase «Da qualificare»                                                |
| Pronte da contattare   | opportunità ora nella fase «Da contattare»                                                 |
| Follow-up di oggi      | follow-up in attesa con scadenza oggi (ora italiana), di opportunità aperte                |
| Follow-up scaduti      | follow-up in attesa con scadenza prima di oggi, di opportunità aperte                      |
| Appuntamenti fissati   | opportunità ora nella fase «Call o appuntamento fissato»                                   |
| Preventivi inviati     | opportunità ora nella fase «Preventivo inviato»                                            |
| Vinte / Perse          | opportunità chiuse in quella fase                                                          |
| Valore pipeline attiva | somma dei valori stimati inseriti a mano sulle opportunità aperte (— se nessuna ne ha uno) |
| Valore vinto           | somma dei valori inseriti sulle opportunità vinte (— se nessuna ne ha uno)                 |

Il sistema non stima ricavi, probabilità di chiusura o tassi di conversione.

## Punteggio, servizi, priorità e fase

Sono quattro informazioni distinte, mostrate separatamente:

- **Punteggio del lead** (Fase 4): quanto l'azienda sembra adatta ai servizi di Noventra in base alle prove raccolte;
- **Corrispondenza dei servizi** (Fase 5): quali servizi e con quale corrispondenza;
- **Priorità commerciale**: decisa da una persona (alta, media, bassa);
- **Fase della pipeline**: a che punto è la trattativa.

Un ricalcolo del punteggio non cambia mai priorità, fase o altri dati del CRM.

## Sicurezza

- Tutte le rotte richiedono una sessione; il CRM è uno strumento interno condiviso tra amministratori e commerciali.
  Le attività si modificano solo dall'autore o da un amministratore.
- Ogni modifica avviene in una transazione con il blocco della riga dell'opportunità; l'unicità dell'opportunità
  aperta è garantita anche dal database.
- Validazione di identificativi, fasi, priorità, date (AAAA-MM-GG), ore (HH:MM), importi (≥ 0, al massimo due
  decimali), lunghezze dei testi, servizi (solo dal catalogo attivo) e responsabili (utenti attivi).
- Limiti: 600 modifiche ogni 15 minuti per utente, 30 aggiunte in blocco all'ora (al massimo 500 aziende ciascuna).
- Le note sono interne: non inserire dati personali non necessari.

## Test

- `server/crm/crm.test.ts` (PGlite e PostgreSQL): creazione per un'azienda esistente, nessun doppione, fasi e
  cronologia, motivo della perdita, note e attività (permessi), follow-up (creazione, completamento, annullamento,
  scadenze passate, scaduti), dashboard (conteggi e valori, chiuse escluse), filtri e Kanban, aggiunta in blocco,
  «non contattare», punteggi invariati e ricalcolo che non tocca il CRM, validazione e autorizzazione, aziende
  mancanti o unite, persistenza dopo il riavvio del server.
- `e2e/workflow-crm.spec.ts`: dal database lead al CRM, pipeline, scheda, follow-up, chiusura, accessibilità, telefono.
