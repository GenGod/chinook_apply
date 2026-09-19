import { describe, it, expect } from 'vitest';
import { PROVINCE_CODES, PROVINCES } from '../src/normalize.js';

describe('PROVINCE_CODES (S19)', () => {
  it('is the sorted tuple of all 13 province/territory codes', () => {
    expect(PROVINCE_CODES).toEqual([
      'AB', 'BC', 'MB', 'NB', 'NL', 'NS', 'NT', 'NU', 'ON', 'PE', 'QC', 'SK', 'YT',
    ]);
  });

  it('stays in sync with the PROVINCES name map (single source of truth)', () => {
    expect(new Set(PROVINCE_CODES)).toEqual(new Set(Object.values(PROVINCES)));
  });
});
