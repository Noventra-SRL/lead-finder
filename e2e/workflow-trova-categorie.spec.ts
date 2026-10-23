import { expect, test, type Page } from '@playwright/test';
import { expectAccessible, expectHome, navLink, signInAsAdmin, trackErrors, openSections } from './helpers.ts';
import { E2E_USERS } from './users.ts';

/*
 * Categorie di «Trova aziende» sul programma reale: conteggi dal database con i filtri attivi, cambio di categoria
 * senza lasciare la pagina, stati vuoti, ricerca di nuove aziende di una categoria con la pipeline reale verso il
 * server Overpass FINTO (Narni, un comune che nessun altro test usa), correzione manuale della categoria. Gira per
 * ultimo: la ricerca che avvia non deve comparire nei test del Lead Hunter (che partono da «nessuna ricerca»).
 */

test.describe.configure({ mode: 'serial' });

async function signIn(page: Page) {
  await signInAsAdmin(page, E2E_USERS.admin.email, E2E_USERS.admin.password);
  await expectHome(page);
}

const categoriesNav = (page: Page) => page.getByRole('navigation', { name: 'Categorie' });
const countOf = async (page: Page, label: string) =>
  Number(
    (
      await categoriesNav(page)
        .getByRole('link', { name: new RegExp(`^${label}`) })
        .locator('.catnav__count')
        .innerText()
    ).replace(/[().\s]/g, ''),
  );

test('categorie con i conteggi reali; una categoria si apre nella stessa pagina e mantiene i filtri', async ({
  page,
}) => {
  const errors = trackErrors(page);
  await signIn(page);
  await navLink(page, 'Trova aziende').click();
  await expect(categoriesNav(page).getByRole('link')).toHaveCount(17);
  const api = await (await page.request.get('/api/businesses/categories')).json();
  expect(await countOf(page, 'Tutte le aziende')).toBe(api.all.total);
  const farmacie = api.categories.find((c: { id: string }) => c.id === 'farmacie');
  expect(farmacie.counts.total).toBeGreaterThan(0);
  expect(await countOf(page, 'Farmacie')).toBe(farmacie.counts.total);
  // «Tutte le aziende» = somma delle categorie (ogni azienda una volta sola) più quelle in classificazione
  const sum = api.categories.reduce((s: number, c: { counts: { total: number } }) => s + c.counts.total, 0);
  expect(api.all.total).toBe(sum + api.pending);
  await expectAccessible(page, 'trova aziende per categoria');

  await categoriesNav(page)
    .getByRole('link', { name: /^Farmacie/ })
    .click();
  await expect(page).toHaveURL(/categoria=farmacie/);
  await expect(page.getByRole('heading', { level: 2, name: 'Farmacie' })).toBeVisible();
  await expect(categoriesNav(page).getByRole('link', { name: /^Farmacie/ })).toHaveAttribute('aria-current', 'page');
  const stats = page.locator('.catstats dd').first();
  await expect(stats).toHaveText(farmacie.counts.total.toLocaleString('it-IT'));
  await expect(page.locator('.results-count')).toContainText(String(farmacie.counts.total));
  const list = await (await page.request.get('/api/businesses?businessCategory=farmacie&pageSize=25')).json();
  await expect(page.getByRole('table', { name: 'Farmacie' }).getByRole('row')).toHaveCount(
    Math.min(25, list.total) + 1,
  );
  // ogni riga con «Invia email» e «Dettagli»
  await expect(page.getByRole('button', { name: /^Invia email a / }).first()).toBeVisible();
  await expect(page.getByRole('link', { name: /^Dettagli di / }).first()).toBeVisible();

  // un filtro resta passando a un'altra categoria; i conteggi seguono il filtro
  await page.getByLabel('Sito web').selectOption({ label: 'Con un sito proprio' });
  await expect(page).toHaveURL(/website=own/);
  const own = await (await page.request.get('/api/businesses/categories?website=own')).json();
  await expect
    .poll(() => countOf(page, 'Ristoranti'))
    .toBe(own.categories.find((c: { id: string }) => c.id === 'ristoranti').counts.total);
  await categoriesNav(page)
    .getByRole('link', { name: /^Ristoranti/ })
    .click();
  await expect(page).toHaveURL(/categoria=ristoranti/);
  await expect(page).toHaveURL(/website=own/);
  await expect(page.getByLabel('Sito web')).toHaveValue('own');

  // stato vuoto della categoria
  await page.goto('/trova?categoria=farmacie&q=nessuna%20corrispondenza%20di%20prova');
  await expect(page.getByText('Nessuna farmacia trovata con questi filtri')).toBeVisible();
  expect(errors).toEqual([]);
});

test('«Cerca nuovi parrucchieri e barbieri»: ricerca reale della categoria, avanzamento, risultati nella categoria', async ({
  page,
}) => {
  const errors = trackErrors(page);
  await signIn(page);
  await page.goto('/trova?categoria=parrucchieri_barbieri');
  const before = await countOf(page, 'Parrucchieri e barbieri');
  // con la categoria vuota l'azione compare anche nello stato vuoto: qui il pulsante dell'intestazione
  await page.locator('.cathead').getByRole('button', { name: 'Cerca nuovi parrucchieri e barbieri' }).click();
  const dialog = page.getByRole('dialog', { name: 'Cerca nuovi parrucchieri e barbieri' });
  await expect(dialog.getByText(/Durante la ricerca non viene inviata nessuna email/)).toBeVisible();
  await dialog.getByLabel('Regione').selectOption({ label: 'Umbria' });
  await dialog.getByLabel('Provincia o città metropolitana').selectOption({ label: 'Terni (TR)' });
  await dialog.getByLabel('Comune').selectOption({ label: 'Narni' });
  await dialog.getByLabel('Verifica automatica dei siti trovati').uncheck();
  await dialog.getByLabel('Quante aziende cercare').fill('10');
  await expectAccessible(page, 'ricerca per categoria');
  await dialog.getByRole('button', { name: 'Avvia la ricerca' }).click();

  await expect(
    page.getByRole('heading', { level: 1, name: /^Parrucchieri e barbieri · 10 aziende · Narni/ }),
  ).toBeVisible();
  const state = page.getByRole('region', { name: 'Stato' });
  await expect(state.getByText(/^Completata/)).toBeVisible({ timeout: 60_000 });
  // il server finto ha un parrucchiere per comune: trovato, salvato, nella sua categoria
  await expect(page.getByText(/Parrucchieri e barbieri: 1 \(1 nuove, 0 già presenti\)/)).toBeVisible();
  await page.getByRole('main').getByRole('link', { name: 'Parrucchieri e barbieri' }).first().click();
  await expect(page).toHaveURL(/categoria=parrucchieri_barbieri/);
  expect(await countOf(page, 'Parrucchieri e barbieri')).toBe(before + 1);
  const row = page.getByRole('row').filter({ hasText: 'Parrucchiere di Prova Narni' });
  await expect(row).toContainText('Email non disponibile');
  await expect(row.getByRole('button', { name: /^Invia email a / })).toBeDisabled();
  expect(errors).toEqual([]);
});

test('scheda: categoria con la prova, correzione manuale e ritorno all’automatica', async ({ page }) => {
  const errors = trackErrors(page);
  await signIn(page);
  await page.goto('/trova?categoria=farmacie&sort=name');
  await page
    .getByRole('link', { name: /^Dettagli di / })
    .first()
    .click();
  await openSections(page);
  const category = page.locator('.category-control');
  await expect(category).toContainText('Categoria: Farmacie');
  // la prova che ha deciso la categoria: tag della fonte o categoria della ricerca
  await expect(category).toContainText(
    /automatica \((OpenStreetMap: amenity=pharmacy|Categoria della scoperta: Farmacie)\)/,
  );
  await category.getByText('Correggi la categoria').click();
  await category.getByLabel('Categoria principale').selectOption({ label: 'Negozi e attività commerciali' });
  await category.getByRole('button', { name: 'Salva la categoria' }).click();
  await expect(category).toContainText('Categoria: Negozi e attività commerciali · scelta a mano');
  await category.getByRole('button', { name: 'Torna alla classificazione automatica' }).click();
  await expect(category).toContainText('Categoria: Farmacie · automatica');
  expect(errors).toEqual([]);
});

test.describe('mobile @mobile', () => {
  test('categorie su telefono: striscia scorrevole, categoria scelta visibile, nessuno scorrimento orizzontale @mobile', async ({
    page,
  }) => {
    const errors = trackErrors(page);
    await signIn(page);
    await page.goto('/trova?categoria=palestre_fitness');
    const current = categoriesNav(page).getByRole('link', { name: /^Palestre e centri fitness/ });
    await expect(current).toHaveAttribute('aria-current', 'page');
    await expect(current).toBeInViewport();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow).toBeLessThanOrEqual(0);
    await expectAccessible(page, 'categorie su telefono');
    expect(errors).toEqual([]);
  });
});
