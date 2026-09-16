import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  // Stable, platform-suffix-free snapshot path under the git-LFS attribute
  // (tests/**/__snapshots__/**/*.png) — same file locally and in CI.
  snapshotPathTemplate: '{testDir}/__snapshots__/{arg}{ext}',
  use: {
    ...devices['Desktop Chrome'],
    viewport: { width: 1280, height: 720 },
    baseURL: 'http://localhost:3000',
  },
  expect: {
    toHaveScreenshot: {
      // Strict: any pixel diff fails (S0 inversion-proof requirement).
      // Cross-platform font drift in CI is handled by pinned browser/fonts
      // in CI, not by loosening the gate (see S0 report, known risks).
      maxDiffPixelRatio: 0,
    },
  },
  outputDir: './test-results',
  webServer: {
    command: 'pnpm --filter @chinook/web run start',
    url: 'http://localhost:3000',
    timeout: 180_000,
    reuseExistingServer: !process.env.CI,
  },
});
