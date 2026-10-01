import { test, expect } from '@playwright/test';
import { resetFixtureMaster } from './fixture-master';

/**
 * S24 — track pipeline e2e: badge in Jobs, jobs-by-track metric card, and
 * add_track entries in the /profile proposal. The seeded first relevant job
 * carries a v6-e2e match with best_track="fixture-track"; the seeded facts
 * include an experience fact that derives a track.
 */

test('jobs row shows the best-track badge next to the score', async ({ page }) => {
  await page.goto('/?rule=relevant');
  const first = page.getByTestId('jobs-table').locator('tbody tr').first();
  await expect(first.getByTestId('track-badge').first()).toHaveText(/fixture-track/);
});

test('metrics quality section shows a jobs-by-track card', async ({ page }) => {
  await page.goto('/metrics');
  const card = page.getByTestId('track-fixture-track');
  await expect(card).toBeVisible();
  await expect(card).toContainText('jobs best-matched');
});

test('profile proposal lists add_track entries with provenance excerpts', async ({ page }) => {
  await resetFixtureMaster();
  await page.goto('/profile');
  await page.getByTestId('profile-build').click();
  const proposal = page.getByTestId('profile-proposal');
  await expect(proposal).toBeVisible();
  await expect(proposal).toContainText('add_track');
  await expect(proposal).toContainText('E2E Track Engineer');
});
