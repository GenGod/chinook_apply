import { test, expect } from '@playwright/test';

test('metrics page renders funnel consistent with API (S13 AC2/AC3)', async ({ page, request }) => {
  await page.goto('/metrics');
  const api = await (await request.get('/api/metrics')).json();

  await expect(page.getByTestId('card-total')).toBeVisible();
  expect(Number((await page.getByTestId('card-total').innerText()).replace(/\D/g, ''))).toBe(api.funnel.total);
  expect(Number((await page.getByTestId('card-relevant').innerText()).replace(/\D/g, ''))).toBe(api.funnel.relevant);
  expect(Number((await page.getByTestId('card-applied').innerText()).replace(/\D/g, ''))).toBe(api.funnel.appliedManual);

  expect(api.funnel.total).toBeGreaterThan(0);
  expect(api.sources.length).toBe(2);
  expect(api.history.length).toBeGreaterThan(0);
});

test('funnel bar widths follow the funnel proportions (S13 AC5, DOM-level)', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('link', { name: 'Metrics →' }).click();
  await page.waitForURL(/\/metrics/);
  const barWidth = async (testId: string) =>
    (await page.getByTestId(testId).locator('div').nth(2).locator('div').boundingBox())?.width ?? 0;
  const total = await barWidth('card-total');
  const relevant = await barWidth('card-relevant');
  const excluded = await barWidth('card-excluded');
  expect(total).toBeGreaterThan(0);
  expect(relevant).toBeGreaterThan(excluded); // fixtures: relevant dominates
  expect(relevant).toBeLessThan(total);
});

test('navigation Jobs ↔ Metrics works (S13 AC4)', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('link', { name: 'Metrics →' }).click();
  await page.waitForURL(/\/metrics/);
  await page.getByRole('link', { name: '← Jobs' }).click();
  await page.waitForURL(/\/$/);
});

test('metrics visual snapshot (frame gate; S13 AC5)', async ({ page }) => {
  await page.goto('/metrics');
  await page.addStyleTag({
    content: '* { scrollbar-width: none !important } *::-webkit-scrollbar { width: 0 !important; display: none !important }',
  });
  // Whole text/bars-bearing blocks are masked (S1a discipline: fixed-box frame
  // gate); bar correctness is asserted on the DOM level above.
  await expect(page).toHaveScreenshot('s13-metrics.png', {
    mask: [
      page.locator('main > div').first(), // heading row
      page.locator('div[class*="cards"]').first(), // funnel cards block
      page.locator('div[class*="sectionTitle"]'), // section captions (text)
      page.locator('table').first(),
      page.getByTestId('history-table'),
    ],
    maskColor: '#1a2f4a',
  });
});

test('styleguide /design renders all DS sections (S16 AC4)', async ({ page }) => {
  await page.goto('/design');
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  const swatches = await page.locator('[data-ds^="badge-"], [data-ds="button-primary"], [data-ds="field"], [data-ds="bar"], [data-ds="card"]').count();
  expect(swatches).toBeGreaterThanOrEqual(5);
  const labels = await page.locator('.swatchLabel, div[class*="swatchLabel"]').count();
  expect(labels).toBeGreaterThanOrEqual(13);
});

test('focus-visible outline present on interactive controls (S16 AC5)', async ({ page }) => {
  await page.goto('/');
  await page.keyboard.press('Tab');
  await page.keyboard.press('Tab');
  const firstLink = page.getByRole('link').first();
  await firstLink.focus();
  const outline = await firstLink.evaluate((el) => getComputedStyle(el).outlineColor);
  expect(outline).not.toBe('transparent');
  expect(outline).not.toBe('');
});

test('styleguide visual gate — swatches/buttons/bars visible, texts masked (S16 AC2)', async ({ page }) => {
  await page.goto('/design');
  await page.addStyleTag({
    content: '* { scrollbar-width: none !important } *::-webkit-scrollbar { width: 0 !important; display: none !important }',
  });
  await expect(page).toHaveScreenshot('s16-design.png', {
    mask: [
      page.getByRole('heading', { level: 1 }),
      page.locator('main h1 + span'),
      page.locator('div[class*="swatchLabel"]'),
      page.locator('div[class*="typeRow"]'),
      page.locator('div[class*="section"]'),
      page.locator('div[class*="cardLabel"], div[class*="cardValue"]'),
      page.locator('div[class*="fieldDemo"]'),
    ],
    maskColor: '#1a2f4a',
    fullPage: true,
  });
});

test('tokens are actually served — accent paints the primary button (S16 regression)', async ({ page }) => {
  // Guards against the class of bug where tokens.css fails to load and every
  // var() silently falls back to transparent (pixel gates can't see it: the
  // baseline would have been captured equally broken).
  await page.goto('/design');
  const bg = await page.locator('[data-ds="button-primary"]').evaluate((el) => getComputedStyle(el).backgroundColor);
  expect(bg).toBe('rgb(47, 129, 247)');
});
