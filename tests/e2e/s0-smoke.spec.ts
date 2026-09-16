import { test, expect } from '@playwright/test';

test('scaffold page renders Chinook brand (S0 AC4)', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1, name: 'Chinook' })).toBeVisible();
});

test('scaffold page visual snapshot (S0 AC4, LFS)', async ({ page }) => {
  await page.goto('/');
  // Text nodes are masked: font rasterization differs across OS (windows
  // local vs linux CI) and is covered semantically by the heading assertion
  // above; layout/colors stay under the strict zero-tolerance pixel gate.
  await expect(page).toHaveScreenshot('s0-scaffold.png', {
    mask: [page.getByRole('heading', { level: 1 }), page.locator('p')],
  });
});
