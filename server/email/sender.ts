import { randomUUID } from 'node:crypto';
import { createTransport } from 'nodemailer';
import type { EmailConfig } from '../config.ts';
import type { Logger } from '../logger.ts';

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
  /** Versione HTML dello stesso testo (generata dal testo, senza immagini né tracciamento). */
  html?: string;
  /** Message-ID scelto da noi (univoco per tentativo): lo stesso messaggio è riconoscibile nei registri del server. */
  messageId: string;
}

export interface SendResult {
  messageId: string;
  /** Risposta del server (già accorciata e senza dati sensibili). */
  response: string;
}

/** Tipo di errore: autenticazione, connessione, mittente, destinatario, messaggio rifiutato, esito incerto. */
export type SendErrorKind = 'auth' | 'connection' | 'sender' | 'recipient' | 'rejected' | 'uncertain';

export class EmailSendError extends Error {
  readonly uncertain: boolean;
  /** Errore della configurazione o del server (non del singolo messaggio): lo stato diventa «Errore del provider». */
  readonly providerProblem: boolean;
  readonly kind: SendErrorKind;
  constructor(message: string, opts: { uncertain?: boolean; providerProblem?: boolean; kind?: SendErrorKind } = {}) {
    super(message);
    this.uncertain = opts.uncertain ?? false;
    this.providerProblem = opts.providerProblem ?? false;
    this.kind = opts.kind ?? (this.uncertain ? 'uncertain' : 'rejected');
  }
}

const escapeHtml = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/**
 * Versione HTML del testo: paragrafi, a capo, elenchi «- …», indirizzi web ed email cliccabili. Tutto il testo è
 * prima reso sicuro (nessun HTML dell'utente o dell'AI passa così com'è); nessuna immagine, nessun tracciamento.
 */
export function textToHtml(text: string): string {
  const linkify = (s: string) =>
    s
      .replace(/https?:\/\/[^\s<]+[^\s<.,;:!?)]/g, (u) => `<a href="${u}">${u}</a>`)
      .replace(/(^|[\s(])([A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,})/g, '$1<a href="mailto:$2">$2</a>');
  const blocks = text
    .replace(/\r\n?/g, '\n')
    .trim()
    .split(/\n{2,}/)
    .map((block) => {
      const lines = block.split('\n').map((l) => linkify(escapeHtml(l)));
      if (lines.every((l) => l.startsWith('- ')))
        return `<ul>${lines.map((l) => `<li>${l.slice(2)}</li>`).join('')}</ul>`;
      return `<p>${lines.join('<br>')}</p>`;
    });
  return `<!doctype html><html lang="it"><head><meta charset="utf-8"></head><body style="font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.5;color:#1a1a1a">${blocks.join('')}</body></html>`;
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
  if (e.code === 'EAUTH' || e.command === 'AUTH PLAIN' || e.command === 'AUTH LOGIN')
    return new EmailSendError(
      `Errore di autenticazione SMTP${code}: controlla SMTP_USER e la password (con Google Workspace serve una password per le app o l’accesso consentito dall’amministratore, non la password normale).`,
      { providerProblem: true, kind: 'auth' },
    );
  // la connessione non è mai partita (rifiutata, nome sconosciuto, TLS): di sicuro nessun messaggio inviato
  if (
    e.code === 'ETLS' ||
    e.code === 'EDNS' ||
    /ECONNREFUSED|ENOTFOUND|EAI_AGAIN|EHOSTUNREACH|ENETUNREACH/.test(e.message ?? '')
  )
    return new EmailSendError(
      `Errore di connessione: server SMTP non raggiungibile o connessione non sicura (${e.code ?? 'rete'}).`,
      { providerProblem: true, kind: 'connection' },
    );
  if (e.command === 'MAIL FROM')
    return new EmailSendError(`Il server SMTP non accetta il mittente${code}: controlla EMAIL_FROM_ADDRESS.`, {
      providerProblem: true,
      kind: 'sender',
    });
  if (e.command === 'RCPT TO' || e.code === 'EENVELOPE')
    return new EmailSendError(`Il server SMTP ha rifiutato il destinatario${code}.`, { kind: 'recipient' });
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
      const e = toSendError(error);
      // durante la verifica nessun messaggio è in viaggio: una connessione caduta o un tempo scaduto è un errore di
      // connessione, non un «esito incerto» (che vale solo durante un invio)
      if (e.uncertain)
        throw new EmailSendError(
          'Errore di connessione: il server SMTP non ha risposto in tempo o ha chiuso la connessione.',
          {
            providerProblem: true,
            kind: 'connection',
          },
        );
      throw e;
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
        ...(msg.html ? { html: msg.html } : {}),
        messageId: msg.messageId,
        // testo e la sua versione HTML; nessun pixel di tracciamento, nessuna immagine remota
        headers: { 'X-Mailer': 'Noventra Lead Finder' },
      });
    } catch (error) {
      throw toSendError(error);
    }
    if (info.rejected.length > 0 || info.accepted.length === 0)
      throw new EmailSendError('Il server SMTP ha rifiutato il destinatario.', { kind: 'recipient' });
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

/** Esito dell'ultimo controllo, con le etichette mostrate nell'interfaccia. */
export type CheckKind = 'verified' | 'test_sent' | 'sent' | 'auth_error' | 'connection_error' | 'send_failed';
export const CHECK_LABEL: Record<CheckKind, string> = {
  verified: 'Connessione verificata',
  test_sent: 'Invio di prova riuscito',
  sent: 'Ultimo invio accettato dal server',
  auth_error: 'Errore di autenticazione',
  connection_error: 'Errore di connessione',
  send_failed: 'Invio non riuscito',
};
export const kindOfError = (e: EmailSendError): CheckKind =>
  e.kind === 'auth' ? 'auth_error' : e.kind === 'connection' ? 'connection_error' : 'send_failed';
export const EMAIL_STATE_LABEL: Record<EmailState, string> = {
  ready: 'Configurazione email completata',
  missing: 'Configurazione email mancante',
  verification_needed: 'Verifica necessaria',
  provider_error: 'Errore del provider',
};

export interface EmailServices {
  config: EmailConfig;
  sender: EmailSender | null;
  /** Ultimo controllo della connessione (verify, prova o invio): nessun dato sensibile. */
  lastCheck: { at: Date; ok: boolean; message: string; kind: CheckKind } | null;
  status(): {
    state: EmailState;
    label: string;
    canSend: boolean;
    explanation: string;
    from: { name: string; address: string } | null;
    replyTo: string | null;
    senderAuthorized: boolean;
    missing: string[];
    lastCheck: { at: string; ok: boolean; message: string; kind: CheckKind; label: string } | null;
  };
  /** Controlla connessione e autenticazione (nessun messaggio inviato). */
  verify(): Promise<{ ok: boolean; message: string }>;
  /**
   * Invia un messaggio di prova all'indirizzo indicato e confermato da un amministratore (mai in automatico).
   * Non è un'email commerciale: non entra nel CRM.
   */
  sendTest(to: string): Promise<{ ok: boolean; message: string; kind: CheckKind; messageId: string | null }>;
  /** Registra l'esito di un invio sul controllo della connessione. */
  record(ok: boolean, message: string, kind?: CheckKind): void;
}

export const TEST_SUBJECT = 'Email di prova — Noventra Lead Finder';
const TEST_TEXT = `Questa è un'email di prova inviata da Noventra Lead Finder per verificare la configurazione dell'invio.

Se la ricevi, il server di posta ha accettato il messaggio dal mittente configurato. Non serve rispondere.

Caratteri italiani di controllo: àèéìòù — «virgolette».`;

export function createEmailServices(
  config: EmailConfig,
  deps: { sender?: EmailSender | null; log?: Logger } = {},
): EmailServices {
  const sender =
    deps.sender !== undefined ? deps.sender : config.smtp ? new SmtpSender(config.smtp, config.timeoutMs) : null;
  const services: EmailServices = {
    config,
    sender,
    lastCheck: null,
    status() {
      const configured = Boolean(sender && config.fromAddress);
      const check = services.lastCheck;
      const state: EmailState = !configured
        ? 'missing'
        : check && !check.ok
          ? 'provider_error'
          : !config.senderAuthorized || !check
            ? 'verification_needed'
            : 'ready';
      const explanation =
        state === 'missing'
          ? `Imposta sul server ${config.missing.filter((m) => m !== 'EMAIL_SENDER_AUTHORIZED=si').join(', ') || 'SMTP_HOST'} e EMAIL_SENDER_AUTHORIZED=si (vedi .env.example). Bozze e generazione restano disponibili.`
          : state === 'provider_error'
            ? `Ultimo controllo non riuscito: ${check!.message}`
            : !config.senderAuthorized
              ? `Il server SMTP è configurato, ma l'amministratore non ha ancora confermato che può inviare da ${config.fromAddress} (SPF/DKIM del dominio). Dopo la verifica imposta EMAIL_SENDER_AUTHORIZED=si.`
              : !check
                ? 'Connessione al server SMTP non ancora verificata: viene controllata prima del primo invio.'
                : 'Il server SMTP accetta la connessione e l’autenticazione. «Inviata» indica che il server ha accettato il messaggio, non che sia stato consegnato.';
      return {
        state,
        label: EMAIL_STATE_LABEL[state],
        // si invia solo con mittente autorizzato e connessione non in errore (verificata prima del primo invio)
        canSend: configured && config.senderAuthorized && (!check || check.ok),
        explanation,
        from: configured ? { name: config.fromName, address: config.fromAddress! } : null,
        replyTo: config.replyTo,
        senderAuthorized: config.senderAuthorized,
        missing: config.missing,
        lastCheck: check
          ? {
              at: check.at.toISOString(),
              ok: check.ok,
              message: check.message,
              kind: check.kind,
              label: CHECK_LABEL[check.kind],
            }
          : null,
      };
    },
    async verify() {
      if (!sender) return { ok: false, message: 'Invio non configurato.' };
      try {
        await sender.verify();
        services.record(true, 'Connessione e autenticazione SMTP riuscite (nessun messaggio inviato).', 'verified');
      } catch (error) {
        const e = toSendError(error);
        services.record(false, e.message, kindOfError(e));
        deps.log?.warn('verifica SMTP non riuscita', { message: e.message });
      }
      return { ok: services.lastCheck!.ok, message: services.lastCheck!.message };
    },
    async sendTest(to) {
      if (!sender || !config.fromAddress)
        return {
          ok: false,
          message: 'Configurazione mancante: imposta SMTP_HOST e le credenziali sul server.',
          kind: 'send_failed',
          messageId: null,
        };
      const messageId = `<prova-${randomUUID()}@${config.fromAddress.split('@')[1]}>`;
      try {
        const r = await sender.send({
          from: { name: config.fromName, address: config.fromAddress },
          replyTo: config.replyTo,
          to,
          subject: TEST_SUBJECT,
          text: TEST_TEXT,
          html: textToHtml(TEST_TEXT),
          messageId,
        });
        services.record(
          true,
          `Messaggio di prova accettato dal server di posta (${r.response}). La consegna nella casella non è confermata.`,
          'test_sent',
        );
        return { ok: true, message: services.lastCheck!.message, kind: 'test_sent', messageId: r.messageId };
      } catch (error) {
        const e = toSendError(error);
        const kind = kindOfError(e);
        // un destinatario rifiutato riguarda solo quella prova, non la configurazione
        if (e.providerProblem) services.record(false, e.message, kind);
        deps.log?.warn('email di prova non inviata', { message: e.message });
        return { ok: false, message: e.message, kind, messageId: null };
      }
    },
    record(ok, message, kind) {
      services.lastCheck = { at: new Date(), ok, message, kind: kind ?? (ok ? 'sent' : 'send_failed') };
    },
  };
  return services;
}
