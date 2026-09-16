import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import globals from 'globals';
import { flatConfig, ignores } from '@chinook/eslint-plugin-arch';

export default tseslint.config(
  { ignores },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  ...flatConfig(),
  {
    languageOptions: {
      globals: { ...globals.node, ...globals.browser },
    },
  },
);
