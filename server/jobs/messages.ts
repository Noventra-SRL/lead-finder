import type { Queryable } from '../db/client.ts';

/*
 * Messaggi leggibili dei job (scoperta e audit): elenco limitato agli ultimi 50, nella colonna "messages".
 * Le tabelle ammesse sono elencate qui: il nome non arriva mai da un input esterno.
 */

export interface JobMessage {
  at: string;
  level: 'info' | 'warning' | 'error';
  message: string;
}

export type JobTable = 'discovery_jobs' | 'audit_jobs' | 'hunt_runs' | 'ai_jobs';
const TABLES: readonly JobTable[] = ['discovery_jobs', 'audit_jobs', 'hunt_runs', 'ai_jobs'];
const MAX_MESSAGES = 50;

export const jobMessage = (level: JobMessage['level'], text: string): JobMessage => ({
  at: new Date().toISOString(),
  level,
  message: text,
});

export async function appendMessages(tx: Queryable, table: JobTable, jobId: string, messages: JobMessage[]) {
  if (!messages.length) return;
  if (!TABLES.includes(table)) throw new Error(`Tabella di job non ammessa: ${table}`);
  const { rows } = await tx.query<{ messages: JobMessage[] }>(
    `SELECT messages FROM ${table} WHERE id = $1 FOR UPDATE`,
    [jobId],
  );
  const all = [...(rows[0]?.messages ?? []), ...messages].slice(-MAX_MESSAGES);
  await tx.query(`UPDATE ${table} SET messages = $2, updated_at = now() WHERE id = $1`, [jobId, JSON.stringify(all)]);
}
