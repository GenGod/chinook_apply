import { describe, it, expect } from 'vitest';
import { applyRules, NOC_TITLE_FAMILIES, JUNIOR_MARKERS } from '../src/rules.js';
import type { Job } from '@chinook/contracts';

function job(p: Partial<Job>): Job {
  return {
    id: '00000000-0000-0000-0000-000000000000',
    canonicalHash: 'canonical_v1:x',
    title: p.title ?? 'Software Developer',
    employer: p.employer ?? 'Acme',
    location: p.location ?? { city: 'calgary', province: 'AB', remote: false },
    url: p.url ?? 'https://example.com',
    urls: ['https://example.com'],
    source: p.source ?? 'jobbank',
    sourceJobId: null,
    postedAt: null,
    salaryMin: null,
    salaryMax: null,
    salaryCurrency: 'CAD',
    nocCode: null,
    raw: null,
    ingestedAt: '2026-09-16T00:00:00Z',
    ...p,
  } as Job;
}

const AB = { targetProvince: 'AB' };

describe('applyRules (S2 AC1)', () => {
  it('AB + developer title → relevant with keyword reason', () => {
    const r = applyRules(job({ title: 'Senior Software Developer' }), AB);
    expect(r.status).toBe('relevant');
    expect(r.reasons.some((x) => x.startsWith('keyword:match:'))).toBe(true);
  });

  it('non-AB, non-remote → excluded with province reason', () => {
    for (const province of ['ON', 'QC', 'BC']) {
      const r = applyRules(job({ location: { city: 'x', province, remote: false } }), AB);
      expect(r.status).toBe('excluded');
      expect(r.reasons).toContain('province:not-AB');
    }
  });

  it('remote is location-relevant regardless of province (G1 answer #2)', () => {
    const r = applyRules(job({ location: { city: '', province: '', remote: true } }), AB);
    expect(r.status).toBe('relevant');
    expect(r.reasons).toContain('location:remote');
  });

  it('AB + react title → relevant via context word', () => {
    const r = applyRules(job({ title: 'React Specialist' }), AB);
    expect(r.status).toBe('relevant');
  });

  it('AB + junior marker → review (G1 answer #1)', () => {
    for (const title of ['Junior Web Developer', 'Software Developer Intern', 'Student Programmer']) {
      const r = applyRules(job({ title }), AB);
      expect(r.status, title).toBe('review');
      expect(r.reasons.some((x) => x.startsWith('seniority:junior-marker:'))).toBe(true);
    }
  });

  it('AB + no keyword match → review with no-match reason', () => {
    const r = applyRules(job({ title: 'Registered Nurse' }), AB);
    expect(r.status).toBe('review');
    expect(r.reasons).toContain('keyword:no-match');
  });

  it('non-AB + no keyword → excluded (province wins)', () => {
    const r = applyRules(job({ title: 'Nurse', location: { city: 'x', province: 'ON', remote: false } }), AB);
    expect(r.status).toBe('excluded');
  });

  it('normalizes case, punctuation, unicode before matching (S2 AC2)', () => {
    expect(applyRules(job({ title: 'Full-Stack Développeur' }), AB).status).toBe('relevant');
    expect(applyRules(job({ title: 'FRONTEND ENGINEER' }), AB).status).toBe('relevant');
  });

  it('bare engineer without dev context → review (calibration safety)', () => {
    expect(applyRules(job({ title: 'Mechanical Engineer' }), AB).status).toBe('review');
  });

  it('junior marker beats keyword match (review, not relevant)', () => {
    const r = applyRules(job({ title: 'Junior React Developer' }), AB);
    expect(r.status).toBe('review');
  });
});

describe('keyword families are data', () => {
  it('include-list and junior-markers are non-empty arrays', () => {
    expect(NOC_TITLE_FAMILIES.length).toBeGreaterThan(5);
    expect(JUNIOR_MARKERS.length).toBeGreaterThan(3);
  });
});
