import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from '../db/client.ts';
import { summary, type BusinessRow } from '../discovery/businesses.ts';
import { testDatabase } from '../testing.ts';
import { checkDomain, checkPendingDomains, type Resolver } from './domain.ts';

/*
 * Controllo del dominio delle email: risolutore DNS finto (nessuna rete), nessun messaggio inviato.
 */

const err = (code: string) => Object.assign(new Error(code), { code });

/** Domini di prova: mx, solo A, inesistente, MX nullo, rete in errore. */
const resolver: Resolver = {
  async resolveMx(d) {
    if (d === 'posta.example') return [{ exchange: 'mx1.posta.example', priority: 10 }];
    if (d === 'nullmx.example') return [{ exchange: '.', priority: 0 }];
    if (d === 'lento.example') throw err('ETIMEOUT');
    if (d === 'inesistente.example') throw err('ENOTFOUND');
    throw err('ENODATA');
  },
  async resolve4(d) {
    if (d === 'soloa.example') return ['192.0.2.1'];
    throw err('ENODATA');
  },
  async resolve6() {
    throw err('ENODATA');
  },
};

let db: Db;
beforeAll(async () => {
  db = await testDatabase();
});
afterAll(async () => {
  await db.close();
});

describe('dominio delle email', () => {
  it('MX, solo A, inesistente, MX nullo, errore di rete', async () => {
    expect(await checkDomain('posta.example', resolver)).toBe('mx');
    expect(await checkDomain('soloa.example', resolver)).toBe('a_only');
    expect(await checkDomain('inesistente.example', resolver)).toBe('none');
    expect(await checkDomain('nullmx.example', resolver)).toBe('none');
    expect(await checkDomain('vuoto.example', resolver)).toBe('none');
    expect(await checkDomain('lento.example', resolver)).toBe('error');
    // tempo massimo: un risolutore che non risponde non blocca il controllo
    const hanging: Resolver = { ...resolver, resolveMx: () => new Promise(() => undefined) };
    expect(await checkDomain('posta.example', hanging, 20)).toBe('error');
  });

  it('controllo delle email salvate: stato per indirizzo, livello di verifica mai «consegna verificata»', async () => {
    const insert = async (name: string, email: string) =>
      (
        await db.query<{ id: string }>(
          `INSERT INTO businesses (name, search_name, category, email, email_kind, email_source, email_status, completeness,
                                   has_website, has_address, has_phone, has_email, has_opening_hours, first_seen_at, last_verified_at)
           VALUES ($1, lower($1), 'altro', $2, 'generic', 'website', 'pubblicata', 1, false, false, false, true, false, now(), now())
           RETURNING id`,
          [name, email],
        )
      ).rows[0]!.id;
    const a = await insert('Dominio Valido di Prova', 'info@posta.example');
    const b = await insert('Dominio Inesistente di Prova', 'info@inesistente.example');
    const r = await checkPendingDomains(db, { resolver });
    expect(r.checked).toBeGreaterThanOrEqual(2);
    const { rows } = await db.query<BusinessRow>('SELECT * FROM businesses WHERE id = ANY($1) ORDER BY name', [[a, b]]);
    const byId = new Map(rows.map((x) => [x.id, x]));
    expect(byId.get(a)).toMatchObject({ email_domain_status: 'mx', email_domain_checked_for: 'info@posta.example' });
    expect(byId.get(b)).toMatchObject({ email_domain_status: 'none' });
    // nessun nuovo controllo finché l'email non cambia
    expect((await checkPendingDomains(db, { resolver })).checked).toBe(0);
    await db.query("UPDATE businesses SET email = 'info@soloa.example' WHERE id = $1", [a]);
    expect((await checkPendingDomains(db, { resolver })).checked).toBe(1);
  });
});

describe('livello di verifica mostrato', () => {
  const row = (over: Partial<BusinessRow>) =>
    summary({
      id: 'x',
      name: 'Prova',
      category: 'altro',
      completeness: 1,
      has_website: false,
      has_address: false,
      has_phone: false,
      has_email: true,
      has_opening_hours: false,
      contactability: 'pubblicata',
      email: 'info@posta.example',
      ...over,
    } as BusinessRow).emailInfo!.verification!;

  it('dalla fonte pubblica al dominio controllato; la consegna solo con una verifica vera', () => {
    expect(row({ email_source: 'website' }).level).toBe('publicly_listed');
    expect(
      row({ email_source: 'website', email_domain_status: 'mx', email_domain_checked_for: 'info@posta.example' }).level,
    ).toBe('domain_checked');
    // controllo riferito a un indirizzo diverso: non vale
    expect(
      row({ email_source: 'osm', email_domain_status: 'mx', email_domain_checked_for: 'altro@posta.example' }).level,
    ).toBe('publicly_listed');
    expect(row({ email_source: 'manuale' }).level).toBe('syntax_valid');
    expect(row({ email_source: 'manuale', email_status: 'verificata' }).level).toBe('delivery_verified');
  });
});
