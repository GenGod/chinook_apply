import { describe, it, expect, beforeAll } from 'vitest';
import process from 'node:process';
import { runIngest } from '@chinook/worker';
import { createDb, ensureSchema, listJobs, markAppliedManually } from '@chinook/core';

/**
 * S1a AC1/AC2: repository filters/sorting against a real Postgres seeded
 * with deterministic fixtures; applied-manually mark is idempotent.
 */
const databaseUrl = process.env.DATABASE_URL ?? 'postgres://chinook:chinook_dev@localhost:5433/chinook';

describe('job repository (S1a)', () => {
  beforeAll(async () => {
    const db = createDb(databaseUrl);
    await ensureSchema(db);
    await runIngest({ fixtures: true, close: false });
    await db.destroy();
  });

  it('lists jobs sorted by posted_at DESC by default', async () => {
    const db = createDb(databaseUrl);
    const jobs = await listJobs(db, {});
    expect(jobs.length).toBeGreaterThan(10);
    const dates = jobs.map((j) => j.postedAt ?? '');
    expect([...dates].sort().reverse()).toEqual(dates);
    await db.destroy();
  });

  it('filters by source (S1a AC1)', async () => {
    const db = createDb(databaseUrl);
    const jobbank = await listJobs(db, { source: 'jobbank' });
    const adzuna = await listJobs(db, { source: 'adzuna' });
    expect(jobbank.length).toBeGreaterThan(0);
    expect(adzuna.length).toBeGreaterThan(0);
    expect(jobbank.every((j) => j.source === 'jobbank')).toBe(true);
    expect(adzuna.every((j) => j.source === 'adzuna')).toBe(true);
    await db.destroy();
  });

  it('filters by salaryMin and days', async () => {
    const db = createDb(databaseUrl);
    const all = await listJobs(db, {});
    const withSalary = all.filter((j) => j.salaryMin !== null);
    if (withSalary.length > 0) {
      const threshold = withSalary[0]!.salaryMin!;
      const filtered = await listJobs(db, { salaryMin: threshold });
      expect(filtered.every((j) => j.salaryMin !== null && j.salaryMin >= threshold)).toBe(true);
    }
    const recent = await listJobs(db, { days: 7 });
    const cutoff = Date.now() - 7 * 24 * 3600 * 1000;
    expect(
      recent.every((j) => j.postedAt === null || new Date(j.postedAt).getTime() >= cutoff),
    ).toBe(true);
    await db.destroy();
  });

  it('sorts by salary DESC (nulls tolerated)', async () => {
    const db = createDb(databaseUrl);
    const jobs = await listJobs(db, { sort: 'salary' });
    const salaries = jobs.map((j) => j.salaryMin ?? -1);
    expect([...salaries].sort((a, b) => b - a)).toEqual(salaries);
    await db.destroy();
  });

  it('appliedManually defaults to false and markAppliedManually is idempotent (S1a AC2)', async () => {
    const db = createDb(databaseUrl);
    // Pick a job with no application yet: e2e runs against the same database
    // in CI and may already have marked the first rows applied.
    const jobs = await listJobs(db, { limit: 50 });
    const target = jobs.find((j) => !j.appliedManually);
    expect(target).toBeTruthy();

    const a = await markAppliedManually(db, target!.id);
    const b = await markAppliedManually(db, target!.id);
    expect(a.status).toBe('applied_manual');
    expect(b.id).toBe(a.id); // idempotent — same row, no duplicate

    const after = await listJobs(db, { limit: 50 });
    expect(after.find((j) => j.id === target!.id)?.appliedManually).toBe(true);
    await db.destroy();
  });

  it('respects limit', async () => {
    const db = createDb(databaseUrl);
    const limited = await listJobs(db, { limit: 5 });
    expect(limited).toHaveLength(5);
    await db.destroy();
  });
});
