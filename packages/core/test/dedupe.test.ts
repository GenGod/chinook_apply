import { describe, it, expect } from 'vitest';
import { dedupe } from '../src/index.js';
import type { Job } from '@chinook/contracts';

function job(p: Partial<Job> & Pick<Job, 'canonicalHash' | 'title' | 'employer'>): Job {
  return {
    id: p.id ?? crypto.randomUUID(),
    location: p.location ?? { city: 'calgary', province: 'AB', remote: false },
    url: p.url ?? 'https://example.com',
    urls: p.urls ?? [p.url ?? 'https://example.com'],
    source: p.source ?? 'jobbank',
    sourceJobId: p.sourceJobId ?? null,
    postedAt: p.postedAt ?? '2026-09-15T00:00:00Z',
    salaryMin: p.salaryMin ?? null,
    salaryMax: p.salaryMax ?? null,
    salaryCurrency: p.salaryCurrency ?? 'CAD',
    nocCode: null,
    raw: null,
    ingestedAt: p.ingestedAt ?? '2026-09-16T00:00:00Z',
    ...p,
  } as Job;
}

describe('dedupe (S1 AC4)', () => {
  it('collapses exact canonical hash duplicates and merges urls', () => {
    const a = job({ canonicalHash: 'canonical_v1:x', title: 'dev', employer: 'acme', url: 'https://a' });
    const b = job({ canonicalHash: 'canonical_v1:x', title: 'dev', employer: 'acme', url: 'https://b', source: 'adzuna' });
    const { unique, merged } = dedupe([a, b]);
    expect(unique).toHaveLength(1);
    expect(merged).toBe(1);
    expect(unique[0]!.urls.sort()).toEqual(['https://a', 'https://b']);
  });

  it('collapses fuzzy duplicates (paraphrased title, same employer+location)', () => {
    const a = job({
      canonicalHash: 'canonical_v1:a',
      title: 'senior full stack developer',
      employer: 'acme',
    });
    const b = job({
      canonicalHash: 'canonical_v1:b',
      title: 'senior developer full stack',
      employer: 'acme corp',
    });
    const { unique } = dedupe([a, b]);
    expect(unique).toHaveLength(1);
  });

  it('keeps different employers apart even with same title', () => {
    const a = job({ canonicalHash: 'canonical_v1:a', title: 'dev', employer: 'acme' });
    const b = job({ canonicalHash: 'canonical_v1:b', title: 'dev', employer: 'globex' });
    expect(dedupe([a, b]).unique).toHaveLength(2);
  });

  it('keeps same employer+title apart when locations differ', () => {
    const a = job({ canonicalHash: 'canonical_v1:a', title: 'dev', employer: 'acme', location: { city: 'calgary', province: 'AB', remote: false } });
    const b = job({ canonicalHash: 'canonical_v1:b', title: 'dev', employer: 'acme', location: { city: 'toronto', province: 'ON', remote: false } });
    expect(dedupe([a, b]).unique).toHaveLength(2);
  });

  it('below-threshold pairs are NOT merged', () => {
    const a = job({ canonicalHash: 'canonical_v1:a', title: 'senior full stack developer typescript react aws', employer: 'acme' });
    const b = job({ canonicalHash: 'canonical_v1:b', title: 'junior qa engineer playwright manual testing', employer: 'acme' });
    expect(dedupe([a, b]).unique).toHaveLength(2);
  });

  it('representative is the earliest postedAt; reports fuzzy pairs with score', () => {
    const a = job({ canonicalHash: 'canonical_v1:a', title: 'senior full stack developer', employer: 'acme', postedAt: '2026-09-10T00:00:00Z' });
    const b = job({ canonicalHash: 'canonical_v1:b', title: 'senior developer full stack', employer: 'acme', postedAt: '2026-09-12T00:00:00Z' });
    const { unique, fuzzyPairs } = dedupe([b, a]);
    expect(unique[0]!.postedAt).toBe('2026-09-10T00:00:00Z');
    expect(fuzzyPairs.length).toBe(1);
    expect(fuzzyPairs[0]!.score).toBeGreaterThanOrEqual(0.92);
  });
});
