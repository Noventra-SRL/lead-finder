import { expect, test } from '@playwright/test';
import { expectAccessible, expectHome, signInAsAdmin, trackErrors } from './helpers.ts';
import { E2E_AUDIT_BUSINESSES, E2E_USERS } from './users.ts';

/*
 * «Modifica» della scheda azienda sul programma reale: campi compilati con i dati attuali, errori per campo,
 * salvataggio confermato dal server, dati che restano dopo la riapertura, «Annulla» con avviso, errore del server
 * con il modulo intatto. Gira per ultima: modifica l'ottica di prova dell'audit (sito non raggiungibile), non più usata dopo.
 */

const NAME = E2E_AUDIT_BUSINESSES.down;
const NEW_NAME = `${E2E_AUDIT_BUSINESSES.down} — Centro`;

test('Modifica: campi attuali, validazione, salvataggio, riapertura, annulla, errore del server', async ({ page }) => {
  const errors = trackErrors(page);
  await signInAsAdmin(page, E2E_USERS.admin.email, E2E_USERS.admin.password);
  await expectHome(page);
  await page.goto(`/trova?q=${encodeURIComponent(NAME)}`);
  await page.getByRole('link', { name: `Dettagli di ${NAME}` }).click();
  await expect(page.getByRole('heading', { level: 1, name: NAME })).toBeVisible();

  // vista in sola lettura predefinita; «Modifica» apre il modulo con i dati attuali
  await page.getByRole('button', { name: 'Modifica' }).click();
  const form = page.getByRole('form', { name: 'Modifica azienda' });
  await expect(form.getByLabel('Nome', { exact: true })).toHaveValue(NAME);
  for (const group of ['Dati aziendali', 'Contatti', 'Indirizzo', 'Informazioni commerciali', 'Note e CRM'])
    await expect(form.getByRole('group', { name: group })).toBeVisible();
  await expectAccessible(page, 'modifica della scheda');

  // errori per campo: il modulo resta com'è
  await form.getByLabel('Email', { exact: true }).fill('non-una-email');
  await form.getByLabel('Sito web').fill('ftp://sito');
  await form.getByRole('button', { name: 'Salva modifiche' }).click();
  await expect(form.getByText(/Indirizzo email non valido/)).toBeVisible();
  await expect(form.getByText(/Indirizzo web non valido/)).toBeVisible();
  await expect(form.getByLabel('Email', { exact: true })).toHaveValue('non-una-email');

  // errore del server (simulato): nessun messaggio di successo, i valori restano
  await form.getByLabel('Email', { exact: true }).fill('info@ottica-prova.example.it');
  await form.getByLabel('Sito web').fill('www.ottica-prova.example.it');
  await page.route('**/api/businesses/*', (route) =>
    route.request().method() === 'PATCH'
      ? route.fulfill({
          status: 503,
          contentType: 'application/json',
          body: JSON.stringify({ error: { code: 'UNAVAILABLE', message: 'Servizio non disponibile, riprova.' } }),
        })
      : route.continue(),
  );
  await form.getByRole('button', { name: 'Salva modifiche' }).click();
  await expect(form.getByText('Servizio non disponibile, riprova.')).toBeVisible();
  await expect(form.getByLabel('Email', { exact: true })).toHaveValue('info@ottica-prova.example.it');
  await expect(page.getByText('Modifiche salvate.')).toHaveCount(0);
  await page.unroute('**/api/businesses/*');

  // salvataggio vero
  await form.getByLabel('Nome', { exact: true }).fill(NEW_NAME);
  await form.getByLabel('Fax', { exact: true }).fill('06 1234 5678');
  await form.getByLabel('Via', { exact: true }).fill('Corso Matteotti');
  await form.getByLabel('Civico').fill('12');
  await form.getByLabel('Referente', { exact: true }).fill('Titolare di prova');
  await form.getByLabel('Note', { exact: true }).fill('Preferisce il contatto via email.');
  await form.getByRole('button', { name: 'Salva modifiche' }).click();
  await expect(page.getByText('Modifiche salvate.')).toBeVisible();
  await expect(page.getByRole('heading', { level: 1, name: NEW_NAME })).toBeVisible();
  const contacts = page.getByRole('region', { name: 'Contatti' });
  await expect(contacts.getByRole('link', { name: 'info@ottica-prova.example.it' })).toBeVisible();
  await expect(contacts.getByText(/inserita a mano/)).toBeVisible();
  await expect(page.getByRole('region', { name: 'Note e referente' })).toContainText(
    'Preferisce il contatto via email.',
  );

  // riaperta: i dati restano
  await page.reload();
  await expect(page.getByRole('heading', { level: 1, name: NEW_NAME })).toBeVisible();
  await page.getByRole('button', { name: 'Modifica' }).click();
  await expect(form.getByLabel('Via', { exact: true })).toHaveValue('Corso Matteotti');
  await expect(form.getByLabel('Referente', { exact: true })).toHaveValue('Titolare di prova');

  // «Annulla» con modifiche: avviso, poi nessun cambiamento
  await form.getByLabel('Note', { exact: true }).fill('Nota da scartare');
  await form.getByRole('button', { name: 'Annulla' }).click();
  const discard = page.getByRole('dialog', { name: 'Scartare le modifiche?' });
  await discard.getByRole('button', { name: 'Scarta le modifiche' }).click();
  await expect(form).toHaveCount(0);
  await expect(page.getByRole('region', { name: 'Note e referente' })).toContainText(
    'Preferisce il contatto via email.',
  );
  await expect(page.getByText('Nota da scartare')).toHaveCount(0);
  // solo gli errori provocati di proposito: validazione (400) ed errore simulato del server (503)
  expect(
    errors.filter(
      (e) =>
        !e.includes(' 400 ') && !e.includes('status of 400') && !e.includes(' 503 ') && !e.includes('status of 503'),
    ),
  ).toEqual([]);
});

test('Impostazioni → Invio email: verifica senza invio e email di prova con conferma (server SMTP finto)', async ({
  page,
}) => {
  const errors = trackErrors(page);
  await signInAsAdmin(page, E2E_USERS.admin.email, E2E_USERS.admin.password);
  await expectHome(page);
  await page.goto('/impostazioni');
  const section = page.getByRole('region', { name: 'Invio email' });
  await expect(section.getByText(/Noventra <staff@noventra\.it>/)).toBeVisible();
  // nessuna credenziale nella pagina
  await expect(section).not.toContainText(/password|SMTP_PASS=\S/i);

  await section.getByRole('button', { name: 'Verifica connessione' }).click();
  await expect(section.getByText('Connessione verificata', { exact: true })).toBeVisible();

  await section.getByLabel('Indirizzo per la prova').fill('prova@noventra-prova.example.it');
  await section.getByRole('button', { name: 'Invia email di prova' }).click();
  const dialog = page.getByRole('dialog', { name: 'Inviare l’email di prova?' });
  await expect(dialog).toContainText('prova@noventra-prova.example.it');
  await dialog.getByRole('button', { name: 'Invia la prova' }).click();
  await expect(section.getByText('Invio di prova riuscito', { exact: true })).toBeVisible();
  await expect(section.getByText(/La consegna nella casella non è confermata/).first()).toBeVisible();
  await expectAccessible(page, 'invio email');
  expect(errors).toEqual([]);
});
