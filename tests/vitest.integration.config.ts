import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['integration/**/*.test.ts'],
    environment: 'node',
    fileParallelism: false,
    setupFiles: ['./integration.setup.ts'],
    testTimeout: 60_000,
    hookTimeout: 30_000,
  },
});
