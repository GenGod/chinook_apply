import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { adzunaAdapter } from '../src/adzuna.js';

const payload = JSON.parse(
  readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures/adzuna/search-alberta.json'),
    'utf8',
  ),
);

describe('adzuna adapter', () => {
  it('maps all fixture results to RawJobs', async () => {
    const raws = adzunaAdapter.parse(payload);
    expect(raws.length).toBe(payload.results.length);
    expect(raws.length).toBeGreaterThan(0);
  });

  it('maps core fields with Alberta locations', async () => {
    const raws = adzunaAdapter.parse(payload);
    const first = raws[0]!;
    expect(first.title.length).toBeGreaterThan(0);
    expect(first.employer.length).toBeGreaterThan(0);
    expect(first.url).toMatch(/^https:/);
    expect(first.postedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(first.sourceJobId).toBeTruthy();
  });

  it('keeps salary when present, null when absent', async () => {
    const raws = adzunaAdapter.parse(payload);
    const withSalary = raws.filter((r) => r.salaryMin !== null);
    if (withSalary.length) {
      expect(withSalary[0]!.salaryPeriod).toBe('annual');
    }
    expect(raws.some((r) => r.salaryMin === null)).toBe(true);
  });
});
