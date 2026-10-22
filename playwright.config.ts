import { defineConfig, devices } from '@playwright/test';

/*
 * Test end-to-end sul programma reale: "npm run build" e poi server/index.ts (e2e/start.ts), che serve API e
 * interfaccia compilata dalla stessa origine con la Content-Security-Policy di produzione.
 * Database PGlite dedicato (.data/e2e), porta dedicata 8811: nessuna interferenza con lo sviluppo (8810, 5210).
 * Usa il Chrome installato nel sistema (channel 'chrome'): nessun browser da scaricare.
 */

const PORT = 8811;

export default defineConfig({
  testDir: 'e2e',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    channel: 'chrome',
    locale: 'it-IT',
    timezoneId: 'Europe/Rome',
    trace: 'retain-on-failure',
  },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'], channel: 'chrome' }, grepInvert: /@mobile/ },
    { name: 'mobile', use: { ...devices['Pixel 7'], channel: 'chrome' }, grep: /@mobile/ },
  ],
  webServer: {
    command: 'npm run build && node e2e/start.ts',
    url: `http://127.0.0.1:${PORT}/api/health/ready`,
    env: { E2E_PORT: String(PORT) },
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
