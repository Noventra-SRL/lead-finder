import { z } from 'zod';
import type { AiConfig } from '../config.ts';
import type { Db } from '../db/client.ts';
import { assessBusiness, type AssessOutcome } from './assess.ts';
import { buildContext } from './context.ts';
import { aiOutputSchema, SYSTEM_PROMPT, userMessage } from './prompt.ts';
import type { AiCallResult, AiProvider } from './provider.ts';

/*
 * Valutazione «dalla chat» (solo sviluppo e prove): al posto della chiamata all'API, una persona o un assistente
 * (Claude in una sessione di Claude Code) legge lo stesso prompt e le stesse prove che riceverebbe il modello e
 * restituisce la risposta nello schema `aiOutputSchema`. Da lì il percorso è identico: validazione delle prove,
 * secondo tentativo impossibile (la risposta è una sola, l'errore torna a chi l'ha scritta), calcolo deterministico
 * del punteggio, salvataggio con provider «chat». Nessuna chiave, nessun costo.
 */

export const CHAT_MODEL = 'claude-chat (sessione Claude Code)';

/** Fornitore a risposta unica: restituisce l'uscita già scritta. */
export class ChatProvider implements AiProvider {
  readonly name = 'chat';
  readonly model = CHAT_MODEL;
  private readonly output: unknown;
  constructor(output: unknown) {
    this.output = output;
  }
  async assess(): Promise<AiCallResult> {
    return { output: this.output, model: this.model, inputTokens: null, outputTokens: null };
  }
  async structured(): Promise<AiCallResult> {
    return this.assess();
  }
}

/** Aziende senza una valutazione AI corrente, con il prompt completo da valutare. */
export async function pendingForChat(db: Db, opts: { limit: number; businessIds?: string[] }) {
  const { rows } = await db.query<{ id: string; name: string }>(
    `SELECT b.id, b.name FROM businesses b
       LEFT JOIN lead_scores s ON s.business_id = b.id AND s.is_current
      WHERE b.merged_into IS NULL AND b.excluded_at IS NULL
        AND ($2::uuid[] IS NULL OR b.id = ANY($2::uuid[]))
        AND NOT EXISTS (SELECT 1 FROM ai_assessments a WHERE a.business_id = b.id AND a.is_current)
      ORDER BY s.score DESC NULLS LAST, b.name LIMIT $1`,
    [opts.limit, opts.businessIds ?? null],
  );
  const items = [];
  for (const r of rows) {
    const ctx = await buildContext(db, r.id);
    if (ctx) items.push({ businessId: r.id, name: r.name, prompt: userMessage(ctx) });
  }
  return { system: SYSTEM_PROMPT, schema: z.toJSONSchema(aiOutputSchema), items };
}

/** Risposta scritta in chat → stesso percorso di una valutazione del modello (validazione, punteggio, salvataggio). */
export async function submitFromChat(
  db: Db,
  aiConfig: AiConfig,
  businessId: string,
  output: unknown,
  userId: string,
): Promise<AssessOutcome> {
  return assessBusiness(db, new ChatProvider(output), aiConfig, businessId, {
    trigger: 'manual',
    userId,
    force: true,
  });
}
