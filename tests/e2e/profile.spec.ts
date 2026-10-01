import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * S11 — /profile workspace e2e. The seed registers one source with two facts
 * (skill + certification) and the webServer runs against the ISOLATED fixture
 * master (MASTER_PROFILE_PATH under data/artifacts-e2e) — the real PII profile
 * is never touched by the approve.
 */

const FIXTURE_MASTER = join(process.cwd(), '..', 'data', 'artifacts-e2e', 'master-profile-e2e.json');

test('profile page lists sources and builds a proposal with excerpts', async ({ page }) => {
  await page.goto('/profile');

  const sources = page.getByTestId('profile-sources');
  await expect(sources).toBeVisible();
  await expect(sources).toContainText('e2e-fixture-resume.txt');
  await expect(sources).toContainText('facts'); // count accumulates across CI re-runs (append-only fixtures)
  await expect(sources).toContainText('Master profile version:');

  await page.getByTestId('profile-build').click();
  const proposal = page.getByTestId('profile-proposal');
  await expect(proposal).toBeVisible();
  await expect(proposal).toContainText('add_skill');
  await expect(proposal).toContainText('E2EFixtureLang');
  await expect(proposal).toContainText('add_certification');
  await expect(proposal).toContainText('E2E Fixture Cert');
  // provenance excerpts render next to the entries
  await expect(proposal).toContainText('Skills: E2EFixtureLang');
});

test('approve applies additions to the fixture master and empties the diff', async ({ page }) => {
  await page.goto('/profile');
  await page.getByTestId('profile-build').click();
  const proposal = page.getByTestId('profile-proposal');
  await expect(proposal).toContainText('add_skill');
  const approveBtn = page.getByTestId('profile-approve');
  await expect(approveBtn).toBeEnabled();

  await approveBtn.click();
  await expect(page.getByTestId('profile-notice')).toContainText('master profile v2');

  const after = JSON.parse(await readFile(FIXTURE_MASTER, 'utf8')) as {
    version: number;
    skills: Record<string, string[]>;
    certifications: Array<{ name: string }>;
  };
  expect(after.version).toBe(2);
  expect(after.skills.languages).toContain('E2EFixtureLang');
  expect(after.certifications?.[0]?.name).toBe('E2E Fixture Cert');

  // rebuild → nothing left to apply
  await page.getByTestId('profile-build').click();
  await expect(page.getByTestId('profile-proposal')).toContainText('Nothing to add');
});

test('profile page visual snapshot (masked chrome)', async ({ page }) => {
  await page.goto('/profile');
  await expect(page.getByTestId('profile-sources')).toBeVisible();
  await page.addStyleTag({
    content: '* { scrollbar-width: none !important } *::-webkit-scrollbar { width: 0 !important; display: none !important }',
  });
  await page.getByTestId('profile-sources').evaluate((el) => el.scrollIntoView({ block: 'start' }));
  await expect(page).toHaveScreenshot('s11-profile.png', {
    mask: [
      page.locator('main h1'),
      page.locator('main > p'),
    ],
    maskColor: '#1a2f4a',
  });
});
