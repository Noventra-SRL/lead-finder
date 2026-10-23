import { expect, test, type Page } from '@playwright/test';
import { expectAccessible, expectHome, signInAsAdmin, trackErrors, openSections } from './helpers.ts';
import { E2E_AUDIT_BUSINESSES, E2E_SITE_EMAIL, E2E_USERS } from './users.ts';

/*
 * Google Maps ed email dai siti sul programma reale: ricerca di una categoria con la fonte Google (server Places
 * FINTO, nessuna richiesta a Google), avanzamento e risultati; email pubblicate trovate sul sito finto della farmacia
 * di prova (verificato da website-audit.spec.ts), filtri di contattabilità, priorità, scheda con la provenienza;
 * nuovo tentativo sui siti non accessibili. Gira per ultimo (la ricerca aggiunge aziende).
 */

test.describe.configure({ mode: 'serial' });

async function signIn(page: Page) {
  await signInAsAdmin(page, E2E_USERS.admin.email, E2E_USERS.admin.password);
  await expectHome(page);
}

test('«Cerca nuove farmacie» con Google Maps: fonte scelta, avanzamento reale, risultati nella categoria', async ({
  page,
}) => {
  const errors = trackErrors(page);
  await signIn(page);
  await page.goto('/trova?categoria=farmacie');
  await page.locator('.cathead').getByRole('button', { name: 'Cerca nuove farmacie' }).click();
  const dialog = page.getByRole('dialog', { name: 'Cerca nuove farmacie' });
  await dialog.getByLabel('Fonte').selectOption({ label: 'Google Maps (Places API)' });
  await expect(dialog.getByText(/non l’email: le email si cercano poi sui siti/)).toBeVisible();
  await dialog.getByLabel('Regione').selectOption({ label: 'Umbria' });
  await dialog.getByLabel('Provincia o città metropolitana').selectOption({ label: 'Terni (TR)' });
  await dialog.getByLabel('Comune').selectOption({ label: 'Narni' });
  await dialog.getByLabel('Quante aziende cercare').fill('10');
  await dialog.getByLabel('Verifica automatica dei siti trovati').uncheck();
  await expectAccessible(page, 'ricerca con Google');
  await dialog.getByRole('button', { name: 'Avvia la ricerca' }).click();

  await expect(page.getByRole('heading', { level: 1, name: /^Farmacie · 10 aziende · Narni/ })).toBeVisible();
  await expect(page.getByText(/^Fonte: Google Maps/)).toBeVisible();
  const state = page.getByRole('region', { name: 'Stato' });
  await expect(state.getByText(/^Completata/)).toBeVisible({ timeout: 60_000 });
  // il server finto restituisce 3 farmacie per comune: una è chiusa definitivamente e non viene salvata
  await expect(page.getByText(/Farmacie: 2 \(2 nuove, 0 già presenti\)/)).toBeVisible();
  await expect(page.getByText(/0 con email pubblica \(/)).toBeVisible();

  await page.goto('/trova?categoria=farmacie&q=di%20prova%20google%20narni');
  const row = page.getByRole('row').filter({ hasText: 'Farmacia di Prova Google Narni 1' });
  await expect(row).toContainText('Email non disponibile');
  await expect(row).toContainText('Senza sito web');
  await expect(row.getByRole('button', { name: /^Invia email a / })).toBeDisabled();
  expect(errors).toEqual([]);
});

test('email pubblicata sul sito: filtro, priorità, recapito con la sua provenienza', async ({ page }) => {
  const errors = trackErrors(page);
  await signIn(page);
  await page.goto('/trova');
  await expect(page.getByLabel('Ordina per')).toHaveValue('priority');
  await page.getByLabel('Email', { exact: true }).selectOption({ label: 'Con email pubblicata sul sito' });
  await expect(page).toHaveURL(/contattabilita=pubblicata/);
  const row = page.getByRole('row').filter({ hasText: E2E_AUDIT_BUSINESSES.good });
  await expect(row).toContainText(E2E_SITE_EMAIL);
  await expect(row).toContainText('Email pubblicata sul sito');
  await expect(row.getByRole('button', { name: `Invia email a ${E2E_AUDIT_BUSINESSES.good}` })).toBeEnabled();
  await expectAccessible(page, 'filtro email pubblicate');

  // scheda: indirizzi trovati con la pagina e la relazione con il sito; l'agenzia del sito non è il recapito
  await row.getByRole('link', { name: `Dettagli di ${E2E_AUDIT_BUSINESSES.good}` }).click();
  // in cima alla scheda: l'email, con la provenienza (scritta sul sito) e senza dichiararla verificata
  const contacts = page.getByRole('region', { name: 'Contatti' });
  await expect(contacts.getByRole('link', { name: E2E_SITE_EMAIL })).toHaveAttribute(
    'href',
    `mailto:${E2E_SITE_EMAIL}`,
  );
  await expect(contacts.getByText(/scritta sul sito .*non verificata/)).toBeVisible();
  await openSections(page);

  const found = page.getByRole('region', { name: 'Email trovate sul sito' });
  await expect(found.getByRole('listitem').filter({ hasText: E2E_SITE_EMAIL })).toContainText('casella gratuita');
  await expect(found.getByRole('listitem').filter({ hasText: 'info@agenzia-web-prova.example.it' })).toContainText(
    'altro dominio, non usato come recapito',
  );
  expect(errors).toEqual([]);
});

test('siti non accessibili: nuovo tentativo in sottofondo dalla pagina, con l’avanzamento', async ({ page }) => {
  const errors = trackErrors(page);
  await signIn(page);
  await page.goto('/trova?contattabilita=sito_non_accessibile');
  await expect(page.getByRole('row').filter({ hasText: E2E_AUDIT_BUSINESSES.down })).toContainText(
    'Sito non accessibile',
  );
  await page.getByRole('button', { name: 'Riprova i siti non accessibili' }).click();
  await expect(page.getByRole('status').filter({ hasText: /Controllo avviato: \d+ sit/ })).toBeVisible();
  await page.getByRole('link', { name: 'Segui l’avanzamento' }).click();
  await expect(page).toHaveURL(/\/audit\/verifiche\//);
  expect(errors).toEqual([]);
});
