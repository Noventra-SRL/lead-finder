import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['server/**/*.test.ts', 'shared/**/*.test.ts', 'src/**/*.test.ts'],
    environment: 'node',
    // ogni file di test apre il proprio PostgreSQL incorporato in memoria
    testTimeout: 20_000,
    // ogni file crea il proprio database e applica tutte le migrazioni: con molti file in parallelo serve margine
    hookTimeout: 60_000,
    // ogni file avvia PostgreSQL in WebAssembly (CPU e memoria): con un processo per core (20 su questa macchina) i
    // file si rallentavano a vicenda fino a superare i tempi massimi; 8 alla volta è stabile e non più lento
    maxWorkers: 8,
  },
});
