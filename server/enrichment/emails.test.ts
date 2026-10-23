import { describe, expect, it } from 'vitest';
import { chooseContact, extractEmails, isBusinessAddress, normalizeEmail, relationOf } from './emails.ts';

/* Estrazione delle email pubblicate: pagine HTML costruite a mano, indirizzi "di prova" su domini .example.it. */

const SITE = 'www.farmacia-prova.example.it';
const page = (body: string) => `<!doctype html><html><head><title>Prova</title>
<script>var x = "tracking@analytics-prova.example.it";</script><style>.a{content:"css@style.example.it"}</style>
</head><body>${body}</body></html>`;

describe('estrazione delle email dalle pagine', () => {
  it('pagina dei contatti e piè di pagina: link mailto: e testo visibile, normalizzati e senza doppioni', () => {
    const html = page(`
      <main><h1>Contatti</h1><p>Scrivici a <a href="mailto:Info@Farmacia-Prova.example.it?subject=Ciao">Info@Farmacia-Prova.example.it</a></p>
      <p>Prenotazioni: prenotazioni@farmacia-prova.example.it.</p></main>
      <footer>P.IVA 00000000000 · <a href="mailto:farmaciaprova@gmail.com">scrivici</a> · PEC: farmaciaprova@pec.it</footer>`);
    const found = extractEmails(html, 'https://www.farmacia-prova.example.it/contatti', SITE);
    expect(found.map((f) => [f.email, f.via, f.relation])).toEqual([
      ['info@farmacia-prova.example.it', 'mailto', 'same_domain'],
      ['farmaciaprova@gmail.com', 'mailto', 'free_provider'],
      ['prenotazioni@farmacia-prova.example.it', 'text', 'same_domain'],
      ['farmaciaprova@pec.it', 'text', 'pec'],
    ]);
    expect(found.every((f) => f.pageUrl === 'https://www.farmacia-prova.example.it/contatti')).toBe(true);
  });

  it('script, stili e commenti ignorati; indirizzi scritti per esteso riconosciuti', () => {
    const html =
      page(`<!-- vecchio: old@farmacia-prova.example.it --><p>info [at] farmacia-prova [dot] example [dot] it</p>
      <p>ordini (chiocciola) farmacia-prova.example.it</p><p>info&#64;farmacia-prova.example.it</p>`);
    expect(extractEmails(html, 'https://x', SITE).map((f) => f.email)).toEqual([
      'info@farmacia-prova.example.it',
      'ordini@farmacia-prova.example.it',
    ]);
  });

  it('valori non validi o segnaposto: scartati; nessun indirizzo generato dal dominio', () => {
    for (const bad of [
      'nome@tuodominio.it',
      'info@example.com',
      'logo@2x.png',
      'icona@sprite.svg',
      'noreply@farmacia-prova.example.it',
      'abc@sentry.io',
      '0123456789abcdef0123@ingest.sentry.example.it',
      'senza-chiocciola.example.it',
      'a@b',
      'doppio..punto@farmacia-prova.example.it',
    ])
      expect(normalizeEmail(bad), bad).toBeNull();
    expect(normalizeEmail(' <INFO@Farmacia-Prova.example.it>. ')).toBe('info@farmacia-prova.example.it');
    expect(normalizeEmail('mailto:info%40farmacia-prova.example.it')).toBe('info@farmacia-prova.example.it');
    // una pagina senza indirizzi non produce indirizzi (mai «info@dominio» dedotto)
    expect(extractEmails(page('<p>Chiamaci al 000 0000000</p>'), 'https://x', SITE)).toEqual([]);
    // indirizzo protetto (es. Cloudflare): non decodificato
    expect(
      extractEmails(
        page('<a href="/cdn-cgi/l/email-protection" data-cfemail="1a2b3c">[email&#160;protected]</a>'),
        'https://x',
        SITE,
      ),
    ).toEqual([]);
  });

  it('relazione con il sito: stesso dominio (anche sottodominio), casella gratuita, PEC, altro dominio', () => {
    expect(relationOf('info@farmacia-prova.example.it', SITE)).toBe('same_domain');
    expect(relationOf('info@mail.farmacia-prova.example.it', SITE)).toBe('same_domain');
    expect(relationOf('farmacia@libero.it', SITE)).toBe('free_provider');
    expect(relationOf('farmacia@legalmail.it', SITE)).toBe('pec');
    expect(relationOf('farmacia@pec.farmacia-prova.example.it', SITE)).toBe('pec');
    expect(relationOf('info@agenzia-web-prova.example.it', SITE)).toBe('other_domain');
  });
});

describe('indirizzi dell’attività e scelta del recapito', () => {
  it('generico o con il nome dell’attività: conservato; personale: no', () => {
    expect(isBusinessAddress('info@farmacia-prova.example.it', 'Farmacia di Prova')).toBe(true);
    expect(isBusinessAddress('trattoriadapino@gmail.com', 'Trattoria da Pino')).toBe(true);
    expect(isBusinessAddress('mario.rossi@farmacia-prova.example.it', 'Farmacia di Prova')).toBe(false);
    expect(isBusinessAddress('noreply@farmacia-prova.example.it', 'Farmacia di Prova')).toBe(false);
  });

  it('più indirizzi: stesso dominio prima, poi casella gratuita, ordine di preferenza; mai PEC né altro dominio', () => {
    const f = (email: string, relation: 'same_domain' | 'free_provider' | 'pec' | 'other_domain') => ({
      email,
      relation,
    });
    expect(
      chooseContact([
        f('farmacia@gmail.com', 'free_provider'),
        f('prenotazioni@farmacia-prova.example.it', 'same_domain'),
        f('info@farmacia-prova.example.it', 'same_domain'),
        f('farmacia@pec.it', 'pec'),
      ])?.email,
    ).toBe('info@farmacia-prova.example.it');
    expect(chooseContact([f('farmacia@gmail.com', 'free_provider'), f('farmacia@pec.it', 'pec')])?.email).toBe(
      'farmacia@gmail.com',
    );
    expect(chooseContact([f('info@agenzia-web-prova.example.it', 'other_domain'), f('x@pec.it', 'pec')])).toBeNull();
    expect(chooseContact([])).toBeNull();
  });
});
