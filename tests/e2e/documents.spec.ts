import { test, expect, type Page } from '@playwright/test';

/**
 * S5 T8 — Documents section on the job detail page (superdesign variant A:
 * versioned accordion). The e2e seed inserts two artifact versions on the
 * FIRST relevant job — the row a `/?rule=relevant` first-title click opens
 * (page order: posted_at desc, canonical_hash asc): resume v1 valid,
 * cover_letter v1 invalid. All content is synthetic — no real PII (G1).
 */

async function openSeededJob(page: Page): Promise<void> {
  await page.goto('/?rule=relevant');
  const link = page.getByTestId('jobs-table').locator('tbody a[href^="/job/"]').first();
  await link.click();
  await page.waitForURL(/\/job\/[0-9a-f-]{36}/);
  await expect(page.getByTestId('documents')).toBeVisible();
}

test('documents section lists seeded versions with status flags and generate buttons', async ({ page }) => {
  await openSeededJob(page);

  const rows = page.getByTestId('documents').getByTestId('artifact-row');
  // S21: the DB accumulates render history — assert on the seeded rows'
  // presence, not a global count (row textContent is spaceless between spans).
  const resumeRow = rows.filter({ hasText: /^Resume v1(?!\d)/ });
  const coverRow = rows.filter({ hasText: /^Cover letter v1(?!\d)/ });
  await expect(resumeRow).toHaveCount(1);
  await expect(coverRow).toHaveCount(1);
  // invalid version is flagged in the row itself
  await expect(coverRow).toContainText('Validation failed');

  // generate buttons present and enabled — never clicked against the real LLM
  await expect(page.getByTestId('generate-resume')).toBeEnabled();
  await expect(page.getByTestId('generate-cover')).toBeEnabled();
  await expect(page.getByTestId('generate-both')).toBeEnabled();
});

test('invalid artifact opens a violations banner with a Regenerate button', async ({ page }) => {
  await openSeededJob(page);

  await page.getByTestId('artifact-row').filter({ hasText: 'Cover letter' }).click();
  const banner = page.getByTestId('violations');
  await expect(banner).toBeVisible();
  await expect(banner).toContainText('word_limit: 342 words exceeds the 300 word limit');
  await expect(page.getByTestId('regenerate')).toBeEnabled();
});

test('valid artifact opens the inline preview with its content', async ({ page }) => {
  await openSeededJob(page);
  await expect(page.getByTestId('artifact-content')).toHaveCount(0);

  await page.getByTestId('artifact-row').filter({ hasText: /^Resume v/ }).click();
  const preview = page.getByTestId('artifact-content');
  await expect(preview).toBeVisible();
  await expect(preview).toContainText('Summary');
  await expect(preview).toContainText('platform serving 40k users'); // synthetic marker bullet
});

test('accordion keeps one preview open and the invalid row exposes its violations', async ({ page }) => {
  await openSeededJob(page);

  await page.getByTestId('artifact-row').filter({ hasText: /^Resume v/ }).click();
  await expect(page.getByTestId('artifact-content')).toBeVisible();
  await expect(page.getByTestId('violations')).toHaveCount(0);

  await page.getByTestId('artifact-row').filter({ hasText: 'Cover letter' }).click();
  await expect(page.getByTestId('violations')).toBeVisible();
  await expect(page.getByTestId('violations')).toContainText('word_limit: 342 words exceeds the 300 word limit');
  await expect(page.getByTestId('artifact-content')).toHaveCount(1); // one at a time
});

test('documents section visual snapshot (masked layout gate, preview closed)', async ({ page }) => {
  await openSeededJob(page);
  // Scrollbars render differently per OS (see s1a snapshot) — hide them for
  // the pixel gate; the gate protects layout chrome, text is masked for font
  // determinism and PII never renders with the preview closed.
  await page.addStyleTag({
    content: '* { scrollbar-width: none !important } *::-webkit-scrollbar { width: 0 !important; display: none !important }',
  });
  // The section sits below the Details block — pin its top to the viewport top
  // so the pixel gate actually covers the Documents layout (S1a discipline:
  // text-bearing boxes masked, frames/spacing gated).
  await page.getByTestId('documents').evaluate((el) => el.scrollIntoView({ block: 'start' }));
  await expect(page).toHaveScreenshot('s5-documents.png', {
    mask: [
      page.locator('main > div').first(), // whole heading row (s1a convention)
      page.locator('article h2'), // job title
      page.locator('article > div').first(), // employer · location · source · date meta
      page.getByRole('link', { name: /Open original posting/ }),
      page.locator('article section').first(), // Details fields (all text)
      page.locator('article > div').nth(1), // status row + move buttons
      page.getByTestId('documents').locator('h3, p'), // section header + subtitle text
      page.getByTestId('versions-label'), // static caption text (OS font raster)
      page.getByTestId('documents').locator('button'), // generate buttons + version rows (dates)
      page.getByTestId('generate-error'), // defensive no-op when absent
      page.getByTestId('violations'), // defensive no-op (preview closed)
      page.getByTestId('artifact-content'), // PII mask anchor (closed → no-op)
      page.locator('article section').nth(2), // long description text below the section
    ],
    maskColor: '#1a2f4a',
  });
});

test('valid artifact exposes DOCX/PDF downloads and render rows appear', async ({ page }) => {
  await openSeededJob(page);

  await page.getByTestId('artifact-row').filter({ hasText: /^Resume v/ }).click();
  const docxButton = page.getByTestId('download-docx');
  const pdfButton = page.getByTestId('download-pdf');
  await expect(docxButton).toBeEnabled();
  await expect(pdfButton).toBeEnabled();

  // DOCX download: the render endpoint runs (no LLM), then the file download starts.
  const docxDownload = page.waitForEvent('download');
  await docxButton.click();
  expect((await docxDownload).suggestedFilename()).toMatch(/^resume-v\d+\.docx$/);

  // Render rows appear in the version list (S21: the list may already hold
  // history rows from earlier tests/retries — relative assertions only).
  const rows = page.getByTestId('documents').getByTestId('artifact-row');
  await expect(rows.filter({ hasText: 'Resume · DOCX' }).first()).toBeVisible();
  await expect(rows.filter({ hasText: 'Resume · PDF' }).first()).toBeVisible();
});

test('render history: repeated renders append downloadable versions (S21)', async ({ page }) => {
  await openSeededJob(page);

  await page.getByTestId('artifact-row').filter({ hasText: /^Resume v/ }).click();
  const docxButton = page.getByTestId('download-docx');
  const rows = page.getByTestId('documents').getByTestId('artifact-row');

  // First render (this test's own baseline).
  let download = page.waitForEvent('download');
  await docxButton.click();
  expect((await download).suggestedFilename()).toMatch(/^resume-v\d+\.docx$/);
  const before = await rows.filter({ hasText: 'Resume · DOCX' }).count();
  expect(before).toBeGreaterThanOrEqual(1);

  // Second render appends a NEW version row (upsert-free history).
  download = page.waitForEvent('download');
  await docxButton.click();
  expect((await download).suggestedFilename()).toMatch(/^resume-v\d+\.docx$/);
  await expect(rows.filter({ hasText: 'Resume · DOCX' })).toHaveCount(before + 1);

  // Historical versions stay downloadable: click the OLDEST render row.
  // (Row textContent is spaceless between spans — digit-lookahead, not \b.)
  const oldest = rows.filter({ hasText: /Resume · DOCX v1(?!\d)/ }).first();
  await expect(oldest).toBeVisible();
  const historyDownload = page.waitForEvent('download');
  await oldest.click();
  expect((await historyDownload).suggestedFilename()).toMatch(/^resume-v1\.docx$/);
});

test('stale preview responses are discarded when switching rows quickly (S22)', async ({ page }) => {
  await openSeededJob(page);

  // Delay only the FIRST preview fetch (the resume row clicked below); the
  // cover fetch returns fast. The slow resume response must be discarded.
  let delayed = false;
  await page.route('**/api/artifacts/*', async (route) => {
    if (!delayed) {
      delayed = true;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    await route.continue();
  });

  await page.getByTestId('artifact-row').filter({ hasText: /^Resume v/ }).click();
  await page.getByTestId('artifact-row').filter({ hasText: /^Cover letter v/ }).click();

  const preview = page.getByTestId('artifact-content');
  await expect(preview).toContainText('Dear Hiring Manager'); // fast cover content wins
  // resume-only bullet (the synthetic cover letter shares the 40k-users phrase!)
  await expect(preview).not.toContainText('Cut batch reporting latency');
});

test('generate network failure surfaces an error message (S22)', async ({ page }) => {
  await openSeededJob(page);
  await page.route('**/api/jobs/*/generate', (route) => route.abort());
  await page.getByTestId('generate-resume').click();
  // The fetch rejection must surface in the error box, not vanish.
  await expect(page.getByTestId('generate-error')).toBeVisible();
});

test('generate error path surfaces the API message (402 daily cap)', async ({ page }) => {
  await openSeededJob(page);
  await page.route('**/api/jobs/*/generate', (route) =>
    route.fulfill({ status: 402, body: JSON.stringify({ error: 'daily generation limit reached' }) }),
  );
  await page.getByTestId('generate-both').click();
  await expect(page.getByTestId('generate-error')).toContainText('daily generation limit reached');
  await expect(page.getByTestId('generate-both')).toBeEnabled(); // busy state reset
});

test('generate error path surfaces the API message (409 not eligible)', async ({ page }) => {
  await openSeededJob(page);
  await page.route('**/api/jobs/*/generate', (route) =>
    route.fulfill({ status: 409, body: JSON.stringify({ error: 'job is excluded by the eligibility rules' }) }),
  );
  await page.getByTestId('generate-resume').click();
  await expect(page.getByTestId('generate-error')).toContainText('job is excluded by the eligibility rules');
});
