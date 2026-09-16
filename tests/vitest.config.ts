import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['unit/**/*.test.mjs'],
    environment: 'node',
  },
});
