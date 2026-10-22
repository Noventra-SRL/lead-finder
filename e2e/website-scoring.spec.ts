import { expect, test, type Page } from '@playwright/test';
import { expectAccessible, signInAsAdmin, trackErrors, expectHome } from './helpers.ts';
import { E2E_AUDIT_BUSINESSES, E2E_USERS } from './users.ts';

/*
 * Fase 4 sul programma reale. Parte dagli audit dei siti finti eseguiti da website-audit.spec.ts: i punteggi sono
 * stati calcolati in automatico dopo ogni audit (e dopo ogni ricerca). Nessun punteggio è inserito a mano.
 */

test.describe.configure({ mode: 'serial' });

async function openLead(page: Page, name: string) {
  await signInAsAdmin(page, E2E_USERS.admin.email, E2E_USERS.admin.password);
  await expectHome(page);
  await page.goto(`/aziende?q=${encodeURIComponent(name)}`);
  await page.getByRole('link', { name }).click();
  await expect(page.getByRole('heading', { level: 1, name })).toBeVisible();
}

test('elenco dei lead: punteggio, fascia, affidabilità e prossimo passo calcolati dopo gli audit', async ({ page }) => {
  const errors = trackErrors(page);
  await signInAsAdmin(page, E2E_USERS.admin.email, E2E_USERS.admin.password);
  await expectHome(page);
  await page.goto('/aziende?q=audit%20di%20prova&sort=score&dir=desc');
  await expect(page.getByText('3 aziende')).toBeVisible();
  const rows = page.getByRole('table').getByRole('row');
  // il ristorante datato è il primo per punteggio, con fascia e affidabilità
  const first = rows.nth(1);
  await expect(first).toContainText(E2E_AUDIT_BUSINESSES.poor);
  await expect(first.locator('td[data-label="Punteggio a regole"]')).toContainText(/^\d+Priorità (A|B|C|bassa)/);
  await expect(first).toContainText(/affidabilità (alta|media|bassa)/);
  // il sito irraggiungibile non ha un punteggio inventato
  const down = rows.filter({ hasText: E2E_AUDIT_BUSINESSES.down });
  await expect(down).toContainText('Dati insufficienti');
  await expect(down).toContainText('Ripeti l’audit più tardi');
  await expect(page.getByText('non una probabilità di acquisto')).toBeVisible();
  await expectAccessible(page, 'elenco con punteggi');

  // filtri: priorità e affidabilità
  await page.getByLabel('Priorità', { exact: true }).selectOption({ label: 'Dati insufficienti' });
  await expect(page).toHaveURL(/priority=insufficient_data/);
  await expect(rows.filter({ hasText: E2E_AUDIT_BUSINESSES.down })).toHaveCount(1);
  await expect(rows.filter({ hasText: E2E_AUDIT_BUSINESSES.poor })).toHaveCount(0);
  await page.getByLabel('Priorità', { exact: true }).selectOption({ label: 'Qualsiasi' });
  await page.getByLabel('Affidabilità delle prove').selectOption({ label: 'Alta o media' });
  await expect(rows.filter({ hasText: E2E_AUDIT_BUSINESSES.poor })).toHaveCount(1);
  expect(errors).toEqual([]);
});

test('scheda: spiegazione, dimensioni, fatti distinti dalle deduzioni, prove collegate all’audit, ricalcolo', async ({
  page,
}) => {
  const errors = trackErrors(page);
  await openLead(page, E2E_AUDIT_BUSINESSES.poor);
  const panel = page.getByRole('region', { name: 'Punteggio del lead' });
  await expect(panel.getByText(/^Priorità (A|B|C|bassa): sito ufficiale raggiungibile con \d+ problem/)).toBeVisible();
  await expect(panel.getByText('Prossimo passo.')).toBeVisible();
  const dims = panel.getByRole('table');
  for (const d of [
    'Problemi tecnici del sito',
    'Capacità digitali mancanti',
    'Opportunità di settore',
    'Qualità delle prove',
    'Indicatori commerciali',
  ])
    await expect(dims.getByRole('rowheader', { name: d })).toBeVisible();
  await expect(panel.getByText('Fatto', { exact: true }).first()).toBeVisible();
  await expect(panel.getByText('Deduzione', { exact: true }).first()).toBeVisible();
  // il menù non è nella pagina del ristorante di prova: "non rilevato", mai "assente"
  await expect(panel.getByText(/Menù consultabile: non rilevato nelle pagine esaminate/)).toBeVisible();
  // lo stesso rilievo compare come segnale, tra i problemi principali e come prova di un servizio
  await expect(panel.getByText('Pagina non configurata per i dispositivi mobili').first()).toBeVisible();
  await expect(panel.getByText(/algoritmo v1, configurazione v1/)).toBeVisible();
  await expectAccessible(page, 'scheda con punteggio');

  await panel.getByRole('link', { name: 'apri l’audit' }).first().click();
  await expect(page.getByRole('region', { name: 'Rilievi' })).toBeVisible();
  await page.goBack();
  await panel.getByRole('button', { name: 'Ricalcola il punteggio' }).click();
  await expect(panel.getByRole('list', { name: 'Storico dei punteggi' }).getByRole('listitem')).toHaveCount(2);
  expect(errors).toEqual([]);
});

test('azienda senza sito indicato: nessun punteggio, assenza del sito dichiarata come non verificata', async ({
  page,
}) => {
  const errors = trackErrors(page);
  await signInAsAdmin(page, E2E_USERS.admin.email, E2E_USERS.admin.password);
  await expectHome(page);
  await page.goto('/aziende?website=no&q=di%20prova');
  await page.getByRole('table').getByRole('row').nth(1).getByRole('link').first().click();
  const panel = page.getByRole('region', { name: 'Punteggio del lead' });
  // calcolato dopo la ricerca, oppure calcolabile qui: in entrambi i casi mai un numero
  if (await panel.getByRole('button', { name: 'Calcola il punteggio' }).isVisible())
    await panel.getByRole('button', { name: 'Calcola il punteggio' }).click();
  await expect(panel.getByText('Dati insufficienti', { exact: true })).toBeVisible();
  await expect(panel.getByText(/l’assenza di un sito non è verificata/)).toBeVisible();
  await expect(panel.getByLabel('Nessun punteggio')).toHaveText('—');
  expect(errors).toEqual([]);
});

test('configurazione (amministratore): validazione, nuova versione, ricalcolo di tutti i punteggi', async ({
  page,
}) => {
  const errors = trackErrors(page);
  await signInAsAdmin(page, E2E_USERS.admin.email, E2E_USERS.admin.password);
  await expectHome(page);
  await page.goto('/impostazioni');
  const section = page.getByRole('region', { name: 'Punteggio dei lead' });
  await expect(section.getByText(/Versione attiva v1/)).toBeVisible();
  await expectAccessible(page, 'configurazione del punteggio');
  // fasce non decrescenti: rifiutate dal server con il motivo
  await section.getByLabel('Priorità B da').fill('85');
  await section.getByRole('button', { name: 'Verifica' }).click();
  await expect(section.getByText('Le soglie devono essere decrescenti: A > B > C.')).toBeVisible();
  await section.getByLabel('Priorità B da').fill('60');
  await section.getByLabel('Problemi tecnici del sito').fill('40');
  await section.getByLabel('Nota sulla modifica (facoltativa)').fill('Più peso ai problemi tecnici (prova e2e)');
  await section.getByRole('button', { name: 'Salva come nuova versione' }).click();
  await expect(section.getByText(/Versione attiva v2/)).toBeVisible();
  await expect(section.getByText(/su una configurazione precedente/)).toBeVisible();
  await section.getByRole('button', { name: 'Ricalcola tutti i punteggi' }).click();
  await expect(section.getByText(/Punteggi aggiornati: \d+ ricalcolati/)).toBeVisible({ timeout: 30_000 });
  await expect(section.getByText(/su una configurazione precedente/)).toHaveCount(0);
  expect(errors).toEqual([]);
});

test.describe('mobile @mobile', () => {
  test('scheda con punteggio leggibile su telefono @mobile', async ({ page }) => {
    const errors = trackErrors(page);
    await openLead(page, E2E_AUDIT_BUSINESSES.poor);
    await expect(page.getByRole('region', { name: 'Punteggio del lead' })).toBeVisible();
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
    await expectAccessible(page, 'punteggio su telefono');
    expect(errors).toEqual([]);
  });
});
