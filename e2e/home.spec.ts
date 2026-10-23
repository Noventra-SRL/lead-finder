import { expect, test } from '@playwright/test';
import { expectAccessible, expectHome, navLink, signInAsAdmin, trackErrors } from './helpers.ts';
import { E2E_USERS } from './users.ts';

/*
 * Dashboard sul programma reale: aziende trovate, pronte da contattare, email inviate, in attesa di risposta;
 * migliori prospect con «Invia email»; stato di errore e telefono.
 */

test('home: quattro domande con numeri reali, migliori prospect con «Invia email», azioni verso le schermate di lavoro', async ({
  page,
}) => {
  const errors = trackErrors(page);
  await signInAsAdmin(page, E2E_USERS.admin.email, E2E_USERS.admin.password);
  await expectHome(page);
  // stato dell'AI nella navigazione, senza dettagli tecnici
  await expect(
    page.getByRole('navigation', { name: 'Sezioni' }).getByRole('link', { name: 'Trova aziende' }),
  ).toBeVisible();
  await expect(page.getByRole('link', { name: 'AI attiva' })).toBeVisible();

  // quattro domande, numeri dall'API reale
  const kpis = page.getByRole('list', { name: 'Numeri principali' });
  const home = await (await page.request.get('/api/home')).json();
  for (const [label, value] of [
    ['Aziende trovate', home.sales.found],
    ['Pronte da contattare', home.sales.readyToContact],
    ['Email inviate', home.sales.emailsSent],
    ['In attesa di risposta', home.sales.awaitingReply],
  ] as const)
    await expect(kpis.getByRole('listitem').filter({ hasText: label }).locator('.dash-kpi__value')).toHaveText(
      Number(value).toLocaleString('it-IT', { useGrouping: 'always' } as Intl.NumberFormatOptions),
    );

  // migliori prospect: aziende contattabili (né escluse né con divieto), per punteggio, 10 per pagina dal server
  const api = await (
    await page.request.get('/api/businesses?doNotContact=0&sort=commercial&dir=desc&page=1&pageSize=10')
  ).json();
  const best = page.getByRole('table', { name: 'Migliori prospect da contattare' });
  if (api.total > 0) {
    await expect(best.getByRole('row')).toHaveCount(Math.min(10, api.total) + 1);
    await expect(best.getByRole('button', { name: /^Invia email a / })).toHaveCount(Math.min(10, api.total));
    await expect(best.getByRole('row').nth(1)).toContainText(api.items[0].name);
    await expect(
      page.getByText(
        `${Number(api.total).toLocaleString('it-IT', { useGrouping: 'always' } as Intl.NumberFormatOptions)} ${api.total === 1 ? 'risultato' : 'risultati'}`,
      ),
    ).toBeVisible();
  } else await expect(page.getByText('Ancora nessuna azienda')).toBeVisible();
  await expectAccessible(page, 'home');

  // le azioni portano alle due schermate di lavoro; ogni numero apre l'elenco che lo spiega
  const main = page.getByRole('main');
  await main.getByRole('link', { name: 'Trova aziende', exact: true }).first().click();
  await expect(page.getByRole('heading', { level: 1, name: 'Trova aziende' })).toBeVisible();
  await navLink(page, 'Dashboard').click();
  await main.getByRole('link', { name: 'Email commerciali', exact: true }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Email commerciali' })).toBeVisible();
  await navLink(page, 'Dashboard').click();
  await kpis.getByRole('link', { name: /In attesa di risposta/ }).click();
  await expect(page).toHaveURL(/vista=in-attesa/);
  expect(errors).toEqual([]);
});

test('home: errore dell’API mostrato con chiarezza, nessun numero inventato, "Riprova" funziona', async ({ page }) => {
  await signInAsAdmin(page, E2E_USERS.admin.email, E2E_USERS.admin.password);
  await page.route('**/api/home', (route) =>
    route.fulfill({
      status: 503,
      contentType: 'application/json',
      body: JSON.stringify({
        error: { code: 'DATABASE_UNAVAILABLE', message: 'Il database non è raggiungibile in questo momento.' },
      }),
    }),
  );
  await page.goto('/');
  await expect(page.getByText('Impossibile caricare i dati')).toBeVisible();
  await expect(page.getByRole('list', { name: 'Numeri principali' })).toHaveCount(0);
  await page.unroute('**/api/home');
  await page.getByRole('button', { name: 'Riprova' }).click();
  await expect(page.getByRole('list', { name: 'Numeri principali' })).toBeVisible();
});

test.describe('mobile @mobile', () => {
  test('home leggibile su telefono, azioni principali visibili @mobile', async ({ page }) => {
    const errors = trackErrors(page);
    await signInAsAdmin(page, E2E_USERS.admin.email, E2E_USERS.admin.password);
    await expectHome(page);
    await expect(
      page.getByRole('main').getByRole('link', { name: 'Trova aziende', exact: true }).first(),
    ).toBeVisible();
    await expect(page.getByRole('list', { name: 'Numeri principali' })).toBeVisible();
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
    await expectAccessible(page, 'home (telefono)');
    expect(errors).toEqual([]);
  });
});
