# Abbinamento ai servizi (Fase 5)

Per ogni azienda il sistema indica quali servizi di Noventra potrebbero essere pertinenti, **con quali prove**, quale
proporre per primo, quale problema risolverebbe e **cosa verificare prima di una proposta**. È un aiuto per chi vende:
una corrispondenza indica una possibile pertinenza, **non una domanda confermata né un'intenzione di acquisto**. Nessun
messaggio viene inviato e nessuna azienda viene contattata in automatico.

## Catalogo dei servizi

Fonte: il sito ufficiale https://www.noventra.it/ e le pagine dei singoli servizi, consultati il 21/10/2026. Il catalogo
contiene solo servizi pubblicati lì; ogni voce conserva l'indirizzo della sua pagina (`source`) e il flag `verified`. Un
servizio non confermato non può essere attivo (regola di validazione).

| Servizio (id)                                           | Area      | Abbinamento                   | Note                                                                                     |
| ------------------------------------------------------- | --------- | ----------------------------- | ---------------------------------------------------------------------------------------- |
| Sviluppo siti web (`sviluppo_siti_web`)                 | Sviluppo  | automatico                    | mobile, errori, collegamenti, prestazioni, impaginazione superata                        |
| Web design & brand identity (`web_design`)              | Sviluppo  | automatico                    | servizi non presentati, inviti all'azione, contatti                                      |
| SEO Optimization (`seo`)                                | Marketing | automatico                    | indicizzazione, titoli, descrizioni, dati strutturati, sitemap, SEO locale               |
| GEO (`geo`)                                             | Marketing | automatico                    | dati strutturati per i motori di risposta AI                                             |
| E-commerce Shopify (`ecommerce_shopify`)                | Sviluppo  | automatico                    | catalogo senza vendita online; escluso se un negozio online c'è già                      |
| Farmacube (`farmacube`)                                 | Sviluppo  | automatico (solo farmacie)    | verifica obbligatoria dell'autorizzazione alla vendita online di farmaci                 |
| Gestionali web & CRM (`gestionali_crm`)                 | Sviluppo  | automatico, **da confermare** | prenotazioni e appuntamenti: la pagina del servizio non li descrive per i clienti finali |
| Server, hosting & assistenza (`hosting_assistenza`)     | Sviluppo  | automatico                    | HTTPS, certificati, errori del server, sito irraggiungibile in modo ripetuto             |
| E-commerce Magento (`ecommerce_magento`)                | Sviluppo  | solo a colloquio              | ampiezza del catalogo e integrazioni non osservabili                                     |
| App mobile iOS & Android (`app_mobile`)                 | Sviluppo  | solo a colloquio              | non si deduce che serva un'app perché manca                                              |
| Automazioni AI & Bot Telegram (`automazioni_ai_bot`)    | Sviluppo  | solo a colloquio              |                                                                                          |
| Software su misura & Vibe Coding (`software_su_misura`) | Sviluppo  | solo a colloquio              |                                                                                          |
| Intelligenza artificiale (`intelligenza_artificiale`)   | Sviluppo  | solo a colloquio              |                                                                                          |
| Digital marketing (`digital_marketing`)                 | Marketing | solo a colloquio              | nessun dato su traffico, conversioni o campagne                                          |
| Web advertising (`web_advertising`)                     | Marketing | solo a colloquio              | idem                                                                                     |

"Solo a colloquio": il servizio è reale e attivo, ma le prove raccolte automaticamente non dicono se l'azienda ne abbia
bisogno; non viene mai proposto dal sistema, una persona può segnarlo nella scheda dopo un colloquio. Il sito non
pubblica pagine di landing page o di gestione dei social come servizi a sé: non sono nel catalogo.

Ogni voce del catalogo contiene: id stabile, nome, area, descrizione, problemi che risolve, pertinenza per settore,
rilievi dell'audit pertinenti (con importanza), capacità la cui mancanza risolve, prova di sito irraggiungibile
ripetutamente, contesto favorevole, condizioni di esclusione, gruppo di problemi (per non proporre due servizi per lo
stesso problema), prerequisiti, verifiche da fare, stato attivo, abbinamento automatico e conferma del team.

## Formula

Per ogni servizio attivo e abbinabile in automatico, cinque dimensioni (0–100):

| Dimensione                    | Peso iniziale | Come si calcola                                                                                         |
| ----------------------------- | ------------: | ------------------------------------------------------------------------------------------------------- |
| Rilievi dell'audit pertinenti |            35 | Σ importanza × gravità (30/15/5/0) × affidabilità (1/0,75/0,5) dei rilievi del servizio; 60 punti = 100 |
| Capacità mancanti             |            25 | lacune pesate: assente (misurato) 1,0, non rilevato 0,6, presente 0; sconosciute escluse                |
| Pertinenza del settore        |            15 | valore configurato per il settore dell'azienda                                                          |
| Affidabilità delle prove      |            15 | affidabilità della Fase 4 (× 0,75 se il servizio si basa solo su elementi "non rilevati")               |
| Contesto verificato           |            10 | segnali favorevoli (es. catalogo presente per l'e-commerce, telefono indicato dalla fonte)              |

```
corrispondenza = Σ (valore × peso) / Σ pesi delle dimensioni con prove
```

Una dimensione senza prove (o non prevista per il servizio, es. GEO non ha capacità collegate) è esclusa: non vale
0 né 100. La **completezza** dell'abbinamento è la quota dei pesi con prove.

**Il punteggio del lead (Fase 4) non entra nel calcolo**: un'azienda in priorità alta può non avere servizi pertinenti e
una in priorità bassa può avere un servizio fortemente pertinente. L'interfaccia mostra separati: punteggio del lead,
corrispondenza di ogni servizio, affidabilità delle prove e stato della revisione.

## Stati

| Stato                   | Quando                                                                                                                     |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `recommended`           | corrispondenza ≥ 60 con una prova di bisogno                                                                               |
| `possible`              | corrispondenza 40–59 con una prova di bisogno                                                                              |
| `needs_review`          | servizio da confermare con il team, affidabilità < 45 o audit superato (oltre 120 giorni)                                  |
| `insufficient_evidence` | nessun sito indicato (assenza non verificata), sito mai verificato, non raggiunto una volta o bloccato, indirizzo cambiato |
| `not_relevant`          | settore non pertinente, condizione di esclusione, nessuna prova di bisogno, corrispondenza < 40                            |

Senza almeno **una prova di bisogno** (un rilievo pertinente, una capacità assente o non rilevata, un sito
irraggiungibile in audit consecutivi) il servizio non è proposto: il settore da solo non basta mai. Un sito non
raggiunto una volta o che nega l'accesso non è un sito "rotto" né "assente".

Revisione di una persona (registrata a parte, solo aggiunte, valida anche dopo i ricalcoli):
`accepted_for_review` (accettato per la valutazione commerciale), `dismissed` (archiviato, con motivo facoltativo),
`needs_review` (da verificare a mano), `reopened` (annulla la decisione), `note`. Un servizio archiviato esce dalla
lista breve ma resta consultabile con il motivo; se le prove cambiano dopo la decisione la scheda lo segnala.

## Lista breve

Servizi consigliati, possibili o da verificare, non archiviati, ordinati per corrispondenza (gli accettati in testa),
**uno per gruppo di problemi** (es. SEO o GEO, un solo e-commerce), al massimo **3** (configurabile) e **1** se le prove
sono poco affidabili. Se le prove sono deboli la lista è più corta o vuota: non viene mai riempita.

## Regole di settore

La pertinenza per settore è nel catalogo. Esempi della versione iniziale: Farmacube solo per farmacie (90) e
parafarmacie (85); e-commerce Shopify soprattutto per negozi (85) e parafarmacie (60), mai per ristoranti o studi;
gestionali per hotel, strutture extralberghiere, studi sanitari e palestre (80), ristorazione (70); sviluppo, design, SEO,
GEO e hosting per tutti i settori (70). Le capacità usate sono le stesse della Fase 4 con gli stessi stati.

## Ricalcolo

L'abbinamento si calcola nello stesso lotto del punteggio della Fase 4, quindi si aggiorna negli stessi momenti:
dopo ogni audit (per tutte le aziende con quel sito), al termine di una ricerca, su richiesta dalla scheda
("Ricalcola i servizi consigliati") o in blocco (`POST /api/scoring/jobs`, "Ricalcola punteggi e abbinamenti" nel
catalogo). Una nuova esecuzione si crea solo se cambiano i dati in ingresso (audit, rilievi, settore, attributi
verificati, freschezza dell'audit), la configurazione del punteggio, il catalogo o l'algoritmo; altrimenti non si scrive
nulla. Le esecuzioni precedenti restano nello storico; un abbinamento attuale per azienda e servizio è garantito da un
indice univoco.

## Configurazione

Pagina **Catalogo servizi**: tutti consultano servizi, regole e versioni; gli amministratori attivano o disattivano i
servizi, modificano pesi, soglie e lunghezza della lista e, nel JSON completo, descrizioni, settori, rilievi, capacità,
esclusioni e verifiche. "Verifica" controlla senza salvare; ogni salvataggio crea una nuova versione con nota e autore
(registro delle attività). Via API: `PUT /api/service-catalog` con `{ "catalog": { … }, "note": "…" }`.
Dopo una modifica, ricalcolare per applicarla: gli abbinamenti esistenti indicano la versione con cui sono stati calcolati.

## Dati (migrazione 0005)

| Tabella                    | Contenuto                                                                                                                      |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `service_catalog_versions` | catalogo e regole, una versione per modifica                                                                                   |
| `service_match_runs`       | un'esecuzione per azienda (impronta, catalogo, algoritmo, punteggio e audit usati, attuale)                                    |
| `service_matches`          | corrispondenza per servizio: stato, punteggio, dimensioni, prove (rilievi, capacità), segnali, problema, spiegazione, verifica |
| `service_match_reviews`    | decisioni e note delle persone, solo aggiunte                                                                                  |

`scoring_jobs.matches_created` conta le esecuzioni create dai ricalcoli in blocco.

## API

Vedi [api.md](api.md#servizi-e-abbinamento).

## Test

- `npm test` / `npm run test:postgres`: motore (determinismo, normalizzazione, configurazione non valida, sconosciuto
  contro assente, settore, rilievi → servizi, intestazioni di sicurezza da sole, sito curato, senza sito, irraggiungibile
  una volta e ripetutamente, audit parziale e superato, soglie, separazione dal punteggio del lead, lista breve,
  gruppi, archiviati e accettati); API (accesso, catalogo solo da amministratore, revisioni conservate dopo i ricalcoli,
  nessuna esecuzione nuova a prove invariate, storico dopo un nuovo audit, calcoli contemporanei, filtri, ordinamento,
  paginazione, disattivazione di un servizio, job in blocco non riuscito).
- `npm run test:e2e`: catalogo, servizi consigliati nella scheda, archiviazione con motivo e riapertura, accettazione,
  nota, filtri dell'elenco, sito irraggiungibile, modifica del catalogo da amministratore, telefono.

## Limiti noti

- Le prove sono quelle dell'audit (3 pagine, senza JavaScript): capacità e contenuti "non rilevati" possono esistere
  altrove; per questo pesano meno e lo stato lo dichiara.
- Per marketing, pubblicità, app e software su misura non esistono prove automatiche: restano "solo a colloquio".
- La prenotazione online per i clienti finali non è descritta esplicitamente nelle pagine dei servizi: gli abbinamenti
  di Gestionali web & CRM sono sempre "da verificare" con il team.
- L'assenza di un sito non è confermabile con le fonti attuali: nessun servizio viene proposto a chi non ha un sito indicato.
- Il catalogo riflette il sito al 21/10/2026: se Noventra cambia i servizi, va aggiornato dalla pagina Catalogo servizi.
