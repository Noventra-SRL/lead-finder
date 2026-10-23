import { expect, test, type Page } from '@playwright/test';
import { expectAccessible, expectHome, navLink, signInAsAdmin, trackErrors } from './helpers.ts';
import { E2E_AUDIT_BUSINESSES, E2E_SITE_EMAIL, E2E_USERS } from './users.ts';

/*
 * Dashboard sul programma reale: numeri dal database e i loro collegamenti, ricerca, città, categoria, ordinamento e
 * altri filtri eseguiti dal server, paginazione e stato vuoto, menu «altre azioni» da tastiera, «Invia email» dalla
 * riga con il composer e il server SMTP FINTO (nessuna email reale). Gira per ultimo: l'invio cambia i conteggi.
 */

test.describe.configure({ mode: 'serial' });

const fmt = (n: number) => n.toLocaleString('it-IT', { useGrouping: 'always' } as Intl.NumberFormatOptions);
const table = (page: Page) => page.getByRole('table', { name: 'Migliori prospect da contattare' });
const rows = (page: Page) => table(page).locator('tbody tr');

async function signIn(page: Page) {
  await signInAsAdmin(page, E2E_USERS.admin.email, E2E_USERS.admin.password);
  await expectHome(page);
}

test('numeri dal database e i loro collegamenti; menu laterale con quattro voci', async ({ page }) => {
  const errors = trackErrors(page);
  await signIn(page);
  await expect(page.getByRole('navigation', { name: 'Sezioni' }).getByRole('link')).toHaveText([
    /Dashboard/,
    /Trova aziende/,
    /Email commerciali/,
    /Impostazioni/,
  ]);
  await expect(navLink(page, 'Dashboard')).toHaveAttribute('aria-current', 'page');
  const home = await (await page.request.get('/api/home')).json();
  const kpis = page.getByRole('list', { name: 'Numeri principali' });
  const links: [string, number, RegExp][] = [
    ['Aziende trovate', home.sales.found, /\/trova$/],
    ['Pronte da contattare', home.sales.readyToContact, /\/trova\?contactStatus=da_contattare&email=yes$/],
    ['Email inviate', home.sales.emailsSent, /\/email\?vista=storico&status=sent$/],
    ['In attesa di risposta', home.sales.awaitingReply, /\/email\?vista=in-attesa$/],
  ];
  for (const [label, value, url] of links) {
    const card = kpis.getByRole('link', { name: new RegExp(label) });
    await expect(card.locator('.dash-kpi__value')).toHaveText(fmt(value));
    await card.click();
    await expect(page).toHaveURL(url);
    await navLink(page, 'Dashboard').click();
  }
  // «Pronte da contattare» è lo stesso numero dell'elenco filtrato
  const ready = await (
    await page.request.get('/api/businesses?contactStatus=da_contattare&email=yes&pageSize=1')
  ).json();
  expect(ready.total).toBe(home.sales.readyToContact);
  await expectAccessible(page, 'dashboard');
  expect(errors).toEqual([]);
});

test('ricerca, città, categoria, ordinamento e altri filtri dal server; paginazione; stato vuoto', async ({ page }) => {
  const errors = trackErrors(page);
  await signIn(page);
  // predefinito: punteggio decrescente, solo aziende contattabili
  await expect(page.getByLabel('Ordina per')).toHaveValue('commercial');
  const all = await (
    await page.request.get('/api/businesses?doNotContact=0&sort=commercial&dir=desc&pageSize=10')
  ).json();
  await expect(page.getByText(`${fmt(all.total)} ${all.total === 1 ? 'risultato' : 'risultati'}`)).toBeVisible();

  // ricerca per nome
  await page.getByLabel('Cerca azienda, settore, città').fill(E2E_AUDIT_BUSINESSES.good);
  await page.getByLabel('Cerca azienda, settore, città').press('Enter');
  await expect(page).toHaveURL(/q=/);
  await expect(rows(page).first()).toContainText(E2E_AUDIT_BUSINESSES.good);

  // categoria
  await page.goto('/');
  await page.getByLabel('Categoria').selectOption({ label: 'Farmacie' });
  await expect(page).toHaveURL(/categoria=farmacie/);
  await expect(rows(page).first()).toContainText('Farmacie');
  const farmacie = await (
    await page.request.get(
      '/api/businesses?doNotContact=0&businessCategory=farmacie&sort=commercial&dir=desc&pageSize=10',
    )
  ).json();
  await expect(
    page.getByText(`${fmt(farmacie.total)} ${farmacie.total === 1 ? 'risultato' : 'risultati'}`),
  ).toBeVisible();

  // città (solo quelle presenti nel database) insieme alla categoria
  const cities = await (await page.request.get('/api/businesses/cities')).json();
  const albano = cities.items.find((c: { name: string }) => c.name === 'Albano Laziale');
  await page.getByLabel('Città', { exact: true }).selectOption(albano.code);
  await expect(page).toHaveURL(/citta=/);
  await expect(page).toHaveURL(/categoria=farmacie/);
  for (const r of await rows(page).all()) await expect(r).toContainText('Albano Laziale');

  // ordinamento per nome: stesso ordine dell'API
  await page.goto('/');
  await page.getByLabel('Ordina per').selectOption({ label: 'Nome (A–Z)' });
  const byName = await (await page.request.get('/api/businesses?doNotContact=0&sort=name&dir=asc&pageSize=10')).json();
  await expect(rows(page).first()).toContainText(byName.items[0].name);

  // paginazione dal server
  if (byName.total > 10) {
    await page.getByRole('button', { name: 'Successiva' }).click();
    await expect(page).toHaveURL(/pagina=2/);
    const second = await (
      await page.request.get('/api/businesses?doNotContact=0&sort=name&dir=asc&pageSize=10&page=2')
    ).json();
    await expect(rows(page).first()).toContainText(second.items[0].name);
  }

  // altri filtri: email pubblicata sul sito
  await page.goto('/');
  await page.getByRole('button', { name: 'Altri filtri' }).click();
  const advanced = page.getByRole('region', { name: 'Altri filtri' });
  await advanced.getByLabel('Email').selectOption({ label: 'Pubblicata sul sito' });
  await expect(page).toHaveURL(/email=pubblicata/);
  await expect(rows(page).filter({ hasText: E2E_AUDIT_BUSINESSES.good })).toContainText(E2E_SITE_EMAIL);
  await expectAccessible(page, 'dashboard con altri filtri');

  // stato vuoto e azzeramento
  await page.goto('/?q=nessuna%20corrispondenza%20di%20prova');
  await expect(page.getByText('Nessuna azienda trovata con questi filtri')).toBeVisible();
  await page.getByRole('button', { name: 'Azzera i filtri' }).first().click();
  await expect(page).toHaveURL(/\/$/);
  await expect(rows(page).first()).toBeVisible();
  expect(errors).toEqual([]);
});

test('menu «altre azioni» da tastiera e «Invia email» dalla dashboard con il server SMTP finto', async ({ page }) => {
  const errors = trackErrors(page);
  await signIn(page);
  await page.goto(`/?q=${encodeURIComponent(E2E_AUDIT_BUSINESSES.good)}`);
  const row = rows(page).filter({ hasText: E2E_AUDIT_BUSINESSES.good });
  // menu: apertura da tastiera, frecce, Esc che lo chiude e riporta il fuoco sul pulsante
  const more = row.getByRole('button', { name: `Altre azioni per ${E2E_AUDIT_BUSINESSES.good}` });
  await more.focus();
  await page.keyboard.press('Enter');
  const menu = page.getByRole('menu', { name: `Altre azioni per ${E2E_AUDIT_BUSINESSES.good}` });
  await expect(menu.getByRole('menuitem', { name: 'Apri la scheda' })).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(menu.getByRole('menuitem', { name: 'Apri sito web' })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(menu).toHaveCount(0);
  await expect(more).toBeFocused();

  // «Invia email» senza aprire la scheda: destinatario e testo già pronti, conferma esplicita, esito del server
  const before = (await (await page.request.get('/api/home')).json()).sales.emailsSent;
  await row.getByRole('button', { name: `Invia email a ${E2E_AUDIT_BUSINESSES.good}` }).click();
  const composer = page.getByRole('dialog', { name: `Email a ${E2E_AUDIT_BUSINESSES.good}` });
  await expect(composer.getByLabel('Destinatario')).toHaveValue(E2E_SITE_EMAIL);
  await expect(composer.getByLabel('Oggetto')).not.toHaveValue('');
  const send = composer.getByRole('button', { name: 'Conferma e invia' });
  await expect(send).toBeEnabled();
  await send.click();
  await expect(composer.getByText('Email accettata dal server di posta')).toBeVisible();
  await expect(composer.getByText(/L’accettazione non conferma la consegna/)).toBeVisible();
  await composer.getByRole('button', { name: 'Chiudi' }).click();
  // i numeri e la riga si aggiornano: un'email inviata in più, l'azienda è in attesa di risposta
  await expect(
    page
      .getByRole('list', { name: 'Numeri principali' })
      .getByRole('link', { name: /Email inviate/ })
      .locator('.dash-kpi__value'),
  ).toHaveText(fmt(before + 1));
  await expect(row).toContainText('In attesa di risposta');
  expect(errors).toEqual([]);
});

test.describe('mobile @mobile', () => {
  test('dashboard su telefono: numeri, filtri e prospect leggibili, nessuno scorrimento orizzontale @mobile', async ({
    page,
  }) => {
    const errors = trackErrors(page);
    await signIn(page);
    await expect(page.getByRole('list', { name: 'Numeri principali' })).toBeVisible();
    await expect(rows(page).first()).toBeVisible();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow).toBeLessThanOrEqual(0);
    await expectAccessible(page, 'dashboard su telefono');
    expect(errors).toEqual([]);
  });
});
