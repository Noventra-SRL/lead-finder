import { z } from 'zod';
import type { Db, Queryable } from '../db/client.ts';
import { audit } from '../audit.ts';
import { JobError } from '../discovery/jobs.ts';

/*
 * Configurazione della valutazione commerciale con AI: pesi delle cinque componenti, penalità commerciali, fasce.
 * Versionata nel database (ai_scoring_configs): cambiarla non riscrive le valutazioni esistenti, che ricordano la
 * versione usata; le nuove valutazioni (e la cache) usano la versione attiva.
 */

export const COMPONENTS = ['acquisition', 'service_fit', 'improvement', 'attractiveness', 'evidence_quality'] as const;
export type Component = (typeof COMPONENTS)[number];

export const COMPONENT_LABEL: Record<Component, string> = {
  acquisition: 'Probabilità stimata di acquisizione',
  service_fit: 'Compatibilità con i servizi di Noventra',
  improvement: 'Opportunità di miglioramento digitale',
  attractiveness: 'Attrattività e sostenibilità commerciale',
  evidence_quality: 'Qualità e affidabilità delle prove',
};

/**
 * Penalità commerciali. Il gruppo indica l'ostacolo di fondo: dentro un gruppo si applica solo la penalità più alta,
 * così lo stesso ostacolo non viene contato due volte (es. ente pubblico e procedure d'acquisto complesse).
 */
export const PENALTIES = {
  public_institution: {
    label: 'Ente pubblico o istituzione',
    group: 'decisione_esterna',
    rationale: 'Gare, mercato elettronico e procedure formali rendono improbabile una vendita diretta.',
  },
  complex_procurement: {
    label: 'Processo d’acquisto complesso o decisore irraggiungibile',
    group: 'decisione_esterna',
    rationale: 'Un ciclo di vendita sproporzionato per un’agenzia delle dimensioni di Noventra.',
  },
  franchise: {
    label: 'Franchising o sito gestito centralmente',
    group: 'decisione_esterna',
    rationale: 'La sede locale di norma non sceglie il fornitore del sito.',
  },
  old_but_adequate_website: {
    label: 'Sito datato ma adeguato',
    group: 'sito_adeguato',
    rationale: 'Un sito vecchio che funziona e non ha carenze rilevanti non dà un motivo concreto per cambiarlo.',
  },
  modern_adequate_website: {
    label: 'Sito moderno e adeguato',
    group: 'sito_adeguato',
    rationale: 'Un investimento recente e funzionante riduce l’opportunità di rifacimento.',
  },
  poor_service_fit: {
    label: 'Bisogno non coperto dai servizi di Noventra',
    group: 'servizi',
    rationale: 'Noventra non offre una soluzione adatta al bisogno emerso.',
  },
  existing_client: {
    label: 'Già cliente (dal CRM)',
    group: 'relazione',
    rationale: 'Un cliente esistente non è una nuova acquisizione senza un motivo commerciale preciso.',
  },
  recently_lost: {
    label: 'Opportunità persa di recente (dal CRM)',
    group: 'relazione',
    rationale: 'Una trattativa chiusa da poco riduce le probabilità di un nuovo contatto a breve.',
  },
} as const;
export type PenaltyType = keyof typeof PENALTIES;
export const PENALTY_TYPES = Object.keys(PENALTIES) as [PenaltyType, ...PenaltyType[]];

const configSchema = z
  .object({
    /** Pesi in percentuale, interi, somma 100. */
    weights: z.object(
      Object.fromEntries(COMPONENTS.map((c) => [c, z.number().int().min(0).max(100)])) as Record<
        Component,
        z.ZodNumber
      >,
    ),
    /** Punti sottratti al punteggio pesato (gravità alta = valore pieno). */
    penalties: z.object(
      Object.fromEntries(PENALTY_TYPES.map((p) => [p, z.number().int().min(0).max(50)])) as Record<
        PenaltyType,
        z.ZodNumber
      >,
    ),
    /** Moltiplicatori per la gravità indicata dal modello. */
    severity: z.object({
      low: z.number().min(0).max(1),
      medium: z.number().min(0).max(1),
      high: z.number().min(0).max(1),
    }),
    /** Fasce in ordine decrescente di soglia minima; l'ultima parte da 0. */
    bands: z
      .array(
        z.object({
          id: z.string().regex(/^[a-z_]{2,30}$/),
          min: z.number().int().min(0).max(100),
          label: z.string().min(2).max(60),
        }),
      )
      .min(2)
      .max(8),
    /** Senza prove verificate (audit o sito non indicato) la componente "miglioramento" non supera questo valore. */
    improvementCapWithoutEvidence: z.number().int().min(0).max(100),
    /** Un punteggio da questa soglia con affidabilità bassa va qualificato a mano. */
    reviewThreshold: z.number().int().min(0).max(100),
  })
  .strict()
  .superRefine((c, ctx) => {
    const sum = COMPONENTS.reduce((s, k) => s + c.weights[k], 0);
    if (sum !== 100)
      ctx.addIssue({ code: 'custom', path: ['weights'], message: `I pesi devono sommare a 100 (ora ${sum}).` });
    const mins = c.bands.map((b) => b.min);
    if (mins.at(-1) !== 0)
      ctx.addIssue({ code: 'custom', path: ['bands'], message: 'L’ultima fascia deve partire da 0.' });
    if (mins.some((m, i) => i > 0 && m >= mins[i - 1]!))
      ctx.addIssue({ code: 'custom', path: ['bands'], message: 'Le soglie delle fasce devono essere decrescenti.' });
    if (new Set(c.bands.map((b) => b.id)).size !== c.bands.length)
      ctx.addIssue({ code: 'custom', path: ['bands'], message: 'Fasce ripetute.' });
  });

export type AiScoringConfig = z.infer<typeof configSchema>;

export const DEFAULT_AI_CONFIG: AiScoringConfig = {
  weights: { acquisition: 40, service_fit: 30, improvement: 15, attractiveness: 10, evidence_quality: 5 },
  penalties: {
    public_institution: 20,
    complex_procurement: 12,
    franchise: 15,
    old_but_adequate_website: 10,
    modern_adequate_website: 12,
    poor_service_fit: 20,
    existing_client: 25,
    recently_lost: 10,
  },
  severity: { low: 0.5, medium: 0.75, high: 1 },
  bands: [
    { id: 'alta', min: 80, label: 'Alta priorità commerciale' },
    { id: 'promettente', min: 60, label: 'Opportunità promettente' },
    { id: 'da_qualificare', min: 40, label: 'Da qualificare' },
    { id: 'bassa', min: 20, label: 'Bassa priorità' },
    { id: 'molto_debole', min: 0, label: 'Opportunità molto debole o non adatta' },
  ],
  improvementCapWithoutEvidence: 70,
  reviewThreshold: 60,
};

export function validateAiConfig(
  input: unknown,
): { ok: true; config: AiScoringConfig } | { ok: false; errors: Record<string, string> } {
  const r = configSchema.safeParse(input);
  if (r.success) return { ok: true, config: r.data };
  const errors: Record<string, string> = {};
  for (const i of r.error.issues) errors[i.path.join('.') || '_'] ??= i.message;
  return { ok: false, errors };
}

export const bandOf = (config: AiScoringConfig, score: number) =>
  config.bands.find((b) => score >= b.min) ?? config.bands.at(-1)!;

export interface ActiveAiConfig {
  version: number;
  config: AiScoringConfig;
  createdAt: string;
  note: string | null;
}

export async function activeAiConfig(db: Queryable): Promise<ActiveAiConfig> {
  const read = () =>
    db.query<{ version: number; config: unknown; created_at: Date; note: string | null }>(
      'SELECT version, config, created_at, note FROM ai_scoring_configs ORDER BY version DESC LIMIT 1',
    );
  let { rows } = await read();
  if (!rows[0]) {
    await db.query(
      "INSERT INTO ai_scoring_configs (version, config, note) VALUES (1, $1, 'Pesi e penalità iniziali') ON CONFLICT (version) DO NOTHING",
      [JSON.stringify(DEFAULT_AI_CONFIG)],
    );
    ({ rows } = await read());
  }
  const r = rows[0]!;
  const v = validateAiConfig(r.config);
  if (!v.ok) throw new Error(`Configurazione della valutazione AI v${r.version} non valida`);
  return { version: r.version, config: v.config, createdAt: new Date(r.created_at).toISOString(), note: r.note };
}

export async function saveAiConfig(db: Db, input: unknown, ctx: { userId: string; note?: string }) {
  const v = validateAiConfig(input);
  if (!v.ok) throw new JobError(400, 'INVALID_CONFIG', 'Configurazione non valida.', undefined, { fields: v.errors });
  const current = await activeAiConfig(db);
  return db.transaction(async (tx) => {
    const version = current.version + 1;
    await tx.query('INSERT INTO ai_scoring_configs (version, config, note, created_by) VALUES ($1, $2, $3, $4)', [
      version,
      JSON.stringify(v.config),
      ctx.note || null,
      ctx.userId,
    ]);
    await audit(tx, {
      userId: ctx.userId,
      action: 'ai.config_updated',
      entityType: 'ai_scoring_config',
      details: { version },
    });
    return version;
  });
}
