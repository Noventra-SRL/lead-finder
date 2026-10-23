import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { expectAccessible, signInAsAdmin, trackErrors, expectHome, openAdvanced, openSections } from './helpers.ts';
import { E2E_USERS } from './users.ts';

/*
 * Fase 8 sul programma reale: follow-up dalla scheda azienda (con conferma per il CRM), filtri dei follow-up,
 * filtri salvati, promemoria nell'applicazione, esportazioni CSV ed Excel, report commerciali.
 * Usa le aziende "di Prova" della scoperta e le opportunità create da workflow-crm.spec.ts.
 */

test.describe.configure({ mode: 'serial' });

const BAR = 'Bar di Prova Albano Laziale';
const ACTION = 'Proporre il nuovo sito con prenotazioni';

async function signIn(page: Page) {
  await signInAsAdmin(page, E2E_USERS.admin.email, E2E_USERS.admin.password);
  await expectHome(page);
}

const inDays = (n: number) => {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return d.toLocaleDateString('en-CA', { timeZone: 'Europe/Rome' });
};

test('follow-up dalla scheda azienda: conferma prima di aggiungerla al CRM', async ({ page }) => {
  const errors = trackErrors(page);
  await signIn(page);
  await page.goto('/aziende?q=bar%20di%20prova%20albano');
  await page.getByRole('link', { name: BAR, exact: true }).click();
  await expect(page.getByRole('heading', { level: 1, name: BAR })).toBeVisible();
  await openSections(page);
  await page.locator('summary', { hasText: 'Pianifica un follow-up' }).click();
  const form = page.getByRole('form', { name: 'Nuovo follow-up' });
  await form.getByLabel('Azione').fill(ACTION);
  await form.getByLabel('Scadenza').fill(inDays(1));
  await form.getByLabel('Priorità del follow-up').selectOption({ label: 'Alta' });
  await form.getByRole('button', { name: 'Aggiungi il follow-up' }).click();

  // nessun follow-up senza opportunità: si chiede conferma, annullando non succede nulla
  const dialog = page.getByRole('dialog', { name: 'Aggiungere l’azienda al CRM?' });
  await expect(dialog).toBeVisible();
  await expectAccessible(page, 'conferma follow-up');
  await dialog.getByRole('button', { name: 'Annulla' }).click();
  await expect(page.getByText('Follow-up salvato')).toHaveCount(0);
  await form.getByRole('button', { name: 'Aggiungi il follow-up' }).click();
  await dialog.getByRole('button', { name: 'Aggiungi e salva il follow-up' }).click();
  await expect(page.getByText('Follow-up salvato e azienda aggiunta al CRM in «Da qualificare»')).toBeVisible();
  await expect(page.getByText('Nel CRM:')).toContainText('Da qualificare');
  expect(errors).toEqual([]);
});

test('follow-up: filtri per priorità e scadenza, spostamento, esportazione CSV', async ({ page }) => {
  const errors = trackErrors(page);
  await signIn(page);
  await page.goto('/pipeline/follow-up');
  await page.getByLabel('Priorità', { exact: true }).selectOption({ label: 'Alta' });
  await expect(page.getByText(ACTION)).toBeVisible();
  await expect(page.getByText('Priorità alta')).toBeVisible();
  await page.getByRole('link', { name: 'Prossimi 7 giorni' }).click();
  await expect(page).toHaveURL(/due=soon/);
  await expect(page).toHaveURL(/priority=alta/);
  await expect(page.getByText(ACTION)).toBeVisible();
  await expectAccessible(page, 'follow-up filtrati');

  // spostare la scadenza: oltre i 7 giorni esce da "prossimi 7 giorni"
  await page.getByRole('button', { name: 'Sposta' }).click();
  await page.getByLabel('Nuova scadenza').fill(inDays(12));
  await page.getByRole('button', { name: 'Salva', exact: true }).click();
  await expect(page.getByText('Nessun follow-up con questi filtri')).toBeVisible();
  await page.getByRole('link', { name: 'Più avanti' }).click();
  await expect(page.getByText(ACTION)).toBeVisible();

  // esportazione: le colonne scelte, intestazioni italiane, i filtri della pagina
  await page.getByRole('button', { name: 'Esporta', exact: true }).click();
  const exportDialog = page.getByRole('dialog', { name: 'Esporta' });
  await expect(exportDialog.getByText('Tutte le 1 righe dei filtri attuali')).toBeVisible();
  await expectAccessible(page, 'dialogo di esportazione');
  await exportDialog.getByRole('checkbox', { name: 'Ora' }).uncheck();
  const [file] = await Promise.all([
    page.waitForEvent('download'),
    exportDialog.getByRole('button', { name: 'Scarica CSV' }).click(),
  ]);
  expect(file.suggestedFilename()).toMatch(/^follow_up_noventra_\d{4}-\d{2}-\d{2}\.csv$/);
  const csv = readFileSync((await file.path())!, 'utf8');
  const lines = csv.slice(1).trim().split('\r\n');
  expect(lines[0]).toMatch(
    /^Titolo;Descrizione;Azienda;Comune;Fase dell’opportunità;Responsabile;Priorità;Stato;Scadenza;/,
  );
  expect(lines[0]).not.toContain(';Ora;');
  expect(lines).toHaveLength(2);
  expect(lines[1]).toContain(ACTION);
  expect(lines[1]).toContain(';Alta;Da fare;');
  await expect(page.getByRole('status').filter({ hasText: 'Esportata 1 riga.' })).toBeVisible();
  expect(errors).toEqual([]);
});

test('filtri salvati: salvare, riaprire con il conteggio, rinominare, eliminare con conferma', async ({ page }) => {
  const errors = trackErrors(page);
  await signIn(page);
  await page.goto('/pipeline/follow-up?priority=alta');
  const saved = page.getByRole('group', { name: 'Filtri salvati' });
  await saved.getByRole('button', { name: 'Salva filtri' }).click();
  const dialog = page.getByRole('dialog', { name: 'Salva i filtri attuali' });
  await dialog.getByLabel('Nome').fill('Priorità alta');
  await dialog.getByRole('button', { name: 'Salva', exact: true }).click();
  await expect(saved.getByRole('link', { name: /Priorità alta/ })).toContainText('1');
  // gli stessi criteri non si salvano due volte
  await expect(saved.getByRole('button', { name: 'Salva filtri' })).toBeDisabled();

  await page.goto('/pipeline/follow-up');
  await saved.getByRole('link', { name: /Priorità alta/ }).click();
  await expect(page).toHaveURL(/priority=alta/);
  await expect(page.getByText(ACTION)).toBeVisible();

  await page.goto('/pipeline/follow-up');
  await saved.getByRole('button', { name: 'Gestisci' }).click();
  await saved.getByRole('button', { name: 'Rinomina' }).click();
  const rename = page.getByRole('dialog', { name: 'Rinomina il filtro' });
  await rename.getByLabel('Nuovo nome').fill('Follow-up urgenti');
  await rename.getByRole('button', { name: 'Rinomina' }).click();
  await expect(saved.getByRole('link', { name: /Follow-up urgenti/ })).toBeVisible();
  await saved.getByRole('button', { name: 'Elimina' }).click();
  const del = page.getByRole('dialog', { name: 'Eliminare il filtro?' });
  await expectAccessible(page, 'eliminazione filtro');
  await del.getByRole('button', { name: 'Elimina' }).click();
  await expect(saved.getByText('Nessuno per ora.')).toBeVisible();
  expect(errors).toEqual([]);
});

test('promemoria: follow-up in scadenza nell’applicazione, segnati come letti', async ({ page }) => {
  const errors = trackErrors(page);
  await signIn(page);
  // riporta il follow-up a domani: diventa "in scadenza"
  await page.goto('/pipeline/follow-up?due=later');
  await page.getByRole('button', { name: 'Sposta' }).click();
  await page.getByLabel('Nuova scadenza').fill(inDays(1));
  await page.getByRole('button', { name: 'Salva', exact: true }).click();
  await expect(page.getByText('Nessun follow-up con questi filtri')).toBeVisible();

  await page
    .getByRole('link', { name: /^Promemoria/ })
    .first()
    .click();
  await expect(page.getByRole('heading', { level: 1, name: 'Promemoria' })).toBeVisible();
  const item = page.getByRole('listitem').filter({ hasText: ACTION });
  await expect(item).toContainText('In scadenza');
  await expect(item.getByRole('link', { name: BAR })).toBeVisible();
  await expectAccessible(page, 'promemoria');
  // riaprire la pagina non duplica il promemoria
  await page.reload();
  await expect(page.getByRole('listitem').filter({ hasText: ACTION })).toHaveCount(1);
  await item.getByRole('button', { name: 'Segna come letto' }).click();
  await expect(item.getByRole('button', { name: 'Segna come letto' })).toHaveCount(0);
  await expect(page.getByText('0 da leggere')).toBeVisible();
  expect(errors).toEqual([]);
});

test('report commerciali: numeri dal database, definizioni, periodi, esportazione Excel', async ({ page }) => {
  const errors = trackErrors(page);
  await signIn(page);
  await openAdvanced(page, 'Risultati e report');
  await page.getByRole('link', { name: 'Tutto il periodo' }).click();
  await expect(page).toHaveURL(/period=all/);
  // l'opportunità persa in workflow-crm.spec.ts: 0 vinte su 1 chiusa
  await expect(page.getByText('Vinte ÷ (vinte + perse) nel periodo')).toBeVisible();
  await expect(page.getByText('Tasso di vittoria nel periodo: 0% (0 vinte su 1 chiuse).')).toBeVisible();
  await expect(page.getByText(/Servono almeno 3 opportunità vinte o perse/)).toBeVisible();
  await expect(page.getByRole('img', { name: /^Aziende censite: \d+ nel periodo/ })).toBeVisible();
  await page.getByText('Mostra i dati in tabella').click();
  await expect(page.getByRole('columnheader', { name: 'Aziende censite' })).toBeVisible();
  await expectAccessible(page, 'report');

  await page.getByRole('button', { name: 'Opportunità', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Opportunità' });
  await dialog.getByText('Excel (.xlsx)').click();
  await dialog.getByText(/Raggruppa per fase/).click();
  const [file] = await Promise.all([
    page.waitForEvent('download'),
    dialog.getByRole('button', { name: 'Scarica Excel' }).click(),
  ]);
  expect(file.suggestedFilename()).toMatch(/^opportunita_noventra_\d{4}-\d{2}-\d{2}\.xlsx$/);
  const xlsx = readFileSync((await file.path())!);
  expect(xlsx.subarray(0, 2).toString()).toBe('PK');
  // un foglio per fase con opportunità (tra cui «Perso» e «Da qualificare»)
  expect(xlsx.toString('latin1')).toContain('name="Perso"');
  expect(xlsx.toString('latin1')).toContain('name="Da qualificare"');
  expect(errors).toEqual([]);
});

test('report e promemoria su telefono @mobile', async ({ page }) => {
  const errors = trackErrors(page);
  await signIn(page);
  await page.goto('/report?period=all');
  await expect(page.getByRole('heading', { level: 1, name: 'Risultati e report' })).toBeVisible();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(0);
  await expectAccessible(page, 'report mobile');
  await page.goto('/promemoria');
  await expect(page.getByRole('heading', { level: 1, name: 'Promemoria' })).toBeVisible();
  expect(errors).toEqual([]);
});
