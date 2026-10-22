import { defineConfig } from 'vitest/config';

/* Prove dal vivo con servizi esterni: solo su richiesta esplicita (npm run test:live con LIVE_OVERPASS_URL o LIVE_AUDIT_URL). */
export default defineConfig({
  test: {
    include: ['server/**/*.live.ts'],
    environment: 'node',
    testTimeout: 300_000,
  },
});
