import { promises as dns } from 'node:dns';
import type { Db } from '../db/client.ts';
import type { Logger } from '../logger.ts';

/*
 * Controllo del dominio delle email delle aziende: solo DNS (record MX, altrimenti A/AAAA), nessuna connessione al
 * server di posta e nessun messaggio inviato. Dice se il dominio può ricevere posta, NON se la casella esiste né se un
 * messaggio verrebbe consegnato: per questo non diventa mai «email verificata».
 *
 *  mx      il dominio dichiara server di posta
 *  a_only  nessun MX ma il dominio esiste (la posta può essere consegnata all'indirizzo del dominio)
 *  none    il dominio non esiste, oppure dichiara di non ricevere posta (MX nullo, RFC 7505)
 *  error   controllo non riuscito (rete, tempo scaduto): ripetuto dopo un giorno
 */

export type DomainStatus = 'mx' | 'a_only' | 'none' | 'error';

export interface Resolver {
  resolveMx(domain: string): Promise<{ exchange: string; priority: number }[]>;
  resolve4(domain: string): Promise<string[]>;
  resolve6(domain: string): Promise<string[]>;
}

/** Il nome non esiste o non ha record di quel tipo: una risposta, non un errore del controllo. */
const NO_RECORD = new Set(['ENODATA', 'ENOTFOUND', 'NXDOMAIN', 'ENONAME']);
const codeOf = (e: unknown) => (e as { code?: string }).code ?? '';

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([
    p,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(Object.assign(new Error('timeout'), { code: 'ETIMEOUT' })), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

export async function checkDomain(domain: string, resolver: Resolver = dns, timeoutMs = 5000): Promise<DomainStatus> {
  try {
    const mx = await withTimeout(resolver.resolveMx(domain), timeoutMs);
    // MX nullo ("." o vuoto): il dominio dichiara di non ricevere posta
    if (mx.length && mx.every((m) => !m.exchange || m.exchange === '.')) return 'none';
    if (mx.length) return 'mx';
  } catch (error) {
    if (!NO_RECORD.has(codeOf(error))) return 'error';
    if (codeOf(error) !== 'ENODATA') return 'none';
  }
  for (const lookup of [resolver.resolve4, resolver.resolve6]) {
    try {
      if ((await withTimeout(lookup.call(resolver, domain), timeoutMs)).length) return 'a_only';
    } catch (error) {
      if (!NO_RECORD.has(codeOf(error))) return 'error';
    }
  }
  return 'none';
}

/**
 * Controlla le email non ancora controllate (o cambiate dopo il controllo), a piccoli gruppi, un dominio una volta
 * per gruppo. Gli errori di rete vengono ripetuti dopo un giorno.
 */
export async function checkPendingDomains(db: Db, opts: { resolver?: Resolver; batch?: number } = {}) {
  const { rows } = await db.query<{ id: string; email: string }>(
    `SELECT id, email FROM businesses
      WHERE email IS NOT NULL AND merged_into IS NULL
        AND (email_domain_checked_for IS DISTINCT FROM email
             OR (email_domain_status = 'error' AND email_domain_checked_at < now() - interval '1 day'))
      ORDER BY email_found_at DESC NULLS LAST, id LIMIT $1`,
    [opts.batch ?? 25],
  );
  const byDomain = new Map<string, DomainStatus>();
  for (const r of rows) {
    const domain = r.email.split('@')[1]?.toLowerCase() ?? '';
    let status = byDomain.get(domain);
    if (!status) {
      status = /^[a-z0-9.-]+\.[a-z]{2,}$/.test(domain) ? await checkDomain(domain, opts.resolver) : 'none';
      byDomain.set(domain, status);
    }
    // solo se l'email è ancora quella controllata (un recapito cambiato nel frattempo verrà ricontrollato)
    await db.query(
      `UPDATE businesses SET email_domain_status = $2, email_domain_checked_at = now(), email_domain_checked_for = $3
        WHERE id = $1 AND email = $3`,
      [r.id, status, r.email],
    );
  }
  return { checked: rows.length, domains: byDomain.size };
}

export class DomainCheckWorker {
  private readonly db: Db;
  private readonly log: Logger;
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<void> | null = null;

  constructor(db: Db, log: Logger) {
    this.db = db;
    this.log = log.child({ component: 'email-domain' });
  }

  start(intervalMs = 15_000) {
    this.tick();
    this.timer = setInterval(() => this.tick(), intervalMs);
    this.timer.unref();
  }

  tick() {
    if (this.running) return;
    this.running = checkPendingDomains(this.db)
      .then((r) => {
        if (r.checked) this.log.debug('domini delle email controllati', r);
      })
      .catch((error) => this.log.warn('controllo dei domini delle email non riuscito', { error }))
      .finally(() => {
        this.running = null;
      });
  }

  async stop() {
    if (this.timer) clearInterval(this.timer);
    await this.running;
  }
}
