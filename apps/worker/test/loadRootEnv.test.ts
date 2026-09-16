import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { loadRootEnv } from '../src/ingest.js';

/**
 * Regression (PROCESS §9): appending a var without a leading newline once
 * merged it into the previous value and poisoned ADZUNA_APP_KEY. The loader
 * must skip-and-warn on such lines instead of loading garbage credentials.
 */
describe('loadRootEnv', () => {
  it('loads well-formed KEY=VALUE lines', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'chinook-env-'));
    const file = path.join(dir, '.env');
    writeFileSync(file, 'A_KEY=value1\nB_KEY=value2\n');
    const target: Record<string, string | undefined> = {};
    const warnings = loadRootEnv(file, target);
    expect(target).toEqual({ A_KEY: 'value1', B_KEY: 'value2' });
    expect(warnings).toEqual([]);
    rmSync(dir, { recursive: true, force: true });
  });

  it('skips and warns on merged lines (embedded VAR= in value)', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'chinook-env-'));
    const file = path.join(dir, '.env');
    // exact shape of the real incident: DATABASE_URL glued onto the key line
    writeFileSync(file, 'ADZUNA_APP_KEY=abcd1234DATABASE_URL=postgres://x\nOTHER=ok\n');
    const target: Record<string, string | undefined> = {};
    const warnings = loadRootEnv(file, target);
    expect(target).toEqual({ OTHER: 'ok' });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('ADZUNA_APP_KEY');
    rmSync(dir, { recursive: true, force: true });
  });

  it('does not override pre-existing environment variables', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'chinook-env-'));
    const file = path.join(dir, '.env');
    writeFileSync(file, 'A_KEY=from-file\n');
    const target: Record<string, string | undefined> = { A_KEY: 'from-env' };
    loadRootEnv(file, target);
    expect(target.A_KEY).toBe('from-env');
    rmSync(dir, { recursive: true, force: true });
  });

  it('returns no warnings when file is missing', () => {
    expect(loadRootEnv(path.join(tmpdir(), 'definitely-missing-.env'))).toEqual([]);
  });
});
