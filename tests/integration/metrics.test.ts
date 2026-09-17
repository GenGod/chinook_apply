import { describe, it, expect, beforeAll } from 'vitest';
import { runIngest } from '@chinook/worker';
import { createDb, ensureSchema, getMetrics, markAppliedManually, listJobs } from '@chinook/core';

/**
 * S13 AC1: getMetrics on a controlled seed — exact funnel numbers, source
 * health (avg over 5 runs, dedup ratio), history cap.
 */
const databaseUrl = process.env.DATABASE_URL ?? 'postgres://chinook:chinook_dev@localhost:5433/chinook';

describe('getMetrics (S13)', () => {
  beforeAll(async () => {
    await runIngest({ fixtures: true, fresh: true, close: false });
    const db = createDb(databaseUrl);
    await ensureSchema(db);
    // two manual applications for the funnel
    const jobs = await listJobs(db, { limit: 2 });
    for (const j of jobs) await markAppliedManually(db, j.id);
    // deterministic health seed: 5 jobbank runs with known fetched/unique
    await db.deleteFrom('ingest_run').where('source', '=', 'jobbank').execute();
    for (let i = 0; i < 5; i += 1) {
      await db
        .insertInto('ingest_run')
        .values({
          started_at: new Date(Date.now() - i * 60_000),
          finished_at: new Date(),
          source: 'jobbank',
          fetched: 10,
          unique_jobs: 7,
          merged: 3,
          inserted: 7,
          updated: 0,
          error: null,
        })
        .execute();
    }
    await db.destroy();
  });

  it('funnel counts match the seed exactly (AC1)', async () => {
    const db = createDb(databaseUrl);
    const m = await getMetrics(db);
    expect(m.funnel.total).toBe(27); // fixtures unique
    expect(m.funnel.relevant + m.funnel.review + m.funnel.excluded).toBe(m.funnel.total);
    expect(m.funnel.appliedManual).toBe(2);
    await db.destroy();
  });

  it('source health: avg over 5 runs, dedup ratio, interval defaults (AC1)', async () => {
    const db = createDb(databaseUrl);
    const m = await getMetrics(db);
    const jb = m.sources.find((s) => s.source === 'jobbank')!;
    expect(jb).toBeTruthy();
    expect(jb.intervalMin).toBe(30);
    expect(jb.avgFetched).toBe(10);
    expect(jb.avgUnique).toBe(7);
    expect(jb.dedupRatio).toBeCloseTo(0.3, 5);
    expect(jb.failuresInRow).toBe(0);
    expect(jb.lastRunAt).toBeTruthy();

    const az = m.sources.find((s) => s.source === 'adzuna')!;
    expect(az.intervalMin).toBe(120);
    await db.destroy();
  });

  it('history capped at 10, newest first (AC1)', async () => {
    const db = createDb(databaseUrl);
    const m = await getMetrics(db);
    expect(m.history.length).toBeLessThanOrEqual(10);
    const times = m.history.map((h) => h.startedAt);
    expect([...times].sort().reverse()).toEqual(times);
    expect(m.history[0]!.source).toBe('jobbank'); // newest run is jobbank seed
    await db.destroy();
  });
});
