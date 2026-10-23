# Email commerciali (Fase 9)

Voce **Email commerciali** nella barra laterale (`/email`): scegli un'azienda, prepari l'email dal modello ufficiale
di Noventra o la personalizzi con l'AI, la modifichi, la salvi e, solo dopo una conferma esplicita, la invii dal server
di posta di Noventra. L'invio viene registrato nel CRM.

Si può partire anche dalla scheda di un'azienda o di un'opportunità («Scrivi un'email»): l'azienda, e l'opportunità
se esiste, sono già selezionate.

## Invio rapido (due clic)

Da **Trova aziende**, dalla dashboard («I migliori prospect da contattare»), dalla vista «Da contattare» o dalla scheda
di un'azienda:

1. **Invia email** apre il composer con il messaggio già pronto: destinatario (l'email generica indicata dalla fonte),
   oggetto e testo dal modello ufficiale. Se l'AI è configurata, apertura e dettagli vengono personalizzati con le
   informazioni verificate; altrimenti, o se la personalizzazione non riesce, resta il modello standard (indicato nel
   composer). Se l'azienda ha già una bozza non inviata, viene ripresa invece di crearne un'altra.
2. Modifiche facoltative a destinatario, oggetto e testo.
3. **Conferma e invia** è la conferma esplicita: dichiara di aver riletto il messaggio e che il contatto è lecito
   (testo accanto al pulsante). Salva le modifiche e invia con un `requestId`: un doppio clic non invia due volte.

Tutti i controlli del server restano: destinatario valido, azienda «non contattare», invio configurato, esito incerto
del tentativo precedente. Il pulsante è disattivato senza email («Email non disponibile») o per le aziende da non
contattare. Se l'invio non riesce il messaggio resta nel composer, salvato, pronto per un nuovo tentativo. Il
risultato mostrato è quello del server di posta: «accettata» non significa consegnata. Per le revisioni AI complete,
gli avvisi dettagliati e la cronologia dei tentativi c'è l'editor completo (`/email/:id`).

## Stato del contatto

Ogni azienda ha uno stato del contatto calcolato dai dati salvati (`server/crm/contactStatus.ts`), mai da una bozza:

| Stato                 | Quando                                                                                                  |
| --------------------- | ------------------------------------------------------------------------------------------------------- |
| Non contattare        | Azienda esclusa dalla prospezione (prevale su tutto).                                                   |
| Cliente               | Opportunità di riferimento «Vinta».                                                                     |
| In trattativa         | Opportunità in fase «Interessato», «Appuntamento», «Preventivo» o «Negoziazione».                       |
| Perso                 | Opportunità di riferimento «Persa».                                                                     |
| In attesa di risposta | Almeno un contatto: email accettata dal server di posta o attività di contatto (chiamata, incontro, …). |
| Da contattare         | Nessun contatto registrato.                                                                             |

L'opportunità di riferimento è quella aperta, altrimenti la più recente. L'ultimo contatto è la data più recente tra
le email accettate e le attività di contatto. La pagina **Email commerciali** ha tre viste: **Da contattare** (con
email, in ordine di punteggio), **In attesa** (per ultimo contatto, con «Registra la risposta» che apre la trattativa)
e **Storico** (tutti i messaggi, per stato).

## Modello ufficiale

Il **Modello commerciale standard Noventra** è una costante del codice (`server/email/template.ts`) e nessuna
generazione lo modifica. Oggetto predefinito: «Un sito web professionale per la tua attività | Noventra». Contatti
ufficiali: https://www.noventra.it/, staff@noventra.it, 081 091 0236.

### Modello Farmacube (farmacie)

Per le aziende della categoria **Farmacie** la bozza parte dal modello **Farmacube — e-commerce per farmacie**
(versione 1, `farmacube` in `server/email/template.ts`), oggetto «Una soluzione e-commerce pensata per la sua
farmacia | Farmacube», con il testo approvato (le parti in grassetto diventano righe normali: le email sono testo
semplice). Parafarmacie e tutte le altre categorie usano il modello standard Noventra.

- La bozza registra modello e versione (`template_id`, `template_version`, migrazione `0016`); il destinatario è
  l'email dell'attività salvata sulla scheda.
- Nell'editor si può scegliere a mano il modello («Modello») e ripristinare in ogni momento il testo ufficiale
  («Ripristina modello ufficiale»); la versione precedente resta nelle revisioni.
- Il modello ufficiale resta il predefinito anche con l'AI configurata: il composer rapido non personalizza da solo le
  farmacie. «Personalizza con AI» cambia solo apertura, un paragrafo di pertinenza e la domanda finale; saluto,
  presentazione, funzioni di Farmacube, obiettivo, link, consulenza gratuita e firma restano identici.
- Senza un sito della farmacia verificato non c'è nulla di vero da personalizzare: la richiesta viene rifiutata
  (`INSUFFICIENT_EVIDENCE`), il fornitore AI non viene chiamato e il testo ufficiale resta invariato.
- La validazione rifiuta una variante che affermi che la farmacia ha o non ha un sito o un e-commerce, o che citi
  gestionali, grossisti, fatturato o vendite; l'oggetto deve contenere «Farmacube».
- All'invio l'attività del CRM registra il modello e la versione usati.

## Due modalità

| Modalità                    | Cosa cambia                                                                                                                                                                                                                                    |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Modello standard            | Nulla: testo e oggetto ufficiali, identici. Nessuna chiamata all'AI.                                                                                                                                                                           |
| Email personalizzata con AI | L'AI scrive solo **oggetto, apertura, un'osservazione facoltativa sul sito, il perché Noventra è pertinente e l'invito finale**. Presentazione, vantaggi, consulenza gratuita, preventivo entro 24 ore, sito e firma restano quelli ufficiali. |

Le scelte della modalità AI sono:

- **obiettivo**: presentare Noventra, nuovo sito, rinnovamento del sito, e-commerce, servizio specifico, call conoscitiva, follow-up;
- **tono**: professionale e diretto, cordiale e consulenziale, formale, breve e informale;
- **istruzioni** facoltative.

Gli obiettivi legati a un servizio compaiono solo se il servizio è nel catalogo attivo. Il **follow-up** è disponibile
solo se il CRM registra un contatto precedente (email inviata o attività di contatto).

### Dati usati e regole sulle prove

La personalizzazione usa i dati già presenti nell'applicazione, numerati come prove (stesso contesto della valutazione
AI):

- nome, settore e sede dell'azienda;
- stato del sito;
- audit tecnico e rilievi;
- capacità del sito;
- servizi abbinati dal catalogo;
- fasi del CRM;
- tipo e data dei contatti precedenti.

**Mai inviati** al fornitore AI:

- le note del CRM;
- telefoni ed email;
- i dati di altre aziende.

Il server valida la risposta prima di salvarla e la rifiuta (con un secondo tentativo, poi errore) se le parti scritte
dall'AI contengono:

- indirizzi web, email o telefoni;
- prezzi, sconti o percentuali;
- numeri non presenti nelle prove;
- nomi o titoli di persone;
- urgenza o garanzie;
- clienti, progetti o risultati citati;
- un contatto precedente che il CRM non registra;
- prove o servizi inesistenti.

Un'osservazione sul sito senza prove del sito o dell'audit viene tolta. Le prove usate e le note interne (fatti
verificati, deduzioni, cose non note) restano nella colonna laterale e **non entrano nel testo dell'email**.

Dalla versione 2 del prompt (`EMAIL_PROMPT_VERSION = 2`) la validazione rifiuta anche:

- una proposta, un'analisi o un preventivo dichiarati «già preparati»;
- promesse di risultati (clienti, vendite o prenotazioni «garantiti», «aumenterete sicuramente», «raddoppiare»);
- «ho analizzato / visitato il vostro sito» quando non esiste un rilievo verificato del sito;
- un servizio principale che non è tra i servizi citati.

### Una email diversa per ogni azienda

Il prompt chiede apertura e pertinenza legate a tipo di attività, città e prove disponibili, con formulazioni varie, e
**un solo servizio principale** (più uno o due complementari al massimo). Con poche prove (solo nome, categoria e
città) l'email è una presentazione cortese per il settore, senza osservazioni specifiche.

Ogni bozza AI salva una nota interna «Perché questa email», mostrata nel composer e nell'editor, mai nel testo:

| Campo               | Origine                                                                                                                              |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| Sintesi             | Scritta dal modello (1-2 frasi), controllata in lunghezza                                                                            |
| Servizio principale | Dal catalogo, validato dal server                                                                                                    |
| Qualità delle prove | Calcolata dal server: **alta** (osservazione sul sito con rilievi e ≥3 prove), **media** (≥2 prove, almeno una specifica), **bassa** |
| Avvisi              | Calcolati dal server: sito non verificato, prove limitate, osservazione tolta, cose non note                                         |
| Versione e impronta | `promptVersion`, modello, data di generazione e `evidenceHash` (impronta delle prove usate)                                          |

L'impronta delle prove dice su quale versione dei dati è stata scritta la bozza: se l'audit o i dati dell'azienda
cambiano, si può decidere di rigenerare. Nulla viene rigenerato da solo.

### Testi esterni

Nomi, rilievi dei siti e percorsi delle pagine sono dati non attendibili:

- sono ripuliti e passati in un blocco JSON con `<` e `>` neutralizzati, quindi non possono chiudere il blocco;
- il prompt chiede di ignorare qualsiasi istruzione contenuta nei dati;
- la validazione blocca comunque gli effetti tipici di un'istruzione nascosta (sconti, telefoni, link).

### Quando l'AI viene chiamata

Aprire la pagina o una bozza già esistente non chiama mai l'AI: si genera solo con «Genera con AI», con «Rigenera»
(composer ed editor) o alla prima apertura del composer rapido per una bozza nuova. Rigenerare chiede conferma se ci
sono modifiche non salvate; la versione precedente resta nelle revisioni. Il composer offre anche «Copia» (oggetto e
testo) e «Salva bozza», che non inviano nulla: l'unico invio è «Conferma e invia». Se l'AI non è configurata o
fallisce, il testo attuale non cambia e il modello standard resta disponibile. Limite: 60 generazioni all'ora per
utente.

## Bozze e stati

| Stato              | Significato                                                                                                                             |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------- |
| Bozza              | Testo salvato, dal modello o modificato.                                                                                                |
| Da revisionare     | Testo appena generato dall'AI: va riletto (il numero compare accanto alla voce del menu).                                               |
| Pronta per l'invio | Scelto esplicitamente da una persona.                                                                                                   |
| Inviata            | Il server SMTP ha **accettato** il messaggio (risposta 250). Non prova la consegna nella casella del destinatario: nessun tracciamento. |
| Invio non riuscito | Errore del server o della rete; la bozza resta intatta. Con «esito incerto» il messaggio potrebbe essere partito.                       |
| Archiviata         | Fuori dalle bozze, ripristinabile.                                                                                                      |

### Protezioni

- Ogni testo generato o salvato è una **revisione**: rigenerare dopo modifiche salvate richiede conferma (409
  `EDITS_WOULD_BE_LOST` senza `overwrite`) e la versione precedente resta.
- Modifiche non salvate: l'interfaccia chiede conferma prima di sostituirle.
- Versione ottimistica: un salvataggio da una scheda vecchia viene rifiutato.
- Nuova bozza con `requestId`: ricaricare o fare doppio clic non crea doppioni.

## Invio

### Configurazione

L'invio usa un server SMTP configurato sul server (`nodemailer`, versione fissata):

- `SMTP_HOST`, `SMTP_PORT`;
- `SMTP_SECURITY`: `starttls` predefinito, `tls`, oppure `none` solo verso 127.0.0.1;
- `SMTP_USER`, `SMTP_PASSWORD`;
- `EMAIL_FROM_ADDRESS`: predefinito staff@noventra.it quando un server è configurato;
- `EMAIL_FROM_NAME`, `EMAIL_REPLY_TO`;
- `EMAIL_SENDER_AUTHORIZED`;
- `EMAIL_TIMEOUT_SECONDS`.

Le credenziali restano sul server: mai nelle risposte, nei registri o nei messaggi d'errore salvati.

Stato mostrato nella pagina:

| Stato                           | Quando                                                                                                                                                           |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Configurazione email mancante   | Nessun server SMTP: bozze, generazione e copia funzionano, l'invio è disattivato con l'elenco delle variabili da impostare.                                      |
| Verifica necessaria             | L'amministratore non ha ancora confermato `EMAIL_SENDER_AUTHORIZED=si` (il server SMTP deve poter inviare da quel mittente: SPF/DKIM del dominio).               |
| Errore del provider             | L'ultima verifica o l'ultimo invio ha avuto un problema di connessione, autenticazione o mittente.                                                               |
| Configurazione email completata | Mittente autorizzato e connessione verificata (all'avvio, con «Verifica connessione» degli amministratori o prima del primo invio; la verifica non invia nulla). |

### Flusso

1. **Invia email** è disponibile solo con le modifiche salvate.
2. Il dialogo di conferma mostra azienda, destinatario, oggetto e mittente, i **blocchi** e gli **avvisi**:
   - blocchi: destinatario mancante o non valido, azienda «non contattare», email già inviata, invio non configurato;
   - avvisi: indirizzo non verificato (pubblico dalla fonte o inserito a mano), testo AI non rivisto, email già
     inviata alla stessa azienda negli ultimi 90 giorni, contatti nel CRM negli ultimi 30 giorni, esito incerto del
     tentativo precedente.
3. Servono due conferme: «Ho riletto…» e «Il contatto è lecito…». Il dialogo ricorda che un recapito pubblico non
   autorizza automaticamente comunicazioni commerciali (GDPR, Codice privacy). Annulla non invia nulla.
4. Il server ripete i controlli e porta l'email in «sending» in modo atomico (due invii contemporanei: ne parte uno).
   Poi invia con un Message-ID proprio `<id-tentativo@dominio-del-mittente>`, in solo testo, senza HTML né pixel.
5. Esito:
   - **accettata**: stato «Inviata» e attività «Email commerciale inviata» nel CRM, con la data di invio come ultimo
     contatto. Se l'azienda non aveva un'opportunità aperta, ne viene creata una, come annunciato nella conferma. Se
     l'opportunità è «Da qualificare» o «Da contattare» passa a «In attesa di risposta», con un'attività di cambio
     fase («Aggiornata automaticamente dopo l'invio dell'email commerciale»). Le fasi più avanzate non cambiano e
     un'opportunità non diventa mai «Vinta» o «Persa» da sola.
   - **errore**: stato «Invio non riuscito», bozza intatta, nessuna attività. Se l'esito è incerto, ritentare
     richiede di confermare di aver controllato la posta inviata.

### Protezione dai doppi invii

Ogni conferma ha un `requestId`: ripeterla, per esempio con un doppio clic o una rete instabile, restituisce l'esito
già registrato senza inviare di nuovo. Un invio rimasto «in corso» per un riavvio del server diventa «non riuscito,
esito incerto», mai «Inviata».

### Limiti

- Nessun invio massivo, automatico o di follow-up.
- Nessun tracciamento di aperture o clic.
- 40 invii all'ora per utente.

## Storico e registro

- Ogni email è legata all'azienda e all'opportunità aperta.
- Scheda azienda e scheda opportunità mostrano la sezione «Email commerciali» con bozze e inviate distinte dallo stato.
- Nella pagina dell'email: revisioni, tentativi di invio (esito, errore sicuro da mostrare) e altre email alla stessa
  azienda.
- Registro delle operazioni: `email.created`, `email.generated`, `email.sent`, `email.send_failed`, `email.verified`.

## Attivare «Email personalizzata con AI»

Il messaggio «Personalizzazione AI non configurata sul server» compare quando il server è partito senza chiave del
fornitore: l'integrazione (Anthropic, SDK ufficiale, solo lato server) è presente, manca la credenziale.

1. Crea una chiave API su console.anthropic.com (account con credito o fatturazione attiva).
2. Nel file `.env` del server (mai nel frontend, mai nel repository): `AI_API_KEY=<la chiave>`. Facoltativi:
   `AI_MODEL` (predefinito `claude-opus-5-5`; `claude-sonnet-5-5` o `claude-haiku-5-5` costano meno),
   `AI_TIMEOUT_SECONDS` (120), `AI_MAX_RETRIES` (3).
3. **Attenzione ai costi**: con `AI_AUTO_ASSESS=on` la stessa chiave avvia anche la valutazione automatica di tutte
   le aziende (limite giornaliero `AI_AUTO_DAILY_LIMIT`). Per usare l'AI solo per le email imposta
   `AI_AUTO_ASSESS=off`.
4. Riavvia il server (`npm run start:api`). All'avvio la chiave viene verificata leggendo le informazioni del modello
   (nessun testo generato, nessun costo in token): nel registro compare «fornitore AI raggiungibile, chiave valida»
   oppure il motivo dell'errore. Gli amministratori possono ripetere la verifica con `POST /api/ai/verify`.
5. Apri una bozza, scegli «Email personalizzata con AI» e premi «Genera email personalizzata».

Errori mostrati (il testo della bozza non cambia mai in caso di errore):

| Situazione                         | HTTP | Messaggio                                                                             |
| ---------------------------------- | ---- | ------------------------------------------------------------------------------------- |
| Chiave assente                     | 503  | Personalizzazione AI non configurata sul server: impostare AI_API_KEY…                |
| Chiave non valida o senza permessi | 502  | Chiave del fornitore AI non valida o senza permessi: controlla AI_API_KEY…            |
| Modello inesistente                | 502  | Richiesta rifiutata dal fornitore AI: controlla AI_MODEL                              |
| Limite di richieste                | 429  | Limite di richieste del fornitore AI raggiunto: riprova più tardi                     |
| Tempo scaduto                      | 502  | Il fornitore AI non ha risposto in tempo                                              |
| Fornitore non raggiungibile        | 502  | Fornitore AI non raggiungibile                                                        |
| Risposta non valida (due volte)    | 422  | Bozza generata non conforme: …                                                        |
| Generazione già in corso           | 409  | Generazione già in corso per questa email                                             |
| Poche informazioni sull'azienda    | 200  | Bozza generata e segnalata: qualità delle prove «bassa», presentazione per il settore |
| Salvataggio non riuscito           | —    | Bozza non salvata: controlla la connessione e riprova                                 |

## Configurazione richiesta per inviare davvero (Google Workspace)

La casella di invio è **staff@noventra.it** su Google Workspace: STARTTLS sulla porta 587, accesso con l'indirizzo
completo e una **password per le app** (la password normale non funziona).

1. **Password per le app**: con l'account staff@noventra.it, Account Google → Sicurezza → Verifica in due passaggi
   (attiva) → Password per le app → crea «Noventra Lead Finder». Se la voce non c'è, l'amministratore di Workspace deve
   consentire le password per le app (Console di amministrazione → Sicurezza) o configurare un relay SMTP.
2. **Sviluppo (locale)**: nel file `.env` (ignorato da Git; non viene mai sovrascritto dall'applicazione):

   ```
   SMTP_HOST=smtp.gmail.com
   SMTP_PORT=587
   SMTP_SECURE=false
   SMTP_USER=staff@noventra.it
   SMTP_PASS=<password per le app, 16 lettere>
   EMAIL_SENDER=staff@noventra.it
   EMAIL_SENDER_NAME=Noventra
   EMAIL_SENDER_AUTHORIZED=si
   ```

   Sono accettati anche i nomi precedenti (`SMTP_SECURITY`, `SMTP_PASSWORD`, `EMAIL_FROM_ADDRESS`,
   `EMAIL_FROM_NAME`); due nomi della stessa impostazione con valori diversi fermano l'avvio con un errore. Gli spazi
   della password per le app mostrata da Google vengono tolti.

3. **Produzione (hosting)**: le stesse variabili nelle variabili d'ambiente del servizio (pannello «Environment» /
   «Secrets» del provider, o il file di ambiente del servizio systemd con permessi 600), mai nel repository né nel
   frontend. In produzione SMTP senza cifratura è rifiutato all'avvio.
4. **Mittente autorizzato**: `EMAIL_SENDER_AUTHORIZED=si` solo dopo aver verificato che il dominio noventra.it ha SPF
   (`include:_spf.google.com`) e DKIM di Google attivi.
5. **Riavvio** del server, poi da Impostazioni → «Invio email» (solo amministratori):
   - «Verifica connessione»: connessione e autenticazione, nessun messaggio inviato → «Connessione verificata» oppure
     «Errore di autenticazione» / «Errore di connessione»;
   - «Invia email di prova»: un solo messaggio all'indirizzo scritto e confermato → «Invio di prova riuscito» (il
     server di Google l'ha accettato; la consegna nella casella non è confermata) oppure «Invio non riuscito». La
     prova non è un'email commerciale e non entra nel CRM (solo nel registro delle operazioni: `email.test_sent`).

Ogni email parte come testo semplice più la sua versione HTML (generata dal testo: paragrafi, elenchi, link; nessuna
immagine né tracciamento). Il mittente è sempre quello configurato: una richiesta che prova a indicarne un altro è
rifiutata.

## Test

Tutti con fornitori finti: nessuna email reale, nessuna chiamata AI a pagamento.

- `server/email/email.test.ts`: modello e contatti ufficiali, due modalità, fatti inventati rifiutati, prove separate
  dal testo, istruzioni nascoste nei dati, AI assente o in errore, bozze (doppioni, revisioni, rigenerazione protetta,
  versioni, archiviazione), CRM, invio (non configurato, mittente non autorizzato, conferme, destinatario, successo,
  ripetizione della conferma, invii contemporanei, errore, esito incerto, non contattare), adattatore SMTP reale contro
  un server SMTP finto locale, configurazione.
- `e2e/workflow-email.spec.ts`: voce del menu e pagina, preselezione da opportunità e azienda, generazione AI con
  revisione, rigenerazione con modifiche non salvate, conferma di invio (annulla e invia), registrazione nel CRM, invio
  rifiutato con bozza intatta, archiviazione, filtri, telefono, accessibilità.
- `server/email/email.test.ts` («flusso rapido»): stato del contatto (bozza e invio fallito non contano, invio accettato
  sì), ripresa della bozza aperta, passaggio a «In attesa di risposta», fasi avanzate intatte, «non contattare» che
  prevale, filtro per email, numeri della dashboard.
- `e2e/workflow-rapido.spec.ts`: da «Trova aziende» due clic fino all'invio accettato dal server SMTP finto, rifiuto con
  messaggio intatto, vista «In attesa», attività e fase nel CRM, pulsante disattivato senza email e per le aziende da
  non contattare.
