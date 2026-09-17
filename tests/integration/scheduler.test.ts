import { describe, it, expect, beforeAll } from 'vitest';
import { createDb, ensureSchema } from '@chinook/core';
import { withIngestLock, lastRunPerSource, consecutiveFailures, startScheduler } from '@chinook/worker';

/**
 * S12 AC2/AC4/AC5: advisory lock mutual exclusion, per-source history reads,
 * graceful stop after in-flight tick.
 */
const databaseUrl = process.env.DATABASE_URL ?? 'postgres://chinook:chinook_dev@localhost:5433/chinook';

describe('scheduler integration (S12)', () => {
  let db: ReturnType<typeof createDb>;

  beforeAll(async () => {
    db = createDb(databaseUrl);
    await ensureSchema(db);
  });

  it('advisory lock: conflicting pool is rejected while held (AC2)', async () => {
    // separate pool => separate session: exactly what a second process looks like
    const otherDb = createDb(databaseUrl);
    let workRan = false;
    let lockHeld!: () => void;
    const held = new Promise<void>((r) => (lockHeld = r));
    let releaseLock!: () => void;
    const releaser = new Promise<void>((r) => (releaseLock = r));

    const first = withIngestLock(db, async () => {
      lockHeld();
      await releaser;
      workRan = true;
    });
    await held; // first pool actually holds the lock now

    const conflicting = await withIngestLock(otherDb, async () => {
      throw new Error('must not run');
    });
    releaseLock();

    expect(conflicting).toBe(false);
    expect(await first).toBe(true);
    expect(workRan).toBe(true);

    // after release the lock is available again
    const reacquired = await withIngestLock(otherDb, async () => {});
    expect(reacquired).toBe(true);
    await otherDb.destroy();
  });

  it('lastRunPerSource reads history seeded via ingest_run (AC5)', async () => {
    await db.deleteFrom('ingest_run').where('source', 'in', ['jobbank', 'adzuna']).execute();
    await db
      .insertInto('ingest_run')
      .values([
        { started_at: new Date('2026-09-17T10:00:00Z'), finished_at: new Date(), source: 'jobbank', fetched: 10, error: null },
        { started_at: new Date('2026-09-17T11:00:00Z'), finished_at: new Date(), source: 'jobbank', fetched: 11, error: null },
        { started_at: new Date('2026-09-17T09:00:00Z'), finished_at: new Date(), source: 'adzuna', fetched: 0, error: 'boom' },
      ])
      .execute();
    const last = await lastRunPerSource(db);
    expect(new Date(last.jobbank!).toISOString()).toBe('2026-09-17T11:00:00.000Z');
    expect(new Date(last.adzuna!).toISOString()).toBe('2026-09-17T09:00:00.000Z');
  });

  it('consecutiveFailures counts newest error streak per source', async () => {
    await db.deleteFrom('ingest_run').where('source', '=', 'adzuna').execute();
    await db
      .insertInto('ingest_run')
      .values([
        { started_at: new Date('2026-09-17T12:00:00Z'), source: 'adzuna', fetched: 0, error: 'e1' },
        { started_at: new Date('2026-09-17T12:05:00Z'), source: 'adzuna', fetched: 0, error: 'e2' },
        { started_at: new Date('2026-09-17T12:10:00Z'), source: 'adzuna', fetched: 5, error: null },
        { started_at: new Date('2026-09-17T12:15:00Z'), source: 'adzuna', fetched: 0, error: 'e3' },
      ])
      .execute();
    const failures = await consecutiveFailures(db);
    expect(failures.adzuna).toBe(1); // newest row failed once, before it a success
  });

  it('startScheduler: tick runs once, stop() resolves after in-flight work (AC4)', async () => {
    const lines: string[] = [];
    let runs = 0;
    const handle = startScheduler({
      db,
      tickMs: 5,
      schedules: [{ source: 'jobbank', intervalMin: 30, jitterRatio: 0.2 }],
      runIngestFn: async () => {
        runs += 1;
        await new Promise((r) => setTimeout(r, 30));
        return {
          sources: [{ source: 'jobbank', fetched: 0, error: null }],
          totalFetched: 0,
          uniqueJobs: 0,
          merged: 0,
          inserted: 0,
          updated: 0,
          jobsInDb: 0,
          fuzzyPairs: 0,
          ruleBuckets: { relevant: 0, review: 0, excluded: 0 },
        };
      },
      log: (line) => lines.push(line),
    });
    await new Promise((r) => setTimeout(r, 80));
    await handle.stop();
    const afterStop = runs;
    await new Promise((r) => setTimeout(r, 30));
    expect(runs).toBeGreaterThanOrEqual(1);
    expect(runs).toBe(afterStop); // no ticks after stop
    expect(lines.some((l) => l.includes('run: jobbank'))).toBe(true);
  });
});
