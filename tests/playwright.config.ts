import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  // Platform-suffixed snapshots (S22/B-011 follow-up): Windows and Linux
  // rasterize text differently at the same threshold 0.01, so each platform
  // keeps its own baseline set (both under the git-LFS attribute).
  snapshotPathTemplate: '{testDir}/__snapshots__/{arg}-{snapshotSuffix}{ext}',
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
      // S8: dispatch sends go to the Mailpit container (never relays out).
      SMTP_HOST: 'localhost',
      SMTP_PORT: '1025',
      SMTP_FROM: 'Chinook E2E <chinook-e2e@example.com>',
      DISPATCH_MODE: 'dry-run',
      // S11: isolated fixture master + sources dir — the e2e approve NEVER
      // touches the real gitignored profile.
      MASTER_PROFILE_PATH: '../../data/artifacts-e2e/master-profile-e2e.json',
      PROFILE_SOURCES_DIR: '../../data/artifacts-e2e/profile-sources',
    },
    url: 'http://localhost:3999',
    timeout: 180_000,
    reuseExistingServer: false, // dedicated port + no reuse: a stale dev server must never serve the gate
  },
});
