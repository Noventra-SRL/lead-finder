import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { expectAccessible, navLink, signInAsAdmin, trackErrors, expectHome, openSections } from './helpers.ts';
import { E2E_USERS } from './users.ts';

/*
 * Fase 6 sul programma reale: Lead Hunter con il coordinatore delle ricerche attivo e il server Overpass FINTO
 * (attività inventate "di Prova", nessuna richiesta verso Internet). Verifica dei siti disattivata: i siti delle
 * attività finte non sono raggiungibili e non vanno contattati.
 * Il file ha un nome che lo fa eseguire per ultimo: aggiunge aziende al database e gli altri test contano le proprie.
 */

test.describe.configure({ mode: 'serial' });

let runUrl = '';

async function openHunter(page: Page) {
  await signInAsAdmin(page, E2E_USERS.admin.email, E2E_USERS.admin.password);
  await expectHome(page);
  await navLink(page, 'Trova aziende').click();
  await expect(page.getByRole('heading', { level: 1, name: 'Trova aziende' })).toBeVisible();
  await page.getByRole('link', { name: 'Avvia o riprendi una ricerca' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Nuova ricerca di aziende' })).toBeVisible();
  await expect(navLink(page, 'Trova aziende')).toHaveAttribute('aria-current', 'page');
}

test('configurazione: catalogo dei settori con copertura, obiettivo e area', async ({ page }) => {
  const errors = trackErrors(page);
  await openHunter(page);
  await expect(page.getByText('Nessuna ricerca di lead ancora')).toBeVisible();
  const form = page.getByRole('form', { name: 'Nuova ricerca di lead' });
  await expect(form.getByLabel('Aziende da trovare')).toHaveValue('1000');
  await expect(form.getByRole('heading', { level: 3, name: 'Turismo e ospitalità' })).toBeVisible();
  await expect(form.getByRole('checkbox', { name: /^Commercialisti.*Copertura limitata/ })).not.toBeChecked();
  await expect(form.getByRole('checkbox', { name: /^Studi dentistici.*Copertura parziale/ })).toBeChecked();
  await form.getByRole('button', { name: 'Deseleziona tutti' }).click();
  await expect(form.getByRole('button', { name: 'Avvia la ricerca di lead' })).toBeDisabled();
  await expectAccessible(page, 'lead hunter');
  expect(errors).toEqual([]);
});

test('ricerca per obiettivo: avanzamento reale, distribuzione, lead con recapiti, esportazione CSV', async ({
  page,
}) => {
  const errors = trackErrors(page);
  await openHunter(page);
  const form = page.getByRole('form', { name: 'Nuova ricerca di lead' });
  await form.getByLabel('Aziende da trovare').fill('20');
  await form.getByLabel('Regione').selectOption({ label: 'Molise' });
  await expect(form.getByLabel('Provincia o città metropolitana')).toBeEnabled();
  await form.getByLabel('Provincia o città metropolitana').selectOption({ label: 'Isernia (IS)' });
  await form.getByRole('button', { name: 'Deseleziona tutti' }).click();
  await form.getByRole('checkbox', { name: /^Studi dentistici/ }).check();
  await form.getByRole('checkbox', { name: /^Commercialisti/ }).check();
  await form.getByRole('checkbox', { name: 'Verifica automatica dei siti trovati' }).uncheck();
  await form.getByRole('button', { name: 'Avvia la ricerca di lead' }).click();

  await expect(page.getByRole('heading', { level: 1, name: /^20 aziende · Isernia/ })).toBeVisible();
  runUrl = page.url();
  const state = page.getByRole('region', { name: 'Stato' });
  await expect(state.getByText('Completata', { exact: true })).toBeVisible({ timeout: 60_000 });
  await expect(state.getByText(/obiettivo raggiunto/)).toBeVisible();
  const qualified = Number(await state.locator('.hunt-figure__value').textContent());
  expect(qualified).toBeGreaterThanOrEqual(20);
  await expect(page.getByText(/Obiettivo raggiunto/).first()).toBeVisible();

  const dist = page.getByRole('region', { name: 'Distribuzione' });
  await expect(dist.getByRole('link', { name: 'Studi dentistici' })).toBeVisible();
  await expect(dist.getByRole('link', { name: 'Commercialisti e consulenti fiscali' })).toBeVisible();
  await expect(dist.getByRole('rowheader', { name: 'Molise' })).toBeVisible();
  await expectAccessible(page, 'ricerca di lead');

  // esportazione dalla pagina della ricerca: file reale, intestazione italiana, solo email generiche
  await page.getByRole('region', { name: 'Risultati' }).getByRole('button', { name: 'Esporta', exact: true }).click();
  const exportDialog = page.getByRole('dialog', { name: 'Esporta' });
  await expect(exportDialog.getByRole('checkbox', { name: 'Azienda' })).toBeChecked();
  const [file] = await Promise.all([
    page.waitForEvent('download'),
    exportDialog.getByRole('button', { name: 'Scarica CSV' }).click(),
  ]);
  expect(file.suggestedFilename()).toMatch(/^lead_hunter_noventra_\d{4}-\d{2}-\d{2}\.csv$/);
  const csv = readFileSync((await file.path())!, 'utf8');
  expect(csv.charCodeAt(0)).toBe(0xfeff);
  const lines = csv.slice(1).trim().split('\r\n');
  expect(lines[0]).toMatch(/^Azienda;Settore;Categoria;/);
  // il numero di righe dichiarato dall'interfaccia è quello del file
  await expect(page.getByRole('region', { name: 'Risultati' }).getByRole('status')).toHaveText(
    `Esportate ${lines.length - 1} righe.`,
  );
  expect(csv).toContain('info@dentista-prova.example.it');
  expect(csv).not.toContain('mario.rossi');
  expect(errors).toEqual([]);
});

test('lead della ricerca: filtri per settore, recapiti, esclusione dalla prospezione', async ({ page }) => {
  const errors = trackErrors(page);
  await signInAsAdmin(page, E2E_USERS.admin.email, E2E_USERS.admin.password);
  await page.goto(runUrl);
  await page.getByRole('link', { name: 'Apri i lead di questa ricerca' }).click();
  await expect(page.getByText('Solo le aziende della')).toBeVisible();
  await page.getByLabel('Settore').selectOption({ label: 'Studi dentistici' });
  const rows = page.getByRole('table').getByRole('row');
  const first = rows.nth(1);
  await expect(first).toContainText('Studio Dentistico di Prova');
  await expect(first.getByRole('link', { name: '+39 000 1111111' })).toBeVisible();
  await expect(first.getByRole('link', { name: 'info@dentista-prova.example.it' })).toBeVisible();
  await expectAccessible(page, 'lead della ricerca');

  // un commercialista con email personale: indicata dalla fonte, non salvata né mostrata
  await page.getByLabel('Settore').selectOption({ label: 'Commercialisti e consulenti fiscali' });
  await expect(rows.nth(1)).toContainText('Studio Commercialista di Prova');
  const name = (await rows.nth(1).getByRole('link').first().textContent())!;
  await rows.nth(1).getByRole('link', { name }).click();
  await expect(page.getByRole('heading', { level: 1, name })).toBeVisible();
  await expect(page.getByText(/solo un indirizzo personale, non salvato/)).toBeVisible();
  await expect(page.getByText('mario.rossi')).toHaveCount(0);
  await openSections(page);
  await expect(page.getByText('trovata per la prima volta da questa ricerca')).toBeVisible();

  // «Gestisci contatto» → «Escludi azienda»: motivo obbligatorio e conferma esplicita
  await page.getByRole('button', { name: 'Gestisci contatto' }).click();
  const manage = page.getByRole('dialog', { name: 'Gestisci contatto' });
  await expect(manage.getByRole('button', { name: 'Conferma l’esclusione' })).toBeDisabled();
  await manage.getByRole('radio', { name: /^Azienda non pertinente/ }).check();
  await manage.getByLabel('Nota (facoltativa)').fill('Fuori target (prova e2e)');
  await manage.getByRole('button', { name: 'Conferma l’esclusione' }).click();
  await expect(page.getByText(/Fuori target \(prova e2e\)/)).toBeVisible();
  await expectAccessible(page, 'scheda esclusa');

  // l'azienda esclusa sparisce dall'elenco predefinito e ricompare solo con il filtro esplicito
  await page.goto(`/aziende?q=${encodeURIComponent(name)}`);
  await expect(page.getByText('Nessuna azienda con questi filtri')).toBeVisible();
  await page.getByLabel('Escluse dalla prospezione').selectOption({ label: 'Solo le escluse' });
  await expect(page.getByText('Esclusa dalla prospezione')).toBeVisible();
  await page.getByRole('link', { name }).click();
  await page.getByRole('button', { name: 'Gestisci contatto' }).click();
  await page.getByRole('button', { name: 'Riporta tra i potenziali clienti' }).click();
  await expect(page.locator('.notice__title', { hasText: 'Esclusa dai potenziali clienti' })).toHaveCount(0);
  expect(errors).toEqual([]);
});

test.describe('mobile @mobile', () => {
  test('pagina del Lead Hunter leggibile su telefono @mobile', async ({ page }) => {
    const errors = trackErrors(page);
    await signInAsAdmin(page, E2E_USERS.admin.email, E2E_USERS.admin.password);
    await page.goto('/lead-hunter');
    await expect(page.getByRole('heading', { level: 1, name: 'Nuova ricerca di aziende' })).toBeVisible();
    const width = await page.evaluate(() => document.documentElement.scrollWidth);
    expect(width).toBeLessThanOrEqual(page.viewportSize()!.width);
    await expectAccessible(page, 'lead hunter (telefono)');
    expect(errors).toEqual([]);
  });
});
