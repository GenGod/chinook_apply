import { test, expect, type Page, type Locator } from '@playwright/test';

/**
 * Deterministic HTML5 drag for the board. Playwright's default dragTo can miss
 * the native dragstart on the source card (React re-renders at the mousedown
 * instant); the pointer path then crosses the card BELOW in the same column and
 * Chromium starts the drag on that wrong card (repro: PATCH went to the residue
 * card). Moving the first pixels strictly inside the source card pins the
 * dragstart to it; the drop lands in the target column's top-left pocket, away
 * from any residue-card buttons.
 */
async function dragCard(page: Page, source: Locator, targetColumn: string): Promise<void> {
  const sb = await source.boundingBox();
  const column = page.locator(`[data-column="${targetColumn}"]`);
  const tb = await column.boundingBox();
  if (!sb || !tb) throw new Error('dragCard: missing bounding box');
  const sx = sb.x + sb.width / 2;
  const sy = sb.y + sb.height / 2;
  await page.mouse.move(sx, sy);
  await page.mouse.down();
  // cross the drag threshold INSIDE the source card
  await page.mouse.move(sx + 8, sy + 8, { steps: 4 });
  // drop into the column's top area (column header pocket), not its center
  await page.mouse.move(tb.x + tb.width / 2, tb.y + 24, { steps: 8 });
  await page.mouse.up();
}

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
      page.getByTestId('board-filters').locator('div'), // S19 filter bar fields (select glyph AA)
      page.getByTestId('board-filters').locator('label'),
      page.getByTestId('board-filters').locator('button'),
    ],
    maskColor: '#1a2f4a',
  });
});

test.beforeEach(async ({ page }) => {
  await page.goto('/board');
});

test('board province filter narrows New column; status flow unaffected (S19 AC4)', async ({ page }) => {
  await page.locator('#province').selectOption('ON');
  await page.getByRole('button', { name: 'Apply filters' }).click();
  await page.waitForURL(/province=ON/);
  const cards = page.locator('[data-column="new"] [data-card-id]');
  await expect(cards.first()).toBeVisible();
  expect(await cards.count()).toBe(1); // only the S19 synthetic ON job (fixtures are AB-only relevant)
  expect(await cards.first().textContent()).toContain('S19 e2e Ontario developer');

  // the filtered view still supports the status flow (filter hides, does not break DnD/buttons)
  await cards.first().getByRole('button', { name: 'Start applying' }).click();
  await expect(page.locator('[data-column="applying"] [data-card-id]')).toBeVisible();
  // cleanup — back to new so later tests stay deterministic
  await page.locator('[data-column="applying"] [data-card-id]').first().getByRole('button', { name: 'Back' }).click();
  await expect(page.locator('[data-column="new"] [data-card-id]')).toBeVisible();
});

test('board REMOTE filter shows only the remote card (S19 AC2/AC4)', async ({ page }) => {
  await page.goto('/board?province=REMOTE');
  const cards = page.locator('[data-column="new"] [data-card-id]');
  expect(await cards.count()).toBe(1);
  expect(await cards.first().textContent()).toContain('S19 e2e remote developer');
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
  await dragCard(page, card, 'applying');
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
  await dragCard(page, card, 'applying');
  await expect(page.locator(`[data-column="applying"] [data-card-id="${cardId}"]`)).toBeVisible();
  await page.waitForLoadState('networkidle'); // let the PATCH's router.refresh() settle
  await dragCard(page, page.locator(`[data-column="applying"] [data-card-id="${cardId}"]`), 'applied_manual');
  await expect(page.locator(`[data-column="applied_manual"] [data-card-id="${cardId}"]`)).toBeVisible();
  // cleanup: applied_manual → applying → new, so consecutive runs (no re-seed) stay deterministic
  await page.locator(`[data-column="applied_manual"] [data-card-id="${cardId}"]`).getByRole('button', { name: 'Back' }).click();
  await expect(page.locator(`[data-column="applying"] [data-card-id="${cardId}"]`)).toBeVisible();
  await page.waitForLoadState('networkidle');
  await page.locator(`[data-column="applying"] [data-card-id="${cardId}"]`).getByRole('button', { name: 'Back' }).click();
  await expect(page.locator(`[data-column="new"] [data-card-id="${cardId}"]`)).toBeVisible();
});

test('illegal drag new → interview is rejected with visible error (S18 AC3)', async ({ page }) => {
  const card = page.locator('[data-column="new"] [data-card-id]').first();
  const cardId = await card.getAttribute('data-card-id');
  await dragCard(page, card, 'interview');
  await expect(page.getByTestId('dnd-error')).toBeVisible();
  await expect(page.locator(`[data-column="new"] [data-card-id="${cardId}"]`)).toBeVisible();
});
