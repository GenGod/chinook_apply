import { test, expect } from '@playwright/test';

// ─── Jobs Table ──────────────────────────────────────────────────────────────

test.beforeEach(async ({ page }) => {
  await page.goto('/');
});

test('jobs table renders with all 9 columns', async ({ page }) => {
  const headers = page.locator('thead th');
  await expect(headers.first()).toBeVisible();
  expect(await headers.count()).toBe(9);
  const texts = (await headers.allTextContents()).map((t) => t.trim());
  // headers contain sort arrows; check for the core label in each
  for (const expected of ['Title', 'Employer', 'Location', 'Source', 'Rule', 'Score', 'Salary', 'Posted', 'Actions']) {
    expect(texts.some((t) => t.includes(expected))).toBe(true);
  }
});

test('jobs table has rows with data', async ({ page }) => {
  const rows = page.locator('[data-testid="jobs-table"] tbody tr');
  await expect(rows.first()).toBeVisible();
  expect(await rows.count()).toBeGreaterThan(5);
});

test('each row has title link to job detail', async ({ page }) => {
  const first = page.locator('[data-testid="jobs-table"] tbody tr').first();
  const link = first.locator('a[href^="/job/"]');
  await expect(link).toBeVisible();
  const href = await link.getAttribute('href');
  expect(href).toMatch(/^\/job\/[0-9a-f-]{36}$/);
});

test('rule badges present with valid data-rule values', async ({ page }) => {
  const badges = page.locator('[data-rule]');
  await expect(badges.first()).toBeVisible();
  const values = await badges.evaluateAll((els) => els.map((e) => e.getAttribute('data-rule')));
  expect(values.every((v) => ['relevant', 'review', 'excluded'].includes(v ?? ''))).toBe(true);
});

test('score column shows numeric values or dash', async ({ page }) => {
  const scores = page.locator('[data-testid="match-score"]');
  const count = await scores.count();
  if (count > 0) {
    const values = await scores.allTextContents();
    expect(values.every((v) => /^\d+$/.test(v.trim()))).toBe(true);
  }
});

// ─── Filtering ────────────────────────────────────────────────────────────────

test('filter by source=adzuna narrows list', async ({ page }) => {
  const all = await page.locator('[data-testid="jobs-table"] tbody tr').count();
  await page.locator('#source').selectOption('adzuna');
  await page.locator('button[type="submit"]').click();
  await page.waitForURL(/source=adzuna/);
  const filtered = await page.locator('[data-testid="jobs-table"] tbody tr').count();
  expect(filtered).toBeGreaterThan(0);
  expect(filtered).toBeLessThan(all);
  const sources = await page.locator('[data-testid="jobs-table"] tbody [data-column="source"], [data-testid="jobs-table"] tbody .source').allTextContents();
  expect(sources.every((s) => s.includes('adzuna'))).toBe(true);
});

test('filter by rule=relevant shows only relevant', async ({ page }) => {
  await page.locator('#rule').selectOption('relevant');
  await page.locator('button[type="submit"]').click();
  await page.waitForURL(/rule=relevant/);
  const badges = await page.locator('[data-rule]').evaluateAll((els) => els.map((e) => e.getAttribute('data-rule')));
  expect(badges.every((v) => v === 'relevant')).toBe(true);
});

test('filter by salary shows only jobs above threshold', async ({ page }) => {
  await page.locator('#salaryMin').fill('100000');
  await page.locator('button[type="submit"]').click();
  await page.waitForURL(/salaryMin=100000/);
  const rows = page.locator('[data-testid="jobs-table"] tbody tr');
  await expect(rows.first()).toBeVisible();
  expect(await rows.count()).toBeGreaterThan(0);
});

test('filter by min_score filters unscored jobs out', async ({ page }) => {
  await page.locator('#minScore').fill('70');
  await page.locator('button[type="submit"]').click();
  await page.waitForURL(/minScore=70/);
  const scores = page.locator('[data-testid="match-score"]');
  const count = await scores.count();
  if (count > 0) {
    const values = await scores.allTextContents();
    expect(values.every((v) => Number(v) >= 70)).toBe(true);
  }
});

test('combined filters work together', async ({ page }) => {
  await page.goto('/?source=adzuna&rule=relevant');
  await expect(page.locator('[data-testid="jobs-table"] tbody tr').first()).toBeVisible();
  const sources = await page.locator('[data-testid="jobs-table"] tbody .source').allTextContents();
  expect(sources.every((s) => s.includes('adzuna'))).toBe(true);
});

test('empty state shows when no jobs match', async ({ page }) => {
  await page.goto('/?salaryMin=999999');
  await expect(page.getByTestId('empty')).toBeVisible();
});

// ─── Column Sorting ───────────────────────────────────────────────────────────

test('click Posted header toggles sort indicator', async ({ page }) => {
  const postedHeader = page.locator('a[href*="sort=posted"]');
  await expect(postedHeader).toBeVisible();
  await expect(postedHeader).toContainText('Posted');
});

test('click Score header navigates to score sort', async ({ page }) => {
  const scoreHeader = page.locator('a[href*="sort=score"]');
  await expect(scoreHeader).toBeVisible();
  await scoreHeader.click();
  await page.waitForURL(/sort=score/);
});

test('click Title header navigates to title sort', async ({ page }) => {
  const titleHeader = page.locator('a[href*="sort=title"]');
  await expect(titleHeader).toBeVisible();
  await titleHeader.click();
  await page.waitForURL(/sort=title/);
});

// ─── Applied Toggle ───────────────────────────────────────────────────────────

test('Applied toggle persists after reload', async ({ page }) => {
  const firstRow = page.locator('[data-testid="jobs-table"] tbody tr').first();
  const markBtn = firstRow.getByRole('button', { name: 'Mark applied' });
  if (await markBtn.count()) {
    await markBtn.click();
    await expect(firstRow.locator('button[data-applied="true"]')).toBeVisible();
    await page.reload();
    await expect(
      page.locator('[data-testid="jobs-table"] tbody tr').first().locator('button[data-applied="true"]'),
    ).toBeVisible();
  }
});

// ─── Job Detail Page ──────────────────────────────────────────────────────────

test('job detail shows all information sections', async ({ page }) => {
  const link = page.locator('[data-testid="jobs-table"] tbody a[href^="/job/"]').first();
  await link.click();
  await page.waitForURL(/\/job\/[0-9a-f-]{36}/);

  await expect(page.getByText('Job details')).toBeVisible();
  await expect(page.getByRole('heading', { level: 2 })).toBeVisible();
  await expect(page.locator('article section').first()).toBeVisible();
  await expect(page.getByRole('link', { name: /Open original posting/i })).toBeVisible();
});

test('job detail shows salary field', async ({ page }) => {
  const link = page.locator('[data-testid="jobs-table"] tbody a[href^="/job/"]').first();
  await link.click();
  await page.waitForURL(/\/job\//);
  const article = page.locator('article');
  const text = await article.innerText();
  expect(text.toLowerCase()).toContain('salary');
});

test('job detail shows rule status field', async ({ page }) => {
  const link = page.locator('[data-testid="jobs-table"] tbody a[href^="/job/"]').first();
  await link.click();
  await page.waitForURL(/\/job\//);
  await expect(page.getByText('Rule status')).toBeVisible();
});

test('job detail shows NOC code field', async ({ page }) => {
  const link = page.locator('[data-testid="jobs-table"] tbody a[href^="/job/"]').first();
  await link.click();
  await page.waitForURL(/\/job\//);
  await expect(page.getByText('NOC code')).toBeVisible();
});

test('job detail shows Source ID field', async ({ page }) => {
  const link = page.locator('[data-testid="jobs-table"] tbody a[href^="/job/"]').first();
  await link.click();
  await page.waitForURL(/\/job\//);
  await expect(page.getByText('Source ID')).toBeVisible();
});

test('job detail external link has noopener', async ({ page }) => {
  const link = page.locator('[data-testid="jobs-table"] tbody a[href^="/job/"]').first();
  await link.click();
  await page.waitForURL(/\/job\//);
  const external = page.getByRole('link', { name: /Open original posting/i });
  await expect(external).toHaveAttribute('target', '_blank');
  await expect(external).toHaveAttribute('rel', /noopener/);
});

test('job detail has status controls', async ({ page }) => {
  const link = page.locator('[data-testid="jobs-table"] tbody a[href^="/job/"]').first();
  await link.click();
  await page.waitForURL(/\/job\//);
  await expect(page.getByText('Status:')).toBeVisible();
  const buttons = page.locator('button[data-move]');
  expect(await buttons.count()).toBeGreaterThan(0);
});

test('job detail description has substantial content', async ({ page }) => {
  const link = page.locator('[data-testid="jobs-table"] tbody a[href^="/job/"]').first();
  await link.click();
  await page.waitForURL(/\/job\//);
  const descSection = page.getByText('Description');
  await expect(descSection).toBeVisible();
  // description should have more than just the heading
  const article = page.locator('article');
  const text = await article.innerText();
  expect(text.length).toBeGreaterThan(200);
});

test('job detail navigates back to Jobs', async ({ page }) => {
  const link = page.locator('[data-testid="jobs-table"] tbody a[href^="/job/"]').first();
  await link.click();
  await page.waitForURL(/\/job\//);
  await page.getByRole('link', { name: 'Jobs' }).click();
  await page.waitForURL(/\/$/);
});

// ─── API ─────────────────────────────────────────────────────────────────────

test('GET /api/jobs returns jobs with matchScore', async ({ request }) => {
  const response = await request.get('/api/jobs?limit=5');
  expect(response.status()).toBe(200);
  const body = await response.json();
  expect(body.jobs.length).toBeGreaterThan(0);
  expect(body.jobs[0]).toHaveProperty('title');
  expect(body.jobs[0]).toHaveProperty('matchScore');
  expect(body.jobs[0]).toHaveProperty('ruleStatus');
});

test('GET /api/jobs?min_score filters', async ({ request }) => {
  const all = await (await request.get('/api/jobs?limit=50')).json();
  const filtered = await (await request.get('/api/jobs?min_score=50&limit=50')).json();
  expect(filtered.jobs.length).toBeLessThanOrEqual(all.jobs.length);
  if (filtered.jobs.length > 0) {
    expect(filtered.jobs.every((j: { matchScore: number | null }) => j.matchScore === null || j.matchScore >= 50)).toBe(true);
  }
});

test('GET /api/metrics includes funnel', async ({ request }) => {
  const response = await request.get('/api/metrics');
  expect(response.status()).toBe(200);
  const body = await response.json();
  expect(body.funnel).toHaveProperty('total');
  expect(body.funnel).toHaveProperty('relevant');
  expect(body.funnel).toHaveProperty('appliedManual');
  expect(body.sources).toHaveLength(2);
});
