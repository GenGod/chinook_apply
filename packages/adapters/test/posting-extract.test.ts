import { describe, it, expect } from 'vitest';
import { extractPosting } from '../src/posting-fetcher.js';

// S23 R1/R2: extraction against the CURRENT live Job Bank markup (captured
// 2026-10-01, trimmed synthetic fixture — no real PII). The old markers
// (jobpostjobdescription / job-description / <article>) no longer exist.

const LIVE_MARKUP = `<!doctype html>
<html><body>
<nav>site navigation</nav>
<section class="job-posting-content row">
  <div class="job-posting-details col-md-12">
    <div class="job-posting-details-body col-md-9">
      <p>Terms of Employment: Full Time, Permanent</p>
      <p>Responsibilities: Write, modify, integrate and test software code. Maintain existing computer programs.</p>
    </div>
    <div class="job-posting-detail-apply">
      <a href="mailto:careers@fixture.example?Subject=developer">careers@fixture.example</a>
    </div>
  </div>
</section>
<footer>footer text</footer>
</body></html>`;

const NO_APPLY = LIVE_MARKUP.replace(
  /<div class="job-posting-detail-apply">[\s\S]*?<\/div>/,
  '<div class="job-posting-detail-apply"><p>Apply through the employer website.</p></div>',
);

const OLD_MARKUP = `<!doctype html>
<html><body>
<div class="outer"><div class="jobpostjobdescription"><p>Legacy description block with enough text to be returned by the legacy marker path.</p></div></div>
</body></html>`;

describe('extractPosting (S23)', () => {
  it('extracts the description from the current job-posting-content section', () => {
    const result = extractPosting(LIVE_MARKUP);
    expect(result.description).toContain('Terms of Employment');
    expect(result.description).toContain('Write, modify, integrate');
    expect(result.description).not.toContain('site navigation');
    expect(result.description).not.toContain('footer text');
  });

  it('captures a static apply email from the apply block (mailto and text)', () => {
    const result = extractPosting(LIVE_MARKUP);
    expect(result.applyEmail).toBe('careers@fixture.example');
  });

  it('returns null applyEmail when the apply block has no address', () => {
    const result = extractPosting(NO_APPLY);
    expect(result.applyEmail).toBeNull();
    expect(result.description).toContain('Terms of Employment');
  });

  it('legacy markers still work as fallback', () => {
    const result = extractPosting(OLD_MARKUP);
    expect(result.description).toContain('Legacy description block');
    expect(result.applyEmail).toBeNull();
  });
});
