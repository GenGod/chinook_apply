import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { loadProfileSearch, DEFAULT_PROFILE_SEARCH } from '../src/profile.js';

/** S2 AC5: profile loads from disk, maps full province names to codes, safe fallbacks. */
describe('loadProfileSearch', () => {
  it('maps "Alberta" (master_profile format) to AB code', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'chinook-profile-'));
    const file = path.join(dir, 'profile.json');
    writeFileSync(file, JSON.stringify({ search_config: { target_province: 'Alberta' } }));
    expect(loadProfileSearch(file)).toEqual({ targetProvince: 'AB' });
    rmSync(dir, { recursive: true, force: true });
  });

  it('keeps two-letter codes as-is', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'chinook-profile-'));
    const file = path.join(dir, 'profile.json');
    writeFileSync(file, JSON.stringify({ search_config: { target_province: 'ON' } }));
    expect(loadProfileSearch(file)).toEqual({ targetProvince: 'ON' });
    rmSync(dir, { recursive: true, force: true });
  });

  it('falls back to default on missing file (CI has no profile)', () => {
    expect(loadProfileSearch(path.join(tmpdir(), 'no-such-profile.json'))).toEqual(DEFAULT_PROFILE_SEARCH);
  });

  it('falls back to default on malformed file', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'chinook-profile-'));
    const file = path.join(dir, 'profile.json');
    writeFileSync(file, '{ not json');
    expect(loadProfileSearch(file)).toEqual(DEFAULT_PROFILE_SEARCH);
    rmSync(dir, { recursive: true, force: true });
  });
});
