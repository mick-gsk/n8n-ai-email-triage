import js from '@eslint/js';
import globals from 'globals';

export default [
  js.configs.recommended,
  {
    files: ['**/*.mjs', 'eslint.config.js'],
    languageOptions: { globals: globals.node },
  },
  {
    // Code node sources: n8n runs them as a function body with $input and $ in scope.
    files: ['workflows/*/src/**/*.js', 'shared/*/src/**/*.js'],
    languageOptions: {
      sourceType: 'script',
      parserOptions: { ecmaFeatures: { globalReturn: true } },
      // Buffer and TextDecoder are also available in the Code node sandbox.
      globals: { $input: 'readonly', $: 'readonly', Buffer: 'readonly', TextDecoder: 'readonly' },
    },
  },
];
