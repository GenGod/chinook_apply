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
    baseURL: 'http://localhost:3999',
  },
  expect: {
    toHaveScreenshot: {
      // Strict: any pixel diff fails (S0 inversion-proof requirement).
      // B-011 (S22): the old default per-pixel threshold 0.2 was blind to
      // intra-palette drift (measured: even a ~10% YIQ shift passed as zero);
      // 0.01 is the only lock that sees both drift probes (see
      // tests/scripts/verify-visual-threshold.mjs). Cross-platform font drift
      // in CI is handled by pinned browser/fonts, not by loosening the gate.
      threshold: 0.01,
      maxDiffPixelRatio: 0,
    },
  },
  outputDir: './test-results',
  webServer: {
    command: 'pnpm --filter @chinook/web exec next start --port 3999',
    env: {
      // isolated e2e DB — the live scheduler keeps ingesting into chinook
      DATABASE_URL:
        process.env.E2E_DATABASE_URL ??
        (process.env.DATABASE_URL ?? 'postgres://chinook:chinook_dev@localhost:5433/chinook').replace(/\/[^/]+$/, '/chinook_e2e'),
      // S21: e2e render files must never mix into the live data/artifacts
      // folder (gitignored either way — synthetic fixtures only land here).
      ARTIFACTS_DIR: '../../data/artifacts-e2e',
    },
    url: 'http://localhost:3999',
    timeout: 180_000,
    reuseExistingServer: false, // dedicated port + no reuse: a stale dev server must never serve the gate
  },
});
