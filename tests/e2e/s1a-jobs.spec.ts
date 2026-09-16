import { test, expect } from '@playwright/test';

test('jobs table renders fixture rows (S1a AC3)', async ({ page }) => {
  await page.goto('/');
  const rows = page.getByTestId('jobs-table').locator('tbody tr');
  await expect(rows.first()).toBeVisible();
  expect(await rows.count()).toBeGreaterThan(10);
});

test('title links open in a new tab with noopener (S1a AC3)', async ({ page }) => {
  await page.goto('/');
  const link = page.getByTestId('jobs-table').locator('tbody tr a').first();
  await expect(link).toHaveAttribute('target', '_blank');
  await expect(link).toHaveAttribute('rel', /noopener/);
});

test('filter by source narrows the list (S1a AC1/AC4)', async ({ page }) => {
  await page.goto('/');
  const all = await page.getByTestId('jobs-table').locator('tbody tr').count();
  await page.locator('#source').selectOption('adzuna');
  await page.getByRole('button', { name: 'Apply filters' }).click();
  await page.waitForURL(/source=adzuna/);
  const filtered = await page.getByTestId('jobs-table').locator('tbody tr').count();
  expect(filtered).toBeGreaterThan(0);
  expect(filtered).toBeLessThan(all);
  const badges = await page.getByTestId('jobs-table').locator('tbody .source').allTextContents();
  expect(badges.every((b) => b === 'adzuna')).toBe(true);
});

test('Applied toggle persists after reload (S1a AC2/AC3)', async ({ page }) => {
  await page.goto('/');
  // State-agnostic: DB may already contain an application for the first row
  // from earlier runs — then the assertion chain still must hold end-to-end.
  const firstRow = page.getByTestId('jobs-table').locator('tbody tr').first();
  const markButton = firstRow.getByRole('button', { name: 'Mark applied' });
  if (await markButton.count()) {
    await markButton.click();
  }
  await expect(firstRow.locator('button[data-applied="true"]')).toBeVisible();
  await page.reload();
  await expect(
    page.getByTestId('jobs-table').locator('tbody tr').first().locator('button[data-applied="true"]'),
  ).toBeVisible();
});

test('PATCH applied-manually API returns application JSON (S1a AC2)', async ({ request }) => {
  const jobs = await (await request.get('/api/jobs?limit=1')).json();
  expect(jobs.jobs.length).toBe(1);
  const response = await request.patch(`/api/jobs/${jobs.jobs[0].id}/applied-manually`);
  expect(response.status()).toBe(200);
  const body = await response.json();
  expect(body.status).toBe('applied_manual');
  expect(body.channel).toBe('external_link');
});

test('empty state is reachable via strict filter', async ({ page }) => {
  await page.goto('/?salaryMin=999999');
  await expect(page.getByTestId('empty')).toBeVisible();
});

test('jobs screen visual snapshot (masked layout gate)', async ({ page }) => {
  await page.goto('/');
  // Scrollbars render differently per OS (classic on linux CI, overlay/none on
  // windows) — hide them for the pixel gate; scrolling itself is not under test.
  await page.addStyleTag({
    content: '* { scrollbar-width: none !important } *::-webkit-scrollbar { width: 0 !important; display: none !important }',
  });
  // Text-heavy data table is covered by DOM assertions above; the pixel gate
  // protects layout chrome (header, filter bar, table frame) — text-bearing
  // elements are masked to stay deterministic across OS font rasterization.
  await expect(page).toHaveScreenshot('s1a-jobs.png', {
    mask: [
      page.locator('label'),
      page.locator('#source'),
      page.locator('#days'),
      page.locator('#salaryMin'),
      page.locator('#sort'),
      page.getByRole('button', { name: 'Apply filters' }),
      page.getByTestId('jobs-table').locator('tbody'),
      page.getByTestId('jobs-table').locator('thead'),
      page.locator('main > div').first(), // whole heading row: fixed box, all text+AA inside mask
    ],
    maskColor: '#1a2f4a',
  });
});
