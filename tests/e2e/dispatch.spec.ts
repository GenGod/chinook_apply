import { test, expect, type Page } from '@playwright/test';

/**
 * S8 — Email dispatch section on the job detail page. The seed creates render
 * fixtures (docx/pdf files + rows) on the FIRST relevant job; Mailpit (compose
 * service, :8025) catches the sent message — nothing leaves the machine, and
 * DISPATCH_MODE=dry-run rewrites the envelope to dispatch-sink@localhost.
 */

// Node's fetch resolves localhost to ::1 first; GitHub service containers
// bind 127.0.0.1 — pin IPv4 unless the environment overrides it.
const MAILPIT = process.env.MAILPIT_URL ?? 'http://127.0.0.1:8025';
const RECIPIENT = 'jobs@fixture-e2e.example';

async function openSeededJob(page: Page): Promise<void> {
  await page.goto('/?rule=relevant');
  const link = page.getByTestId('jobs-table').locator('tbody a[href^="/job/"]').first();
  await link.click();
  await page.waitForURL(/\/job\/[0-9a-f-]{36}/);
  await expect(page.getByTestId('dispatch')).toBeVisible();
}

test('dispatch section exposes the package: recipient, attachments, one-time send', async ({ page }) => {
  await openSeededJob(page);

  // Recipient input is empty for fixture jobs (no emails in raw) — typed in.
  await page.getByTestId('dispatch-recipient').fill(RECIPIENT);

  // Both seeded render fixtures offered, checked by default.
  const docx = page.getByTestId('dispatch-attach-render_docx');
  const pdf = page.getByTestId('dispatch-attach-render_pdf');
  await expect(docx).toBeChecked();
  await expect(pdf).toBeChecked();

  await expect(page.getByTestId('dispatch-send')).toBeEnabled();
});

test('send delivers the package to Mailpit (dry-run) and shows success', async ({ page }) => {
  await openSeededJob(page);
  await page.getByTestId('dispatch-recipient').fill(RECIPIENT);

  // Clear Mailpit for a deterministic assertion window.
  await fetch(`${MAILPIT}/api/v1/messages`, { method: 'DELETE' });

  await page.getByTestId('dispatch-send').click();
  await expect(page.getByTestId('dispatch-success')).toContainText('Sent ✓');

  // The message reached Mailpit with the right header, subject and attachments.
  const list = (await (await fetch(`${MAILPIT}/api/v1/messages`)).json()) as {
    messages: Array<{ ID: string; To: Array<{ Address: string }>; Subject: string; Attachments: number }>;
  };
  const sent = list.messages.find((m) => m.To.some((t) => t.Address === RECIPIENT));
  expect(sent).toBeTruthy();
  expect(sent!.Subject).toContain('Application for');
  expect(sent!.Attachments).toBe(2); // summary counts attachments
});

test('dispatch errors surface in the section (invalid recipient)', async ({ page }) => {
  await openSeededJob(page);
  await page.getByTestId('dispatch-recipient').fill('not-an-email');
  await page.getByTestId('dispatch-send').click();
  await expect(page.getByTestId('dispatch-error')).toBeVisible();
});
