import { test, expect } from '@playwright/test';

test('jobs table renders fixture rows (S1a AC3)', async ({ page }) => {
  await page.goto('/');
  const rows = page.getByTestId('jobs-table').locator('tbody tr');
  await expect(rows.first()).toBeVisible();
  expect(await rows.count()).toBeGreaterThan(10);
});

test('title opens local preview; external arrow opens provider in a new tab (S20 AC1/AC2)', async ({ page }) => {
  await page.goto('/');
  const title = page.getByTestId('jobs-table').locator('tbody tr td:first-child a').first();
  expect(await title.getAttribute('target')).toBeNull(); // internal navigation, no _blank
  await title.click();
  await page.waitForURL(/\/job\/[0-9a-f-]{36}/);
  await page.goBack();
  const arrow = page.getByTestId('jobs-table').locator('tbody [data-testid="apply-external"]').first();
  await expect(arrow).toHaveAttribute('target', '_blank');
  await expect(arrow).toHaveAttribute('rel', /noopener/);
  expect(await arrow.getAttribute('href')).toMatch(/^https?:\/\//);
});

test('job preview shows the full untruncated description with paragraphs (S20 AC3)', async ({ page }) => {
  await page.goto('/?province=ON');
  // fixture ON jobs are posted later and sort first — target the synthetic by name
  await page.getByRole('link', { name: 'S19 e2e Ontario developer' }).click();
  await page.waitForURL(/\/job\/[0-9a-f-]{36}/);
  const description = page.locator('main article section p').last();
  const text = (await description.textContent()) ?? '';
  expect(text.length).toBeGreaterThan(1200); // no truncation (fixtures are ≤500)
  expect(text).toContain('\n'); // paragraph breaks preserved
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
  expect(body.status).toBe('applied');
  expect(body.channel).toBe('manual');
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
      // whole field boxes (div) and labels: native select glyph AA can bleed
      // past the control box on some platforms — the fixed field box absorbs it
      page.getByTestId('filters').locator('div'),
      page.getByTestId('filters').locator('label'),
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

test('API province filter narrows strictly; invalid is ignored (S19 AC5)', async ({ request }) => {
  const on = await (await request.get('/api/jobs?province=ON&limit=100')).json();
  expect(on.jobs.length).toBeGreaterThan(0);
  expect(on.jobs.every((j: { location: { province: string } }) => j.location.province === 'ON')).toBe(true);
  // strict: remote jobs (province '') are not in the ON slice
  expect(on.jobs.some((j: { location: { remote: boolean } }) => j.location.remote)).toBe(false);

  const remote = await (await request.get('/api/jobs?province=REMOTE&limit=100')).json();
  expect(remote.jobs.length).toBeGreaterThan(0);
  expect(remote.jobs.every((j: { location: { remote: boolean } }) => j.location.remote)).toBe(true);

  const bogus = await (await request.get('/api/jobs?province=XX&limit=100')).json();
  const all = await (await request.get('/api/jobs?limit=100')).json();
  expect(bogus.jobs.length).toBe(all.jobs.length); // invalid → ignored, no 4xx
});

test('API board filter narrows to province across columns (S19 AC4/AC5)', async ({ request }) => {
  const on = await (await request.get('/api/board?province=ON')).json();
  // earlier board.spec tests may move the synthetic card between columns —
  // the filter must hold in EVERY column (it applies to both board queries)
  const cards = on.columns.flatMap((c: { cards: Array<{ location: string }> }) => c.cards);
  expect(cards.length).toBeGreaterThan(0);
  expect(cards.every((c: { location: string }) => c.location.endsWith(', ON'))).toBe(true);
});

test('filter by province narrows the list to that province (S19 AC1)', async ({ page }) => {
  await page.goto('/');
  const all = await page.getByTestId('jobs-table').locator('tbody tr').count();
  await page.locator('#province').selectOption('ON');
  await page.getByRole('button', { name: 'Apply filters' }).click();
  await page.waitForURL(/province=ON/);
  const rows = page.getByTestId('jobs-table').locator('tbody tr');
  const filtered = await rows.count();
  expect(filtered).toBeGreaterThan(0);
  expect(filtered).toBeLessThan(all);
  // Location is column 3; strict filter → every cell is "city, ON" (no Remote cells)
  const cells = await rows.locator('td:nth-child(3)').allTextContents();
  expect(cells.every((c) => c.endsWith(', ON'))).toBe(true);
  expect(cells.some((c) => c === 'Remote')).toBe(false);
});

test('REMOTE option shows only remote jobs (S19 AC2)', async ({ page }) => {
  await page.goto('/?province=REMOTE');
  const cells = await page.getByTestId('jobs-table').locator('tbody tr td:nth-child(3)').allTextContents();
  expect(cells.length).toBeGreaterThan(0);
  expect(cells.every((c) => c === 'Remote')).toBe(true);
});

test('combined province+source+rule filter works (S19 AC3)', async ({ page }) => {
  await page.goto('/?province=ON&source=jobbank&rule=relevant');
  const rows = page.getByTestId('jobs-table').locator('tbody tr');
  expect(await rows.count()).toBeGreaterThan(0);
  const cells = await rows.locator('td:nth-child(3)').allTextContents();
  expect(cells.every((c) => c.includes('ON'))).toBe(true);
  const sources = await page.getByTestId('jobs-table').locator('tbody .source').allTextContents();
  expect(sources.every((s) => s === 'jobbank')).toBe(true);
});
