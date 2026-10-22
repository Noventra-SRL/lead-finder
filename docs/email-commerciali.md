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

### Testi esterni

Nomi, rilievi dei siti e percorsi delle pagine sono dati non attendibili:

- sono ripuliti e passati in un blocco JSON con `<` e `>` neutralizzati, quindi non possono chiudere il blocco;
- il prompt chiede di ignorare qualsiasi istruzione contenuta nei dati;
- la validazione blocca comunque gli effetti tipici di un'istruzione nascosta (sconti, telefoni, link).

### Quando l'AI viene chiamata

Aprire la pagina o una bozza non chiama mai l'AI: si genera solo con «Genera con AI». Se l'AI non è configurata o
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
- `EMAIL_SENDER_AUTHORIZED`: `si` forza l'autorizzazione del mittente (vedi «Controllo DNS del mittente»);
- `EMAIL_DKIM_SELECTOR`: selettori DKIM del provider, separati da virgola (vuoto = i più comuni);
- `EMAIL_TIMEOUT_SECONDS`.

### Controllo DNS del mittente

All'avvio del server e con «Verifica connessione» il dominio di `EMAIL_FROM_ADDRESS` viene controllato via DNS
(`server/email/deliverability.ts`, nessun messaggio inviato, nessun servizio a pagamento):

| Controllo    | Superato quando                                                                        |
| ------------ | -------------------------------------------------------------------------------------- |
| MX           | almeno un server di posta                                                              |
| SPF          | un solo record `v=spf1`, senza `+all`/`all` (`?all` = attenzione)                      |
| DKIM         | chiave pubblica trovata per i selettori indicati o, in mancanza, tra quelli più comuni |
| DMARC        | politica `quarantine` o `reject` (`none` = attenzione, accettata)                      |
| Spamhaus DBL | dominio non elencato                                                                   |
| Spamhaus ZEN | IP del server SMTP non elencato (solo per server non locali)                           |

Se MX, SPF, DKIM e DMARC sono a posto e nessuna blocklist elenca il dominio o il server, il mittente è autorizzato
senza `EMAIL_SENDER_AUTHORIZED` (lo stato indica «autorizzato dal controllo DNS»). Il dettaglio è nella barra dello
stato dell'invio.

Limiti: gli `include:` dell'SPF non vengono espansi, quindi un SPF presente non prova che il server SMTP configurato sia
tra quelli autorizzati; Spamhaus non risponde ai DNS pubblici (8.8.8.8, 1.1.1.1) e in quel caso il controllo è «non
verificabile» e non blocca; nessuna prova di consegna in casella (servono gli strumenti del provider).

Le credenziali restano sul server: mai nelle risposte, nei registri o nei messaggi d'errore salvati.

Stato mostrato nella pagina:

| Stato                           | Quando                                                                                                                                                           |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Configurazione email mancante   | Nessun server SMTP: bozze, generazione e copia funzionano, l'invio è disattivato con l'elenco delle variabili da impostare.                                      |
| Verifica necessaria             | Il dominio del mittente non supera il controllo DNS e l'amministratore non ha impostato `EMAIL_SENDER_AUTHORIZED=si`.                                            |
| Errore del provider             | L'ultima verifica o l'ultimo invio ha avuto un problema di connessione, autenticazione o mittente.                                                               |
| Configurazione email completata | Mittente autorizzato e connessione verificata (all'avvio, con «Verifica connessione» degli amministratori o prima del primo invio; la verifica non invia nulla). |

### Flusso

1. **Invia email** è disponibile solo con le modifiche salvate.
2. Il dialogo di conferma mostra azienda, destinatario, oggetto e mittente, i **blocchi** e gli **avvisi**:
   - blocchi: destinatario mancante o non valido, azienda «non contattare», email già inviata, invio non configurato;
   - avvisi: indirizzo non verificato (pubblico dalla fonte o inserito a mano), testo AI non rivisto, email già
     inviata alla stessa azienda negli ultimi 90 giorni, contatti nel CRM negli ultimi 30 giorni, esito incerto del
     tentativo precedente.
   - controlli sul testo (`server/email/gate.ts`, da Harvey): blocchi per segnaposto non sostituiti (`{nome}`,
     `[AZIENDA]`) e codice HTML; avvisi per oggetto oltre 90 caratteri o tutto maiuscolo, testo oltre 450 parole,
     espressioni penalizzate dai filtri antispam («gratis», «clicca qui», «!!», …) e link a siti diversi da
     noventra.it. Il modello ufficiale li supera senza avvisi.
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

### Sequenze di follow-up

Cadenza portata da Harvey (`server/email/sequence.ts`, migrazione 0012):

1. Quando il server di posta accetta il primo messaggio, viene creata la **bozza** del secondo, prevista 3 giorni dopo
   l'invio; quando accetta il secondo, la bozza del terzo e ultimo, prevista 4 giorni dopo. Testi standard brevi
   (`followUpEmail` in `server/email/template.ts`), oggetto «Re: …» del primo messaggio.
2. Nessun follow-up parte da solo: la vista **Follow-up** (`/email?vista=follow-up`) elenca quelli da inviare, in
   programma o fermati; si aprono nell'editor e si inviano con la stessa conferma esplicita.
3. Il follow-up parte nello stesso thread (`In-Reply-To` e `References` verso i messaggi già inviati della sequenza).
4. La sequenza si ferma da sola, ed è un **blocco** nella conferma, se: l'azienda ha risposto o un messaggio è tornato
   indietro (lettura della casella, sotto), l'azienda è «non contattare», l'opportunità è oltre «In attesa di risposta»
   o dopo il primo messaggio è registrata nel CRM una telefonata, una conversazione o un incontro.
5. Inviarlo prima della data prevista è possibile, con un avviso. I passi della stessa sequenza non generano l'avviso
   «già inviata a questa azienda».

### Limiti

- Nessun invio massivo o automatico: anche i follow-up partono solo con una conferma.
- Nessun tracciamento di aperture o clic.
- 40 invii all'ora per utente.

## Risposte dalla casella (IMAP)

Portato da Harvey (`server/email/replies.ts`). Con `IMAP_HOST` (credenziali `IMAP_USER`/`IMAP_PASSWORD`, o quelle
SMTP) il server legge la cartella `IMAP_MAILBOX` ogni `REPLIES_POLL_MINUTES` minuti (10) e con «Controlla ora» nella
vista **Risposte** (`/email?vista=risposte`). La cartella si apre in **sola lettura**: nessun messaggio viene segnato
come letto, spostato o cancellato. Al primo giro (o se l'UIDVALIDITY cambia) si leggono gli ultimi 30 giorni, poi solo
i messaggi nuovi, al massimo 200 per giro.

1. **Abbinamento**: `In-Reply-To`/`References` verso un'email inviata; per i rimbalzi il Message-ID citato nel corpo;
   altrimenti stesso indirizzo del destinatario di un'email inviata negli ultimi 180 giorni. **La posta non collegata
   non viene salvata.**
2. **Classificazione**, prima con le regole del codice: rimbalzo (`multipart/report` di consegna o MAILER-DAEMON),
   risposta automatica (`Auto-Submitted`, «fuori sede», …), richiesta di non essere contattati («cancellatemi», «non
   contattateci», «STOP», …), rifiuto esplicito. Il resto, se l'AI è configurata, viene classificato dall'AI
   (interessato, domanda, obiezione, non interessato, persona sbagliata, altro) con un riassunto e una bozza di
   risposta; il testo ricevuto passa all'AI solo in un blocco di dati, con le istruzioni eventualmente contenute
   ignorate, e una bozza con prezzi, percentuali, link o telefoni viene scartata. Senza AI resta «altro».
3. **Effetti automatici, solo protettivi**: rimbalzo → l'email è segnata e un nuovo invio allo stesso indirizzo è
   bloccato; richiesta di non essere contattati → azienda «non contattare» con il motivo; ogni risposta → attività
   «Risposta ricevuta» nel CRM e sequenza di follow-up ferma. Le fasi del CRM non cambiano da sole.
4. **Rispondi** crea una bozza verso il mittente, nello stesso thread (`In-Reply-To`), dalla proposta dell'AI se c'è:
   si rilegge e si invia dall'editor con la conferma di sempre. **Nessuna risposta parte da sola.**

Si conservano mittente, oggetto, data e il testo senza le parti citate (al massimo 5000 caratteri). Senza `IMAP_HOST`
la vista lo dice e le risposte si registrano a mano («Registra la risposta» nella vista «In attesa»).

## Storico e registro

- Ogni email è legata all'azienda e all'opportunità aperta.
- Scheda azienda e scheda opportunità mostrano la sezione «Email commerciali» con bozze e inviate distinte dallo stato.
- Nella pagina dell'email: revisioni, tentativi di invio (esito, errore sicuro da mostrare) e altre email alla stessa
  azienda.
- Registro delle operazioni: `email.created`, `email.generated`, `email.sent`, `email.send_failed`, `email.verified`,
  `email.reply_received`, `email.reply_handled`, `email.inbox_checked`.

## Configurazione richiesta per inviare davvero

1. Credenziali SMTP del dominio noventra.it (o di un provider transazionale con SMTP) in `.env` sul server.
2. Record DNS del dominio (SPF, DKIM, DMARC) configurati presso il provider: il controllo DNS li verifica. Solo se il
   controllo non può passare (es. selettore DKIM non standard senza `EMAIL_DKIM_SELECTOR`) e dopo una verifica
   manuale: `EMAIL_SENDER_AUTHORIZED=si`.
3. Riavvio del server e «Verifica connessione» dalla pagina (solo amministratori).

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
