import { z } from 'zod';
import type { ExportResult } from './format.ts';

/* Parametri e risposta comuni delle esportazioni (formato, colonne, nome del file). */

export const exportParams = {
  format: z.enum(['csv', 'xlsx']).default('csv'),
  /** Colonne scelte (id del catalogo, separati da virgola); vuoto = predefinite. */
  fields: z
    .string()
    .max(2000)
    .optional()
    .transform((v) => (v ? v.split(',').filter(Boolean) : undefined)),
  /** Prima parte del nome del file (es. "prospect"). */
  name: z
    .string()
    .regex(/^[a-z0-9_-]{2,40}$/, 'Nome del file non valido.')
    .optional(),
};

/** Le colonne richieste devono esistere nel catalogo dell'elenco. */
export function checkFields(fields: string[] | undefined, catalog: { id: string }[]): string | null {
  if (!fields) return null;
  const known = new Set(catalog.map((c) => c.id));
  const unknown = fields.filter((f) => !known.has(f));
  if (unknown.length) return `Colonne sconosciute: ${unknown.join(', ')}.`;
  if (!fields.length) return 'Scegli almeno una colonna.';
  return null;
}

export function fileReply(r: ExportResult) {
  return {
    status: 200,
    file: {
      content: r.content,
      contentType: r.contentType,
      filename: r.filename,
      headers: { 'X-Export-Rows': String(r.rows), 'X-Export-Truncated': String(r.truncated) },
    },
  };
}
