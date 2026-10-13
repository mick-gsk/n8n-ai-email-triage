import js from '@eslint/js';
import globals from 'globals';

export default [
  js.configs.recommended,
  {
    files: ['scripts/**/*.mjs', 'test/**/*.mjs', 'eval/**/*.mjs', 'eslint.config.js'],
    languageOptions: { globals: globals.node },
  },
  {
    // Code node sources: n8n runs them as a function body with $input and $ in scope.
    files: ['src/**/*.js'],
    languageOptions: {
      sourceType: 'script',
      parserOptions: { ecmaFeatures: { globalReturn: true } },
      globals: { $input: 'readonly', $: 'readonly' },
    },
  },
];
