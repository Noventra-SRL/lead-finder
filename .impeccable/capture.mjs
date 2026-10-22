// Catture per la revisione del design (solo sviluppo locale): pagine a 1440 e 375 px di larghezza.
import { chromium } from '@playwright/test';
import process from 'node:process';

const BASE = 'http://localhost:5210';
const OUT = '.impeccable/review';
const [email, password, businessId] = process.argv.slice(2);

const browser = await chromium.launch({ channel: 'chrome' });
async function shoot(width, height, shots) {
  const ctx = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  await page.goto(`${BASE}/`);
  await page.getByLabel('Email di lavoro').fill(email);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Accedi' }).click();
  await page.getByRole('heading', { level: 1, name: 'Oggi' }).waitFor();
  for (const [file, path, opts = {}] of shots) {
    await page.goto(`${BASE}${path}`);
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(600);
    if (opts.scrollTo) await page.locator(opts.scrollTo).first().scrollIntoViewIfNeeded();
    await page.screenshot({ path: `${OUT}/${file}`, fullPage: Boolean(opts.full) });
  }
  await ctx.close();
}

await shoot(1440, 900, [
  ['desktop.png', '/', { full: true }],
  ['desktop-trova.png', '/trova'],
  ['desktop-trova-tabella.png', '/trova', { scrollTo: 'table' }],
  ['desktop-azienda.png', `/aziende/${businessId}`],
  ['desktop-trattative.png', '/pipeline'],
  ['desktop-email.png', '/email?vista=da-contattare'],
]);
await shoot(375, 812, [['mobile.png', '/', { full: true }]]);
await browser.close();
