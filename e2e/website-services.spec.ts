import { expect, test, type Page } from '@playwright/test';
import { expectAccessible, signInAsAdmin, trackErrors, expectHome, openAdvanced } from './helpers.ts';
import { E2E_AUDIT_BUSINESSES, E2E_USERS } from './users.ts';

/*
 * Fase 5 sul programma reale. Parte dagli audit dei siti finti (website-audit.spec.ts) e dai punteggi
 * (website-scoring.spec.ts): gli abbinamenti ai servizi sono stati calcolati in automatico. Nessun dato inserito a mano.
 */

test.describe.configure({ mode: 'serial' });

async function open(page: Page, name: string) {
  await signInAsAdmin(page, E2E_USERS.admin.email, E2E_USERS.admin.password);
  await expectHome(page);
  await page.goto(`/aziende?q=${encodeURIComponent(name)}`);
  await page.getByRole('link', { name }).click();
  await expect(page.getByRole('heading', { level: 1, name })).toBeVisible();
  return page.getByRole('region', { name: 'Servizi Noventra consigliati' });
}

test('catalogo: solo servizi di noventra.it, abbinamento automatico o solo a colloquio, aziende per servizio', async ({
  page,
}) => {
  const errors = trackErrors(page);
  await signInAsAdmin(page, E2E_USERS.admin.email, E2E_USERS.admin.password);
  await expectHome(page);
  await openAdvanced(page, 'Servizi Noventra');
  await expect(page.getByRole('heading', { level: 3, name: 'SEO Optimization' })).toBeVisible();
  await expect(page.getByRole('heading', { level: 3, name: 'Farmacube' })).toBeVisible();
  const app = page
    .getByRole('listitem')
    .filter({ has: page.getByRole('heading', { name: 'App mobile iOS & Android' }) });
  await expect(app).toContainText('Solo a colloquio');
  await expectAccessible(page, 'catalogo servizi');
  const site = page
    .getByRole('listitem')
    .filter({ has: page.getByRole('heading', { name: 'Sviluppo siti web', exact: true }) });
  await site.getByRole('link', { name: 'Vedi le aziende' }).click();
  await expect(page).toHaveURL(/service=sviluppo_siti_web/);
  await expect(page.getByRole('row').filter({ hasText: E2E_AUDIT_BUSINESSES.poor })).toHaveCount(1);
  expect(errors).toEqual([]);
});

test('scheda: servizi consigliati con problema, prove, verifica; punteggio del lead mostrato a parte', async ({
  page,
}) => {
  const errors = trackErrors(page);
  const panel = await open(page, E2E_AUDIT_BUSINESSES.poor);
  const list = panel.getByRole('list', { name: 'Servizi consigliati' });
  const items = list.locator(':scope > li');
  await expect(items.first()).toBeVisible();
  expect(await items.count()).toBeLessThanOrEqual(3);
  await expect(items.first()).toContainText('Problema osservato.');
  await expect(items.first()).toContainText('Da verificare prima di proporlo.');
  await expect(items.first()).toContainText(/\/100 corrispondenza · affidabilità (alta|media|bassa)/);
  await expect(panel.getByText(/Punteggio del lead:/)).toBeVisible();
  await expect(panel.getByText(/distinta dalla corrispondenza di ogni servizio/)).toBeVisible();
  await expectAccessible(page, 'servizi consigliati');
  expect(errors).toEqual([]);
});

test('revisione: archiviazione con motivo (conservata), riapertura, accettazione, nota', async ({ page }) => {
  const errors = trackErrors(page);
  const panel = await open(page, E2E_AUDIT_BUSINESSES.poor);
  const list = panel.getByRole('list', { name: 'Servizi consigliati' });
  const first = list.locator(':scope > li').first();
  const service = (await first.getByRole('heading', { level: 3 }).textContent())!;
  await first.getByRole('button', { name: 'Archivia…' }).click();
  await first.getByLabel('Motivo dell’archiviazione (facoltativo)').fill('Ha appena rifatto il sito (prova e2e)');
  await first.getByRole('button', { name: 'Archivia', exact: true }).click();
  await expect(list.getByRole('heading', { level: 3, name: service })).toHaveCount(0);
  // il servizio archiviato resta consultabile, con il motivo, tra gli altri servizi
  await panel.getByText(/Altri servizi valutati/).click();
  const row = panel.getByRole('row').filter({ hasText: service });
  await expect(row).toContainText('Archiviato');
  await row.getByText(/Revisioni \(1\)/).click();
  await expect(row).toContainText('Ha appena rifatto il sito (prova e2e)');
  await row.getByRole('button', { name: 'Riapri' }).click();
  await expect(list.getByRole('heading', { level: 3, name: service })).toBeVisible();

  const again = list.locator(':scope > li').filter({ has: page.getByRole('heading', { level: 3, name: service }) });
  await again.getByRole('button', { name: 'Accetta per la valutazione' }).click();
  await expect(again.getByText('Accettato per la valutazione commerciale').first()).toBeVisible();
  await again.getByRole('button', { name: 'Nota…' }).click();
  await again.getByLabel('Nota', { exact: true }).fill('Chiedere del fornitore attuale (prova e2e)');
  await again.getByRole('button', { name: 'Salva la nota' }).click();
  await again.getByText(/Revisioni \(\d\)/).click();
  await expect(again.getByText(/Chiedere del fornitore attuale/)).toBeVisible();
  expect(errors).toEqual([]);
});

test('elenco: filtri per servizio e stato dell’abbinamento, ordinamento per corrispondenza', async ({ page }) => {
  const errors = trackErrors(page);
  await signInAsAdmin(page, E2E_USERS.admin.email, E2E_USERS.admin.password);
  await expectHome(page);
  await page.goto('/aziende?q=audit%20di%20prova');
  await page.getByLabel('Stato dell’abbinamento').selectOption({ label: 'Accettato per la valutazione' });
  await expect(page).toHaveURL(/matchStatus=accepted_for_review/);
  await expect(page.getByText('1 azienda', { exact: true })).toBeVisible();
  await page.getByLabel('Stato dell’abbinamento').selectOption({ label: 'Qualsiasi' });
  await page.getByLabel('Ordina per').selectOption({ label: 'Corrispondenza del servizio' });
  await expect(page.getByRole('row').nth(1)).toContainText(E2E_AUDIT_BUSINESSES.poor);
  await expect(page.getByRole('row').nth(1)).toContainText(/\d+\/100/);
  // ogni intestazione corrisponde a una colonna di dati (nessuna intestazione spostata)
  const headers = await page.getByRole('table').locator('thead th').count();
  expect(await page.getByRole('row').nth(1).locator('td').count()).toBe(headers);
  await expect(page.getByRole('row').nth(1).locator('td[data-label="Punteggio a regole"]')).toContainText(
    /Priorità|Dati insufficienti/,
  );
  await expect(page.getByRole('row').nth(1).locator('td[data-label="Servizio consigliato"]')).toContainText(/\d+\/100/);
  await expectAccessible(page, 'elenco con servizi');
  expect(errors).toEqual([]);
});

test('sito irraggiungibile: prove insufficienti, nessun servizio inventato', async ({ page }) => {
  const errors = trackErrors(page);
  const panel = await open(page, E2E_AUDIT_BUSINESSES.down);
  await expect(panel.getByText('Prove insufficienti per consigliare un servizio')).toBeVisible();
  await expect(panel.getByRole('list', { name: 'Servizi consigliati' })).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('amministratore: disattiva un servizio, nuova versione del catalogo, ricalcolo', async ({ page }) => {
  const errors = trackErrors(page);
  await signInAsAdmin(page, E2E_USERS.admin.email, E2E_USERS.admin.password);
  await expectHome(page);
  await page.goto('/servizi');
  const rules = page.getByRole('region', { name: 'Regole di abbinamento' });
  await rules.getByLabel('Consigliato da').fill('30');
  await rules.getByRole('button', { name: 'Verifica' }).click();
  await expect(rules.getByText('La soglia "consigliato" deve superare "possibile".')).toBeVisible();
  await rules.getByLabel('Consigliato da').fill('60');
  await rules.getByRole('checkbox', { name: 'GEO' }).uncheck();
  await rules.getByLabel('Nota sulla modifica (facoltativa)').fill('GEO sospeso (prova e2e)');
  await rules.getByRole('button', { name: 'Salva come nuova versione' }).click();
  await expect(rules.getByText(/v2 del .* — GEO sospeso \(prova e2e\)/)).toBeVisible();
  await rules.getByRole('button', { name: 'Ricalcola punteggi e abbinamenti di tutte le aziende' }).click();
  await expect(rules.getByText(/Punteggi aggiornati/)).toBeVisible({ timeout: 30_000 });
  const geo = page.getByRole('listitem').filter({ has: page.getByRole('heading', { name: 'GEO', exact: true }) });
  await expect(geo).toContainText('Disattivato');
  expect(errors).toEqual([]);
});

test.describe('mobile @mobile', () => {
  test('servizi consigliati leggibili su telefono @mobile', async ({ page }) => {
    const errors = trackErrors(page);
    const panel = await open(page, E2E_AUDIT_BUSINESSES.poor);
    await expect(panel).toBeVisible();
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth),
    ).toBeLessThanOrEqual(0);
    await expectAccessible(page, 'servizi su telefono');
    expect(errors).toEqual([]);
  });
});
