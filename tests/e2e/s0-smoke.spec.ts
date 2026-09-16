import { test, expect } from '@playwright/test';

test('scaffold page renders Chinook brand (S0 AC4)', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1, name: 'Chinook' })).toBeVisible();
});

test('scaffold page visual snapshot (S0 AC4, LFS)', async ({ page }) => {
  await page.goto('/');
  await expect(page).toHaveScreenshot('s0-scaffold.png');
});
