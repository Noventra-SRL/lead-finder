import { z } from 'zod';
import { FINDINGS, type FindingCode } from '../audit/findings.ts';
import { CATEGORIES, type CategoryId } from '../discovery/categories.ts';
import { CAPABILITIES, type Capability } from '../scoring/config.ts';

/*
 * Catalogo dei servizi di Noventra e regole di abbinamento: UN solo documento configurabile, validato e versionato
 * (service_catalog_versions). Ogni servizio è verificato sul sito ufficiale: nome, descrizione e contenuti vengono
 * dalle pagine indicate in "source" (consultate il 21/10/2026). Nessun servizio inventato.
 *
 * L'abbinamento indica quanto le prove osservate corrispondono a un servizio: è un suggerimento da verificare,
 * non una domanda confermata né una probabilità di vendita.
 */

export const MATCHING_ALGORITHM_VERSION = 1;

export const MATCH_DIMENSIONS = ['findings', 'capabilities', 'category', 'evidence', 'context'] as const;
export type MatchDimension = (typeof MATCH_DIMENSIONS)[number];

/** Segnali dell'audit (Fase 3) usabili come contesto. */
export const AUDIT_SIGNALS = [
  'contactPage',
  'phoneLink',
  'emailLink',
  'contactForm',
  'address',
  'openingHours',
  'privacy',
  'cookie',
  'callToAction',
  'servicesSection',
  'booking',
  'appointment',
  'ordering',
  'menu',
  'ecommerce',
  'rooms',
  'schedule',
  'catalog',
  'otaLinks',
  'social',
] as const;
export type AuditSignal = (typeof AUDIT_SIGNALS)[number];

const CATEGORY_IDS = Object.keys(CATEGORIES) as [CategoryId, ...CategoryId[]];
const CAPABILITY_IDS = Object.keys(CAPABILITIES) as [Capability, ...Capability[]];
const FINDING_IDS = Object.keys(FINDINGS) as [FindingCode, ...FindingCode[]];

const pct = z.number().min(0).max(100);
const weight = z.number().min(0).max(1000);
const importance = z.number().min(0.1).max(10);
const text = (max: number) => z.string().trim().min(1).max(max);

const serviceSchema = z
  .object({
    id: z.string().regex(/^[a-z][a-z0-9_]{1,40}$/),
    name: text(80),
    /** Area del sito di Noventra ("Sviluppo & tecnologia" o "Marketing & crescita"). */
    category: z.enum(['sviluppo', 'marketing']),
    description: text(300),
    /** Pagina ufficiale da cui provengono nome e descrizione. */
    source: z
      .url()
      .refine((u) => u.startsWith('https://www.noventra.it/'), 'La fonte deve essere una pagina di noventra.it.'),
    /** Servizio confermato sul sito ufficiale. I servizi non confermati non vengono mai proposti. */
    verified: z.boolean(),
    active: z.boolean(),
    /**
     * Abbinamento automatico possibile: false per i servizi per cui le prove raccolte automaticamente non bastano
     * (es. un'app: non si deduce che serva perché manca). Restano nel catalogo, proponibili solo a mano.
     */
    autoMatch: z.boolean(),
    /** La corrispondenza va confermata con il team (es. funzione non descritta esplicitamente nella pagina del servizio). */
    requiresTeamConfirmation: z.boolean(),
    problems: z.array(text(200)).max(10),
    /** Pertinenza per settore (0–100). Un settore assente vale 0: il servizio non è proposto. */
    categories: z.partialRecord(z.enum(CATEGORY_IDS), pct),
    /** Rilievi dell'audit direttamente pertinenti, con la loro importanza. */
    findings: z.partialRecord(z.enum(FINDING_IDS), importance),
    /** Capacità digitali la cui mancanza il servizio risolve, con la loro importanza. */
    capabilityGaps: z.partialRecord(z.enum(CAPABILITY_IDS), importance),
    /** Il sito non risponde in audit consecutivi: prova diretta per questo servizio. */
    repeatedFailure: z.boolean(),
    /** Contesto favorevole verificato (segnali dell'audit o dati della fonte) con importanza. */
    context: z.partialRecord(
      z.enum([...AUDIT_SIGNALS, 'sourcePhone', 'sourceOpeningHours', 'sourceAddress'] as const),
      importance,
    ),
    /** Condizioni che rendono il servizio non pertinente (es. negozio online già presente per un nuovo e-commerce). */
    disqualifiers: z.array(z.object({ signal: z.enum(AUDIT_SIGNALS), reason: text(200) }).strict()).max(10),
    /** Servizi che addressano lo stesso problema di fondo: nella lista breve ne compare uno solo per gruppo. */
    dedupeGroup: z.string().regex(/^[a-z_]{2,40}$/),
    /** Servizi che di norma vengono prima (solo informativo). */
    prerequisites: z.array(z.string()).max(5),
    /** Cosa verificare prima di proporre il servizio. */
    nextSteps: z.array(text(240)).min(1).max(6),
  })
  .strict();

export type CatalogService = z.infer<typeof serviceSchema>;

export const catalogSchema = z
  .object({
    weights: z
      .object(Object.fromEntries(MATCH_DIMENSIONS.map((d) => [d, weight])) as Record<MatchDimension, typeof weight>)
      .strict(),
    thresholds: z
      .object({
        /** Corrispondenza "consigliata" da questo valore, "possibile" da possible. */
        recommended: pct,
        possible: pct,
        /** Affidabilità delle prove (Fase 4) sotto cui un abbinamento va verificato a mano. */
        minConfidence: pct,
        /** Completezza minima delle prove per il servizio (quota dei pesi delle dimensioni con prove). */
        minActiveWeightPct: pct,
      })
      .strict()
      .refine((t) => t.recommended > t.possible, 'La soglia "consigliato" deve superare "possibile".'),
    shortlist: z
      .object({
        max: z.number().int().min(1).max(10),
        /** Con prove poco affidabili si mostrano meno servizi. */
        maxWithLowConfidence: z.number().int().min(0).max(10),
      })
      .strict(),
    findingPoints: z
      .object({
        severity: z.object({ high: weight, medium: weight, low: weight, info: weight }).strict(),
        confidence: z
          .object({ high: z.number().min(0).max(1), medium: z.number().min(0).max(1), low: z.number().min(0).max(1) })
          .strict(),
        /** Punti (importanza × gravità × affidabilità) che valgono il 100% della dimensione. */
        saturation: z.number().min(1).max(10_000),
      })
      .strict(),
    gapFactor: z.object({ missing: z.number().min(0).max(1), not_detected: z.number().min(0).max(1) }).strict(),
    services: z.array(serviceSchema).min(1).max(60),
  })
  .strict()
  .superRefine((c, ctx) => {
    if (MATCH_DIMENSIONS.every((d) => c.weights[d] <= 0))
      ctx.addIssue({
        code: 'custom',
        path: ['weights'],
        message: 'Almeno una dimensione deve avere peso maggiore di zero.',
      });
    if (c.shortlist.maxWithLowConfidence > c.shortlist.max)
      ctx.addIssue({
        code: 'custom',
        path: ['shortlist', 'maxWithLowConfidence'],
        message: 'Non può superare il massimo della lista.',
      });
    const ids = new Set<string>();
    c.services.forEach((s, i) => {
      if (ids.has(s.id))
        ctx.addIssue({ code: 'custom', path: ['services', i, 'id'], message: `Identificativo ripetuto: ${s.id}.` });
      ids.add(s.id);
      if (s.active && !s.verified)
        ctx.addIssue({
          code: 'custom',
          path: ['services', i, 'active'],
          message: 'Un servizio non confermato non può essere attivo.',
        });
    });
    c.services.forEach((s, i) => {
      for (const p of s.prerequisites)
        if (!ids.has(p))
          ctx.addIssue({
            code: 'custom',
            path: ['services', i, 'prerequisites'],
            message: `Servizio sconosciuto: ${p}.`,
          });
    });
  });

export type ServiceCatalog = z.infer<typeof catalogSchema>;

export function validateCatalog(
  input: unknown,
): { ok: true; catalog: ServiceCatalog } | { ok: false; errors: Record<string, string> } {
  const r = catalogSchema.safeParse(input);
  if (r.success) return { ok: true, catalog: r.data };
  const errors: Record<string, string> = {};
  for (const issue of r.error.issues) errors[issue.path.join('.') || '_'] ??= issue.message;
  return { ok: false, errors };
}

const ALL: Partial<Record<CategoryId, number>> = Object.fromEntries(CATEGORY_IDS.map((c) => [c, 70]));
const SRC = 'https://www.noventra.it/servizi/';
const VERIFY_NEEDS = 'Verificare con l’azienda le esigenze reali prima di qualsiasi proposta.';

/** Catalogo iniziale (versione 1): servizi pubblicati su https://www.noventra.it/ e pagine dei singoli servizi. */
export const DEFAULT_CATALOG: ServiceCatalog = {
  weights: { findings: 35, capabilities: 25, category: 15, evidence: 15, context: 10 },
  thresholds: { recommended: 60, possible: 40, minConfidence: 45, minActiveWeightPct: 50 },
  shortlist: { max: 3, maxWithLowConfidence: 1 },
  findingPoints: {
    severity: { high: 30, medium: 15, low: 5, info: 0 },
    confidence: { high: 1, medium: 0.75, low: 0.5 },
    saturation: 60,
  },
  gapFactor: { missing: 1, not_detected: 0.6 },
  services: [
    {
      id: 'sviluppo_siti_web',
      name: 'Sviluppo siti web',
      category: 'sviluppo',
      description:
        'Siti web professionali e performanti: siti vetrina e aziendali, design responsive, prestazioni curate (Core Web Vitals) e struttura pensata per la SEO.',
      source: `${SRC}sviluppo-siti-web`,
      verified: true,
      active: true,
      autoMatch: true,
      requiresTeamConfirmation: false,
      problems: [
        'Sito non adatto a smartphone e tablet',
        'Errori tecnici, pagine o collegamenti non funzionanti',
        'Prestazioni lente',
        'Impaginazione tecnicamente superata',
      ],
      categories: ALL,
      findings: {
        MOBILE_NO_VIEWPORT: 3,
        MOBILE_VIEWPORT_FIXED: 2,
        MOBILE_LEGACY_LAYOUT: 3,
        MOBILE_FIXED_WIDTH: 1,
        SEO_BROKEN_INTERNAL_LINKS: 2,
        AVAIL_HTTP_ERROR: 3,
        AVAIL_NOT_HTML: 2,
        PERF_LOW_SCORE: 2,
        PERF_LCP_SLOW: 2,
        PERF_CLS_HIGH: 1,
        PERF_INP_SLOW: 1,
        SEO_THIN_CONTENT: 1,
      },
      capabilityGaps: { website: 3, mobile: 3 },
      repeatedFailure: false,
      context: { servicesSection: 1, sourcePhone: 1, sourceAddress: 1 },
      disqualifiers: [],
      dedupeGroup: 'sito',
      prerequisites: [],
      nextSteps: [
        'Aprire il sito da smartphone e confermare i problemi indicati dai rilievi.',
        'Verificare se l’azienda ha già un rifacimento in corso o un fornitore.',
      ],
    },
    {
      id: 'web_design',
      name: 'Web design & brand identity',
      category: 'sviluppo',
      description:
        'Identità di marca e design di siti e interfacce: logo, palette, tipografia, prototipi e sistema di design.',
      source: `${SRC}web-design-branding`,
      verified: true,
      active: true,
      autoMatch: true,
      requiresTeamConfirmation: false,
      problems: [
        'Servizi o prodotti non presentati con chiarezza',
        'Inviti all’azione assenti',
        'Contatti poco visibili',
      ],
      categories: ALL,
      findings: { CONTENT_NO_SERVICES: 2, CONTENT_NO_CTA: 2, CONTENT_NO_CONTACT: 2, MOBILE_ZOOM_DISABLED: 1 },
      capabilityGaps: { services_info: 2, call_to_action: 2, contact_route: 2 },
      repeatedFailure: false,
      context: { sourcePhone: 1, social: 1 },
      disqualifiers: [],
      dedupeGroup: 'presentazione',
      prerequisites: [],
      nextSteps: [
        'Valutare di persona la chiarezza delle pagine: i rilievi indicano elementi non trovati, non un giudizio estetico.',
        VERIFY_NEEDS,
      ],
    },
    {
      id: 'seo',
      name: 'SEO Optimization',
      category: 'marketing',
      description:
        'Più visibilità organica su Google: audit tecnico e dei contenuti, parole chiave, ottimizzazione di pagine, dati strutturati e prestazioni.',
      source: `${SRC}seo-optimization`,
      verified: true,
      active: true,
      autoMatch: true,
      requiresTeamConfirmation: false,
      problems: [
        'Pagine escluse o poco leggibili per i motori di ricerca',
        'Titoli e descrizioni assenti o inadeguati',
        'Dati strutturati e sitemap assenti',
        'Informazioni locali (indirizzo) poco evidenti',
      ],
      categories: ALL,
      findings: {
        SEO_NOINDEX: 3,
        SEO_ROBOTS_DISALLOW_ALL: 3,
        SEO_MISSING_TITLE: 3,
        SEO_TITLE_LENGTH: 1,
        SEO_MISSING_META_DESCRIPTION: 2,
        SEO_META_DESCRIPTION_LENGTH: 1,
        SEO_MISSING_H1: 2,
        SEO_MULTIPLE_H1: 1,
        SEO_CANONICAL_OTHER_HOST: 2,
        SEO_CANONICAL_MISSING: 1,
        SEO_NO_SITEMAP: 1,
        SEO_NO_STRUCTURED_DATA: 1,
        SEO_INVALID_JSON_LD: 1,
        SEO_IMAGES_MISSING_ALT: 1,
        SEO_MISSING_LANG: 1,
        SEO_THIN_CONTENT: 1,
      },
      capabilityGaps: { local_seo: 2 },
      repeatedFailure: false,
      context: { servicesSection: 1, address: 1, sourceAddress: 1 },
      disqualifiers: [],
      dedupeGroup: 'visibilita',
      prerequisites: [],
      nextSteps: [
        'Cercare l’azienda su Google per i suoi servizi principali e la sua città prima del contatto.',
        'Confermare che l’indicizzazione e i titoli segnalati non siano stati già corretti.',
      ],
    },
    {
      id: 'geo',
      name: 'GEO',
      category: 'marketing',
      description:
        'Visibilità sui motori di risposta AI (ChatGPT, Gemini, Perplexity): dati strutturati, segnali per i crawler AI, contenuti chiari da citare.',
      source: `${SRC}geo`,
      verified: true,
      active: true,
      autoMatch: true,
      requiresTeamConfirmation: false,
      problems: ['Informazioni dell’attività non strutturate per i motori di risposta AI'],
      categories: ALL,
      findings: { SEO_NO_STRUCTURED_DATA: 3, SEO_INVALID_JSON_LD: 2, SEO_THIN_CONTENT: 1 },
      capabilityGaps: {},
      repeatedFailure: false,
      context: { servicesSection: 1, address: 1 },
      disqualifiers: [],
      dedupeGroup: 'visibilita',
      prerequisites: [],
      nextSteps: [
        'Provare a chiedere a un assistente AI informazioni sull’attività e verificare cosa risponde.',
        VERIFY_NEEDS,
      ],
    },
    {
      id: 'ecommerce_shopify',
      name: 'E-commerce Shopify',
      category: 'sviluppo',
      description:
        'Negozi online con Shopify: tema personalizzato, catalogo organizzato, pagamenti, spedizioni e tasse configurati, formazione.',
      source: `${SRC}e-commerce-shopify`,
      verified: true,
      active: true,
      autoMatch: true,
      requiresTeamConfirmation: false,
      problems: ['Prodotti presentati online ma senza possibilità di acquisto'],
      categories: { negozi: 85, parafarmacie: 60, artigiani_servizi: 40, industria: 40 },
      findings: { IND_NO_ECOMMERCE: 3 },
      capabilityGaps: { ecommerce: 3 },
      repeatedFailure: false,
      context: { catalog: 3, servicesSection: 1 },
      disqualifiers: [{ signal: 'ecommerce', reason: 'Un negozio online è già presente sul sito.' }],
      dedupeGroup: 'ecommerce',
      prerequisites: [],
      nextSteps: [
        'Verificare che l’azienda venda davvero prodotti adatti alla vendita online e con quale assortimento.',
        'Chiedere se usa già un gestionale o un marketplace: con cataloghi ampi o integrazioni complesse valutare Magento.',
      ],
    },
    {
      id: 'ecommerce_magento',
      name: 'E-commerce Magento',
      category: 'sviluppo',
      description:
        'Negozi online su Magento 2 per cataloghi ampi, logiche di vendita complesse e integrazioni con gestionali, listini e fornitori.',
      source: `${SRC}e-commerce-magento`,
      verified: true,
      active: true,
      // l'ampiezza del catalogo e le integrazioni non sono osservabili automaticamente
      autoMatch: false,
      requiresTeamConfirmation: true,
      problems: ['Catalogo ampio o integrazioni con gestionali e fornitori da gestire online'],
      categories: { negozi: 60, parafarmacie: 60, industria: 50, farmacie: 40 },
      findings: { IND_NO_ECOMMERCE: 2 },
      capabilityGaps: { ecommerce: 2 },
      repeatedFailure: false,
      context: { catalog: 3 },
      disqualifiers: [],
      dedupeGroup: 'ecommerce',
      prerequisites: [],
      nextSteps: [
        'Proponibile solo dopo aver verificato ampiezza del catalogo e necessità di integrazione con gestionali e fornitori.',
      ],
    },
    {
      id: 'farmacube',
      name: 'Farmacube',
      category: 'sviluppo',
      description:
        'E-commerce e gestionale per farmacie: e-shop su Shopify o Magento personalizzato con il marchio, connettore con il gestionale della farmacia, supporto.',
      source: 'https://www.noventra.it/farmacube',
      verified: true,
      active: true,
      autoMatch: true,
      requiresTeamConfirmation: false,
      problems: ['Farmacia senza vendita online dei prodotti'],
      categories: { farmacie: 90, parafarmacie: 85 },
      findings: { IND_NO_ECOMMERCE: 3, IND_NO_CATALOG: 2 },
      capabilityGaps: { ecommerce: 3, catalog: 1 },
      repeatedFailure: false,
      context: { catalog: 2, servicesSection: 1 },
      disqualifiers: [{ signal: 'ecommerce', reason: 'Un negozio online è già presente sul sito.' }],
      dedupeGroup: 'ecommerce',
      prerequisites: [],
      nextSteps: [
        'Verificare che la farmacia abbia (o intenda chiedere) l’autorizzazione alla vendita online di farmaci senza obbligo di ricetta prima di proporre la vendita di medicinali.',
        'Chiedere quale gestionale di farmacia usa (per il connettore).',
      ],
    },
    {
      id: 'gestionali_crm',
      name: 'Gestionali web & CRM',
      category: 'sviluppo',
      description:
        'Software gestionali e CRM su misura: clienti e pipeline, fatturazione, magazzino e prenotazioni, risorse umane, dashboard; integrazione via API.',
      source: `${SRC}gestionali-crm`,
      verified: true,
      active: true,
      autoMatch: true,
      // la pagina del servizio non descrive esplicitamente la prenotazione online per i clienti finali
      requiresTeamConfirmation: true,
      problems: [
        'Prenotazioni, appuntamenti o ordini gestiti fuori dal sito',
        'Richieste dei clienti senza un flusso digitale',
      ],
      categories: {
        hotel: 80,
        extralberghiero: 80,
        ristorazione: 70,
        studi_sanitari: 80,
        studi_professionali: 60,
        palestre_benessere: 80,
        artigiani_servizi: 50,
        industria: 50,
        farmacie: 40,
      },
      findings: {
        IND_NO_ONLINE_BOOKING: 3,
        IND_HOTEL_NO_DIRECT_BOOKING: 3,
        IND_RESTAURANT_NO_RESERVATION: 2,
        IND_NO_APPOINTMENT: 3,
      },
      capabilityGaps: {
        booking: 3,
        appointment: 3,
        reservation: 2,
        direct_booking: 3,
        online_ordering: 1,
        quote_request: 1,
      },
      repeatedFailure: false,
      context: { otaLinks: 2, sourcePhone: 1, servicesSection: 1 },
      disqualifiers: [],
      dedupeGroup: 'processi',
      prerequisites: [],
      nextSteps: [
        'Confermare con il team tecnico che la soluzione di prenotazione/richiesta adatta rientri nell’offerta (la pagina del servizio non la descrive esplicitamente).',
        'Chiedere all’azienda come gestisce oggi prenotazioni o richieste (telefono, portali, email).',
      ],
    },
    {
      id: 'hosting_assistenza',
      name: 'Server, hosting & assistenza',
      category: 'sviluppo',
      description:
        'Server e hosting gestiti, monitoraggio e manutenzione continuativa, backup, sicurezza e aggiornamenti, assistenza tecnica.',
      source: `${SRC}server-hosting-assistenza`,
      verified: true,
      active: true,
      autoMatch: true,
      requiresTeamConfirmation: false,
      problems: [
        'Sito non raggiungibile in modo ripetuto',
        'Certificato HTTPS assente, non valido o in scadenza',
        'Server lento o con errori',
      ],
      categories: ALL,
      // le intestazioni di sicurezza mancanti (rilievo informativo) non bastano da sole: non sono nell'elenco
      findings: {
        SEC_NO_HTTPS: 3,
        SEC_TLS_ERROR: 3,
        SEC_CERT_EXPIRING: 2,
        SEC_HTTP_NOT_REDIRECTED: 2,
        SEC_MIXED_CONTENT: 1,
        AVAIL_HTTP_ERROR: 2,
        AVAIL_SLOW_RESPONSE: 1,
        AVAIL_UNREACHABLE: 3,
        AVAIL_TIMEOUT: 3,
      },
      capabilityGaps: {},
      repeatedFailure: true,
      context: {},
      disqualifiers: [],
      dedupeGroup: 'infrastruttura',
      prerequisites: [],
      nextSteps: [
        'Ricontrollare il sito: problemi di certificato o di raggiungibilità possono essere già stati risolti.',
        'Chiedere chi gestisce oggi hosting e manutenzione.',
      ],
    },
    // Servizi confermati ma non abbinabili in automatico: nessuna prova automatica ne indica il bisogno.
    ...(
      [
        [
          'app_mobile',
          'App mobile iOS & Android',
          'sviluppo',
          'App native e cross-platform per iOS e Android, dall’idea alla pubblicazione sugli store, con integrazioni e manutenzione.',
          'app-mobile',
        ],
        [
          'automazioni_ai_bot',
          'Automazioni AI & Bot Telegram',
          'sviluppo',
          'Bot Telegram e automazioni su misura: notifiche e report automatici, collegamenti con gestionale e CRM, assistenti conversazionali con AI.',
          'bot-telegram',
        ],
        [
          'software_su_misura',
          'Software su misura & Vibe Coding',
          'sviluppo',
          'Software su misura sviluppato con AI e LLM e verificato da persone: gestionali, piattaforme web con area riservata, integrazioni.',
          'vibe-coding',
        ],
        [
          'intelligenza_artificiale',
          'Intelligenza artificiale',
          'sviluppo',
          'Soluzioni AI su misura: chatbot e assistenti sui contenuti aziendali, automazione di processi con modelli linguistici.',
          'intelligenza-artificiale',
        ],
        [
          'digital_marketing',
          'Digital marketing',
          'marketing',
          'Strategie di marketing digitale integrate e misurabili: posizionamento, piano dei canali e dei contenuti, email marketing, analytics, report.',
          'digital-marketing',
        ],
        [
          'web_advertising',
          'Web advertising',
          'marketing',
          'Campagne Google Ads, Meta Ads e LinkedIn Ads con tracciamento delle conversioni e ottimizzazione del budget.',
          'web-advertising',
        ],
      ] as const
    ).map(([id, name, category, description, slug]): CatalogService => ({
      id,
      name,
      category,
      description,
      source: `${SRC}${slug}`,
      verified: true,
      active: true,
      autoMatch: false,
      requiresTeamConfirmation: true,
      problems: [],
      categories: ALL,
      findings: {},
      capabilityGaps: {},
      repeatedFailure: false,
      context: {},
      disqualifiers: [],
      dedupeGroup: id,
      prerequisites: [],
      nextSteps: [
        'Valutabile solo a colloquio: le prove raccolte automaticamente non indicano se l’azienda ne abbia bisogno.',
      ],
    })),
  ],
};
