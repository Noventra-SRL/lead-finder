import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { expectAccessible, login, navLink, trackErrors, expectHome, openAdvanced } from './helpers.ts';
import { E2E_AUDIT_BUSINESSES, E2E_FAKE_OVERPASS_PORT, E2E_USERS } from './users.ts';

/*
 * Fase 2 sul programma reale. Il fornitore è il client Overpass reale, puntato su un server Overpass FINTO locale
 * con attività inventate ("… di Prova"): nessuna richiesta verso Internet. I test sono in sequenza: ognuno parte
 * dai dati salvati dai precedenti nello stesso database.
 */

test.describe.configure({ mode: 'serial' });

const control = (request: APIRequestContext, data: { failures?: number[]; missing?: string[] }) =>
  request.post(`http://127.0.0.1:${E2E_FAKE_OVERPASS_PORT}/__control`, { data });

async function openDiscovery(page: Page) {
  await login(page, E2E_USERS.admin.email, E2E_USERS.admin.password);
  await expectHome(page);
  // la ricerca manuale è la seconda scheda della nuova ricerca, aperta da «Trova aziende»
  await navLink(page, 'Trova aziende').click();
  await page.getByRole('link', { name: 'Avvia o riprendi una ricerca' }).click();
  await page
    .getByRole('navigation', { name: 'Modi di cercare' })
    .getByRole('link', { name: /^Ricerca manuale/ })
    .click();
  await expect(page.getByRole('heading', { level: 1, name: 'Nuova ricerca di aziende' })).toBeVisible();
  await expect(page.getByRole('form', { name: 'Nuova ricerca' })).toBeVisible();
  await expect(navLink(page, 'Trova aziende')).toHaveAttribute('aria-current', 'page');
}

async function chooseArea(page: Page, area: { region: string; province: string; municipality?: string }) {
  const form = page.getByRole('form', { name: 'Nuova ricerca' });
  await form.getByLabel('Regione').selectOption({ label: area.region });
  await expect(form.getByLabel('Provincia o città metropolitana')).toBeEnabled();
  await form.getByLabel('Provincia o città metropolitana').selectOption({ label: area.province });
  if (area.municipality) {
    await expect(form.getByLabel('Comune', { exact: true })).toBeEnabled();
    await form.getByLabel('Comune', { exact: true }).selectOption({ label: area.municipality });
  }
}

async function startSearch(page: Page, categories: RegExp[], maxResults = '200') {
  const form = page.getByRole('form', { name: 'Nuova ricerca' });
  for (const c of categories) await form.getByRole('checkbox', { name: c }).check();
  await form.getByLabel('Risultati massimi').fill(maxResults);
  await form.getByRole('button', { name: 'Avvia la ricerca' }).click();
  await expect(page.getByText('Ricerca avviata')).toBeVisible();
  await page.getByRole('link', { name: 'Segui l’avanzamento' }).click();
}

/** Stato della ricerca nella sezione «Stato» della pagina di dettaglio (non quello delle singole richieste). */
const jobState = (page: Page, text: string) =>
  page.getByRole('region', { name: 'Stato' }).getByText(text, { exact: true });

const LAZIO_ALBANO = { region: 'Lazio', province: 'Roma (RM)', municipality: 'Albano Laziale' };
const FOUR = [/^Farmacie/, /^Parafarmacie/, /^Ristoranti e bar/, /^Hotel/];

test('pagina di ricerca: fornitore configurato, copertura delle categorie, attribuzione', async ({ page }) => {
  const errors = trackErrors(page);
  await openDiscovery(page);
  await expect(page.getByText(`127.0.0.1:${E2E_FAKE_OVERPASS_PORT}`)).toBeVisible();
  await expect(page.getByText('Nessuna ricerca ancora')).toBeVisible();
  // i limiti della fonte sono dichiarati accanto alle categorie
  await expect(page.getByRole('checkbox', { name: /^Studi professionali.*Copertura limitata/ })).toBeVisible();
  await expect(page.getByText('Pochi studi professionali sono mappati')).toBeVisible();
  await expect(page.getByRole('link', { name: '© OpenStreetMap contributors' })).toHaveAttribute(
    'href',
    'https://www.openstreetmap.org/copyright',
  );
  // il raggio vale solo partendo da un comune; senza categorie non si parte
  const form = page.getByRole('form', { name: 'Nuova ricerca' });
  await expect(form.getByLabel('Raggio intorno al comune')).toBeDisabled();
  await expect(form.getByRole('button', { name: 'Avvia la ricerca' })).toBeDisabled();
  await expectAccessible(page, 'scoperta');
  expect(errors).toEqual([]);
});

test('ricerca su un comune: avanzamento reale, risultati salvati, scheda con provenienza', async ({ page }) => {
  const errors = trackErrors(page);
  await openDiscovery(page);
  await chooseArea(page, LAZIO_ALBANO);
  await startSearch(page, FOUR);

  await expect(page.getByRole('heading', { level: 1, name: 'Albano Laziale' })).toBeVisible();
  await expect(jobState(page, 'Completata')).toBeVisible({ timeout: 20_000 });
  const results = page.getByRole('region', { name: 'Risultati' });
  await expect(results.getByText(/6 nuove/)).toBeVisible();
  await expect(results.getByText(/1\s+da verificare/)).toBeVisible();
  await expect(page.getByRole('progressbar', { name: 'Avanzamento della ricerca' })).toHaveAttribute(
    'aria-valuenow',
    '1',
  );
  await expectAccessible(page, 'dettaglio ricerca');

  await page.getByRole('link', { name: 'Vedi le aziende di questa ricerca' }).click();
  await expect(page.getByText('6 aziende')).toBeVisible();
  await page.getByRole('button', { name: /^Azienda/ }).click();
  await expect(page.getByRole('columnheader', { name: /Azienda/ })).toHaveAttribute('aria-sort', 'ascending');
  await expect(page.getByRole('row').nth(1)).toContainText('Bar di Prova Albano Laziale');
  await expect(page.getByText('Possibile duplicato').first()).toBeVisible();
  await expectAccessible(page, 'database lead');

  await page.getByRole('link', { name: 'Farmacia di Prova Albano Laziale', exact: true }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Farmacia di Prova Albano Laziale' })).toBeVisible();
  await expect(page.getByText('Albano Laziale, Roma (RM), Lazio')).toBeVisible();
  await expect(page.getByRole('link', { name: 'https://www.farmacia-albanolaziale.example.it/' })).toBeVisible();
  const source = page.getByRole('link', { name: 'Apri il record originale' });
  await expect(source).toHaveAttribute('href', 'https://www.openstreetmap.org/node/9005800301');
  await expect(page.getByText(/ODbL 1\.0 — © OpenStreetMap contributors/)).toBeVisible();
  await expect(page.getByText('Creata da una ricerca')).toBeVisible();
  // dalla Fase 6 il telefono pubblico dell'attività è conservato e mostrato; l'email non è indicata dalla fonte
  await expect(page.getByText(/Telefono indicato/)).toBeVisible();
  await expect(page.getByRole('link', { name: '+39 000 0000000' })).toHaveAttribute('href', 'tel:+390000000000');
  await expect(page.getByText('email generica non indicata')).toBeVisible();
  await expectAccessible(page, 'scheda azienda');
  expect(errors).toEqual([]);
});

test('ripetere la stessa ricerca aggiorna senza creare doppioni', async ({ page }) => {
  await openDiscovery(page);
  await chooseArea(page, LAZIO_ALBANO);
  await startSearch(page, FOUR);
  await expect(jobState(page, 'Completata')).toBeVisible({ timeout: 20_000 });
  const results = page.getByRole('region', { name: 'Risultati' });
  await expect(results.getByText(/0 nuove/)).toBeVisible();
  await expect(results.getByText(/6 già presenti e invariate/)).toBeVisible();
  await openAdvanced(page, 'Database aziende');
  await page.getByLabel('Regione').selectOption({ label: 'Lazio' });
  await expect(page.getByText('6 aziende')).toBeVisible();
});

test('revisione dei duplicati: unione confermata da una persona', async ({ page }) => {
  const errors = trackErrors(page);
  await openDiscovery(page);
  await openAdvanced(page, 'Database aziende');
  await page.getByRole('link', { name: /Possibili duplicati/ }).click();
  await expect(page.getByText('Stesso nome a breve distanza · 80 m')).toBeVisible();
  await expectAccessible(page, 'duplicati');
  await page.getByRole('button', { name: 'Unisci, mantieni la prima' }).click();
  const dialog = page.getByRole('dialog', { name: 'Unire le due aziende?' });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Unisci' }).click();
  await expect(page.getByText('Nessun possibile duplicato da verificare')).toBeVisible();
  await page.getByRole('navigation', { name: 'Viste del database' }).getByRole('link', { name: 'Aziende' }).click();
  // 5 dalla ricerca + le aziende di prova dell'audit create all'avvio (e2e/start.ts)
  await expect(page.getByText(`${5 + Object.keys(E2E_AUDIT_BUSINESSES).length} aziende`)).toBeVisible();
  expect(errors).toEqual([]);
});

test('server della fonte non disponibile: errore visibile, nessun dato inventato, ripresa', async ({
  page,
  request,
}) => {
  await openDiscovery(page);
  await control(request, { failures: [503] });
  await chooseArea(page, { region: 'Lazio', province: 'Roma (RM)', municipality: 'Ariccia' });
  await startSearch(page, [/^Farmacie/]);
  await expect(jobState(page, 'Non riuscita')).toBeVisible({ timeout: 20_000 });
  await expect(
    page.getByText(/Ariccia: Server OpenStreetMap occupato o sovraccarico \(HTTP 503\)/).first(),
  ).toBeVisible();
  await expect(page.getByRole('region', { name: 'Risultati' }).getByText(/0 nuove/)).toBeVisible();
  await page.getByRole('button', { name: 'Ripeti le parti non riuscite' }).click();
  await expect(jobState(page, 'Completata')).toBeVisible({ timeout: 20_000 });
  await expect(page.getByRole('region', { name: 'Risultati' }).getByText(/1 nuove/)).toBeVisible();
});

test('comune assente su OpenStreetMap: avviso esplicito invece di «zero risultati»', async ({ page, request }) => {
  await openDiscovery(page);
  await control(request, { missing: ['058005'] });
  await chooseArea(page, { region: 'Lazio', province: 'Roma (RM)', municipality: 'Anguillara Sabazia' });
  await startSearch(page, [/^Hotel/]);
  await expect(jobState(page, 'Completata con avvisi')).toBeVisible({ timeout: 20_000 });
  await expect(
    page.getByText(/Comune non trovato su OpenStreetMap con il codice ISTAT: Anguillara Sabazia \(058005\)/),
  ).toBeVisible();
  await control(request, { missing: [] });
});

test('provincia intera: più richieste, filtri e paginazione sul database', async ({ page }) => {
  await openDiscovery(page);
  await chooseArea(page, { region: 'Lazio', province: 'Roma (RM)' });
  await startSearch(page, [/^Farmacie/], '1000');
  await expect(page.getByRole('heading', { level: 1, name: 'Roma' })).toBeVisible();
  await expect(jobState(page, 'Completata')).toBeVisible({ timeout: 60_000 });
  await expect(page.getByText(/5 \/ 5/)).toBeVisible();

  await openAdvanced(page, 'Database aziende');
  await page.getByLabel('Regione').selectOption({ label: 'Lazio' });
  await page.getByLabel('Provincia o città metropolitana').selectOption({ label: 'Roma (RM)' });
  await page.getByLabel('Categoria').selectOption({ label: 'Farmacie' });
  await expect(page.getByText('121 aziende')).toBeVisible();
  await expect(page.getByText('1–25 di 121')).toBeVisible();
  await page.getByRole('button', { name: 'Successiva' }).click();
  await expect(page.getByText('26–50 di 121')).toBeVisible();
  await expect(page).toHaveURL(/page=2/);
  // cambiare un filtro riporta alla prima pagina
  await page.getByLabel('Sito web').selectOption({ label: 'Senza sito indicato' });
  await expect(page.getByText('Nessuna azienda con questi filtri')).toBeVisible();
  await page.getByLabel('Sito web').selectOption({ label: 'Con un sito proprio' });
  await expect(page.getByText('1–25 di 121')).toBeVisible();
  await page.getByLabel('Cerca per nome, dominio o comune').fill('ariccia');
  await page.getByRole('button', { name: 'Cerca', exact: true }).click();
  await expect(page.getByText('1 azienda', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Azzera i filtri' }).click();
  await expect(page).toHaveURL(/\/aziende$/);
});

test('dashboard: numeri reali dal database', async ({ page }) => {
  await login(page, E2E_USERS.admin.email, E2E_USERS.admin.password);
  // «Aziende trovate» è lo stesso conteggio dell'elenco delle aziende (uniche, senza duplicati uniti né escluse)
  const kpi = page
    .getByRole('list', { name: 'Numeri principali' })
    .getByRole('listitem')
    .filter({ hasText: 'Aziende trovate' });
  await expect(kpi.locator('.kpi__value')).toHaveText(/^[\d.]+$/);
  const shown = Number((await kpi.locator('.kpi__value').textContent())!.replace(/\./g, ''));
  const api = await page.request.get('/api/businesses?pageSize=1');
  expect(shown).toBe((await api.json()).total);
  await kpi.getByRole('link').click();
  await expect(page.getByRole('heading', { level: 1, name: 'Trova aziende' })).toBeVisible();
  await page.goBack();
  await expectAccessible(page, 'dashboard con dati');
});

test.describe('mobile @mobile', () => {
  test('ricerca e database utilizzabili su telefono @mobile', async ({ page }) => {
    const errors = trackErrors(page);
    await login(page, E2E_USERS.admin.email, E2E_USERS.admin.password);
    await expectHome(page);
    for (const path of ['/scoperta', '/aziende', '/aziende/duplicati']) {
      await page.goto(path);
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      expect(overflow, path).toBeLessThanOrEqual(0);
    }
    await expectAccessible(page, 'duplicati (mobile)');
    expect(errors).toEqual([]);
  });
});
