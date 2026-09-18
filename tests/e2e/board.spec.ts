import { test, expect } from '@playwright/test';

test('board visual snapshot (masked cards, columns visible; S7 AC6)', async ({ page }) => {
  await page.addStyleTag({
    content: '* { scrollbar-width: none !important } *::-webkit-scrollbar { width: 0 !important; display: none !important }',
  });
  await expect(page).toHaveScreenshot('s7-board.png', {
    mask: [
      page.locator('main > div').first(), // whole header row: wordmark, subtitle, count, nav (hashed-class trap avoided)
      page.locator('section[data-column] header'), // titles + counts (text AA)
      page.locator('.horizon'), // gradient interpolation differs across GPU/platform
      page.locator('[data-card-id]'),
      page.locator('div[class*="emptyColumn"]'),
    ],
    maskColor: '#1a2f4a',
  });
});

test.beforeEach(async ({ page }) => {
  await page.goto('/board');
});

test('board renders six columns with New filled (S7 AC3)', async ({ page }) => {
  const columns = page.getByTestId('board').locator('section[data-column]');
  await expect(columns.first()).toBeVisible();
  expect(await columns.count()).toBe(6);
  const newCards = page.locator('[data-column="new"] [data-card-id]');
  await expect(newCards.first()).toBeVisible();
  expect(await newCards.count()).toBeGreaterThan(5);
  await expect(page.getByTestId('active-count')).toBeVisible();
});

test('move new → applying persists after reload (S7 AC3)', async ({ page }) => {
  const firstCard = page.locator('[data-column="new"] [data-card-id]').first();
  const cardId = await firstCard.getAttribute('data-card-id');
  await firstCard.getByRole('button', { name: 'Start applying' }).click();
  await expect(page.locator(`[data-column="applying"] [data-card-id="${cardId}"]`)).toBeVisible();
  await page.reload();
  await expect(page.locator(`[data-column="applying"] [data-card-id="${cardId}"]`)).toBeVisible();
  // and back to new (row deleted)
  await page.locator(`[data-column="applying"] [data-card-id="${cardId}"]`).getByRole('button', { name: 'Back' }).click();
  await expect(page.locator(`[data-column="new"] [data-card-id="${cardId}"]`)).toBeVisible();
});

test('move applying → applied manual lands in split column (G1 #2)', async ({ page }) => {
  const firstCard = page.locator('[data-column="new"] [data-card-id]').first();
  const cardId = await firstCard.getAttribute('data-card-id');
  await firstCard.getByRole('button', { name: 'Start applying' }).click();
  await expect(page.locator(`[data-column="applying"] [data-card-id="${cardId}"]`)).toBeVisible();
  await page
    .locator(`[data-column="applying"] [data-card-id="${cardId}"]`)
    .getByRole('button', { name: 'Applied manual' })
    .click();
  await expect(page.locator(`[data-column="applied_manual"] [data-card-id="${cardId}"]`)).toBeVisible();
});

test('job details page shows info and status controls (S7 AC4)', async ({ page }) => {
  const link = page.locator('[data-column="new"] [data-card-id] a').first();
  await link.click();
  await page.waitForURL(/\/job\/[0-9a-f-]{36}/);
  await expect(page.getByText('Job details')).toBeVisible();
  await expect(page.locator('main h2').first()).toBeVisible();
  await expect(page.getByRole('link', { name: 'Open original posting' })).toHaveAttribute('target', '_blank');
  await expect(page.getByRole('button', { name: 'Start applying' })).toBeVisible();
});


test('drag new → applying persists (S18 AC1)', async ({ page }) => {
  const card = page.locator('[data-column="new"] [data-card-id]').first();
  const cardId = await card.getAttribute('data-card-id');
  await card.dragTo(page.locator('[data-column="applying"]'));
  await expect(page.locator(`[data-column="applying"] [data-card-id="${cardId}"]`)).toBeVisible();
  await page.reload();
  await expect(page.locator(`[data-column="applying"] [data-card-id="${cardId}"]`)).toBeVisible();
  // cleanup: back to new (delete row) so later tests stay deterministic
  await page.locator(`[data-column="applying"] [data-card-id="${cardId}"]`).getByRole('button', { name: 'Back' }).click();
  await expect(page.locator(`[data-column="new"] [data-card-id="${cardId}"]`)).toBeVisible();
});

test('drag applying → applied manual sets channel (S18 AC2)', async ({ page }) => {
  const card = page.locator('[data-column="new"] [data-card-id]').first();
  const cardId = await card.getAttribute('data-card-id');
  await card.dragTo(page.locator('[data-column="applying"]'));
  await expect(page.locator(`[data-column="applying"] [data-card-id="${cardId}"]`)).toBeVisible();
  await page.locator(`[data-column="applying"] [data-card-id="${cardId}"]`).dragTo(page.locator('[data-column="applied_manual"]'));
  await expect(page.locator(`[data-column="applied_manual"] [data-card-id="${cardId}"]`)).toBeVisible();
});

test('illegal drag new → interview is rejected with visible error (S18 AC3)', async ({ page }) => {
  const card = page.locator('[data-column="new"] [data-card-id]').first();
  const cardId = await card.getAttribute('data-card-id');
  await card.dragTo(page.locator('[data-column="interview"]'));
  await expect(page.getByTestId('dnd-error')).toBeVisible();
  await expect(page.locator(`[data-column="new"] [data-card-id="${cardId}"]`)).toBeVisible();
});
