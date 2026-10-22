import { expect, test, type Page } from '@playwright/test';
import { expectAccessible, signInAsAdmin, trackErrors, expectHome, navLink } from './helpers.ts';
import { E2E_USERS } from './users.ts';

/*
 * Fase 7 sul programma reale: dal database lead al CRM, pipeline, scheda dell'opportunità, follow-up.
 * Usa le aziende "di Prova" salvate da discovery.spec.ts (server Overpass finto): nessun dato inserito a mano.
 */

test.describe.configure({ mode: 'serial' });

const HOTEL = 'Hotel di Prova Albano Laziale';
const TRATTORIA = 'Trattoria di Prova Albano Laziale';

async function signIn(page: Page) {
  await signInAsAdmin(page, E2E_USERS.admin.email, E2E_USERS.admin.password);
  await expectHome(page);
}

const tomorrow = () => {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  return d.toLocaleDateString('en-CA', { timeZone: 'Europe/Rome' });
};

test('CRM vuoto: spiega da dove nascono le opportunità', async ({ page }) => {
  const errors = trackErrors(page);
  await signIn(page);
  await navLink(page, 'Trattative').click();
  await expect(page.getByRole('heading', { level: 1, name: 'Trattative' })).toBeVisible();
  await expect(page.getByText('Nessuna opportunità ancora')).toBeVisible();
  await expectAccessible(page, 'crm vuoto');
  expect(errors).toEqual([]);
});

test('aggiunta in blocco dal database lead, senza doppioni, con riepilogo', async ({ page }) => {
  const errors = trackErrors(page);
  await signIn(page);
  await page.goto('/aziende?q=di%20prova%20albano');
  await page.getByRole('checkbox', { name: `Seleziona ${HOTEL}` }).check();
  await page.getByRole('checkbox', { name: `Seleziona ${TRATTORIA}` }).check();
  await page.getByRole('button', { name: 'Aggiungi al CRM' }).click();
  await expect(page.getByRole('status').filter({ hasText: '2 aggiunte al CRM.' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Nel CRM: Da qualificare' })).toHaveCount(2);
  // di nuovo le stesse: nessun doppione
  await page.getByRole('checkbox', { name: `Seleziona ${HOTEL}` }).check();
  await page.getByRole('button', { name: 'Aggiungi al CRM' }).click();
  await expect(
    page.getByRole('status').filter({ hasText: '0 aggiunte al CRM, 1 già con un’opportunità aperta.' }),
  ).toBeVisible();
  // filtro: aziende non ancora nel CRM
  await page.getByLabel('CRM', { exact: true }).selectOption({ label: 'Non ancora nel CRM' });
  await expect(page.getByRole('row').filter({ hasText: HOTEL })).toHaveCount(0);
  await expectAccessible(page, 'database lead con CRM');
  expect(errors).toEqual([]);
});

test('pipeline: numeri dal database, Kanban, spostamento esplicito di fase', async ({ page }) => {
  const errors = trackErrors(page);
  await signIn(page);
  await navLink(page, 'Trattative').click();
  await expect(page.getByRole('heading', { level: 1, name: 'Trattative' })).toBeVisible();
  const metrics = page.locator('.crm-metrics');
  await expect(metrics.locator('.crm-metric').filter({ hasText: 'Opportunità aperte' })).toContainText('2');
  const board = page.getByRole('list', { name: 'Pipeline per fase' });
  const toQualify = board.getByRole('listitem', { name: 'Da qualificare: 2' });
  await expect(toQualify.getByRole('article')).toHaveCount(2);
  await toQualify.getByLabel(`Sposta in: ${TRATTORIA}`).selectOption({ label: 'Da contattare' });
  await expect(
    board.getByRole('listitem', { name: 'Da contattare: 1' }).getByRole('article', { name: TRATTORIA }),
  ).toBeVisible();
  await expect(metrics.locator('.crm-metric').filter({ hasText: 'Pronte da contattare' })).toContainText('1');
  // le fasi di chiusura chiedono conferma
  await board.getByLabel(`Sposta in: ${HOTEL}`).selectOption({ label: 'Vinto' });
  await expect(page.getByRole('dialog', { name: 'Chiudere come «Vinto»?' })).toBeVisible();
  await page.getByRole('dialog').getByRole('button', { name: 'Annulla' }).click();
  await expect(board.getByRole('listitem', { name: 'Da qualificare: 1' })).toBeVisible();
  await expectAccessible(page, 'pipeline crm');
  expect(errors).toEqual([]);
});

test('scheda dell’opportunità: dati commerciali, follow-up, attività, chiusura come persa', async ({ page }) => {
  const errors = trackErrors(page);
  await signIn(page);
  await page.goto('/pipeline');
  await page.getByRole('link', { name: HOTEL }).click();
  await expect(page.getByRole('heading', { level: 1, name: HOTEL })).toBeVisible();
  // dati dell'azienda riusati, non copiati
  await expect(page.getByRole('link', { name: 'Scheda completa dell’azienda' })).toBeVisible();

  const commercial = page.getByRole('form', { name: 'Dati commerciali' });
  await commercial.getByLabel('Priorità commerciale').selectOption({ label: 'Alta' });
  await commercial.getByLabel('Valore stimato (€)').fill('1500,50');
  await commercial.getByLabel('Note interne').fill('Titolare disponibile al mattino');
  await commercial.getByRole('button', { name: 'Salva i dati commerciali' }).click();
  await expect(page.getByLabel('Valore stimato (€)')).toHaveValue('1500.5');

  const followUp = page.getByRole('form', { name: 'Nuovo follow-up' });
  await followUp.getByLabel('Azione').fill('Richiamare per fissare una call');
  await followUp.getByLabel('Scadenza').fill(tomorrow());
  await followUp.getByRole('button', { name: 'Aggiungi il follow-up' }).click();
  await expect(page.getByText('Richiamare per fissare una call')).toBeVisible();

  await page.getByText('Registra un’attività').click();
  const activity = page.getByRole('form', { name: 'Nuova attività' });
  await activity.getByLabel('Tipo').selectOption({ label: 'Telefonata' });
  await activity.getByLabel('Sintesi').fill('Prima telefonata con il titolare');
  await activity.getByRole('button', { name: 'Registra' }).click();
  const timeline = page.getByRole('list', { name: 'Attività' });
  await expect(timeline.getByText('Prima telefonata con il titolare')).toBeVisible();
  await expectAccessible(page, 'scheda opportunità');

  // follow-up nella vista dei prossimi
  await page.goto('/pipeline/follow-up?view=upcoming');
  await expect(page.getByText('Richiamare per fissare una call')).toBeVisible();
  await expectAccessible(page, 'follow-up');
  await page.getByRole('link', { name: HOTEL }).click();

  // chiusura come persa: il motivo è obbligatorio, il follow-up viene annullato
  await page.getByLabel('Fase della pipeline').selectOption({ label: 'Perso' });
  const dialog = page.getByRole('dialog', { name: 'Chiudere come «Perso»?' });
  await expect(dialog.getByRole('button', { name: 'Conferma' })).toBeDisabled();
  await dialog.getByLabel('Motivo (obbligatorio)').fill('Ha appena rifatto il sito con un altro fornitore');
  await dialog.getByRole('button', { name: 'Conferma' }).click();
  await expect(timeline.getByText('Da qualificare → Perso')).toBeVisible();
  await expect(page.getByText('Ha appena rifatto il sito con un altro fornitore').first()).toBeVisible();
  await expect(page.getByText('Opportunità chiusa.')).toBeVisible();
  expect(errors).toEqual([]);
});

test('scheda dell’azienda: apre l’opportunità aperta invece di crearne un’altra', async ({ page }) => {
  const errors = trackErrors(page);
  await signIn(page);
  await page.goto('/aziende?q=trattoria%20di%20prova%20albano');
  await page.getByRole('link', { name: TRATTORIA, exact: true }).click();
  await expect(page.getByText('Nel CRM:')).toContainText('Da contattare');
  await page.getByRole('link', { name: 'Apri l’opportunità' }).click();
  await expect(page.getByRole('heading', { level: 1, name: TRATTORIA })).toBeVisible();
  expect(errors).toEqual([]);
});

test.describe('mobile @mobile', () => {
  test('pipeline utilizzabile su telefono @mobile', async ({ page }) => {
    const errors = trackErrors(page);
    await signIn(page);
    await page.goto('/pipeline');
    await expect(page.getByRole('heading', { level: 1, name: 'Trattative' })).toBeVisible();
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
    await expectAccessible(page, 'pipeline (telefono)');
    expect(errors).toEqual([]);
  });
});
