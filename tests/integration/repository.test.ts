import { describe, it, expect, beforeAll } from 'vitest';
import process from 'node:process';
import { Client } from 'pg';
import { runIngest } from '@chinook/worker';
import { createDb, ensureSchema, listJobs, markAppliedManually, upsertJobs } from '@chinook/core';
import type { Job } from '@chinook/contracts';

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
    expect(a.status).toBe('applied');
    expect(a.channel).toBe('manual');
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

// S19 synthetic rows: fixtures are Alberta-only and have no remote jobs.
const SYNTHETIC_ON: Job = {
  id: '11111111-1111-4111-8111-111111111111',
  canonicalHash: 's19-it-on-developer',
  title: 'S19 it Ontario developer',
  employer: 'Chinook Fixtures Inc.',
  location: { city: 'toronto', province: 'ON', remote: false },
  url: 'https://www.jobbank.gc.ca/jobsearch/jobposting/91000001',
  urls: [],
  source: 'jobbank',
  sourceJobId: '91000001',
  postedAt: '2026-09-18T12:00:00Z',
  salaryMin: 90000,
  salaryMax: null,
  salaryCurrency: 'CAD',
  nocCode: null,
  raw: null,
  ingestedAt: '2026-09-18T12:00:00Z',
};
const SYNTHETIC_REMOTE: Job = {
  id: '22222222-2222-4222-8222-222222222222',
  canonicalHash: 's19-it-remote-developer',
  title: 'S19 it remote developer',
  employer: 'Chinook Fixtures Inc.',
  location: { city: '', province: '', remote: true },
  url: 'https://www.jobbank.gc.ca/jobsearch/jobposting/91000002',
  urls: [],
  source: 'jobbank',
  sourceJobId: '91000002',
  postedAt: '2026-09-18T12:00:00Z',
  salaryMin: 100000,
  salaryMax: null,
  salaryCurrency: 'CAD',
  nocCode: null,
  raw: null,
  ingestedAt: '2026-09-18T12:00:00Z',
};

async function seedS19Synthetics(): Promise<void> {
  const db = createDb(databaseUrl);
  await upsertJobs(db, [SYNTHETIC_ON, SYNTHETIC_REMOTE]);
  await db
    .updateTable('job')
    .set({ rule_status: 'relevant' })
    .where('canonical_hash', 'in', ['s19-it-on-developer', 's19-it-remote-developer'])
    .execute();
  await db.destroy();
}

describe('job repository province filters (S19)', () => {
  beforeAll(async () => {
    await seedS19Synthetics();
  });

  it('filters strictly by province code (AC1, R4)', async () => {
    const db = createDb(databaseUrl);
    const onJobs = await listJobs(db, { province: 'ON' });
    expect(onJobs.length).toBeGreaterThan(0);
    expect(onJobs.every((j) => j.location.province === 'ON')).toBe(true);
    // strict semantics: the synthetic remote job (province '') must be hidden
    expect(onJobs.some((j) => j.canonicalHash === 's19-it-remote-developer')).toBe(false);
    await db.destroy();
  });

  it('remoteOnly returns only remote jobs (AC2)', async () => {
    const db = createDb(databaseUrl);
    const remote = await listJobs(db, { remoteOnly: true });
    expect(remote.length).toBeGreaterThan(0);
    expect(remote.every((j) => j.location.remote)).toBe(true);
    expect(remote.some((j) => j.canonicalHash === 's19-it-remote-developer')).toBe(true);
    await db.destroy();
  });

  it('combines province with source and rule (AC3)', async () => {
    const db = createDb(databaseUrl);
    const combined = await listJobs(db, { province: 'ON', source: 'jobbank', rule: 'relevant' });
    expect(combined.length).toBeGreaterThan(0);
    expect(
      combined.every(
        (j) => j.location.province === 'ON' && j.source === 'jobbank' && j.ruleStatus === 'relevant',
      ),
    ).toBe(true);
    await db.destroy();
  });

  it('job_province_idx exists after ensureSchema (R6)', async () => {
    const db = createDb(databaseUrl);
    await ensureSchema(db);
    await db.destroy();
    const client = new Client({ connectionString: databaseUrl });
    await client.connect();
    const res = await client.query(
      "select indexname from pg_indexes where tablename = 'job' and indexname = 'job_province_idx'",
    );
    await client.end();
    expect(res.rowCount).toBe(1);
  });
});
