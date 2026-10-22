import { createTransport } from 'nodemailer';
import type { EmailConfig } from '../config.ts';
import type { Logger } from '../logger.ts';
import { ImapReader, type InboxReader } from './replies.ts';
import { checkDeliverability, realResolver, type DeliverabilityReport, type DnsResolver } from './deliverability.ts';

/*
 * Invio delle email commerciali (Fase 9): un adattatore SMTP lato server (nodemailer). Le credenziali restano in
 * questo processo: non entrano nei messaggi d'errore salvati, nei registri o nelle risposte dell'API.
 *
 * Esiti, senza esagerazioni:
 *  - «accettata»: il server SMTP ha risposto 250 al testo del messaggio. NON prova la consegna nella casella.
 *  - «non riuscito»: il server ha rifiutato prima di ricevere il testo (connessione, autenticazione, mittente,
 *    destinatario): il messaggio di sicuro non è partito.
 *  - «esito incerto»: ogni altro errore a sessione avviata (connessione caduta, tempo scaduto): il server potrebbe
 *    averlo accettato. Ritentare richiede una conferma esplicita, per non inviare due volte.
 */

export interface OutgoingEmail {
  from: { name: string; address: string };
  replyTo: string | null;
  to: string;
  subject: string;
  text: string;
  /** Message-ID scelto da noi (univoco per tentativo): lo stesso messaggio è riconoscibile nei registri del server. */
  messageId: string;
  /** Follow-up: risposta ai messaggi precedenti della sequenza (stesso thread nella casella del destinatario). */
  inReplyTo?: string | null;
  references?: string[];
}

export interface SendResult {
  messageId: string;
  /** Risposta del server (già accorciata e senza dati sensibili). */
  response: string;
}

export class EmailSendError extends Error {
  readonly uncertain: boolean;
  /** Errore della configurazione o del server (non del singolo messaggio): lo stato diventa «Errore del provider». */
  readonly providerProblem: boolean;
  constructor(message: string, opts: { uncertain?: boolean; providerProblem?: boolean } = {}) {
    super(message);
    this.uncertain = opts.uncertain ?? false;
    this.providerProblem = opts.providerProblem ?? false;
  }
}

export interface EmailSender {
  readonly name: string;
  /** Controlla connessione e autenticazione senza inviare nulla. */
  verify(): Promise<void>;
  send(msg: OutgoingEmail): Promise<SendResult>;
}

/** Testo sicuro da mostrare e salvare: niente a capo, niente indirizzi del server, lunghezza limitata. */
const safe = (s: string) =>
  s
    .replace(/\s+/g, ' ')
    .replace(/(user|pass|password)=\S+/gi, '$1=***')
    .trim()
    .slice(0, 300);

/** Traduce gli errori di nodemailer in messaggi sicuri; distingue i casi in cui il messaggio può essere partito. */
export function toSendError(error: unknown): EmailSendError {
  if (error instanceof EmailSendError) return error;
  const e = error as { code?: string; command?: string; responseCode?: number; response?: string; message?: string };
  const code = e.responseCode ? ` (codice SMTP ${e.responseCode})` : '';
  if (e.code === 'EAUTH')
    return new EmailSendError(`Autenticazione SMTP non riuscita${code}: controlla SMTP_USER e SMTP_PASSWORD.`, {
      providerProblem: true,
    });
  // la connessione non è mai partita (rifiutata, nome sconosciuto, TLS): di sicuro nessun messaggio inviato
  if (
    e.code === 'ETLS' ||
    e.code === 'EDNS' ||
    /ECONNREFUSED|ENOTFOUND|EAI_AGAIN|EHOSTUNREACH|ENETUNREACH/.test(e.message ?? '')
  )
    return new EmailSendError(`Server SMTP non raggiungibile o connessione non sicura (${e.code ?? 'rete'}).`, {
      providerProblem: true,
    });
  if (e.command === 'MAIL FROM')
    return new EmailSendError(`Il server SMTP non accetta il mittente${code}: controlla EMAIL_FROM_ADDRESS.`, {
      providerProblem: true,
    });
  if (e.command === 'RCPT TO' || e.code === 'EENVELOPE')
    return new EmailSendError(`Il server SMTP ha rifiutato il destinatario${code}.`);
  // risposta esplicita di rifiuto al messaggio (5xx/4xx dopo DATA): il server l'ha rifiutato
  if (e.command === 'DATA' && e.responseCode && e.responseCode >= 400)
    return new EmailSendError(`Il server SMTP ha rifiutato il messaggio${code}: ${safe(e.response ?? '')}`);
  // tutto il resto (connessione caduta a sessione avviata, tempo scaduto, errore sconosciuto): il messaggio può
  // essere stato accettato senza che la risposta arrivasse. Si dichiara incerto: ritentare richiede una conferma.
  return new EmailSendError(
    `Esito incerto${code}: la connessione con il server di posta si è interrotta durante l'invio (${e.code ?? 'errore'}). Il messaggio potrebbe essere partito.`,
    { uncertain: true },
  );
}

export class SmtpSender implements EmailSender {
  readonly name = 'smtp';
  private readonly transport: ReturnType<typeof createTransport>;

  constructor(config: NonNullable<EmailConfig['smtp']>, timeoutMs: number) {
    this.transport = createTransport({
      host: config.host,
      port: config.port,
      secure: config.security === 'tls',
      // starttls: la cifratura è obbligatoria (nessun invio in chiaro se il server non la offre)
      requireTLS: config.security === 'starttls',
      ignoreTLS: config.security === 'none',
      auth: config.user ? { user: config.user, pass: config.password ?? '' } : undefined,
      connectionTimeout: timeoutMs,
      greetingTimeout: timeoutMs,
      socketTimeout: timeoutMs,
      // nessun registro di nodemailer: conterrebbe indirizzi e dettagli della sessione SMTP
      logger: false,
      debug: false,
    });
  }

  async verify() {
    try {
      await this.transport.verify();
    } catch (error) {
      throw toSendError(error);
    }
  }

  async send(msg: OutgoingEmail): Promise<SendResult> {
    let info;
    try {
      info = await this.transport.sendMail({
        from: { name: msg.from.name, address: msg.from.address },
        to: msg.to,
        replyTo: msg.replyTo ?? undefined,
        subject: msg.subject,
        text: msg.text,
        messageId: msg.messageId,
        inReplyTo: msg.inReplyTo ?? undefined,
        references: msg.references?.length ? msg.references : undefined,
        // nessun pixel di tracciamento, nessun HTML: solo testo
        headers: { 'X-Mailer': 'Noventra Lead Finder' },
      });
    } catch (error) {
      throw toSendError(error);
    }
    if (info.rejected.length > 0 || info.accepted.length === 0)
      throw new EmailSendError('Il server SMTP ha rifiutato il destinatario.');
    return { messageId: info.messageId || msg.messageId, response: safe(info.response ?? '') };
  }
}

/** SOLO TEST: registra i messaggi o simula un errore, senza rete. */
export class FakeEmailSender implements EmailSender {
  readonly name = 'fake';
  readonly sent: OutgoingEmail[] = [];
  verifyError: EmailSendError | null = null;
  next: (msg: OutgoingEmail) => EmailSendError | null | Promise<EmailSendError | null> = () => null;

  async verify() {
    if (this.verifyError) throw this.verifyError;
  }

  async send(msg: OutgoingEmail): Promise<SendResult> {
    const error = await this.next(msg);
    if (error) throw error;
    this.sent.push(msg);
    return { messageId: msg.messageId, response: '250 2.0.0 Ok: queued (prova)' };
  }
}

// ---------------------------------------------------------------- stato della configurazione

export type EmailState = 'ready' | 'missing' | 'verification_needed' | 'provider_error';
export const EMAIL_STATE_LABEL: Record<EmailState, string> = {
  ready: 'Configurazione email completata',
  missing: 'Configurazione email mancante',
  verification_needed: 'Verifica necessaria',
  provider_error: 'Errore del provider',
};

export interface EmailServices {
  config: EmailConfig;
  sender: EmailSender | null;
  /** Ultimo controllo della connessione (verify o invio): nessun dato sensibile. */
  lastCheck: { at: Date; ok: boolean; message: string } | null;
  /** Lettura delle risposte (IMAP, sola lettura); null = non configurata. */
  inbox: InboxReader | null;
  /** Ultimo controllo DNS del dominio del mittente (MX, SPF, DKIM, DMARC, blocklist). */
  deliverability: DeliverabilityReport | null;
  status(): {
    state: EmailState;
    label: string;
    canSend: boolean;
    explanation: string;
    from: { name: string; address: string } | null;
    replyTo: string | null;
    senderAuthorized: boolean;
    /** Da dove viene l'autorizzazione: dichiarazione dell'amministratore, controllo DNS o nessuna. */
    authorizedBy: 'admin' | 'dns' | null;
    missing: string[];
    lastCheck: { at: string; ok: boolean; message: string } | null;
    deliverability: DeliverabilityReport | null;
  };
  /** Controlla connessione e autenticazione (nessun messaggio inviato). */
  verify(): Promise<{ ok: boolean; message: string }>;
  /** Controlla via DNS il dominio del mittente (nessun messaggio inviato). */
  checkDomain(): Promise<DeliverabilityReport | null>;
  /** Registra l'esito di un invio sul controllo della connessione. */
  record(ok: boolean, message: string): void;
}

export function createEmailServices(
  config: EmailConfig,
  deps: { sender?: EmailSender | null; log?: Logger; dns?: DnsResolver; inbox?: InboxReader | null } = {},
): EmailServices {
  const sender =
    deps.sender !== undefined ? deps.sender : config.smtp ? new SmtpSender(config.smtp, config.timeoutMs) : null;
  const services: EmailServices = {
    config,
    sender,
    lastCheck: null,
    inbox: deps.inbox !== undefined ? deps.inbox : config.imap ? new ImapReader(config.imap, config.timeoutMs) : null,
    deliverability: null,
    status() {
      const configured = Boolean(sender && config.fromAddress);
      const check = services.lastCheck;
      const report = services.deliverability;
      const authorizedBy = config.senderAuthorized ? 'admin' : report?.ready ? 'dns' : null;
      const authorized = authorizedBy !== null;
      const failed = report?.checks.filter((c) => c.status === 'fail' || c.status === 'unknown') ?? [];
      const state: EmailState = !configured
        ? 'missing'
        : check && !check.ok
          ? 'provider_error'
          : !authorized || !check
            ? 'verification_needed'
            : 'ready';
      const explanation =
        state === 'missing'
          ? `Imposta sul server ${config.missing.filter((m) => m !== 'EMAIL_SENDER_AUTHORIZED=si').join(', ') || 'SMTP_HOST'} (vedi .env.example). Bozze e generazione restano disponibili.`
          : state === 'provider_error'
            ? `Ultimo controllo non riuscito: ${check!.message}`
            : !authorized
              ? report
                ? `Il dominio di ${config.fromAddress} non supera i controlli DNS (${failed.map((c) => c.label).join(', ') || 'DKIM'}). Correggi i record del dominio e ripeti «Verifica connessione», oppure, dopo una verifica manuale, imposta EMAIL_SENDER_AUTHORIZED=si.`
                : `Controllo DNS del dominio di ${config.fromAddress} non ancora eseguito: avvia «Verifica connessione».`
              : !check
                ? 'Connessione al server SMTP non ancora verificata: viene controllata prima del primo invio.'
                : 'Il server SMTP accetta la connessione e l’autenticazione. «Inviata» indica che il server ha accettato il messaggio, non che sia stato consegnato.';
      return {
        state,
        label: EMAIL_STATE_LABEL[state],
        // si invia solo con mittente autorizzato e connessione non in errore (verificata prima del primo invio)
        canSend: configured && authorized && (!check || check.ok),
        explanation,
        from: configured ? { name: config.fromName, address: config.fromAddress! } : null,
        replyTo: config.replyTo,
        senderAuthorized: authorized,
        authorizedBy,
        missing: authorized ? config.missing.filter((m) => m !== 'EMAIL_SENDER_AUTHORIZED=si') : config.missing,
        lastCheck: check ? { at: check.at.toISOString(), ok: check.ok, message: check.message } : null,
        deliverability: report,
      };
    },
    async checkDomain() {
      const domain = config.fromAddress?.split('@')[1];
      if (!domain) return null;
      try {
        services.deliverability = await checkDeliverability(domain.toLowerCase(), {
          dns: deps.dns ?? realResolver(),
          dkimSelectors: config.dkimSelectors,
          smtpHost: config.smtp?.host ?? null,
        });
      } catch (error) {
        deps.log?.warn('controllo DNS del mittente non riuscito', { message: (error as Error).message });
      }
      return services.deliverability;
    },
    async verify() {
      if (!sender) return { ok: false, message: 'Invio non configurato.' };
      try {
        await sender.verify();
        services.record(true, 'Connessione e autenticazione SMTP riuscite.');
      } catch (error) {
        const e = toSendError(error);
        services.record(false, e.message);
        deps.log?.warn('verifica SMTP non riuscita', { message: e.message });
      }
      return { ok: services.lastCheck!.ok, message: services.lastCheck!.message };
    },
    record(ok, message) {
      services.lastCheck = { at: new Date(), ok, message };
    },
  };
  return services;
}
