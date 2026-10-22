# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

- **Titolare di Noventra**: guarda la dashboard e i risultati (aziende trovate, contattate, trattative, valore), decide priorità e servizi da spingere.
- **Collaboratori commerciali**: fanno il lavoro operativo quotidiano: trovare aziende, aprire il messaggio pronto, confermare e inviare, seguire follow-up, risposte e trattative.

Uso interno, in italiano, da computer in ufficio (il layout deve comunque restare usabile su schermi stretti).

## Product Purpose

Piattaforma interna di Noventra (web agency italiana) per trovare, analizzare e qualificare potenziali clienti B2B in Italia e
contattarli, con un CRM integrato. Successo: più conversazioni vere con aziende pertinenti, con meno lavoro manuale e senza
contatti inopportuni.

## Positioning

Ogni lead è sostenuto da evidenze verificabili e tracciate (fonte OpenStreetMap, audit del sito, punteggio spiegato,
servizi Noventra abbinati), e nessun contatto parte senza la decisione esplicita di una persona.

## Operating Context

Lavoro quotidiano (README, «Navigazione»): Trova aziende → «Invia email» con il messaggio già pronto → conferma → invio;
poi vista «In attesa», follow-up, risposte dalla casella, trattative nel CRM, promemoria, report. Sezioni avanzate
(Lead Hunter, audit dei siti, valutazione AI, servizi, report, database aziende) raggiungibili da Impostazioni →
«Strumenti avanzati». Dati reali da OpenStreetMap, audit dei siti, AI (Anthropic) e casella email.

## Capabilities and Constraints

- Stack esistente: React 19 + React Router 8 + Vite, CSS proprio per modulo (`src/styles/*.css`, token in
  `tokens.css`), nessuna libreria di componenti. Font IBM Plex (sans, condensed, mono) installati via @fontsource.
- Moduli: dashboard, Trova aziende, Lead Hunter, audit, punteggio, servizi, AI, CRM/pipeline, promemoria, email
  commerciali (modello, AI, invio confermato, follow-up, risposte), report, impostazioni, utenti.
- Test e2e Playwright con controlli di accessibilità axe: il redesign deve mantenerli verdi (testi, ruoli, etichette).
- CSP restrittiva: nessuna risorsa esterna a runtime (font e asset locali).

## Brand Commitments

Allineamento al sito ufficiale https://www.noventra.it/ (colori, logo, tono). Contatti ufficiali: staff@noventra.it,
081 091 0236. Nome prodotto: «Lead Finder» di Noventra.

## Evidence on Hand

Nessun dato dimostrativo: le pagine mostrano solo dati reali, e i moduli non configurati lo dichiarano apertamente.
Nessuna testimonianza, cliente o metrica da inventare.

## Product Principles

1. Una persona decide ogni contatto: l'interfaccia rende chiara la conferma, mai l'automatismo.
2. Evidenze prima delle opinioni: ogni numero e ogni giudizio mostra da dove viene.
3. Il lavoro di oggi in primo piano: cosa fare adesso (da contattare, follow-up, risposte) prima dei dettagli.
4. Onestà sui limiti: ciò che non è configurato o non è verificato si dice, senza dati finti.

## Accessibility & Inclusion

WCAG 2.1 AA, verificato dai test e2e con axe; navigazione da tastiera e focus visibile.
