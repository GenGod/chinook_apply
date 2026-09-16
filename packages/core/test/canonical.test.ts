import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { createHash } from '../src/index.js';

describe('canonicalHash (S1 AC3)', () => {
  it('is deterministic for identical inputs', () => {
    const args = { title: 'Dev', employer: 'Acme', city: 'calgary', province: 'AB' } as const;
    expect(createHash(args)).toBe(createHash(args));
  });
  it('is versioned', () => {
    expect(createHash({ title: 'Dev', employer: 'A', city: 'c', province: 'AB' })).toMatch(/^canonical_v1:/);
  });
  it('changes when any component changes', () => {
    const base = { title: 'Dev', employer: 'Acme', city: 'calgary', province: 'AB' } as const;
    for (const patch of [
      { title: 'Dev2' },
      { employer: 'Beta' },
      { city: 'edmonton' },
      { province: 'ON' },
    ] as const) {
      expect(createHash({ ...base, ...patch })).not.toBe(createHash(base));
    }
  });
  it('property: stable under repetition (fast-check)', () => {
    fc.assert(
      fc.property(fc.string({ minLength: 1, maxLength: 40 }), fc.string({ minLength: 1, maxLength: 40 }), (a, b) => {
        const args = { title: a, employer: b, city: 'calgary', province: 'AB' };
        return createHash(args) === createHash(args);
      }),
      { numRuns: 200 },
    );
  });
});
