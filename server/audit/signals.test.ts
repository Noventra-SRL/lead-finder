import { describe, expect, it } from 'vitest';
import { detectAgency, detectTools } from './signals.ts';

/* Strumenti di terze parti e agenzia nei crediti (portati da Harvey): solo impronte distintive, nessun falso positivo. */

describe('strumenti e agenzia', () => {
  it('riconosce analytics, pixel, email marketing e chat dagli host degli script', () => {
    const html = `<script src="https://www.googletagmanager.com/gtm.js?id=GTM-X"></script>
      <script src="https://connect.facebook.net/it_IT/fbevents.js"></script>
      <script src="https://code.tidio.co/abc.js"></script>
      <script src="https://chimpstatic.com/mcjs-connected/js/users/1.js"></script>`;
    expect(detectTools(html).map((t) => t.name)).toEqual(['Google Tag Manager', 'Meta Pixel', 'Mailchimp', 'Tidio']);
    expect(detectTools('<p>Usiamo google analytics e facebook</p>')).toEqual([]);
  });

  it('agenzia solo con formula esplicita nel footer, mai il sito stesso o i social', () => {
    const credit = (text: string, href = 'https://www.webagency-esempio.it/') =>
      `<body><main>...</main><footer>© 2026 Bar Rossi · ${text} <a href="${href}">Web Agency Esempio</a></footer></body>`;
    expect(detectAgency(credit('Sito realizzato da'), 'www.barrossi.it')).toEqual({
      name: 'Web Agency Esempio',
      href: 'https://webagency-esempio.it/',
    });
    expect(detectAgency(credit('Powered by:'), 'barrossi.it')?.name).toBe('Web Agency Esempio');
    expect(detectAgency(credit('Seguici su'), 'barrossi.it')).toBeNull();
    expect(detectAgency(credit('Realizzato da', 'https://www.facebook.com/x'), 'barrossi.it')).toBeNull();
    expect(detectAgency(credit('Realizzato da', 'https://barrossi.it/chi-siamo'), 'www.barrossi.it')).toBeNull();
  });
});
