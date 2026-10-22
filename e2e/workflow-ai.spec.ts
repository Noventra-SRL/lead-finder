import { expect, test, type Page } from '@playwright/test';
import { expectAccessible, signInAsAdmin, trackErrors, expectHome, openAdvanced } from './helpers.ts';
import { E2E_USERS } from './users.ts';

/*
 * Valutazione commerciale con AI sul programma reale: interfaccia → server → SDK di Anthropic vero → server FINTO
 * locale (e2e/start.ts, ammesso solo in test). Nessuna chiamata reale, nessun costo; la chiave è di prova.
 * Aziende "di Prova" salvate da discovery.spec.ts.
 */

test.describe.configure({ mode: 'serial' });

const HOTEL = 'Hotel di Prova Albano Laziale';
const FARMACIA = 'Farmacia di Prova Albano Laziale';
const PARAFARMACIA = 'Parafarmacia di Prova Albano Laziale';

async function signIn(page: Page) {
  await signInAsAdmin(page, E2E_USERS.admin.email, E2E_USERS.admin.password);
  await expectHome(page);
}

test('Analisi AI: stato del fornitore senza segreti, formula e penalità', async ({ page }) => {
  const errors = trackErrors(page);
  await signIn(page);
  await openAdvanced(page, 'Valutazione dei potenziali clienti');
  const status = page.getByRole('region', { name: 'Stato' });
  await expect(status.getByText('Attiva', { exact: true })).toBeVisible();
  await expect(status.getByText('claude-opus-5-5')).toBeVisible();
  await expect(page.getByText('sk-ant-chiave-di-prova-e2e')).toHaveCount(0);
  const formula = page.getByRole('region', { name: 'Formula e penalità' });
  await expect(formula.getByLabel('Probabilità stimata di acquisizione (%)')).toHaveValue('40');
  await expect(formula.getByText('Ente pubblico o istituzione')).toBeVisible();
  await expect(page.getByText('Nessuna valutazione in blocco')).toBeVisible();
  // valutazione di tutte le aziende: conteggi reali dal database, coda automatica spenta in questo ambiente
  const coverage = page.getByRole('region', { name: 'Valutazione di tutte le aziende' });
  await expect(coverage.getByText(/di \d+ aziende valutabili hanno una valutazione aggiornata/)).toBeVisible();
  await expect(coverage.getByText('Valutazione automatica disattivata sul server (AI_AUTO_ASSESS=off)')).toBeVisible();
  await expect(coverage.getByRole('progressbar', { name: 'Aziende con una valutazione aggiornata' })).toBeVisible();
  await expectAccessible(page, 'analisi ai');
  // ogni conteggio apre l'elenco filtrato: le aziende da valutare sono quante dice il pannello
  const pendingCount = await coverage.locator('.ai-coverage__row--pending dd').innerText();
  await coverage.getByRole('link', { name: 'Da valutare', exact: true }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Database aziende' })).toBeVisible();
  await expect(page.locator('.results-count')).toHaveText(new RegExp(`^${pendingCount} aziend[ae]`));
  expect(errors).toEqual([]);
});

test('scheda: valutazione singola con componenti, prove, calcolo del server e revisione', async ({ page }) => {
  const errors = trackErrors(page);
  await signIn(page);
  await page.goto('/aziende?q=hotel%20di%20prova%20albano');
  await page.getByRole('link', { name: HOTEL, exact: true }).click();
  const panel = page.getByRole('region', { name: 'Valutazione commerciale AI' });
  await expect(panel.getByText('Nessuna valutazione AI per questa azienda.')).toBeVisible();
  await panel.getByRole('button', { name: 'Valuta con AI' }).click();
  // 72×… = 71,55 → 72: «Opportunità promettente» (nessuna penalità)
  await expect(panel.getByText('Opportunità promettente')).toBeVisible({ timeout: 20_000 });
  await expect(panel.locator('.ai-headline__score')).toHaveText('72');
  await expect(panel.getByRole('table').getByRole('row')).toHaveCount(6);
  await expect(panel.getByText(/Calcolo del server: punteggio pesato/)).toBeVisible();
  await panel.getByText('Fatti, deduzioni, informazioni mancanti e prove').click();
  await expect(panel.getByText('Prove inviate al modello')).toBeVisible();
  await expect(page.getByText('sk-ant-chiave-di-prova-e2e')).toHaveCount(0);
  // revisione: la nota è obbligatoria per segnalare un'imprecisione
  const review = panel.getByRole('form', { name: 'Revisione della valutazione' });
  await expect(review.getByRole('button', { name: 'Registra la revisione' })).toBeDisabled();
  await review.getByLabel('Nota (obbligatoria)').fill('L’hotel fa parte di una catena: verificare chi decide il sito');
  await review.getByRole('button', { name: 'Registra la revisione' }).click();
  await expect(panel.getByText(/segnalata come imprecisa: L’hotel fa parte di una catena/)).toBeVisible();
  // il punteggio a regole resta visibile e distinto, come riserva
  await expect(page.getByRole('region', { name: 'Punteggio del lead' })).toBeVisible();
  await expectAccessible(page, 'scheda con valutazione ai');
  expect(errors).toEqual([]);
});

test('elenco: stima del costo, lotto esplicito, avanzamento e punteggio con la sua fonte', async ({ page }) => {
  const errors = trackErrors(page);
  await signIn(page);
  await page.goto('/aziende?q=di%20prova%20albano');
  await page.getByRole('checkbox', { name: `Seleziona ${FARMACIA}` }).check();
  await page.getByRole('checkbox', { name: `Seleziona ${PARAFARMACIA}` }).check();
  await page.getByRole('checkbox', { name: `Seleziona ${HOTEL}` }).check();
  await page.getByRole('button', { name: 'Valuta con AI' }).click();
  const dialog = page.getByRole('dialog', { name: 'Valutare le aziende selezionate con l’AI?' });
  // l'hotel ha già una valutazione con le stesse prove: riusata senza costo
  await expect(dialog.getByText(/2\s+da valutare,\s+1\s+già valutate/)).toBeVisible();
  await expect(dialog.getByText(/Costo stimato:/)).toBeVisible();
  await dialog.getByRole('button', { name: 'Valuta 2' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Valutazione di 3 aziende' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Stato' }).getByText('Completata', { exact: true })).toBeVisible({
    timeout: 30_000,
  });
  await expect(page.getByRole('region', { name: 'Stato' })).toContainText('2 valutate, 1 riusate');
  await expectAccessible(page, 'valutazione in blocco');

  await page.goto('/aziende?q=di%20prova%20albano&sort=commercial&dir=desc');
  const row = page.getByRole('row').filter({ has: page.getByRole('link', { name: FARMACIA, exact: true }) });
  await expect(row.locator('td[data-label="Valutazione commerciale"]')).toContainText('valutazione AI');
  await expect(
    page.getByRole('row').filter({ hasText: 'Trattoria di Prova' }).locator('td[data-label="Valutazione commerciale"]'),
  ).not.toContainText('valutazione AI');
  // filtro per stato della valutazione
  await page.getByLabel('Valutazione AI').selectOption({ label: 'Valutate' });
  await expect(page.getByText('3 aziende')).toBeVisible();
  expect(errors).toEqual([]);
});

test.describe('mobile @mobile', () => {
  test('valutazione AI leggibile su telefono @mobile', async ({ page }) => {
    const errors = trackErrors(page);
    await signIn(page);
    await page.goto('/aziende?q=hotel%20di%20prova%20albano');
    await page.getByRole('link', { name: HOTEL, exact: true }).click();
    await expect(page.getByRole('region', { name: 'Valutazione commerciale AI' })).toBeVisible();
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
    await expectAccessible(page, 'valutazione ai (telefono)');
    expect(errors).toEqual([]);
  });
});
