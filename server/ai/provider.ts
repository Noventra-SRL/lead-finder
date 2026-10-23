import Anthropic from '@anthropic-ai/sdk';
import type { z } from 'zod';
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod';
import type { AiConfig } from '../config.ts';
import { aiOutputSchema } from './prompt.ts';

/*
 * Fornitore del modello, solo lato server. La chiave resta in questo processo: non viene registrata, non entra nei
 * messaggi d'errore salvati e non arriva mai all'interfaccia.
 *
 * Anthropic (Claude): risposta strutturata validata con lo schema (structured outputs), riprova automatica con
 * attesa crescente sugli errori temporanei (429, 5xx, rete: gestita dall'SDK, AI_MAX_RETRIES volte), tempo massimo
 * per richiesta, fallback lato server se il modello rifiuta per una regola di sicurezza.
 */

export type AiErrorCode =
  | 'not_configured'
  | 'auth'
  | 'rate_limited'
  | 'timeout'
  | 'unavailable'
  | 'bad_request'
  | 'refusal'
  | 'truncated'
  | 'invalid_output'
  | 'unknown';

/** Errore del fornitore con un messaggio sicuro da mostrare e salvare (mai la chiave, mai la risposta grezza). */
export class AiError extends Error {
  readonly code: AiErrorCode;
  readonly retryable: boolean;
  constructor(code: AiErrorCode, message: string, retryable = false) {
    super(message);
    this.code = code;
    this.retryable = retryable;
  }
}

export interface AiCallResult {
  output: unknown;
  model: string;
  inputTokens: number | null;
  outputTokens: number | null;
}

export interface AiRequest {
  system: string;
  user: string;
  signal?: AbortSignal;
}

export interface AiProvider {
  readonly name: string;
  readonly model: string;
  /** Valutazione commerciale (schema di server/ai/prompt.ts). */
  assess(req: AiRequest): Promise<AiCallResult>;
  /** Risposta strutturata con uno schema qualsiasi (es. le email commerciali della Fase 9). */
  structured(req: AiRequest & { schema: z.ZodType; maxTokens?: number }): Promise<AiCallResult>;
  /** Verifica chiave e modello senza generare testo (nessun costo in token). */
  verify(): Promise<{ model: string }>;
}

export class AnthropicProvider implements AiProvider {
  readonly name = 'anthropic';
  readonly model: string;
  private readonly client: Anthropic;
  private readonly effort: AiConfig['effort'];

  /** `baseURL` solo per i test (server finto locale con il protocollo del fornitore). */
  constructor(config: AiConfig, options: { baseURL?: string } = {}) {
    if (!config.apiKey) throw new AiError('not_configured', 'Valutazione AI non configurata.');
    this.model = config.model;
    this.effort = config.effort;
    this.client = new Anthropic({
      apiKey: config.apiKey,
      maxRetries: config.maxRetries,
      timeout: config.timeoutMs,
      ...(options.baseURL ? { baseURL: options.baseURL } : {}),
    });
  }

  assess(req: AiRequest): Promise<AiCallResult> {
    return this.structured({ ...req, schema: aiOutputSchema });
  }

  // lettura delle informazioni del modello: conferma chiave, permessi e AI_MODEL senza consumare token
  async verify(): Promise<{ model: string }> {
    try {
      const m = await this.client.models.retrieve(this.model);
      return { model: m.id };
    } catch (error) {
      throw toAiError(error);
    }
  }

  async structured(req: AiRequest & { schema: z.ZodType; maxTokens?: number }): Promise<AiCallResult> {
    let res;
    try {
      res = await this.client.beta.messages.parse(
        {
          model: this.model,
          max_tokens: req.maxTokens ?? 16000,
          // se il modello rifiuta per una regola di sicurezza, il server ripete su un modello di riserva adatto
          betas: ['server-side-fallback-2026-07-01'],
          fallbacks: 'default',
          system: req.system,
          messages: [{ role: 'user', content: req.user }],
          output_config: { effort: this.effort, format: betaZodOutputFormat(req.schema) },
        },
        { signal: req.signal },
      );
    } catch (error) {
      throw toAiError(error);
    }
    if (res.stop_reason === 'refusal')
      throw new AiError('refusal', 'Il modello ha rifiutato la valutazione (regole di sicurezza del fornitore).');
    if (res.stop_reason === 'max_tokens') throw new AiError('truncated', 'Risposta del modello troncata.', true);
    if (!res.parsed_output) throw new AiError('invalid_output', 'Risposta del modello non conforme allo schema.', true);
    return {
      output: res.parsed_output,
      model: res.model,
      inputTokens: res.usage.input_tokens ?? null,
      outputTokens: res.usage.output_tokens ?? null,
    };
  }
}

/** Traduce gli errori dell'SDK in messaggi sicuri (codice HTTP al massimo, nessun dettaglio della richiesta). */
function toAiError(error: unknown): AiError {
  if (error instanceof AiError) return error;
  if (error instanceof Anthropic.AuthenticationError || error instanceof Anthropic.PermissionDeniedError)
    return new AiError(
      'auth',
      'Chiave del fornitore AI non valida o senza permessi: controlla AI_API_KEY sul server e riavvialo.',
    );
  if (error instanceof Anthropic.RateLimitError)
    return new AiError('rate_limited', 'Limite di richieste del fornitore AI raggiunto: riprova più tardi.', true);
  if (error instanceof Anthropic.APIConnectionTimeoutError)
    return new AiError('timeout', 'Il fornitore AI non ha risposto in tempo.', true);
  if (error instanceof Anthropic.APIConnectionError)
    return new AiError('unavailable', 'Fornitore AI non raggiungibile.', true);
  if (error instanceof Anthropic.BadRequestError || error instanceof Anthropic.NotFoundError)
    return new AiError(
      'bad_request',
      `Richiesta rifiutata dal fornitore AI (HTTP ${error.status}): controlla AI_MODEL.`,
    );
  if (error instanceof Anthropic.APIError)
    return new AiError('unavailable', `Errore del fornitore AI (HTTP ${error.status ?? '—'}).`, true);
  if (error instanceof Error && error.name === 'AbortError')
    return new AiError('timeout', 'Richiesta annullata.', true);
  // risposta non interpretabile come JSON dello schema
  if (error instanceof SyntaxError)
    return new AiError('invalid_output', 'Risposta del modello non interpretabile.', true);
  return new AiError('unknown', 'Errore imprevisto durante la valutazione AI.');
}

/**
 * Fornitore di prova (solo test): risponde con una funzione del messaggio inviato, senza rete e senza costi.
 * Può restituire una risposta, lanciare un AiError o attendere (per i timeout).
 */
export class FakeAiProvider implements AiProvider {
  readonly name = 'fake';
  readonly model: string;
  readonly calls: { system: string; user: string }[] = [];
  private readonly respond: (user: string, call: number) => unknown;

  constructor(respond: (user: string, call: number) => unknown, model = 'modello-di-prova') {
    this.respond = respond;
    this.model = model;
  }

  assess(req: AiRequest): Promise<AiCallResult> {
    return this.structured({ ...req, schema: aiOutputSchema });
  }

  /** Esito della verifica: il modello, oppure l'errore impostato dal test. */
  verifyError: AiError | null = null;

  verify(): Promise<{ model: string }> {
    return this.verifyError ? Promise.reject(this.verifyError) : Promise.resolve({ model: this.model });
  }

  async structured(req: AiRequest & { schema: z.ZodType }): Promise<AiCallResult> {
    this.calls.push({ system: req.system, user: req.user });
    const out = await this.respond(req.user, this.calls.length);
    if (out instanceof Error) throw out;
    return { output: out, model: this.model, inputTokens: Math.round(req.user.length / 4), outputTokens: 800 };
  }
}

export function createProvider(config: AiConfig): AiProvider | null {
  if (!config.provider || !config.apiKey) return null;
  return new AnthropicProvider(config, config.testBaseUrl ? { baseURL: config.testBaseUrl } : {});
}
