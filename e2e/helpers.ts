import AxeBuilder from '@axe-core/playwright';
import { expect, type Page } from '@playwright/test';

/* Strumenti comuni ai test end-to-end. */

export const navLink = (page: Page, label: string) =>
  page.getByRole('navigation', { name: 'Sezioni' }).getByRole('link', { name: new RegExp(`^${label}`) });

/** Sezioni fuori dal menu: si aprono da Impostazioni → «Strumenti avanzati». */
export async function openAdvanced(page: Page, label: string) {
  await navLink(page, 'Impostazioni').click();
  await page
    .getByRole('region', { name: 'Strumenti avanzati' })
    .getByRole('link', { name: label, exact: true })
    .click();
  await expect(page.getByRole('heading', { level: 1, name: label })).toBeVisible();
}

/** Errori del browser: eccezioni JavaScript, errori in console (CSP inclusa), risposte HTTP ≥ 400. */
export function trackErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(`eccezione: ${e.message}`));
  page.on('console', (m) => m.type() === 'error' && errors.push(`console: ${m.text()}`));
  page.on('response', (r) => r.status() >= 400 && errors.push(`HTTP ${r.status()} ${r.request().method()} ${r.url()}`));
  return errors;
}

/** Nessuna violazione WCAG 2.1 A/AA secondo axe-core nella schermata corrente. */
export async function expectAccessible(page: Page, screen: string) {
  // contrasto misurato a schermata ferma: a metà dell'apertura di un dialogo i colori sono ancora in dissolvenza
  // (le animazioni infinite, come gli indicatori di caricamento, non si aspettano)
  await page.evaluate(() =>
    Promise.all(
      document
        .getAnimations()
        .filter((a) => a.effect?.getComputedTiming().endTime !== Infinity)
        .map((a) => a.finished.catch(() => undefined)),
    ),
  );
  const result = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
  const violations = result.violations.map(
    (v) => `${screen} · ${v.id} (${v.impact}): ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`,
  );
  expect(violations).toEqual([]);
}

export async function login(page: Page, email: string, password: string) {
  await page.goto('/');
  await page.getByLabel('Email di lavoro').fill(email);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Accedi' }).click();
}

/*
 * Accesso riusando la sessione dell'amministratore di prova tra un test e l'altro (come un utente che resta collegato):
 * la suite completa supererebbe altrimenti il limite reale di 30 accessi ogni 15 minuti per indirizzo IP.
 */
let adminCookies: Awaited<ReturnType<import('@playwright/test').BrowserContext['cookies']>> | null = null;

export async function signInAsAdmin(page: Page, email: string, password: string) {
  if (adminCookies) {
    await page.context().addCookies(adminCookies);
    await page.goto('/');
    // la sessione salvata è ancora valida se l'app si apre già collegata (attesa reale, non un controllo istantaneo)
    const signedIn = await Promise.race([
      homeHeading(page)
        .waitFor({ timeout: 10_000 })
        .then(() => true),
      page
        .getByLabel('Email di lavoro')
        .waitFor({ timeout: 10_000 })
        .then(() => false),
    ]).catch(() => false);
    if (signedIn) return;
  }
  await login(page, email, password);
  await expectHome(page);
  adminCookies = await page.context().cookies();
}

/** Titolo della pagina iniziale: dopo l'accesso l'app è pronta quando compare. */
export const HOME_TITLE = 'Trova i clienti giusti per Noventra.';
const homeHeading = (page: Page) => page.getByRole('heading', { level: 1, name: HOME_TITLE });
export const expectHome = (page: Page) => expect(homeHeading(page)).toBeVisible();
