import { describe, expect, it } from 'vitest';
import { createLogger, redact } from './logger.ts';

describe('logger', () => {
  it('nasconde i campi sensibili a qualsiasi profondità', () => {
    const out = redact({
      password: 'x',
      nested: { newPassword: 'y', sessionId: 'z', Authorization: 'Bearer t', ok: 1 },
      list: [{ token: 'k' }],
      DATABASE_URL: 'postgres://u:p@h/db',
    });
    expect(JSON.stringify(out)).not.toMatch(/"x"|"y"|"z"|Bearer|"k"|postgres:/);
    expect(out).toMatchObject({ nested: { ok: 1 } });
  });

  it('scrive JSON strutturato e rispetta il livello minimo', () => {
    const lines: string[] = [];
    const log = createLogger({ level: 'info', format: 'json', sink: (l) => lines.push(l) });
    log.debug('nascosto');
    log.child({ requestId: 'abc' }).info('richiesta', { status: 200, cookie: 'nlf_session=segreto' });
    expect(lines).toHaveLength(1);
    const entry = JSON.parse(lines[0]!);
    expect(entry).toMatchObject({
      level: 'info',
      msg: 'richiesta',
      requestId: 'abc',
      status: 200,
      cookie: '[nascosto]',
    });
    expect(lines[0]).not.toContain('segreto');
  });

  it('riduce gli errori a nome, messaggio e codice', () => {
    const e = Object.assign(new Error('boom'), { code: 'E1', config: { password: 'p' } });
    expect(redact({ error: e })).toEqual({ error: { name: 'Error', message: 'boom', code: 'E1' } });
  });
});
