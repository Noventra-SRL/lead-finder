import { expect, test } from '@playwright/test';
import { expectAccessible, login, navLink, openAdvanced, trackErrors, expectHome } from './helpers.ts';
import { E2E_USERS } from './users.ts';

/*
 * Fase 1 sul programma reale (server/index.ts + interfaccia compilata, CSP di produzione, PGlite su disco).
 * Ogni flusso verifica anche che il browser non registri errori (comprese le violazioni della CSP)
 * e che le schermate rispettino WCAG 2.1 AA secondo axe-core.
 */

test.describe('interfaccia servita dal server', () => {
  test('pagina con CSP e intestazioni di sicurezza; /api sempre JSON', async ({ request }) => {
    const page = await request.get('/impostazioni');
    expect(page.status()).toBe(200);
    expect(page.headers()['content-type']).toContain('text/html');
    expect(page.headers()['content-security-policy']).toContain("script-src 'self'");
    expect(page.headers()['x-frame-options']).toBe('DENY');
    const api = await request.get('/api/inesistente');
    expect(api.status()).toBe(404);
    expect((await api.json()).error.code).toBe('NOT_FOUND');
  });
});

test.describe('accesso', () => {
  test('la pagina di accesso si apre senza errori ed è accessibile', async ({ page }) => {
    const errors = trackErrors(page);
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'Accedi' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Accedi' })).toBeDisabled();
    await expectAccessible(page, 'accesso');
    expect(errors).toEqual([]);
  });

  test('credenziali errate: messaggio chiaro, nessun accesso', async ({ page }) => {
    await login(page, E2E_USERS.admin.email, 'password-sbagliata');
    await expect(page.getByRole('alert')).toContainText('Email o password non corretti.');
    await expect(page.getByRole('heading', { name: 'Accedi' })).toBeVisible();
    await expect(page.getByLabel('Password', { exact: true })).toHaveValue('');
  });

  test('accesso, dashboard con dati reali, sessione persistente e uscita, senza errori', async ({ page }) => {
    const errors = trackErrors(page);
    await login(page, E2E_USERS.admin.email, E2E_USERS.admin.password);
    // la home dice cosa fa l'applicazione e qual è il prossimo passo; le azioni portano alle pagine esistenti
    await expectHome(page);
    const main = page.getByRole('main');
    await expect(main.getByRole('link', { name: 'Trova aziende', exact: true }).first()).toHaveAttribute(
      'href',
      '/trova',
    );
    await expect(main.getByRole('link', { name: 'Email commerciali', exact: true })).toHaveAttribute('href', '/email');
    await expect(page.getByRole('list', { name: 'Numeri principali' }).getByRole('listitem')).toHaveCount(4);
    await expectAccessible(page, 'dashboard');
    // lo stato tecnico del sistema è nelle impostazioni, letto dall'API reale: database connesso e schema aggiornato
    await navLink(page, 'Impostazioni').click();
    const system = page.getByRole('region', { name: 'Stato del sistema' });
    await expect(system.getByText('Connesso')).toBeVisible();
    await expect(system.getByText('Aggiornato')).toBeVisible();
    await expect(system.getByText('0001_foundation')).toBeVisible();
    await expect(system.getByText('PostgreSQL incorporato (PGlite) in .data/e2e')).toBeVisible();
    await expect(system.getByText('2 utenti attivi')).toBeVisible();
    await navLink(page, 'Dashboard').click();

    // la sessione sopravvive al ricaricamento (cookie HttpOnly, nessun token leggibile dal browser)
    await page.reload();
    await expectHome(page);
    expect(await page.evaluate(() => document.cookie)).toBe('');
    expect(await page.evaluate(() => Object.keys(localStorage).length + Object.keys(sessionStorage).length)).toBe(0);

    await page.getByRole('button', { name: 'Esci' }).click();
    await expect(page.getByRole('heading', { name: 'Accedi' })).toBeVisible();
    await page.reload();
    await expect(page.getByRole('heading', { name: 'Accedi' })).toBeVisible();
    expect(errors).toEqual([]);
  });

  test("dopo l'accesso si apre la pagina richiesta", async ({ page }) => {
    await page.goto('/impostazioni');
    await page.getByLabel('Email di lavoro').fill(E2E_USERS.admin.email);
    await page.getByLabel('Password', { exact: true }).fill(E2E_USERS.admin.password);
    await page.getByRole('button', { name: 'Accedi' }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Impostazioni' })).toBeVisible();
    await expect(page).toHaveURL(/\/impostazioni$/);
  });

  test('cookie di una sessione non più valida: avviso all’apertura, nessun errore', async ({
    page,
    context,
    baseURL,
  }) => {
    const errors = trackErrors(page);
    await context.addCookies([{ name: 'nlf_session', value: 'x'.repeat(43), url: `${baseURL}/api/` }]);
    await page.goto('/');
    await expect(page.getByText('La sessione è scaduta: accedi di nuovo.')).toBeVisible();
    expect(errors).toEqual([]);
  });
});

test.describe('navigazione', () => {
  test.beforeEach(async ({ page }) => {
    await login(page, E2E_USERS.admin.email, E2E_USERS.admin.password);
    await expectHome(page);
  });

  test('menu essenziale: quattro voci sotto «Principale», le altre sezioni restano raggiungibili', async ({ page }) => {
    const errors = trackErrors(page);
    const nav = page.getByRole('navigation', { name: 'Sezioni' });
    await expect(nav.getByText('Principale')).toBeVisible();
    await expect(nav.getByRole('link')).toHaveText([/Dashboard/, /Trova aziende/, /Email commerciali/, /Impostazioni/]);
    await expect(nav.getByText('non ancora attivo')).toHaveCount(0);
    await expect(nav.getByText('Analisi e strumenti')).toHaveCount(0);
    // ogni voce apre la sua pagina e resta evidenziata
    const pages: [string, string][] = [
      ['Trova aziende', '/trova'],
      ['Email commerciali', '/email'],
      ['Impostazioni', '/impostazioni'],
    ];
    for (const [label, path] of pages) {
      await navLink(page, label).click();
      await expect(page).toHaveURL(new RegExp(`${path}$`));
      await expect(page.getByRole('heading', { level: 1, name: label })).toBeVisible();
      await expect(navLink(page, label)).toHaveAttribute('aria-current', 'page');
      await expect(nav.locator('[aria-current="page"]')).toHaveCount(1);
    }
    // sezioni fuori dal menu: stesse pagine e indirizzi, aperte dagli strumenti avanzati; resta evidenziata la voce madre
    const advanced: [string, string, string][] = [
      ['Nuova ricerca di aziende', '/lead-hunter', 'Trova aziende'],
      ['Database aziende', '/aziende', 'Trova aziende'],
      ['Trattative', '/pipeline', 'Email commerciali'],
      ['Analisi dei siti web', '/audit', 'Impostazioni'],
      ['Valutazione dei potenziali clienti', '/analisi-ai', 'Impostazioni'],
      ['Servizi Noventra', '/servizi', 'Impostazioni'],
      ['Risultati e report', '/report', 'Dashboard'],
    ];
    for (const [label, path, parent] of advanced) {
      await openAdvanced(page, label);
      await expect(page).toHaveURL(new RegExp(`${path}$`));
      await expect(navLink(page, parent)).toHaveAttribute('aria-current', 'page');
    }
    await navLink(page, 'Impostazioni').click();
    await expect(page.getByRole('main').getByText('Non ancora attivo', { exact: true })).toHaveCount(0);
    await expectAccessible(page, 'impostazioni');
    await navLink(page, 'Dashboard').click();
    await expectHome(page);
    await page.goto('/indirizzo-inesistente');
    await expect(page.getByRole('heading', { name: 'Pagina non trovata' })).toBeVisible();
    expect(errors).toEqual([]);
  });

  test('impostazioni: account, sessioni e utenti (amministratore), accessibili', async ({ page }) => {
    const errors = trackErrors(page);
    await navLink(page, 'Impostazioni').click();
    await expect(page.getByText(E2E_USERS.admin.email).first()).toBeVisible();
    await expect(page.getByRole('cell', { name: /· questa sessione/ })).toBeVisible();
    const users = page.getByRole('region', { name: 'Utenti' });
    await expect(users.getByText(E2E_USERS.fresh.email)).toBeVisible();
    await expect(users.getByText('Password temporanea', { exact: true })).toBeVisible();
    await expectAccessible(page, 'impostazioni');
    expect(errors).toEqual([]);
  });

  test('cambio password dalle impostazioni: errori per campo dal server', async ({ page }) => {
    await navLink(page, 'Impostazioni').click();
    await page.getByLabel('Password attuale').fill('non-è-quella-giusta');
    await page.getByLabel('Nuova password', { exact: true }).fill('una-frase-nuova-lunga');
    await page.getByLabel('Ripeti la nuova password').fill('una-frase-nuova-lunga');
    await page.getByRole('button', { name: 'Cambia password' }).click();
    await expect(page.getByText('La password attuale non è corretta.')).toBeVisible();
    await expect(page.getByLabel('Password attuale')).toHaveAttribute('aria-invalid', 'true');
  });

  test('chiudere le altre sessioni richiede conferma e disconnette gli altri dispositivi', async ({
    page,
    browser,
  }) => {
    const other = await browser.newContext();
    const otherPage = await other.newPage();
    await login(otherPage, E2E_USERS.admin.email, E2E_USERS.admin.password);
    await expectHome(otherPage);

    await navLink(page, 'Impostazioni').click();
    await page.getByRole('button', { name: 'Chiudi le altre sessioni' }).click();
    const dialog = page.getByRole('dialog', { name: 'Chiudere le altre sessioni?' });
    await expect(dialog).toBeVisible();
    await expectAccessible(page, 'dialogo di conferma');
    // Annulla non chiude nulla
    await dialog.getByRole('button', { name: 'Annulla' }).click();
    await expect(dialog).toBeHidden();
    await page.getByRole('button', { name: 'Chiudi le altre sessioni' }).click();
    await dialog.getByRole('button', { name: /^Chiudi \d+ session/ }).click();
    await expect(page.getByText(/chiusa 1 sessione|chiuse \d+ sessioni/)).toBeVisible();

    await navLink(otherPage, 'Impostazioni').click();
    await expect(otherPage.getByRole('heading', { name: 'Accedi' })).toBeVisible();
    await expect(otherPage.getByText('La sessione è scaduta')).toBeVisible();
    await other.close();
  });
});

test.describe('password temporanea', () => {
  test('al primo accesso va cambiata prima di usare l’app', async ({ page }) => {
    const errors = trackErrors(page);
    await login(page, E2E_USERS.fresh.email, E2E_USERS.fresh.password);
    await expect(page.getByRole('heading', { name: 'Imposta la password' })).toBeVisible();
    await expectAccessible(page, 'cambio password obbligatorio');
    // le API protette restano bloccate finché la password non è cambiata
    const blocked = await page.request.get('/api/system/status');
    expect(blocked.status()).toBe(403);
    expect((await blocked.json()).error.code).toBe('PASSWORD_CHANGE_REQUIRED');

    await page.getByLabel('Password attuale').fill(E2E_USERS.fresh.password);
    await page.getByLabel('Nuova password', { exact: true }).fill('una-nuova-frase-sicura');
    await page.getByLabel('Ripeti la nuova password').fill('una-nuova-frase-diversa');
    await expect(page.getByText('Le due password non coincidono.')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Salva e continua' })).toBeDisabled();
    await page.getByLabel('Ripeti la nuova password').fill('una-nuova-frase-sicura');
    await page.getByRole('button', { name: 'Salva e continua' }).click();

    await expectHome(page);
    // un commerciale non vede la gestione utenti e non può leggerla dall'API
    await navLink(page, 'Impostazioni').click();
    await expect(page.getByRole('heading', { level: 1, name: 'Impostazioni' })).toBeVisible();
    await expect(page.getByRole('region', { name: 'Utenti' })).toHaveCount(0);
    expect(errors).toEqual([]);
    expect((await page.request.get('/api/users')).status()).toBe(403);
  });
});

test.describe('mobile @mobile', () => {
  test('menu a pannello, pagine leggibili e accessibili su telefono @mobile', async ({ page }) => {
    const errors = trackErrors(page);
    await page.goto('/');
    await expectAccessible(page, 'accesso (mobile)');
    await login(page, E2E_USERS.admin.email, E2E_USERS.admin.password);
    await expectHome(page);
    const nav = page.getByRole('navigation', { name: 'Sezioni' });
    await expect(nav).toBeHidden();
    await page.getByRole('button', { name: 'Menu' }).click();
    await expect(nav).toBeVisible();
    await expectAccessible(page, 'menu (mobile)');
    await page.keyboard.press('Escape');
    await expect(nav).toBeHidden();
    await page.getByRole('button', { name: 'Menu' }).click();
    await nav.getByRole('link', { name: /Impostazioni/ }).click();
    await expect(nav).toBeHidden();
    await expect(page.getByRole('heading', { level: 1, name: 'Impostazioni' })).toBeVisible();
    for (const path of ['/', '/impostazioni', '/scoperta']) {
      await page.goto(path);
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      expect(overflow, path).toBeLessThanOrEqual(0);
    }
    expect(errors).toEqual([]);
  });
});
