import { afterEach, describe, expect, it } from 'vitest';
import { crawlerUserAgent } from '../src/user-agent.js';

const ENV_KEY = 'CRAWLER_CONTACT_EMAIL';

describe('crawlerUserAgent (contact via env — no hardcoded PII)', () => {
  afterEach(() => {
    delete process.env[ENV_KEY];
  });

  it('appends the contact clause from CRAWLER_CONTACT_EMAIL when set', () => {
    process.env[ENV_KEY] = 'ops@example.org';
    const ua = crawlerUserAgent();
    expect(ua).toContain('contact: ops@example.org');
    expect(ua).toMatch(/^Chinook\//);
  });

  it('omits any contact when the env var is unset — no email in the code', () => {
    delete process.env[ENV_KEY];
    const ua = crawlerUserAgent();
    expect(ua).not.toContain('@');
    expect(ua).not.toContain('contact:');
    expect(ua).toMatch(/^Chinook\/0\.1 \(personal job-search automation\)$/);
  });

  it('does not build the string from a hardcoded literal email', () => {
    delete process.env[ENV_KEY];
    expect(crawlerUserAgent()).not.toContain('gmail.com');
  });
});
