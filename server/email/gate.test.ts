import { describe, expect, it } from 'vitest';
import { contentChecks } from './gate.ts';
import { DEFAULT_SUBJECT, STANDARD_BODY } from './template.ts';

/* Controlli sul testo prima dell'invio (portati da Harvey): il modello ufficiale li supera senza avvisi. */

describe('controlli sul testo prima dell’invio', () => {
  it('modello ufficiale: nessun blocco, nessun avviso', () => {
    expect(contentChecks(DEFAULT_SUBJECT, STANDARD_BODY)).toEqual({ blockers: [], warnings: [] });
  });

  it('segnaposto rimasti e HTML: blocchi', () => {
    expect(contentChecks('Ciao {nome}', 'Testo').blockers).toHaveLength(1);
    expect(contentChecks('Oggetto', 'Buongiorno [AZIENDA],').blockers).toHaveLength(1);
    expect(contentChecks('Oggetto', '<p>Buongiorno</p>').blockers[0]).toMatch(/HTML/);
    expect(contentChecks('Oggetto', 'Prezzi < 100 e > 50').blockers).toEqual([]);
  });

  it('oggetto lungo o in maiuscolo, spam, link esterni, testo lungo: avvisi', () => {
    const w = (subject: string, body: string) => contentChecks(subject, body).warnings.join(' ');
    expect(w('x'.repeat(91), 'Testo')).toMatch(/Oggetto lungo/);
    expect(w('OFFERTA PER VOI', 'Testo')).toMatch(/maiuscolo/);
    expect(w('Sito gratis', 'Clicca qui!!')).toMatch(/«gratis».*«Clicca qui».*«!!»/);
    expect(w('Oggetto', 'Guarda https://altro.it/x e https://www.noventra.it/')).toMatch(/altro\.it\)/);
    expect(w('Oggetto', 'parola '.repeat(500))).toMatch(/Testo lungo/);
  });
});
