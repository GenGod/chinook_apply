import { describe, it, expect } from 'vitest';
import { normalizeTitle, normalizeEmployer, parseLocation, normalizeJob } from '../src/index.js';

describe('normalizeTitle', () => {
  it('lowercases, strips punctuation, collapses whitespace', () => {
    expect(normalizeTitle('  Senior   Full-Stack Engineer! ')).toBe('senior full stack engineer');
  });
  it('folds diacritics (NFD)', () => {
    expect(normalizeTitle('Développeur Logiciel')).toBe('developpeur logiciel');
  });
  it('is idempotent', () => {
    const once = normalizeTitle('QA / SDET (Remote-friendly)');
    expect(normalizeTitle(once)).toBe(once);
  });
});

describe('normalizeEmployer', () => {
  it('normalizes like title and drops legal suffix noise', () => {
    expect(normalizeEmployer('Acme Corp. Inc.')).toBe('acme');
    expect(normalizeEmployer('Voki Games LTD')).toBe('voki games');
  });
});

describe('parseLocation', () => {
  it('parses Job Bank style "Calgary (AB)"', () => {
    expect(parseLocation('Calgary (AB)')).toEqual({ city: 'calgary', province: 'AB', remote: false });
  });
  it('parses Adzuna style "Calgary, Alberta, Canada"', () => {
    expect(parseLocation('Calgary, Alberta, Canada')).toEqual({ city: 'calgary', province: 'AB', remote: false });
  });
  it('flags remote', () => {
    expect(parseLocation('Remote')).toEqual({ city: '', province: '', remote: true });
    expect(parseLocation('Toronto (ON) (remote)')).toMatchObject({ city: 'toronto', remote: true });
  });
  it('unknown location passes through as city with empty province', () => {
    expect(parseLocation('Somewhere')).toEqual({ city: 'somewhere', province: '', remote: false });
  });
});

describe('normalizeJob', () => {
  const base = {
    title: 'Software Developer',
    employer: 'Acme Corp.',
    locationRaw: 'Edmonton (AB)',
    url: 'https://example.com/1',
    postedAt: '2026-09-15T11:00:00Z',
    salaryMin: 30,
    salaryMax: 40,
    salaryPeriod: 'hourly' as const,
    sourceJobId: '123',
    raw: { x: 1 },
  };
  it('produces a contract-valid Job with annualized CAD salary', () => {
    const job = normalizeJob(base, 'jobbank');
    expect(job.canonicalHash).toMatch(/^canonical_v1:/);
    expect(job.location).toEqual({ city: 'edmonton', province: 'AB', remote: false });
    expect(job.salaryMin).toBe(30 * 2080);
    expect(job.salaryMax).toBe(40 * 2080);
    expect(job.salaryCurrency).toBe('CAD');
    expect(job.urls).toEqual(['https://example.com/1']);
    expect(job.source).toBe('jobbank');
  });
  it('keeps annual salary as-is', () => {
    const job = normalizeJob({ ...base, salaryPeriod: 'annual', salaryMin: 100000, salaryMax: 120000 }, 'adzuna');
    expect(job.salaryMin).toBe(100000);
    expect(job.salaryMax).toBe(120000);
  });
});
