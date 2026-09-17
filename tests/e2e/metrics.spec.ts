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

test('navigation Jobs ↔ Metrics works (S13 AC4)', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('link', { name: 'Metrics →' }).click();
  await page.waitForURL(/\/metrics/);
  await page.getByRole('link', { name: '← Jobs' }).click();
  await page.waitForURL(/\/$/);
});

test('metrics visual snapshot (bars visible, text masked; S13 AC5)', async ({ page }) => {
  await page.goto('/metrics');
  await page.addStyleTag({
    content: '* { scrollbar-width: none !important } *::-webkit-scrollbar { width: 0 !important; display: none !important }',
  });
  const cards = page.locator('[data-testid^="card-"]');
  // mask label (1st child) and value (2nd child) of each card; the bar track
  // (3rd child) stays visible — widths are deterministic from fixture counts.
  await expect(page).toHaveScreenshot('s13-metrics.png', {
    mask: [
      page.getByRole('heading', { level: 1 }),
      page.locator('main h1 + span'),
      cards.locator('> div:nth-child(1)'),
      cards.locator('> div:nth-child(2)'),
      page.locator('table').first().locator('tbody'),
      page.locator('table').first().locator('thead'),
      page.getByTestId('history-table').locator('tbody'),
      page.getByTestId('history-table').locator('thead'),
    ],
    maskColor: '#1a2f4a',
  });
});
