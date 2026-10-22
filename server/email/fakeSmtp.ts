import { createServer, type Server, type Socket } from 'node:net';
import type { AddressInfo } from 'node:net';

/*
 * SOLO TEST: server SMTP minimo su 127.0.0.1 (nessuna consegna reale, nessuna rete esterna) per provare l'intero
 * flusso di invio con il client SMTP reale (nodemailer). Comportamenti di prova per destinatario:
 *  - contiene "rifiuta"   → 550 al RCPT TO (rifiuto certo, il messaggio non parte);
 *  - contiene "interrompi" → connessione chiusa dopo il testo del messaggio (esito incerto).
 */

export interface FakeSmtp {
  url: string;
  port: number;
  messages: { from: string; to: string[]; data: string }[];
  close(): Promise<void>;
}

export async function startFakeSmtp(port = 0): Promise<FakeSmtp> {
  const messages: FakeSmtp['messages'] = [];
  const sockets = new Set<Socket>();
  const server: Server = createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.setEncoding('utf8');
    let buffer = '';
    let inData = false;
    let data = '';
    let from = '';
    let to: string[] = [];
    const reply = (line: string) => socket.write(`${line}\r\n`);
    reply('220 fake-smtp.prova ESMTP pronto');
    socket.on('data', (chunk: string) => {
      buffer += chunk;
      for (;;) {
        if (inData) {
          const end = buffer.indexOf('\r\n.\r\n');
          if (end === -1) return;
          data += buffer.slice(0, end);
          buffer = buffer.slice(end + 5);
          inData = false;
          if (to.some((t) => t.includes('interrompi'))) {
            socket.destroy();
            return;
          }
          messages.push({ from, to, data });
          reply(`250 2.0.0 Ok: queued as PROVA${messages.length}`);
          continue;
        }
        const nl = buffer.indexOf('\r\n');
        if (nl === -1) return;
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 2);
        const cmd = line.slice(0, 4).toUpperCase();
        if (cmd === 'EHLO') {
          reply('250-fake-smtp.prova');
          reply('250 8BITMIME');
        } else if (cmd === 'HELO') reply('250 fake-smtp.prova');
        else if (cmd === 'MAIL') {
          from = /<([^>]*)>/.exec(line)?.[1] ?? '';
          to = [];
          reply('250 2.1.0 Ok');
        } else if (cmd === 'RCPT') {
          const addr = /<([^>]*)>/.exec(line)?.[1] ?? '';
          if (addr.includes('rifiuta')) reply('550 5.1.1 Destinatario inesistente (prova)');
          else {
            to.push(addr);
            reply('250 2.1.5 Ok');
          }
        } else if (cmd === 'DATA') {
          inData = true;
          data = '';
          reply('354 Fine con <CRLF>.<CRLF>');
        } else if (cmd === 'RSET') reply('250 Ok');
        else if (cmd === 'NOOP') reply('250 Ok');
        else if (cmd === 'QUIT') {
          reply('221 Arrivederci');
          socket.end();
        } else reply('502 Comando non implementato');
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));
  const actual = (server.address() as AddressInfo).port;
  return {
    url: `smtp://127.0.0.1:${actual}`,
    port: actual,
    messages,
    close: () =>
      new Promise((resolve) => {
        for (const s of sockets) s.destroy();
        server.close(() => resolve());
      }),
  };
}
