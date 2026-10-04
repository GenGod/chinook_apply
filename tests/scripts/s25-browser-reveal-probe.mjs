// S25 diagnostic probe (manual): reveal the apply panel with a REAL browser
// (Playwright chromium) — same user-visible action as clicking the button.
// Read-only: one page load + one click. Nothing is submitted anywhere.
// Usage: npx tsx tests/scripts/s25-browser-reveal-probe.mjs <postingUrl>
const url = process.argv[2];
if (!url || !/^https:\/\/www\.jobbank\.gc\.ca\/jobsearch\/jobposting\/\d+$/.test(url)) {
  console.error('usage: npx tsx tests/scripts/s25-browser-reveal-probe.mjs <postingUrl>');
  process.exit(2);
}

const { chromium } = await import('@playwright/test');

const browser = await chromium.launch();
try {
  const page = await browser.newPage();
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45_000 });

  const direct = await page.locator('#applynowbutton').count();
  const partner = await page.locator('#externalJobLink').count();
  console.log(`classify: direct=${direct} partner=${partner}`);
  if (direct === 0) {
    console.log(partner > 0 ? 'RESULT: partner posting (external link present)' : 'RESULT: unknown page');
    process.exit(0);
  }

  // The real user action: click the site's own button.
  await page.locator('#applynowbutton').click();
  try {
    await page.waitForSelector('#howtoapply', { timeout: 15_000 });
  } catch {
    console.log('RESULT: panel did NOT expand after button click (browser path also throttled)');
    process.exit(0);
  }

  const panel = page.locator('#howtoapply');
  const text = (await panel.innerText()).replace(/\s+/g, ' ').slice(0, 600);
  console.log('RESULT: panel EXPANDED in browser');
  console.log('PANEL TEXT:', text);
} finally {
  await browser.close();
}
