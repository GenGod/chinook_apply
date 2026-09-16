import { describe, it, expect, beforeAll } from 'vitest';
import process from 'node:process';
import { runIngest } from '@chinook/worker';
import { createDb, ensureSchema, countJobs } from '@chinook/core';

/**
 * S1 AC5: ingest CLI path against a real Postgres (docker compose up / CI service).
 * Fixtures mode is deterministic; second run must not create duplicates.
 */
const databaseUrl = process.env.DATABASE_URL ?? 'postgres://chinook:chinook_dev@localhost:5433/chinook';
describe.skipIf(!databaseUrl)('ingest integration (fixtures → postgres)', () => {
  beforeAll(async () => {
    const db = createDb(databaseUrl);
    await ensureSchema(db);
    await db.deleteFrom('job').execute();
    await db.deleteFrom('ingest_run').execute();
    await db.destroy();
  });

  it('first run inserts fixture jobs from both sources', async () => {
    const summary = await runIngest({ fixtures: true });
    expect(summary.totalFetched).toBeGreaterThan(20);
    expect(summary.uniqueJobs).toBeGreaterThan(0);
    expect(summary.inserted).toBe(summary.uniqueJobs);
    expect(summary.sources.map((s) => s.source).sort()).toEqual(['adzuna', 'jobbank']);
  });

  it('second run upserts without duplicates (S1 AC5)', async () => {
    const before = await usingCount();
    const summary = await runIngest({ fixtures: true });
    expect(summary.inserted).toBe(0);
    expect(summary.updated).toBe(summary.uniqueJobs);
    expect(await usingCount()).toBe(before);
  });

  it('canonical_hash is unique in the table', async () => {
    const db = createDb(databaseUrl);
    const rows = await db.selectFrom('job').select('canonical_hash').execute();
    const hashes = rows.map((r) => r.canonical_hash);
    expect(new Set(hashes).size).toBe(hashes.length);
    await db.destroy();
  });
});

async function usingCount(): Promise<number> {
  const db = createDb(databaseUrl);
  const n = await countJobs(db);
  await db.destroy();
  return n;
}
