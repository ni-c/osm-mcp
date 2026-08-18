// @ts-check
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist/', 'coverage/', 'docs/'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_' },
      ],
    },
  },
  {
    // Plain-JavaScript scripts (the opt-in live smoke test). The TypeScript
    // sources get their globals from tsconfig's "types": ["node"]; an .mjs file
    // has no such declaration, so the handful used here is named instead of
    // pulling in the whole `globals` package.
    files: ['scripts/**/*.mjs'],
    languageOptions: {
      globals: {
        console: 'readonly',
        process: 'readonly',
        setTimeout: 'readonly',
        URL: 'readonly',
      },
    },
  }
);
