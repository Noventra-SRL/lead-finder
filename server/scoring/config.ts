import { z } from 'zod';
import { CATEGORIES, type CategoryId } from '../discovery/categories.ts';
import { FINDINGS, SERVICE_AREAS, type FindingCode, type ServiceArea } from '../audit/findings.ts';

/*
 * Configurazione del punteggio dei lead: TUTTE le costanti del modello sono qui, validate con zod.
 * La configurazione attiva è salvata nel database con un numero di versione (scoring_configs); ogni punteggio
 * registra la versione usata, così i risultati storici restano interpretabili dopo una modifica.
 * Il punteggio è un criterio di priorità, non una probabilità di acquisto.
 */

export const SCORING_ALGORITHM_VERSION = 1;

export const DIMENSIONS = ['technical', 'capabilities', 'industry', 'evidence', 'commercial'] as const;
export type Dimension = (typeof DIMENSIONS)[number];

/** Capacità digitali valutabili con le prove dell'audit (signals della Fase 3 e rilievi). */
export const CAPABILITIES = {
  website: 'Sito ufficiale proprio',
  mobile: 'Sito adatto ai dispositivi mobili',
  contact_route: 'Canale di contatto chiaro (telefono, email, modulo o pagina contatti)',
  call_to_action: 'Inviti all’azione',
  services_info: 'Presentazione di servizi o prodotti',
  opening_hours: 'Orari di apertura',
  local_seo: 'Segnali di SEO locale (indirizzo e dati strutturati)',
  booking: 'Prenotazione online',
  appointment: 'Richiesta di appuntamento online',
  reservation: 'Prenotazione o ordinazione online',
  direct_booking: 'Prenotazione diretta',
  online_ordering: 'Ordini online',
  menu: 'Menù consultabile',
  rooms: 'Informazioni sulle camere',
  schedule: 'Calendario di corsi o attività',
  catalog: 'Catalogo di prodotti',
  ecommerce: 'Vendita online',
  quote_request: 'Richiesta di preventivo (modulo)',
} as const;
export type Capability = keyof typeof CAPABILITIES;

const CAPABILITY_IDS = Object.keys(CAPABILITIES) as [Capability, ...Capability[]];
const SERVICE_IDS = Object.keys(SERVICE_AREAS) as [ServiceArea, ...ServiceArea[]];
const CATEGORY_IDS = Object.keys(CATEGORIES) as [CategoryId, ...CategoryId[]];
const FINDING_IDS = Object.keys(FINDINGS) as [FindingCode, ...FindingCode[]];

const pct = z.number().min(0).max(100);
const weight = z.number().min(0).max(1000);
const factor = z.number().min(0).max(1);

const categoryRules = z
  .object({
    /** Capacità pertinenti per il settore, con la loro importanza relativa (le altre sono "non pertinenti"). */
    capabilities: z.partialRecord(z.enum(CAPABILITY_IDS), z.number().min(0.1).max(10)),
    /** Pertinenza di base del settore per i servizi di Noventra (0–100): un solo segnale, mai sufficiente da solo. */
    baseRelevance: pct,
    /** Servizi pertinenti per il settore, con la loro importanza relativa. */
    services: z.partialRecord(z.enum(SERVICE_IDS), z.number().min(0.1).max(10)),
  })
  .strict();

export const scoringConfigSchema = z
  .object({
    weights: z
      .object(Object.fromEntries(DIMENSIONS.map((d) => [d, weight])) as Record<Dimension, typeof weight>)
      .strict(),
    bands: z
      .object({ A: pct, B: pct, C: pct })
      .strict()
      .refine((b) => b.A > b.B && b.B > b.C, 'Le soglie devono essere decrescenti: A > B > C.'),
    thresholds: z
      .object({
        /** Completezza dei dati minima per presentare un punteggio (sotto: "dati insufficienti"). */
        minCompleteness: pct,
        /** Somma minima dei pesi delle dimensioni con prove (in % del totale). */
        minActiveWeightPct: pct,
        /** Affidabilità minima: sotto, un lead con punteggio almeno C va verificato prima di essere classificato. */
        minConfidence: pct,
        /** Soglie dell'affidabilità mostrata come alta / media. */
        confidenceHigh: pct,
        confidenceMedium: pct,
      })
      .strict()
      .refine((t) => t.confidenceHigh > t.confidenceMedium, 'L’affidabilità "alta" deve superare la "media".'),
    freshness: z
      .object({
        /** Un audit è recente fino a questi giorni, invecchiato fino a staleDays, poi superato. */
        auditFreshDays: z.number().int().min(1).max(3650),
        auditStaleDays: z.number().int().min(1).max(3650),
        /** Dati della fonte (conferma dell'attività) considerati attuali fino a questi giorni. */
        sourceFreshDays: z.number().int().min(1).max(3650),
      })
      .strict()
      .refine((f) => f.auditStaleDays > f.auditFreshDays, 'auditStaleDays deve superare auditFreshDays.'),
    technical: z
      .object({
        /** Punti per gravità del rilievo (prima del fattore di affidabilità). */
        severityPoints: z.object({ high: weight, medium: weight, low: weight, info: weight }).strict(),
        confidenceFactor: z.object({ high: factor, medium: factor, low: factor }).strict(),
        /** Dentro un gruppo vale il rilievo più forte, più questa frazione degli altri. */
        secondaryFactor: factor,
        /** Punti che corrispondono al 100% della dimensione. */
        saturationPoints: z.number().min(1).max(10_000),
        /** Valore della dimensione quando il sito ha fallito più audit consecutivi (problema ripetuto, non un caso). */
        repeatedFailureScore: pct,
        repeatedFailureAudits: z.number().int().min(2).max(10),
        /** Rilievi dello stesso problema di fondo: contano come uno solo. */
        groups: z.record(z.string().regex(/^[a-z_]{2,40}$/), z.array(z.enum(FINDING_IDS)).min(1)),
      })
      .strict(),
    capabilities: z
      .object({
        /** Peso della lacuna: "assente" (misurato) e "non rilevato" (cercato nelle pagine esaminate, non trovato). */
        gapFactor: z.object({ missing: factor, not_detected: factor }).strict(),
        /** Servizio di Noventra collegato a ciascuna capacità. */
        services: z.record(z.enum(CAPABILITY_IDS), z.enum(SERVICE_IDS)),
      })
      .strict(),
    categories: z.record(z.enum(CATEGORY_IDS), categoryRules),
    commercial: z
      .object({
        /** Pesi degli indicatori commerciali osservabili (nessuna stima di fatturato, dimensione o budget). */
        weights: z
          .object({
            activeOperation: weight,
            onlinePresence: weight,
            identifiableOffer: weight,
            contactChannel: weight,
            existingOnlineProcess: weight,
            actionableProblem: weight,
          })
          .strict(),
        /** Peso minimo degli indicatori verificabili per calcolare la dimensione (altrimenti: sconosciuta). */
        minKnownWeight: weight,
      })
      .strict(),
    completeness: z
      .object({
        audit: weight,
        capabilities: weight,
        businessData: weight,
        location: weight,
      })
      .strict(),
    rules: z
      .object({
        /** Settori dichiarati non adatti (scelta esplicita dell'amministratore). Predefinito: nessuno. */
        notSuitableCategories: z.array(z.enum(CATEGORY_IDS)),
      })
      .strict(),
  })
  .strict()
  .superRefine((c, ctx) => {
    const active = DIMENSIONS.reduce((s, d) => s + c.weights[d], 0);
    if (active <= 0)
      ctx.addIssue({
        code: 'custom',
        path: ['weights'],
        message: 'Almeno una dimensione deve avere peso maggiore di zero.',
      });
    const seen = new Map<string, string>();
    for (const [group, codes] of Object.entries(c.technical.groups))
      for (const code of codes) {
        if (seen.has(code))
          ctx.addIssue({
            code: 'custom',
            path: ['technical', 'groups', group],
            message: `${code} è già nel gruppo ${seen.get(code)}.`,
          });
        seen.set(code, group);
      }
    for (const cat of CATEGORY_IDS)
      if (!c.categories[cat])
        ctx.addIssue({
          code: 'custom',
          path: ['categories', cat],
          message: `Manca la configurazione del settore ${cat}.`,
        });
    for (const cap of CAPABILITY_IDS)
      if (!c.capabilities.services[cap])
        ctx.addIssue({
          code: 'custom',
          path: ['capabilities', 'services', cap],
          message: `Manca il servizio della capacità ${cap}.`,
        });
  });

export type ScoringConfig = z.infer<typeof scoringConfigSchema>;

/** Errori di validazione leggibili: { "percorso.del.campo": "messaggio" }. */
export function validateScoringConfig(
  input: unknown,
): { ok: true; config: ScoringConfig } | { ok: false; errors: Record<string, string> } {
  const r = scoringConfigSchema.safeParse(input);
  if (r.success) return { ok: true, config: r.data };
  const errors: Record<string, string> = {};
  for (const issue of r.error.issues) errors[issue.path.join('.') || '_'] ??= issue.message;
  return { ok: false, errors };
}

const base = { website: 3, mobile: 2, contact_route: 2 } as const;

/** Valori iniziali (versione 1 della configurazione). Modificabili dagli amministratori senza toccare il codice. */
export const DEFAULT_SCORING_CONFIG: ScoringConfig = {
  weights: { technical: 30, capabilities: 25, industry: 15, evidence: 15, commercial: 15 },
  bands: { A: 80, B: 60, C: 40 },
  thresholds: {
    minCompleteness: 55,
    minActiveWeightPct: 50,
    minConfidence: 45,
    confidenceHigh: 70,
    confidenceMedium: 45,
  },
  freshness: { auditFreshDays: 30, auditStaleDays: 120, sourceFreshDays: 365 },
  technical: {
    severityPoints: { high: 30, medium: 15, low: 5, info: 0 },
    confidenceFactor: { high: 1, medium: 0.75, low: 0.5 },
    secondaryFactor: 0.25,
    saturationPoints: 80,
    repeatedFailureScore: 75,
    repeatedFailureAudits: 2,
    groups: {
      metadati: [
        'SEO_MISSING_TITLE',
        'SEO_TITLE_LENGTH',
        'SEO_MISSING_META_DESCRIPTION',
        'SEO_META_DESCRIPTION_LENGTH',
        'SEO_NO_OPEN_GRAPH',
        'SEO_MISSING_H1',
        'SEO_MULTIPLE_H1',
      ],
      https: [
        'SEC_NO_HTTPS',
        'SEC_TLS_ERROR',
        'SEC_CERT_EXPIRING',
        'SEC_HTTP_NOT_REDIRECTED',
        'SEC_MIXED_CONTENT',
        'SEC_INSECURE_FORM',
        'SEC_HEADERS_MISSING',
      ],
      mobile: [
        'MOBILE_NO_VIEWPORT',
        'MOBILE_VIEWPORT_FIXED',
        'MOBILE_FIXED_WIDTH',
        'MOBILE_LEGACY_LAYOUT',
        'MOBILE_ZOOM_DISABLED',
        'MOBILE_IMAGES_NO_DIMENSIONS',
      ],
      indicizzazione: [
        'SEO_NOINDEX',
        'SEO_ROBOTS_DISALLOW_ALL',
        'SEO_CANONICAL_MISSING',
        'SEO_CANONICAL_OTHER_HOST',
        'SEO_NO_SITEMAP',
      ],
      dati_strutturati: ['SEO_NO_STRUCTURED_DATA', 'SEO_INVALID_JSON_LD'],
      prestazioni: ['PERF_LOW_SCORE', 'PERF_LCP_SLOW', 'PERF_CLS_HIGH', 'PERF_INP_SLOW', 'AVAIL_SLOW_RESPONSE'],
      disponibilita: ['AVAIL_HTTP_ERROR', 'AVAIL_NOT_HTML', 'AVAIL_REDIRECT_CHAIN'],
      contenuti: ['SEO_THIN_CONTENT', 'SEO_IMAGES_MISSING_ALT', 'SEO_MISSING_LANG'],
      collegamenti: ['SEO_BROKEN_INTERNAL_LINKS'],
    },
  },
  capabilities: {
    gapFactor: { missing: 1, not_detected: 0.6 },
    services: {
      website: 'sviluppo_siti_web',
      mobile: 'sviluppo_siti_web',
      contact_route: 'web_design',
      call_to_action: 'web_design',
      services_info: 'web_design',
      opening_hours: 'web_design',
      local_seo: 'seo',
      booking: 'gestionali_crm',
      appointment: 'gestionali_crm',
      reservation: 'gestionali_crm',
      direct_booking: 'gestionali_crm',
      online_ordering: 'gestionali_crm',
      menu: 'web_design',
      rooms: 'web_design',
      schedule: 'web_design',
      catalog: 'ecommerce',
      ecommerce: 'ecommerce',
      quote_request: 'gestionali_crm',
    },
  },
  categories: {
    farmacie: {
      capabilities: { ...base, opening_hours: 2, services_info: 2, local_seo: 2, appointment: 1, catalog: 1 },
      baseRelevance: 80,
      services: { sviluppo_siti_web: 3, seo: 3, web_design: 2, gestionali_crm: 1, ecommerce: 1 },
    },
    parafarmacie: {
      capabilities: { ...base, opening_hours: 1, catalog: 2, ecommerce: 2, local_seo: 1 },
      baseRelevance: 80,
      services: { sviluppo_siti_web: 3, ecommerce: 3, seo: 2, web_design: 2 },
    },
    hotel: {
      capabilities: { ...base, direct_booking: 3, rooms: 2, call_to_action: 1, local_seo: 1 },
      baseRelevance: 90,
      services: { sviluppo_siti_web: 3, gestionali_crm: 3, seo: 2, web_design: 2, digital_marketing: 2 },
    },
    extralberghiero: {
      capabilities: { ...base, direct_booking: 3, rooms: 2, call_to_action: 1, local_seo: 1 },
      baseRelevance: 85,
      services: { sviluppo_siti_web: 3, gestionali_crm: 3, seo: 2, web_design: 2, digital_marketing: 1 },
    },
    ristorazione: {
      capabilities: { ...base, contact_route: 1, menu: 3, reservation: 2, opening_hours: 2, local_seo: 2 },
      baseRelevance: 80,
      services: { sviluppo_siti_web: 3, web_design: 3, seo: 2, gestionali_crm: 2, digital_marketing: 1 },
    },
    studi_sanitari: {
      capabilities: { ...base, appointment: 3, services_info: 2, opening_hours: 1, local_seo: 1 },
      baseRelevance: 75,
      services: { sviluppo_siti_web: 3, gestionali_crm: 3, seo: 2, web_design: 2 },
    },
    studi_professionali: {
      capabilities: { ...base, services_info: 2, call_to_action: 2, appointment: 1, local_seo: 1 },
      baseRelevance: 70,
      services: { sviluppo_siti_web: 3, seo: 3, web_design: 2, gestionali_crm: 1 },
    },
    palestre_benessere: {
      capabilities: { ...base, contact_route: 1, schedule: 3, booking: 2, call_to_action: 2, opening_hours: 1 },
      baseRelevance: 80,
      services: { sviluppo_siti_web: 3, gestionali_crm: 2, web_design: 2, digital_marketing: 2, seo: 1 },
    },
    artigiani_servizi: {
      capabilities: { ...base, services_info: 2, call_to_action: 2, local_seo: 2 },
      baseRelevance: 70,
      services: { sviluppo_siti_web: 3, seo: 3, web_design: 2 },
    },
    industria: {
      capabilities: { website: 3, mobile: 1, contact_route: 2, services_info: 2, catalog: 2, quote_request: 2 },
      baseRelevance: 70,
      services: { sviluppo_siti_web: 3, web_design: 2, seo: 2, gestionali_crm: 2, ecommerce: 1 },
    },
    aziende_uffici: {
      capabilities: { ...base, services_info: 2, call_to_action: 1 },
      baseRelevance: 60,
      services: { sviluppo_siti_web: 3, web_design: 2, seo: 2, gestionali_crm: 1 },
    },
    negozi: {
      capabilities: { ...base, contact_route: 1, catalog: 2, ecommerce: 2, opening_hours: 2, local_seo: 2 },
      baseRelevance: 75,
      services: { sviluppo_siti_web: 3, ecommerce: 3, seo: 2, web_design: 2, digital_marketing: 1 },
    },
  },
  commercial: {
    weights: {
      activeOperation: 2,
      onlinePresence: 1,
      identifiableOffer: 2,
      contactChannel: 2,
      existingOnlineProcess: 1,
      actionableProblem: 2,
    },
    minKnownWeight: 4,
  },
  completeness: { audit: 40, capabilities: 25, businessData: 20, location: 15 },
  rules: { notSuitableCategories: [] },
};
