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

// ---------------------------------------------------------------- modello Farmacube (farmacie)

/*
 * Modello ufficiale Farmacube per le farmacie, testo approvato (versione 1). Testo semplice: i titoli in grassetto
 * del testo approvato diventano righe normali (le email partono senza HTML).
 * La variante personalizzata cambia SOLO l'apertura, un paragrafo di pertinenza e la domanda finale; saluto,
 * presentazione di Noventra, funzioni di Farmacube, obiettivo, link ufficiali, consulenza gratuita e firma restano
 * identici.
 */

export const FARMACUBE = { site: 'https://www.farmacube.it/' } as const;
export const FARMACUBE_TEMPLATE_ID = 'farmacube';
export const FARMACUBE_SUBJECT = 'Una soluzione e-commerce pensata per la sua farmacia | Farmacube';

const F_GREETING = 'Gentile Dottore/Dottoressa,';

const F_OPENING =
  "oggi avere una presenza online efficace può rappresentare un'importante opportunità di crescita per una farmacia. Per questo vogliamo presentarle Farmacube, una soluzione pensata per semplificare la realizzazione e la gestione del suo e-commerce.";

const F_ABOUT =
  "Siamo Noventra, un'agenzia digitale specializzata nello sviluppo di siti web, e-commerce e soluzioni tecnologiche su misura. Con Farmacube abbiamo sviluppato una soluzione dedicata alle esigenze specifiche delle farmacie, per aiutarle a vendere online con un processo più semplice, rapido e accessibile.";

const F_FEATURES = `Cosa può fare Farmacube per la sua farmacia?

- E-commerce personalizzato: un negozio online con il brand della sua farmacia, pronto per presentare e vendere i prodotti.
- Integrazione con il gestionale: collegamento con i gestionali supportati per semplificare la gestione delle attività online.
- Catalogo prodotti automatizzato: sincronizzazione dei listini dei grossisti e aggiornamento delle schede prodotto, con foto, descrizioni e caratteristiche tecniche.
- Gestione più efficiente: strumenti per configurare prezzi e ricarichi, riducendo il lavoro manuale necessario per mantenere aggiornato il catalogo.
- Avvio rapido e assistenza: una soluzione strutturata per ridurre la complessità tecnica e accompagnarla nella gestione del negozio online.`;

const F_GOAL =
  'Il nostro obiettivo è offrirle una soluzione concreta, evitando costi e complessità non necessari e individuando la configurazione più adatta alle esigenze e al budget della sua farmacia.';

const F_LINKS = `Può scoprire come funziona visitando il nostro sito dedicato:

Farmacube: ${FARMACUBE.site}

Per conoscere anche gli altri nostri servizi di sviluppo web, e-commerce e digitalizzazione:

Noventra: ${NOVENTRA.site}`;

const F_CONSULTATION =
  'Saremmo lieti di offrirle una consulenza gratuita e senza impegno, per capire come migliorare la presenza online della sua farmacia e valutare insieme la soluzione più adatta.';

const F_CTA = 'Le farebbe piacere approfondire la proposta con una breve conversazione?';

const F_SIGNATURE = `Cordiali saluti,

Team Noventra
Sviluppo web ed e-commerce
${NOVENTRA.site}
${FARMACUBE.site}
${NOVENTRA.email}
${NOVENTRA.phone}`;

export const FARMACUBE_BODY = [
  F_GREETING,
  F_OPENING,
  F_ABOUT,
  F_FEATURES,
  F_GOAL,
  F_LINKS,
  F_CONSULTATION,
  F_CTA,
  F_SIGNATURE,
].join('\n\n');

function farmacubePersonalized(p: PersonalParts): string {
  return [
    F_GREETING,
    p.opening,
    F_ABOUT,
    ...(p.observation ? [p.observation] : []),
    p.relevance,
    F_FEATURES,
    F_GOAL,
    F_LINKS,
    F_CONSULTATION,
    p.callToAction,
    F_SIGNATURE,
  ].join('\n\n');
}

// ---------------------------------------------------------------- registro dei modelli

export type TemplateId = typeof TEMPLATE_ID | typeof FARMACUBE_TEMPLATE_ID;

export interface EmailTemplate {
  id: TemplateId;
  name: string;
  /** Versione del testo approvato: cambia solo con un nuovo testo ufficiale (le bozze salvano quella usata). */
  version: number;
  subject: string;
  body: string;
  /** Marchio che l'oggetto di una variante personalizzata deve contenere. */
  brand: string;
  /** Categorie di «Trova aziende» per cui è il modello predefinito. */
  defaultFor: string[];
  required: { label: string; text: string }[];
  personalize: (p: PersonalParts) => string;
}

export const EMAIL_TEMPLATES: Record<TemplateId, EmailTemplate> = {
  [TEMPLATE_ID]: {
    id: TEMPLATE_ID,
    name: TEMPLATE_NAME,
    version: 1,
    subject: DEFAULT_SUBJECT,
    body: STANDARD_BODY,
    brand: 'Noventra',
    defaultFor: [],
    required: REQUIRED_ELEMENTS,
    personalize: personalizedBody,
  },
  [FARMACUBE_TEMPLATE_ID]: {
    id: FARMACUBE_TEMPLATE_ID,
    name: 'Farmacube — e-commerce per farmacie',
    version: 1,
    subject: FARMACUBE_SUBJECT,
    body: FARMACUBE_BODY,
    brand: 'Farmacube',
    // solo farmacie: le parafarmacie e le altre attività sanitarie usano il modello standard
    defaultFor: ['farmacie'],
    required: [
      { label: 'saluto', text: F_GREETING },
      { label: 'presentazione di Noventra e Farmacube', text: F_ABOUT },
      { label: 'funzioni di Farmacube', text: F_FEATURES },
      { label: 'obiettivo della proposta', text: F_GOAL },
      { label: 'sito Farmacube e sito Noventra', text: F_LINKS },
      { label: 'consulenza gratuita', text: F_CONSULTATION },
      { label: 'firma con i contatti ufficiali', text: F_SIGNATURE },
    ],
    personalize: farmacubePersonalized,
  },
};

export const TEMPLATE_IDS = Object.keys(EMAIL_TEMPLATES) as [TemplateId, ...TemplateId[]];

export const templateOf = (id: string | null | undefined): EmailTemplate =>
  EMAIL_TEMPLATES[(id ?? TEMPLATE_ID) as TemplateId] ?? EMAIL_TEMPLATES[TEMPLATE_ID];

/** Modello predefinito per la categoria commerciale dell'azienda (Farmacube solo per le farmacie). */
export function templateForCategory(category: string | null | undefined): EmailTemplate {
  return Object.values(EMAIL_TEMPLATES).find((t) => category && t.defaultFor.includes(category)) ?? templateOf(null);
}

export const missingElements = (body: string, templateId: string = TEMPLATE_ID) =>
  templateOf(templateId)
    .required.filter((e) => !body.includes(e.text))
    .map((e) => e.label);

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
