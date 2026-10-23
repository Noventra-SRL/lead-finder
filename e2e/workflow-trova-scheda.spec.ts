import { expect, test } from '@playwright/test';
import { expectAccessible, expectHome, signInAsAdmin, trackErrors } from './helpers.ts';
import { E2E_AUDIT_BUSINESSES, E2E_SITE_EMAIL, E2E_USERS } from './users.ts';

/*
 * Scheda dell'azienda compatta: i contatti e le azioni in cima, senza scorrere; link mailto:/sito, «Copia» e «Copia
 * contatti» (letti dagli appunti reali del browser), campi mancanti dichiarati, azioni disattivate senza dati, sezioni
 * secondarie chiuse sotto. Usa la farmacia di prova con l'email trovata sul sito finto (website-audit.spec.ts).
 */

test('contatti in cima con link, copia, provenienza e campi mancanti; azioni; sezioni secondarie sotto', async ({
  page,
  context,
}) => {
  const errors = trackErrors(page);
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.setViewportSize({ width: 1280, height: 800 });
  await signInAsAdmin(page, E2E_USERS.admin.email, E2E_USERS.admin.password);
  await expectHome(page);
  await page.goto(`/trova?q=${encodeURIComponent(E2E_AUDIT_BUSINESSES.good)}`);
  await page.getByRole('link', { name: `Dettagli di ${E2E_AUDIT_BUSINESSES.good}` }).click();
  await expect(page.getByRole('heading', { level: 1, name: E2E_AUDIT_BUSINESSES.good })).toBeVisible();

  const contacts = page.getByRole('region', { name: 'Contatti' });
  const email = contacts.getByRole('link', { name: E2E_SITE_EMAIL });
  await expect(email).toHaveAttribute('href', `mailto:${E2E_SITE_EMAIL}`);
  // l'email e le azioni si vedono subito, senza scorrere
  await expect(email).toBeInViewport();
  await expect(page.getByRole('button', { name: 'Invia email' })).toBeInViewport();
  await expect(contacts.getByText(/scritta sul sito .*non verificata/)).toBeVisible();
  // campi mancanti: dichiarati, mai inventati
  await expect(contacts.getByText('Telefono non disponibile')).toBeVisible();
  await expect(contacts.getByText('Fax non indicato')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Chiama' })).toBeDisabled();
  const site = page.getByRole('link', { name: 'Apri sito web' });
  await expect(site).toHaveAttribute('target', '_blank');
  await expect(site).toHaveAttribute('rel', /noopener/);

  await contacts.getByRole('button', { name: 'Copia email' }).click();
  await expect(contacts.getByRole('button', { name: 'Copiato email' })).toBeVisible();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(E2E_SITE_EMAIL);
  await page.getByRole('button', { name: 'Copia contatti' }).click();
  const all = await page.evaluate(() => navigator.clipboard.readText());
  expect(all).toContain(`Email: ${E2E_SITE_EMAIL}`);
  expect(all).not.toContain('Telefono:');

  // le sezioni secondarie sono sotto i contatti, chiuse
  const sections = page.locator('details.biz-section');
  await expect(sections).toHaveCount(4);
  await expect(sections.locator(':scope > summary')).toHaveText([
    /^Valutazione commerciale/,
    /^Sito web/,
    /^Attività commerciali/,
    /^Informazioni azienda/,
  ]);
  for (const d of await sections.all()) await expect(d).not.toHaveAttribute('open');
  await sections
    .locator(':scope > summary')
    .filter({ hasText: /^Sito web/ })
    .click();
  await expect(page.getByRole('region', { name: 'Email trovate sul sito' })).toBeVisible();
  await expectAccessible(page, 'scheda compatta');

  // «Invia email» apre il composer con il destinatario già scelto
  await page.getByRole('button', { name: 'Invia email' }).click();
  const composer = page.getByRole('dialog', { name: `Email a ${E2E_AUDIT_BUSINESSES.good}` });
  await expect(composer.getByLabel('Destinatario')).toHaveValue(E2E_SITE_EMAIL);
  await composer.getByRole('button', { name: 'Annulla' }).click();

  // «Gestisci contatto»: senza motivo non si conferma; annullare non cambia nulla
  await page.getByRole('button', { name: 'Gestisci contatto' }).click();
  const manage = page.getByRole('dialog', { name: 'Gestisci contatto' });
  await expect(manage.getByRole('radio')).toHaveCount(7);
  await expect(manage.getByRole('button', { name: 'Conferma l’esclusione' })).toBeDisabled();
  await manage.getByRole('radio', { name: /^Altro/ }).check();
  await manage.getByRole('button', { name: 'Conferma l’esclusione' }).click();
  await expect(manage.getByText('Per «Altro» scrivi una breve nota.')).toBeVisible();
  await manage.getByRole('button', { name: 'Annulla' }).click();
  await expect(page.locator('.notice__title', { hasText: 'Esclusa dai potenziali clienti' })).toHaveCount(0);
  expect(errors).toEqual([]);
});

test.describe('mobile @mobile', () => {
  test('scheda compatta su telefono: contatti e azioni leggibili, nessuno scorrimento orizzontale @mobile', async ({
    page,
  }) => {
    const errors = trackErrors(page);
    await signInAsAdmin(page, E2E_USERS.admin.email, E2E_USERS.admin.password);
    await page.goto(`/trova?q=${encodeURIComponent(E2E_AUDIT_BUSINESSES.good)}`);
    await page.getByRole('link', { name: `Dettagli di ${E2E_AUDIT_BUSINESSES.good}` }).click();
    await expect(
      page.getByRole('region', { name: 'Contatti' }).getByRole('link', { name: E2E_SITE_EMAIL }),
    ).toBeInViewport();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow).toBeLessThanOrEqual(0);
    await expectAccessible(page, 'scheda compatta su telefono');
    expect(errors).toEqual([]);
  });
});
