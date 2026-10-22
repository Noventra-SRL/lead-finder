import type { LogLevel } from './config.ts';

/*
 * Registro centralizzato del server. Ogni riga ha livello, ora, messaggio e campi strutturati.
 *  - produzione: una riga JSON per evento (leggibile da qualsiasi raccoglitore di log);
 *  - sviluppo: testo leggibile.
 * I campi con nomi sensibili (password, token, cookie, segreti, DATABASE_URL…) sono sostituiti da "[nascosto]"
 * a qualsiasi profondità: un errore di programmazione non può far finire un segreto nei log.
 */

export interface Logger {
  debug(message: string, fields?: Record<string, unknown>): void;
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
  child(fields: Record<string, unknown>): Logger;
}

const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const SENSITIVE =
  /pass(word)?|secret|token|cookie|authorization|api[-_]?key|database_url|connection_?string|session_?id/i;
const REDACTED = '[nascosto]';

export function redact(value: unknown, depth = 0): unknown {
  if (depth > 6) return '[profondità massima]';
  if (value instanceof Error)
    return { name: value.name, message: value.message, code: (value as { code?: unknown }).code };
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = SENSITIVE.test(k) ? REDACTED : redact(v, depth + 1);
    return out;
  }
  return value;
}

export type LogSink = (line: string, level: LogLevel) => void;

const defaultSink: LogSink = (line, level) => {
  (level === 'error' || level === 'warn' ? process.stderr : process.stdout).write(line + '\n');
};

export function createLogger(options: {
  level?: LogLevel;
  format?: 'json' | 'pretty';
  sink?: LogSink;
  base?: Record<string, unknown>;
}): Logger {
  const min = ORDER[options.level ?? 'info'];
  const format = options.format ?? 'pretty';
  const sink = options.sink ?? defaultSink;
  const base = options.base ?? {};

  const write = (level: LogLevel, message: string, fields?: Record<string, unknown>) => {
    if (ORDER[level] < min) return;
    const data = redact({ ...base, ...fields }) as Record<string, unknown>;
    const time = new Date().toISOString();
    if (format === 'json') {
      sink(JSON.stringify({ time, level, msg: message, ...data }), level);
      return;
    }
    const extra = Object.entries(data)
      .map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`)
      .join(' ');
    sink(`${time.slice(11, 19)} ${level.toUpperCase().padEnd(5)} ${message}${extra ? `  ${extra}` : ''}`, level);
  };

  return {
    debug: (m, f) => write('debug', m, f),
    info: (m, f) => write('info', m, f),
    warn: (m, f) => write('warn', m, f),
    error: (m, f) => write('error', m, f),
    child: (fields) => createLogger({ ...options, base: { ...base, ...fields } }),
  };
}

/** Registro muto per i test. */
export const silentLogger: Logger = createLogger({ level: 'error', sink: () => undefined });
