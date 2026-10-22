import { Resolver } from 'node:dns/promises';

/*
 * Controllo del dominio del mittente (deliverability), solo DNS: nessun messaggio inviato, nessun servizio a
 * pagamento. Verifica MX, SPF, DKIM, DMARC e le liste di Spamhaus (dominio nella DBL, IP del server SMTP nella ZEN).
 *
 * Limiti dichiarati:
 *  - SPF presente non prova che il nostro server SMTP sia tra quelli autorizzati (gli `include:` non vengono espansi).
 *  - DKIM si cerca nei selettori indicati (EMAIL_DKIM_SELECTOR) o, in mancanza, tra quelli più comuni.
 *  - Spamhaus non risponde ai DNS pubblici (8.8.8.8, 1.1.1.1): in quel caso il controllo è «non verificabile».
 *  - Nessuna prova di consegna in casella: per quella servono gli strumenti del provider (es. Postmaster Tools).
 */

export type CheckStatus = 'ok' | 'warn' | 'fail' | 'unknown';
export type CheckCode = 'MX' | 'SPF' | 'DKIM' | 'DMARC' | 'DBL' | 'ZEN';

export interface DeliverabilityCheck {
  code: CheckCode;
  status: CheckStatus;
  label: string;
  detail: string;
}

export interface DeliverabilityReport {
  at: string;
  domain: string;
  /** Tutti i controlli necessari superati: il mittente si considera autorizzato senza EMAIL_SENDER_AUTHORIZED. */
  ready: boolean;
  checks: DeliverabilityCheck[];
}

/** Sottoinsieme di `Resolver` di node:dns/promises: nei test si passa un resolver finto. */
export interface DnsResolver {
  resolveMx(name: string): Promise<{ exchange: string; priority: number }[]>;
  resolveTxt(name: string): Promise<string[][]>;
  resolve4(name: string): Promise<string[]>;
}

export const realResolver = (): DnsResolver => new Resolver({ timeout: 5000, tries: 2 });

/** Selettori DKIM più diffusi (Google Workspace, Microsoft 365, Aruba, provider transazionali). */
export const COMMON_DKIM_SELECTORS = [
  'default',
  'google',
  'selector1',
  'selector2',
  'dkim',
  'mail',
  'k1',
  'k2',
  's1',
  's2',
  'smtp',
  'mx',
  'key1',
  'sig1',
  'mandrill',
  'mailjet',
  'sendgrid',
  'zoho',
  'brevo',
  'aruba',
];

const NOT_FOUND = new Set(['ENOTFOUND', 'ENODATA', 'ENOTIMP', 'NXDOMAIN']);
const notFound = (e: unknown) => NOT_FOUND.has((e as { code?: string }).code ?? '');

async function txt(dns: DnsResolver, name: string): Promise<string[] | null> {
  try {
    return (await dns.resolveTxt(name)).map((parts) => parts.join(''));
  } catch (e) {
    if (notFound(e)) return [];
    return null; // errore di rete o del resolver: non verificabile
  }
}

const unknown = (code: CheckCode, label: string): DeliverabilityCheck => ({
  code,
  status: 'unknown',
  label,
  detail: 'DNS non raggiungibile: controllo non verificabile ora.',
});

async function checkMx(dns: DnsResolver, domain: string): Promise<DeliverabilityCheck> {
  const label = 'Record MX';
  try {
    const mx = await dns.resolveMx(domain);
    return mx.length > 0
      ? { code: 'MX', status: 'ok', label, detail: `${mx.length} server di posta configurati.` }
      : { code: 'MX', status: 'fail', label, detail: 'Nessun record MX: il dominio non riceve risposte.' };
  } catch (e) {
    if (notFound(e))
      return { code: 'MX', status: 'fail', label, detail: 'Nessun record MX: il dominio non riceve risposte.' };
    return unknown('MX', label);
  }
}

export function evaluateSpf(records: string[]): Omit<DeliverabilityCheck, 'code' | 'label'> {
  const spf = records.filter((r) => /^v=spf1(\s|$)/i.test(r.trim()));
  if (spf.length === 0) return { status: 'fail', detail: 'Nessun record SPF (v=spf1).' };
  if (spf.length > 1) return { status: 'fail', detail: 'Più record SPF: secondo lo standard il controllo fallisce.' };
  const rule = spf[0]!.trim();
  // «all» o «+all» (senza -, ~, ?) autorizza qualsiasi server
  if (/(^|\s)\+?all\b/i.test(rule))
    return { status: 'fail', detail: 'SPF con «+all»: chiunque può inviare a nome del dominio.' };
  if (/\?all\b/i.test(rule)) return { status: 'warn', detail: 'SPF con «?all» (neutro): protezione debole.' };
  return { status: 'ok', detail: 'Record SPF presente. Gli «include» non vengono espansi.' };
}

export function evaluateDmarc(records: string[]): Omit<DeliverabilityCheck, 'code' | 'label'> {
  const dmarc = records.find((r) => /^v=DMARC1/i.test(r.trim()));
  if (!dmarc) return { status: 'fail', detail: 'Nessun record DMARC (_dmarc).' };
  const policy = /(?:^|;)\s*p=(\w+)/i.exec(dmarc)?.[1]?.toLowerCase();
  if (policy === 'reject' || policy === 'quarantine')
    return { status: 'ok', detail: `DMARC presente, politica «${policy}».` };
  if (policy === 'none')
    return {
      status: 'warn',
      detail: 'DMARC presente con politica «none»: solo monitoraggio, accettabile per iniziare.',
    };
  return { status: 'fail', detail: 'Record DMARC senza politica (p=) valida.' };
}

async function checkDkim(dns: DnsResolver, domain: string, selectors: string[] | null): Promise<DeliverabilityCheck> {
  const label = 'Firma DKIM';
  const list = selectors ?? COMMON_DKIM_SELECTORS;
  let unreachable = false;
  for (const selector of list) {
    const records = await txt(dns, `${selector}._domainkey.${domain}`);
    if (records === null) {
      unreachable = true;
      continue;
    }
    if (records.some((r) => /(^|;)\s*p=[A-Za-z0-9+/=]{20,}/.test(r)))
      return { code: 'DKIM', status: 'ok', label, detail: `Chiave DKIM trovata (selettore «${selector}»).` };
  }
  if (unreachable) return unknown('DKIM', label);
  return selectors
    ? { code: 'DKIM', status: 'fail', label, detail: `Nessuna chiave DKIM per i selettori ${selectors.join(', ')}.` }
    : {
        code: 'DKIM',
        status: 'warn',
        label,
        detail: 'Nessuna chiave DKIM tra i selettori comuni: imposta EMAIL_DKIM_SELECTOR con quello del provider.',
      };
}

/** Interroga una lista DNS di Spamhaus; null = non elencato. */
async function spamhaus(dns: DnsResolver, name: string): Promise<string[] | null | 'unknown'> {
  try {
    const answers = await dns.resolve4(name);
    // 127.255.255.x: Spamhaus rifiuta la domanda (DNS pubblico o limite superato), non è un elenco
    if (answers.some((a) => a.startsWith('127.255.255.'))) return 'unknown';
    return answers;
  } catch (e) {
    return notFound(e) ? null : 'unknown';
  }
}

async function checkDbl(dns: DnsResolver, domain: string): Promise<DeliverabilityCheck> {
  const label = 'Dominio in blocklist (Spamhaus DBL)';
  const r = await spamhaus(dns, `${domain}.dbl.spamhaus.org`);
  if (r === 'unknown')
    return {
      code: 'DBL',
      status: 'unknown',
      label,
      detail: 'Spamhaus non risponde da questo DNS (spesso succede con i DNS pubblici).',
    };
  if (r && r.some((a) => a.startsWith('127.0.1.') && a !== '127.0.1.255'))
    return { code: 'DBL', status: 'fail', label, detail: 'Il dominio è elencato nella Spamhaus DBL.' };
  return { code: 'DBL', status: 'ok', label, detail: 'Dominio non elencato.' };
}

async function checkZen(dns: DnsResolver, smtpHost: string): Promise<DeliverabilityCheck> {
  const label = 'Server SMTP in blocklist (Spamhaus ZEN)';
  let ips: string[];
  try {
    ips = /^\d{1,3}(\.\d{1,3}){3}$/.test(smtpHost) ? [smtpHost] : await dns.resolve4(smtpHost);
  } catch {
    return unknown('ZEN', label);
  }
  for (const ip of ips) {
    const r = await spamhaus(dns, `${ip.split('.').reverse().join('.')}.zen.spamhaus.org`);
    if (r === 'unknown')
      return {
        code: 'ZEN',
        status: 'unknown',
        label,
        detail: 'Spamhaus non risponde da questo DNS (spesso succede con i DNS pubblici).',
      };
    // 127.0.0.10/11 (PBL) indicano IP di accesso domestico: non riguardano un server SMTP autenticato
    if (r && r.some((a) => /^127\.0\.0\.[2-9]$/.test(a)))
      return { code: 'ZEN', status: 'fail', label, detail: `L’indirizzo ${ip} del server SMTP è elencato.` };
  }
  return { code: 'ZEN', status: 'ok', label, detail: 'Server SMTP non elencato.' };
}

/** Controlli che devono essere «ok» (o «warn») perché il mittente sia considerato pronto. */
const REQUIRED: CheckCode[] = ['MX', 'SPF', 'DKIM', 'DMARC'];

export function isReady(checks: DeliverabilityCheck[]): boolean {
  return checks.every((c) =>
    REQUIRED.includes(c.code) ? c.status === 'ok' || (c.status === 'warn' && c.code === 'DMARC') : c.status !== 'fail',
  );
}

export async function checkDeliverability(
  domain: string,
  opts: { dns: DnsResolver; dkimSelectors: string[] | null; smtpHost: string | null; now?: Date },
): Promise<DeliverabilityReport> {
  const local = !opts.smtpHost || /^(127\.|localhost$|::1$)/.test(opts.smtpHost);
  const [mx, spfTxt, dmarcTxt, dkim, dbl, zen] = await Promise.all([
    checkMx(opts.dns, domain),
    txt(opts.dns, domain),
    txt(opts.dns, `_dmarc.${domain}`),
    checkDkim(opts.dns, domain, opts.dkimSelectors),
    checkDbl(opts.dns, domain),
    local ? null : checkZen(opts.dns, opts.smtpHost!),
  ]);
  const spf: DeliverabilityCheck =
    spfTxt === null ? unknown('SPF', 'Record SPF') : { code: 'SPF', label: 'Record SPF', ...evaluateSpf(spfTxt) };
  const dmarc: DeliverabilityCheck =
    dmarcTxt === null
      ? unknown('DMARC', 'Politica DMARC')
      : { code: 'DMARC', label: 'Politica DMARC', ...evaluateDmarc(dmarcTxt) };
  const checks = [mx, spf, dkim, dmarc, dbl, ...(zen ? [zen] : [])];
  return { at: (opts.now ?? new Date()).toISOString(), domain, ready: isReady(checks), checks };
}
