import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';

export default tseslint.config(
  { ignores: ['dist', 'node_modules', '.data', 'coverage', 'playwright-report', 'test-results'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      // nessun errore silenziato senza commento: un catch vuoto deve spiegare perché
      'no-empty': ['error', { allowEmptyCatch: false }],
      eqeqeq: ['error', 'always'],
    },
  },
  {
    files: ['src/**/*.{ts,tsx}'],
    languageOptions: { globals: globals.browser },
    ...reactHooks.configs.flat.recommended,
  },
  {
    files: ['server/**/*.ts', 'e2e/**/*.ts', 'scripts/**/*.ts', '*.config.{ts,js}'],
    languageOptions: { globals: globals.node },
    rules: {
      // il server scrive solo tramite il logger centralizzato
      'no-console': 'error',
    },
  },
  {
    // le CLI scrivono sul terminale per definizione
    files: ['server/**/cli.ts', 'scripts/**/*.ts'],
    rules: { 'no-console': 'off' },
  },
);
