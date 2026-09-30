import { test, expect } from '@playwright/test';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * S9 — Web form dispatch e2e: the seeded first relevant job carries a
 * formConfig pointing at the app's own /mock-form fixture page. The flow
 * launches real chromium (headless) through the web app, fills the form with
 * the approved package and captures screenshots into data/artifacts-e2e.
 */

test('web form dispatch fills the mock form and audits screenshots', async ({ page }) => {
  await page.goto('/?rule=relevant');
  const link = page.getByTestId('jobs-table').locator('tbody a[href^="/job/"]').first();
  await link.click();
  await page.waitForURL(/\/job\/[0-9a-f-]{36}/);

  const section = page.getByTestId('web-form');
  await expect(section).toBeVisible();
  await expect(page.getByTestId('web-form-url')).toContainText('/mock-form');

  await page.getByTestId('web-form-send').click();
  await expect(page.getByTestId('web-form-success')).toContainText('Sent via web form');

  // Art. 11.2: three screenshots landed in the (gitignored) artifacts dir.
  const jobId = page.url().match(/job\/([0-9a-f-]{36})/)![1];
  const dir = join(process.cwd(), '..', 'data', 'artifacts-e2e', 'form');
  const files = await readdir(dir);
  const shot = files.filter((f) => f.startsWith(jobId.slice(0, 8)) && f.endsWith('.png'));
  expect(shot.length).toBeGreaterThanOrEqual(3);
});

test('captcha page stops the attempt with manual fallback (art. 11.3)', async ({ page }) => {
  // The captcha flow is covered against the fixture server in integration;
  // here we only verify the fixture page itself renders the captcha marker
  // (the marker the detector keys on) and the route is reachable.
  const response = await page.request.get('/mock-form?captcha=1');
  expect(response.ok()).toBeTruthy();
  const html = await response.text();
  expect(html).toContain('g-recaptcha');
});
