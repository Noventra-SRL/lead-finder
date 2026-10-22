---
version: 1
slug: 'src-app-tsx'
primary_target: 'src/App.tsx'
related_targets: ['src']
---

Scope: intera app Lead Finder (shell + tutte le pagine); approfondimento su Dashboard, Trova aziende, Email commerciali, Scheda azienda e CRM. Mode: Operate.

Audience: titolare (dashboard, risultati) e collaboratori commerciali (lavoro operativo quotidiano), desktop in ufficio.
Job: trovare aziende, inviare con conferma, seguire follow-up, risposte e trattative.
Constraints: dati solo reali; test e2e Playwright + axe da mantenere verdi (testi, ruoli, etichette); CSP senza risorse esterne; brand noventra.it.
Reference: throxy.com (siteinspire, Business & Finance / Technology / Minimal), scelto dall'utente come riferimento; brand noventra.it (cobalto #0132CC, ciano #00CCFF, Space Grotesk).

## Direction contract

THESIS: il lavoro commerciale come agenda di stati: ogni azienda, email e trattativa è una casella con uno stato colorato leggibile a colpo d'occhio. Rifiuta il gestionale grigio a paragrafi con sopratitoli e numeri di sezione.

OWN-WORLD: barra laterale blu cobalto Noventra piena con voci bianche e contatori; fondo chiaro freddo, superfici bianche, inchiostro blu notte; griglie a filetto sottile come un calendario; stati come riquadri pastello pieni (menta = risposta/positivo, lilla = follow-up, azzurro = inviata, giallo = da controllare, rosa = bloccato); pulsanti primari cobalto pieni, secondari a filetto; titoli Space Grotesk, testo di sistema, numeri in mono tabellare.

STORY: chi apre l'app capisce subito cosa fare oggi (risposte, follow-up, aziende da contattare), lo fa in un clic e vede il risultato tornare nella griglia.

FIRST VIEWPORT: Dashboard: a sinistra la barra cobalto; in alto titolo «Oggi» con data e i tre conteggi d'azione come pulsanti; al centro la griglia «Agenda della settimana» (7 colonne lun–dom, caselle con eventi reali colorati per stato); sotto, i migliori prospect in tabella a filetto con «Invia email» cobalto.

FORM: Agenda commerciale (fusione throxy calendar grid + identità Noventra); prima della lista ordinata; seed key: pinned-by-user (riferimento scelto dall'utente, concept-seed non eseguito).

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance
