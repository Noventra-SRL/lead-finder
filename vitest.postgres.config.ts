import { defineConfig, mergeConfig } from 'vitest/config';
import base from './vitest.config.ts';

/*
 * Stessa suite del server, ma su un vero PostgreSQL tramite il driver `pg` di produzione
 * (vedi server/test/postgresSetup.ts). I test specifici di PGlite (blocco della cartella, persistenza su disco)
 * restano nella suite principale.
 */
export default mergeConfig(
  base,
  defineConfig({
    test: {
      include: ['server/**/*.test.ts'],
      exclude: ['server/db/pglite.test.ts'],
      globalSetup: ['server/test/postgresSetup.ts'],
      testTimeout: 30_000,
      hookTimeout: 60_000,
    },
  }),
);
