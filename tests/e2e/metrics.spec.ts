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
