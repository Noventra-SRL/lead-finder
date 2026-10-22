import { describe, expect, it } from 'vitest';
import { ConfigError, describeDatabase, loadConfig } from './config.ts';

describe('loadConfig', () => {
  it('usa valori predefiniti sicuri in sviluppo', () => {
    const c = loadConfig({});
    expect(c.env).toBe('development');
    expect(c.host).toBe('127.0.0.1');
    expect(c.port).toBe(8810);
    expect(c.database).toEqual({ kind: 'pglite', dataDir: '.data/pglite' });
    expect(c.security.secureCookies).toBe(false);
  });

  it('tratta le variabili vuote come assenti', () => {
    const c = loadConfig({ DATABASE_URL: '', API_PORT: '', APP_ORIGIN: '  ' });
    expect(c.database.kind).toBe('pglite');
    expect(c.port).toBe(8810);
    expect(c.security.appOrigin).toBeNull();
  });

  it('rifiuta valori non validi nominando la variabile, mai il valore', () => {
    const secret = 'mysql://utente:segretissima@host/db';
    let error: unknown;
    try {
      loadConfig({ DATABASE_URL: secret, API_PORT: '99999' });
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(ConfigError);
    const message = (error as Error).message;
    expect(message).toContain('DATABASE_URL');
    expect(message).toContain('API_PORT');
    expect(message).not.toContain('segretissima');
  });

  it('in produzione richiede DATABASE_URL e APP_ORIGIN https', () => {
    expect(() => loadConfig({ NODE_ENV: 'production' })).toThrow(/DATABASE_URL/);
    expect(() => loadConfig({ NODE_ENV: 'production', DATABASE_URL: 'postgres://h/db' })).toThrow(/APP_ORIGIN/);
    expect(() =>
      loadConfig({ NODE_ENV: 'production', DATABASE_URL: 'postgres://h/db', APP_ORIGIN: 'http://leads.esempio.it' }),
    ).toThrow(/https/);
    const c = loadConfig({
      NODE_ENV: 'production',
      DATABASE_URL: 'postgres://u:p@h:5432/db',
      DATABASE_SSL: 'require',
      APP_ORIGIN: 'https://leads.esempio.it',
    });
    expect(c.security.secureCookies).toBe(true);
    expect(c.database).toEqual({ kind: 'postgres', url: 'postgres://u:p@h:5432/db', ssl: true });
  });

  it("rifiuta un'origine con percorso", () => {
    expect(() => loadConfig({ APP_ORIGIN: 'https://leads.esempio.it/app' })).toThrow(/APP_ORIGIN/);
  });

  it("rifiuta un'inattività più lunga della durata massima", () => {
    expect(() => loadConfig({ SESSION_IDLE_HOURS: '48', SESSION_MAX_DAYS: '1' })).toThrow(/SESSION_IDLE_HOURS/);
  });
});

describe('describeDatabase', () => {
  it('non mostra mai le credenziali', () => {
    const d = describeDatabase({
      kind: 'postgres',
      url: 'postgres://utente:segreta@db.esempio.it:5432/leads',
      ssl: true,
    });
    expect(d).toBe('PostgreSQL su db.esempio.it:5432/leads (TLS)');
    expect(d).not.toContain('segreta');
  });
});

describe('test isolati dai servizi reali', () => {
  it('con NODE_ENV=test nessuna email reale e nessuna chiamata AI a pagamento', () => {
    expect(() => loadConfig({ NODE_ENV: 'test', SMTP_HOST: 'smtp.example.com' })).toThrow(
      /solo verso un server SMTP locale/,
    );
    expect(loadConfig({ NODE_ENV: 'test', SMTP_HOST: '127.0.0.1', SMTP_SECURITY: 'none' }).email.smtp?.host).toBe(
      '127.0.0.1',
    );
    const key = 'sk-ant-chiave-di-prova-000000000000000000';
    expect(() => loadConfig({ NODE_ENV: 'test', AI_API_KEY: key })).toThrow(/server finto locale/);
    expect(
      loadConfig({ NODE_ENV: 'test', AI_API_KEY: key, AI_TEST_BASE_URL: 'http://127.0.0.1:9999' }).ai.provider,
    ).toBe('anthropic');
  });
});

describe('.env.example', () => {
  it('documenta ogni variabile letta dal server (tranne quelle dei soli test) e contiene solo segnaposto', async () => {
    const { ENV_VARIABLES } = await import('./config.ts');
    const { readFileSync } = await import('node:fs');
    const example = readFileSync(new URL('../.env.example', import.meta.url), 'utf8');
    const testOnly = new Set(['AI_TEST_BASE_URL', 'AUDIT_TEST_LOOPBACK_PORTS', 'ANTHROPIC_API_KEY']);
    const missing = ENV_VARIABLES.filter((v) => !testOnly.has(v) && !new RegExp(`\\b${v}\\b`).test(example));
    expect(missing).toEqual([]);
    // nessun segreto con un valore
    for (const secret of ['AI_API_KEY', 'SMTP_PASSWORD', 'SMTP_USER', 'PAGESPEED_API_KEY', 'DATABASE_URL'])
      expect(example).toMatch(new RegExp(`^${secret}=$`, 'm'));
    // il file di esempio si carica senza errori
    const env = Object.fromEntries(
      example
        .split('\n')
        .filter((l) => /^[A-Z_]+=/.test(l))
        .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]),
    );
    expect(() => loadConfig(env)).not.toThrow();
  });
});
