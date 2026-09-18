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

test('rule filter narrows the list (S2 AC4)', async ({ request }) => {
  const all = await (await request.get('/api/jobs?limit=100')).json();
  const relevant = await (await request.get('/api/jobs?rule=relevant&limit=100')).json();
  expect(relevant.jobs.every((j: { ruleStatus: string }) => j.ruleStatus === 'relevant')).toBe(true);
  expect(relevant.jobs.length).toBeLessThanOrEqual(all.jobs.length);
  expect(relevant.jobs.length).toBeGreaterThan(0);
});

test('rule badges present and valid (S14 AC1)', async ({ page }) => {
  await page.goto('/');
  const badges = page.locator('[data-rule]');
  await expect(badges.first()).toBeVisible();
  const statuses = await badges.evaluateAll((els) => els.map((e) => e.getAttribute('data-rule')));
  expect(statuses.length).toBeGreaterThan(10);
  expect(statuses.every((s) => s === 'relevant' || s === 'review' || s === 'excluded')).toBe(true);
});

test('rule filter narrows and colors consistently (S14 AC2)', async ({ page }) => {
  await page.goto('/');
  const all = await page.getByTestId('jobs-table').locator('tbody tr').count();
  await page.locator('#rule').selectOption('review');
  await page.getByRole('button', { name: 'Apply filters' }).click();
  await page.waitForURL(/rule=review/);
  const filtered = await page.getByTestId('jobs-table').locator('tbody tr').count();
  expect(filtered).toBeGreaterThan(0);
  expect(filtered).toBeLessThan(all);
  const badges = await page.locator('[data-rule]').evaluateAll((els) =>
    els.map((e) => e.getAttribute('data-rule')),
  );
  expect(badges.every((s) => s === 'review')).toBe(true);
});

test('combined source+rule filter works (S14 AC3)', async ({ page }) => {
  await page.goto('/?source=adzuna&rule=relevant');
  const sources = await page.getByTestId('jobs-table').locator('tbody .source').allTextContents();
  expect(sources.every((s) => s === 'adzuna')).toBe(true);
  const badges = await page.locator('[data-rule]').evaluateAll((els) =>
    els.map((e) => e.getAttribute('data-rule')),
  );
  expect(badges.length).toBeGreaterThan(0);
  expect(badges.every((s) => s === 'relevant')).toBe(true);
});
