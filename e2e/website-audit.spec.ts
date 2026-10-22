import { expect, test, type Page } from '@playwright/test';
import { expectAccessible, signInAsAdmin, trackErrors, expectHome, openAdvanced } from './helpers.ts';
import { E2E_AUDIT_BUSINESSES, E2E_FAKE_SITE_PORTS, E2E_USERS } from './users.ts';

/*
 * Fase 3 sul programma reale: audit di tre aziende di prova collegate a siti FINTI locali (e2e/start.ts).
 * Nessuna richiesta verso Internet. I test sono in sequenza e partono dai dati dei precedenti.
 */

test.describe.configure({ mode: 'serial' });

const jobState = (page: Page, text: string) =>
  page.getByRole('region', { name: 'Stato' }).getByText(text, { exact: true });

async function openLeads(page: Page, query = '') {
  await signInAsAdmin(page, E2E_USERS.admin.email, E2E_USERS.admin.password);
  await expectHome(page);
  await page.goto(`/aziende${query}`);
  await expect(page.getByRole('heading', { level: 1, name: 'Database aziende' })).toBeVisible();
}

test('pagina dell’audit: regole dichiarate, nessuna verifica, prestazioni non configurate', async ({ page }) => {
  const errors = trackErrors(page);
  await signInAsAdmin(page, E2E_USERS.admin.email, E2E_USERS.admin.password);
  await openAdvanced(page, 'Analisi dei siti web');
  await expect(page.getByText('Nessuna verifica avviata')).toBeVisible();
  await expect(page.getByText(/PageSpeed Insights non è configurato/)).toBeVisible();
  await expect(page.getByText('80, 443')).toBeVisible();
  await expectAccessible(page, 'audit vuoto');
  expect(errors).toEqual([]);
});

test('selezione nel database lead e avvio dell’audit; avanzamento ed esiti per azienda', async ({ page }) => {
  const errors = trackErrors(page);
  await openLeads(page, '?q=audit%20di%20prova');
  await page.getByLabel('Audit del sito').selectOption({ label: 'Sito proprio non ancora verificato' });
  await expect(page.getByText('3 aziende')).toBeVisible();
  await expect(page.getByRole('cell', { name: 'Non verificato' })).toHaveCount(3);
  const start = page.getByRole('button', { name: 'Avvia audit dei selezionati' });
  await expect(start).toBeDisabled();
  await page.getByRole('checkbox', { name: 'Seleziona tutte le aziende di questa pagina' }).check();
  await expect(page.getByText('3 selezionate')).toBeVisible();
  await expectAccessible(page, 'database lead con selezione');
  await start.click();

  await expect(page).toHaveURL(/\/audit\/verifiche\//);
  await expect(page.getByRole('heading', { level: 1, name: 'Verifica di 3 aziende' })).toBeVisible();
  // il sito lento tiene la verifica in corso per qualche istante, poi tutto termina
  await expect(jobState(page, 'Completata')).toBeVisible({ timeout: 30_000 });
  const rows = page.getByRole('table').getByRole('row');
  await expect(rows.filter({ hasText: E2E_AUDIT_BUSINESSES.good })).toContainText('Raggiungibile');
  await expect(rows.filter({ hasText: E2E_AUDIT_BUSINESSES.poor })).toContainText('Raggiungibile');
  await expect(rows.filter({ hasText: E2E_AUDIT_BUSINESSES.down })).toContainText('Irraggiungibile');
  await expect(page.getByText('3 / 3')).toBeVisible();
  await expectAccessible(page, 'verifica completata');
  expect(errors).toEqual([]);
});

test('esito dell’audit: sintesi, rilievi con evidenza e filtri, limiti dichiarati', async ({ page }) => {
  const errors = trackErrors(page);
  await openLeads(page, '?q=trattoria%20audit');
  await page.getByRole('link', { name: /rilievi utili/ }).click();
  await expect(page.getByRole('heading', { level: 1, name: `127.0.0.1:${E2E_FAKE_SITE_PORTS.poor}` })).toBeVisible();
  await expect(page.getByText('Audit completo')).toBeVisible();
  const findings = page.getByRole('region', { name: 'Rilievi' });
  await expect(findings.getByRole('heading', { level: 3, name: /SEO tecnica/ })).toBeVisible();
  await expect(findings.getByRole('heading', { level: 3, name: /Mobile \(indicatori statici\)/ })).toBeVisible();
  await expect(findings.getByText('Intervento suggerito.').first()).toBeVisible();
  // la pagina del ristorante di prova non dichiara la viewport
  await expect(findings.getByText('MOBILE_NO_VIEWPORT')).toBeVisible();
  await expectAccessible(page, 'esito audit');

  await findings.getByLabel('Gravità').selectOption({ label: 'Alta' });
  await expect(page).toHaveURL(/severity=high/);
  for (const s of await findings.locator('.finding .status').allTextContents()) expect(s).toBe('Alta');
  await findings.getByLabel('Area').selectOption({ label: 'Prestazioni' });
  await findings.getByLabel('Gravità').selectOption({ label: 'Tutte' });
  await expect(findings.getByRole('heading', { level: 3, name: /SEO tecnica/ })).toHaveCount(0);

  await expect(page.getByRole('region', { name: 'Prestazioni' })).toContainText('Non misurate');
  await expect(page.getByRole('region', { name: 'Limiti di questo audit' })).toContainText('PageSpeed Insights');
  await expect(page.getByRole('region', { name: 'Pagine esaminate' })).toContainText('200');
  expect(errors).toEqual([]);
});

test('scheda azienda: stato del sito, storico e ripetizione dell’audit', async ({ page }) => {
  const errors = trackErrors(page);
  await openLeads(page, '?q=farmacia%20audit');
  await page.getByRole('link', { name: E2E_AUDIT_BUSINESSES.good }).click();
  const section = page.getByRole('region', { name: 'Sito web e audit' });
  await expect(section.getByText('Raggiungibile', { exact: true })).toBeVisible();
  await expect(section.getByRole('list', { name: 'Storico degli audit' }).getByRole('listitem')).toHaveCount(1);
  await expectAccessible(page, 'scheda con audit');
  await section.getByRole('button', { name: 'Ripeti l’audit' }).click();
  await expect(page).toHaveURL(/\/audit\/verifiche\//);
  await expect(jobState(page, 'Completata')).toBeVisible({ timeout: 30_000 });
  await page.getByRole('link', { name: E2E_AUDIT_BUSINESSES.good }).click();
  await expect(
    page
      .getByRole('region', { name: 'Sito web e audit' })
      .getByRole('list', { name: 'Storico degli audit' })
      .getByRole('listitem'),
  ).toHaveCount(2);
  expect(errors).toEqual([]);
});

test('sito irraggiungibile: stato chiaro e motivo tecnico, mai un errore della pagina', async ({ page }) => {
  const errors = trackErrors(page);
  await openLeads(page, '?audit=unavailable');
  await expect(page.getByText('1 azienda', { exact: true })).toBeVisible();
  await page.getByRole('link', { name: E2E_AUDIT_BUSINESSES.down }).click();
  await expect(
    page.getByRole('region', { name: 'Sito web e audit' }).getByText('Irraggiungibile', { exact: true }),
  ).toBeVisible();
  await page.getByRole('region', { name: 'Sito web e audit' }).getByRole('link', { name: 'Audit completo' }).click();
  await expect(page.getByRole('heading', { level: 1, name: `127.0.0.1:${E2E_FAKE_SITE_PORTS.closed}` })).toBeVisible();
  await expect(page.getByText('Motivo tecnico:')).toBeVisible();
  await expect(page.getByText('Sito non raggiungibile')).toBeVisible();
  expect(errors).toEqual([]);
});

test.describe('mobile @mobile', () => {
  test('verifiche ed esiti leggibili su telefono @mobile', async ({ page }) => {
    const errors = trackErrors(page);
    await signInAsAdmin(page, E2E_USERS.admin.email, E2E_USERS.admin.password);
    await expectHome(page);
    await page.goto('/audit');
    await expect(page.getByRole('heading', { level: 1, name: 'Analisi dei siti web' })).toBeVisible();
    await page
      .getByRole('link', { name: /^Verifica di/ })
      .first()
      .click();
    await expect(jobState(page, 'Completata')).toBeVisible();
    await page.getByRole('link', { name: 'Apri' }).first().click();
    await expect(page.getByRole('region', { name: 'Rilievi' })).toBeVisible();
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
    await expectAccessible(page, 'esito audit su telefono');
    expect(errors).toEqual([]);
  });
});
