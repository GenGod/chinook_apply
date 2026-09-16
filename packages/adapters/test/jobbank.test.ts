import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { jobbankAdapter } from '../src/jobbank.js';

const feed = readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures/jobbank/feed.xml'),
  'utf8',
);

describe('jobbank adapter (Atom feed)', () => {
  it('parses the fixture feed into RawJobs', async () => {
    const raws = await jobbankAdapter.parse(feed);
    expect(raws.length).toBeGreaterThanOrEqual(10);
  });

  it('extracts employer, location, salary from summary HTML', async () => {
    const raws = await jobbankAdapter.parse(feed);
    const first = raws[0]!;
    expect(first.employer.length).toBeGreaterThan(0);
    expect(first.locationRaw).toMatch(/\([A-Z]{2}\)/);
    expect(first.url).toContain('jobbank.gc.ca/jobsearch/jobposting/');
    expect(first.postedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  });

  it('parses annual salary "55,000.00 to 65,000.00 annually"', async () => {
    const raws = await jobbankAdapter.parse(feed);
    const annual = raws.find((r) => r.salaryPeriod === 'annual');
    if (annual) {
      expect(annual.salaryMin).toBeLessThanOrEqual(annual.salaryMax!);
      expect(annual.salaryMin).toBeGreaterThan(1000);
    }
  });

  it('parses hourly salary and adapter reports hourly period', async () => {
    const raws = await jobbankAdapter.parse(feed);
    const hourly = raws.find((r) => r.salaryPeriod === 'hourly');
    if (hourly) {
      expect(hourly.salaryMin).toBeGreaterThan(10);
      expect(hourly.salaryMin).toBeLessThan(200);
    }
  });
});
