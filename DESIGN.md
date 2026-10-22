---
name: Lead Finder
description: Agenda commerciale di Noventra per trovare aziende, contattarle e seguire le trattative.
colors:
  accent: "#0132cc"
  accent-hover: "#0027a8"
  accent-wash: "#e4eaff"
  on-accent: "#ffffff"
  signal: "#00ccff"
  paper: "#f2f5f9"
  surface: "#ffffff"
  sunken: "#e7edf4"
  ink: "#0a1638"
  ink-2: "#39446a"
  ink-3: "#56607d"
  rule: "#d6dee9"
  rule-strong: "#b7c3d4"
  st-positive: "#c9f5d5"
  st-positive-ink: "#0b5228"
  st-followup: "#e3dbff"
  st-followup-ink: "#43278c"
  st-sent: "#d2f1ff"
  st-sent-ink: "#04476a"
  st-attention: "#ffebb3"
  st-attention-ink: "#644400"
  st-blocked: "#ffd9d6"
  st-blocked-ink: "#8a1c16"
  ok: "#127a3a"
  warn: "#8a5d00"
  danger: "#b4231a"
typography:
  display:
    fontFamily: "Space Grotesk, system-ui, sans-serif"
    fontSize: "2.375rem"
    fontWeight: 700
    lineHeight: 1.05
    letterSpacing: "-0.03em"
  headline:
    fontFamily: "Space Grotesk, system-ui, sans-serif"
    fontSize: "1.375rem"
    fontWeight: 600
    lineHeight: 1.1
    letterSpacing: "-0.01em"
  title:
    fontFamily: "Space Grotesk, system-ui, sans-serif"
    fontSize: "1.125rem"
    fontWeight: 600
    lineHeight: 1.1
  body:
    fontFamily: "IBM Plex Sans, system-ui, sans-serif"
    fontSize: "0.9375rem"
    fontWeight: 400
    lineHeight: 1.55
  label:
    fontFamily: "Space Grotesk, system-ui, sans-serif"
    fontSize: "0.75rem"
    fontWeight: 600
  data:
    fontFamily: "IBM Plex Mono, ui-monospace, monospace"
    fontSize: "0.92em"
    fontFeature: "tnum"
rounded:
  sm: "6px"
  md: "8px"
  lg: "14px"
  pill: "999px"
spacing:
  "1": "4px"
  "2": "8px"
  "3": "12px"
  "4": "16px"
  "5": "24px"
  "6": "32px"
  "7": "48px"
  "8": "72px"
components:
  button-primary:
    backgroundColor: "{colors.accent}"
    textColor: "{colors.on-accent}"
    typography: "{typography.label}"
    rounded: "{rounded.md}"
    padding: "0 16px"
    height: "40px"
  button-primary-hover:
    backgroundColor: "{colors.accent-hover}"
  button-secondary:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    rounded: "{rounded.md}"
    padding: "0 16px"
    height: "40px"
  button-ghost:
    backgroundColor: "transparent"
    textColor: "{colors.ink-2}"
    rounded: "{rounded.md}"
    padding: "0 12px"
    height: "40px"
  button-disabled:
    backgroundColor: "{colors.sunken}"
    textColor: "{colors.ink-3}"
  input:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    rounded: "{rounded.md}"
    padding: "0 12px"
    height: "42px"
  status-positive:
    backgroundColor: "{colors.st-positive}"
    textColor: "{colors.st-positive-ink}"
    rounded: "{rounded.pill}"
    padding: "2px 10px 2px 8px"
  nav-link-active:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.accent}"
    rounded: "{rounded.md}"
    height: "42px"
  week-event-followup:
    backgroundColor: "{colors.st-followup}"
    textColor: "{colors.st-followup-ink}"
    rounded: "{rounded.sm}"
    padding: "6px 8px"
---

# Design System: Lead Finder

## Overview

**Creative North Star: "Agenda commerciale"**

Il lavoro commerciale si legge come un'agenda da tavolo: ogni azienda, email e trattativa è una casella con uno stato colorato riconoscibile a colpo d'occhio. Una barra laterale cobalto Noventra piena regge l'app; il resto è carta chiara e fredda, superfici bianche, inchiostro blu notte e griglie a filetto sottile come un calendario. Densità da strumento d'ufficio: molte righe, poca decorazione, un'azione evidente per riga.

Il riferimento è throxy.com (scelto dall'utente da siteinspire) fuso con l'identità di noventra.it. Il concept-seed roll non è stato eseguito: il riferimento è stato fissato dall'utente, che ha approvato la direzione. Rifiutato in modo esplicito: il gestionale grigio a paragrafi con sopratitoli e numeri di sezione.

**Key Characteristics:**
- Barra laterale cobalto piena, voci bianche, contatori ciano.
- Stati come riquadri pastello pieni, sempre accompagnati dal testo dello stato.
- Griglie a filetto da 1px su superficie bianca (agenda settimanale, tabelle).
- Primario cobalto pieno, secondario a filetto, ghost per azioni di riga.
- Titoli Space Grotesk, testo IBM Plex Sans, dati IBM Plex Mono tabellari.

## Colors

Cobalto e ciano di Noventra su una base fredda e quasi neutra; il colore pieno è riservato a navigazione, azioni e stati.

### Primary
- **Cobalto Noventra** (accent): barra laterale, pulsanti primari, giorno corrente nell'agenda, link attivi al passaggio. Variante più scura (accent-hover) al passaggio; velo cobalto (accent-wash) per l'alone di focus dei campi e la barra di caricamento.

### Secondary
- **Ciano segnale** (signal): solo sulla barra cobalto: contatori, anello di focus nella barra, selezione del testo, segno del marchio.

### Neutral
- **Carta fredda** (paper): fondo dell'area di lavoro.
- **Superficie** (surface): tabelle, agenda, dialoghi, campi, voce attiva della barra.
- **Incavato** (sunken): pulsanti disattivati, hover dei ghost, campi disattivati.
- **Inchiostro blu notte** (ink), **secondario** (ink-2), **terziario** (ink-3, contrasto ≥ 4.5:1 su carta e superficie).
- **Filetto** (rule) e **filetto marcato** (rule-strong): bordi di griglie, tabelle, campi, pulsanti secondari.

### Stati
Coppie fondo pastello + inchiostro della stessa famiglia (contrasto ≥ 4.5:1): **menta** = risposta/positivo, **lilla** = follow-up, **azzurro** = inviata, **giallo** = da controllare, **rosa** = bloccato, **incavato** = inattivo. ok / warn / danger sono gli inchiostri pieni per testo d'errore e pulsante di pericolo.

### Named Rules
**The Colore-più-Testo Rule.** Uno stato non è mai solo colore: pastiglia, casella o riquadro portano sempre la parola dello stato.

**The Ciano-sul-Cobalto Rule.** Il ciano vive sulla barra cobalto; nell'area chiara non compare come testo o fondo.

## Typography

**Display Font:** Space Grotesk (con system-ui) — impegno di brand noventra.it.
**Body Font:** IBM Plex Sans (con system-ui) — già installato, carattere da lavoro dell'interfaccia; scelto al posto di uno stack di sistema.
**Label/Mono Font:** IBM Plex Mono per dati, orari, codici e numeri tabellari.

**Character:** Space Grotesk geometrico e un po' tecnico per titoli, navigazione e numeri grandi; Plex Sans neutro e leggibile per il testo denso; Plex Mono per allineare le cifre.

### Hierarchy
- **Display** (700, 2.375rem, 1.05, -0.03em): titolo di pagina.
- **Headline** (600, 1.375rem): titoli di dialogo.
- **Title** (600, 1.125rem): titoli di sezione e blocco, date dell'agenda.
- **Body** (400, 0.9375rem, 1.55): testo corrente; descrizioni a 64ch max.
- **Label** (600, 0.75–0.8125rem, Space Grotesk): pulsanti, intestazioni di tabella, voci di navigazione (500, 0.9375rem).
- **Numeri d'azione** (700, 2.5rem, -0.04em, tabellari): i tre conteggi della dashboard «Oggi».

### Named Rules
**The Cifre-Allineate Rule.** Tabelle, `.mono` e conteggi usano cifre tabellari.

## Layout

Shell a due colonne: barra laterale da 240px sticky a tutta altezza + area di lavoro con padding 32/48px e contenuto max 1240px. Ritmo di spaziatura a 4/8px (4, 8, 12, 16, 24, 32, 48, 72). Sezioni a due colonne (testa 180–260px + corpo) che collassano sotto 860px. Agenda settimanale a 7 colonne con caselle alte almeno 188px.

Responsive: sotto 960px la barra diventa una topbar cobalto da 60px e un menu a scorrimento laterale; sotto 640px le tabelle `--stack` diventano blocchi con etichette; punti di rottura osservati a 1100, 960, 860, 720, 640, 520px.

## Elevation & Depth

Ibrido sobrio: superfici piatte separate da filetti, con ombre blu notte morbide e basse solo su contenitori (tabelle, agenda, caselle d'azione) e una più ampia per dialoghi e hover delle caselle d'azione. I pulsanti primari portano un'ombra cobalto leggera che cresce al passaggio. Valori nel sidecar.

### Named Rules
**The Filetto-Prima Rule.** La separazione si fa con il filetto da 1px; l'ombra segnala solo un contenitore o una risposta all'hover.

## Shapes

Angoli gentili: 8px per pulsanti, campi, voci di navigazione e riquadri di avviso; 14px per contenitori (tabelle, agenda, dialoghi, caselle d'azione); 6px per gli eventi dentro l'agenda; pillola per stati e contatori. Le icone sono SVG disegnati nel progetto, tratto unico 1.75 su griglia 24, colore dal testo, sempre decorative.

## Components

### Buttons
- **Shape:** angoli gentili (8px), altezza 40px, Space Grotesk 600.
- **Primary:** cobalto pieno, testo bianco; hover cobalto scuro con ombra cobalto; active scende di 1px.
- **Secondary:** superficie bianca a filetto marcato; hover filetto e testo cobalto.
- **Ghost:** trasparente, inchiostro secondario; hover fondo incavato. Usato per azioni di riga.
- **Disabled:** grigio incavato neutro, mai un blu sbiadito.
- **Danger:** contorno rosso, pieno al passaggio.

### Chips (stati)
- **Style:** pastiglia pastello con pallino del colore dell'inchiostro e testo dello stato, 0.75rem.
- **Idle:** pallino vuoto a contorno.

### Cards / Containers
- **Corner Style:** 14px.
- **Background:** superficie bianca su carta fredda.
- **Shadow Strategy:** ombra bassa (vedi Elevation).
- **Border:** filetto 1px.
- **Internal Padding:** 12–16px nelle celle, 24px nei dialoghi.

### Inputs / Fields
- **Style:** superficie bianca, filetto marcato, 8px, altezza 42px, caret cobalto.
- **Focus:** bordo cobalto + alone velo cobalto 3px.
- **Error / Disabled:** bordo rosso con messaggio sotto; fondo incavato.

### Navigation
- **Barra cobalto:** voci Space Grotesk 500 bianche all'80%; hover velo bianco 10%; voce attiva su superficie bianca con testo cobalto 600. Contatori a pillola ciano (rosa per allarme). Focus: anello ciano su cobalto. Mobile: topbar cobalto + menu a scorrimento.

### Agenda della settimana (firma)
Griglia di 7 caselle bianche separate da filetti da 1px dentro un contenitore da 14px; giorni passati su bianco spento; oggi con numero in cerchio cobalto. Gli eventi sono riquadri pastello nello stato reale, con titolo e azienda.

### Caselle d'azione «Oggi»
Tre riquadri grandi nel colore dello stato (menta, lilla, azzurro) con conteggio da 2.5rem, etichetta e freccia; senza lavoro la casella resta bianca e quieta.

## Do's and Don'ts

### Do:
- **Do** usare il cobalto pieno per una sola azione primaria per riga o blocco.
- **Do** accompagnare ogni colore di stato con il testo dello stato.
- **Do** separare con filetti da 1px (rule) prima di ricorrere alle ombre.
- **Do** usare IBM Plex Mono con cifre tabellari per dati, orari e codici.
- **Do** mantenere ink-3 come colore minimo per testo secondario (≥ 4.5:1).

### Don't:
- **Don't** costruire pagine da gestionale grigio a paragrafi con sopratitoli e numeri di sezione.
- **Don't** usare il ciano come testo o fondo nell'area chiara.
- **Don't** mostrare un pulsante disattivato in blu sbiadito.
- **Don't** caricare font o risorse da domini esterni (CSP).
- **Don't** usare icone glifo o da pacchetti esterni: solo gli SVG del progetto.

## Punti aperti (ultima revisione)

- I contatori della barra compaiono solo su «Email commerciali»; manca il conteggio su «Trattative».
- I pulsanti ghost disattivati «Invia email» ripetuti sulle righe senza email restano: li richiedono i test e2e e la documentazione.
