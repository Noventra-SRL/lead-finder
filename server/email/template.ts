/*
 * Modello commerciale ufficiale di Noventra (Fase 9). È una costante del codice: nessuna generazione lo modifica.
 * Le varianti personalizzate cambiano solo i paragrafi indicati (apertura, osservazione, pertinenza, invito finale);
 * presentazione, vantaggi, consulenza gratuita, preventivo entro 24 ore, sito e firma restano quelli ufficiali.
 */

export const TEMPLATE_ID = 'noventra_standard';
export const TEMPLATE_NAME = 'Modello commerciale standard Noventra';

export const NOVENTRA = {
  site: 'https://www.noventra.it/',
  email: 'staff@noventra.it',
  phone: '081 091 0236',
} as const;

export const DEFAULT_SUBJECT = 'Un sito web professionale per la tua attività | Noventra';

const GREETING = 'Buongiorno,';

const INTRO =
  "mi presento, sono un referente di Noventra, un'agenzia digitale che aiuta aziende e professionisti a sviluppare la propria presenza online con soluzioni moderne, personalizzate e accessibili.";

const STANDARD_OPENING =
  "Hai bisogno di un nuovo sito web o vuoi rinnovare quello che hai già? Realizziamo siti professionali progettati sulle reali esigenze della tua attività, con l'obiettivo di valorizzare i tuoi servizi, presentare al meglio il tuo brand e aiutarti a raggiungere nuovi clienti.";

const APPROACH = `Il nostro approccio è semplice:

- Soluzioni su misura: realizziamo il sito in base alle tue necessità, senza funzionalità inutili.
- Rapidità di realizzazione: lavoriamo con un processo snello per ridurre i tempi di sviluppo.
- Costi accessibili: proponiamo soluzioni convenienti, adattate al progetto e al budget disponibile.
- Un unico partner digitale: possiamo occuparci anche di e-commerce, SEO, marketing digitale e intelligenza artificiale.`;

const CONSULTATION =
  'Offriamo una consulenza gratuita e senza impegno, con un preventivo chiaro entro 24 ore, così potrai valutare la proposta prima di prendere qualsiasi decisione.';

const SITE = `Puoi conoscere meglio i nostri servizi e vedere i nostri progetti sul sito ufficiale:

${NOVENTRA.site}`;

const STANDARD_CTA =
  'Ti andrebbe di raccontarci brevemente la tua attività e cosa vorresti realizzare? Saremo felici di proporti una soluzione concreta, senza impegno.';

const SIGNATURE = `Un cordiale saluto,

Il Team Noventra
Web Agency
${NOVENTRA.site}
${NOVENTRA.email}
${NOVENTRA.phone}`;

/** Testo del modello standard, identico a quello approvato. */
export const STANDARD_BODY = [
  GREETING,
  INTRO,
  STANDARD_OPENING,
  APPROACH,
  CONSULTATION,
  SITE,
  STANDARD_CTA,
  SIGNATURE,
].join('\n\n');

/** Parti scritte dall'AI (già validate): il resto del messaggio è sempre quello ufficiale. */
export interface PersonalParts {
  opening: string;
  observation: string | null;
  relevance: string;
  callToAction: string;
}

/** Email personalizzata: stessa struttura del modello, con i paragrafi personali al posto di quelli generici. */
export function personalizedBody(p: PersonalParts): string {
  return [
    GREETING,
    INTRO,
    p.opening,
    ...(p.observation ? [p.observation] : []),
    p.relevance,
    APPROACH,
    CONSULTATION,
    SITE,
    p.callToAction,
    SIGNATURE,
  ].join('\n\n');
}

/** Elementi che ogni email generata deve contenere (controllo finale prima del salvataggio). */
export const REQUIRED_ELEMENTS: { label: string; text: string }[] = [
  { label: 'presentazione di Noventra', text: INTRO },
  { label: 'consulenza gratuita e preventivo entro 24 ore', text: CONSULTATION },
  { label: 'sito ufficiale', text: NOVENTRA.site },
  { label: 'email di Noventra', text: NOVENTRA.email },
  { label: 'telefono di Noventra', text: NOVENTRA.phone },
  { label: 'firma', text: SIGNATURE },
];

export const missingElements = (body: string) =>
  REQUIRED_ELEMENTS.filter((e) => !body.includes(e.text)).map((e) => e.label);

// ---------------------------------------------------------------- obiettivi e toni

/**
 * Obiettivi commerciali. `services`: servizi del catalogo che l'obiettivo richiede (almeno uno attivo, altrimenti
 * non viene proposto). `needsContact`: richiede un contatto precedente registrato (email inviata o attività di
 * contatto nel CRM), così l'email non lascia intendere un contatto mai avvenuto.
 */
export const OBJECTIVES = [
  { id: 'presentazione', label: 'Presentare Noventra', services: [], needsContact: false },
  { id: 'nuovo_sito', label: 'Proporre un nuovo sito web', services: ['sviluppo_siti_web'], needsContact: false },
  {
    id: 'rinnovo_sito',
    label: 'Proporre il rinnovamento di un sito esistente',
    services: ['sviluppo_siti_web', 'web_design'],
    needsContact: false,
  },
  {
    id: 'ecommerce',
    label: 'Proporre un progetto e-commerce',
    services: ['ecommerce_shopify', 'ecommerce_magento'],
    needsContact: false,
  },
  { id: 'servizio', label: 'Proporre un servizio digitale specifico', services: ['*'], needsContact: false },
  { id: 'call', label: 'Richiedere una call conoscitiva', services: [], needsContact: false },
  { id: 'follow_up', label: 'Follow-up su un contatto precedente', services: [], needsContact: true },
] as const;
export type ObjectiveId = (typeof OBJECTIVES)[number]['id'];
export const OBJECTIVE_IDS = OBJECTIVES.map((o) => o.id) as [ObjectiveId, ...ObjectiveId[]];

export const TONES = [
  { id: 'diretto', label: 'Professionale e diretto' },
  { id: 'consulenziale', label: 'Cordiale e consulenziale' },
  { id: 'formale', label: 'Formale' },
  { id: 'informale', label: 'Breve e informale' },
] as const;
export type ToneId = (typeof TONES)[number]['id'];
export const TONE_IDS = TONES.map((t) => t.id) as [ToneId, ...ToneId[]];

export const MODES = [
  { id: 'standard', label: 'Modello standard' },
  { id: 'ai', label: 'Email personalizzata con AI' },
] as const;
export type ModeId = (typeof MODES)[number]['id'];
