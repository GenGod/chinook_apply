import { describe, it, expect, beforeAll } from 'vitest';
import { runIngest } from '@chinook/worker';
import { createDb, ensureSchema, listJobs } from '@chinook/core';

/**
 * S2 AC3/AC4: ingest applies rules and persists rule_*; listJobs filters by
 * rule; a changed profile re-scores on the next run.
 */
const databaseUrl = process.env.DATABASE_URL ?? 'postgres://chinook:chinook_dev@localhost:5433/chinook';

describe('rule matcher integration (S2)', () => {
  beforeAll(async () => {
    const db = createDb(databaseUrl);
    await ensureSchema(db);
    await db.destroy();
  });

  it('ingest scores jobs into baskets and persists rule fields', async () => {
    const summary = await runIngest({ fixtures: true });
    expect(summary.uniqueJobs).toBeGreaterThan(0);
    expect(summary.ruleBuckets?.relevant + summary.ruleBuckets?.review + summary.ruleBuckets?.excluded).toBe(
      summary.uniqueJobs,
    );

    const db = createDb(databaseUrl);
    const jobs = await listJobs(db, { limit: 100 });
    expect(jobs.length).toBeGreaterThan(0);
    for (const j of jobs) {
      expect(['relevant', 'review', 'excluded']).toContain(j.ruleStatus);
    }
    await db.destroy();
  });

  it('listJobs rule filter returns only that basket (S2 AC4)', async () => {
    const db = createDb(databaseUrl);
    const all = await listJobs(db, { limit: 100 });
    const relevant = await listJobs(db, { rule: 'relevant', limit: 100 });
    expect(relevant.every((j) => j.ruleStatus === 'relevant')).toBe(true);
    expect(relevant.length).toBeLessThanOrEqual(all.length);
    await db.destroy();
  });

  it('re-running with a different target province re-scores (rules evolve)', async () => {
    await runIngest({ fixtures: true, profile: { targetProvince: 'ON' } });
    const db = createDb(databaseUrl);
    const jobs = await listJobs(db, { limit: 100 });
    expect(jobs.some((j) => j.ruleStatus === 'excluded')).toBe(true); // AB jobs now excluded
    await db.destroy();
    // restore AB scoring for other suites
    await runIngest({ fixtures: true });
  });
});
