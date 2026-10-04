import { test, expect } from '@playwright/test';

/**
 * S25 — Apply methods (Job Bank) on the job detail page. The seeded first
 * relevant job carries a FRESH applyMethods cache (revealedAt = now), so the
 * reveal endpoint answers 'cached' and NO network call to Job Bank happens in
 * e2e (the live-reveal path is covered in integration against a local server).
 */

async function openSeededJob(page: import('@playwright/test').Page): Promise<void> {
  await page.goto('/?rule=relevant');
  const link = page.getByTestId('jobs-table').locator('tbody a[href^="/job/"]').first();
  await link.click();
  await page.waitForURL(/\/job\/[0-9a-f-]{36}/);
}

test('apply methods section shows revealed email, questions and direct-apply note', async ({ page }) => {
  await openSeededJob(page);

  const section = page.getByTestId('apply-methods');
  await expect(section).toBeVisible();
  await expect(section).toContainText('apply@fixture-e2e.example');
  await expect(section).toContainText('Direct Apply');
  await expect(section).toContainText('valid driver');
  await expect(section).toContainText('References attesting experience');

  // S25 R5: the revealed email prefills the email-dispatch recipient
  // (same address as the S23 fixture — contract unchanged for prefill).
  await expect(page.getByTestId('dispatch-recipient')).toHaveValue('apply@fixture-e2e.example');
});

test('re-check answers from the cache without network and keeps the section stable', async ({ page }) => {
  await openSeededJob(page);
  await page.getByTestId('apply-methods-refresh').click();
  await expect(page.getByTestId('apply-methods-status')).toContainText('saved methods');
  await expect(page.getByTestId('apply-methods')).toContainText('apply@fixture-e2e.example');
});

test('dispatch auto-reveal: send without a typed recipient resolves the revealed email (dry-run)', async ({ page }) => {
  await openSeededJob(page);
  // Clear the recipient: the /dispatch route must resolve it from applyMethods.
  await page.getByTestId('dispatch-recipient').fill('');
  await page.getByTestId('dispatch-send').click();
  await expect(page.getByTestId('dispatch-success')).toContainText('Sent ✓');
});

test('apply methods section visual baseline (S16/S17 tokens, B-011 threshold)', async ({ page }) => {
  await openSeededJob(page);
  const section = page.getByTestId('apply-methods');
  await expect(section).toBeVisible();
  await expect(section).toContainText('apply@fixture-e2e.example');
  await expect(section).toHaveScreenshot('s25-apply-methods.png', { threshold: 0.01 });
});

test('unrevealed state shows the Reveal button (visual baseline)', async ({ page }) => {
  // Детерминированно находим jobbank-вакансию БЕЗ кэша методов (сид кладёт
  // applyMethods только на первую relevant — она может быть adzuna-фикстурой).
  const res = await page.request.get('/api/jobs?source=jobbank&rule=relevant');
  const { jobs } = (await res.json()) as { jobs: Array<{ id: string; title: string }> };
  const fixture = jobs.find((j) => j.title.startsWith('S19 e2e'));
  expect(fixture, 'seed must contain an S19 jobbank row without applyMethods').toBeTruthy();
  await page.goto(`/job/${fixture!.id}`);

  const section = page.getByTestId('apply-methods');
  await expect(section).toBeVisible();
  await expect(section).not.toContainText('apply@fixture-e2e.example');
  await expect(page.getByTestId('apply-methods-reveal')).toBeVisible();
  await expect(section).toHaveScreenshot('s25-apply-methods-unrevealed.png', { threshold: 0.01 });
});
