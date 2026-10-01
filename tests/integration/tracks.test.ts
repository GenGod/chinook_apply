import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createDb, ensureSchema, upsertMatch, getMetrics, type Database } from '@chinook/core';
import type { Kysely } from 'kysely';

/**
 * S24 T2: job_match.best_track persistence (migration + upsertMatch param).
 */
const db: Kysely<Database> = createDb(
  process.env.DATABASE_URL ?? 'postgres://chinook:chinook_dev@localhost:5433/chinook_test',
);

describe('job_match.best_track (S24 T2)', () => {
  beforeAll(async () => {
    await ensureSchema(db);
  });

  afterAll(async () => {
    await db.destroy();
  });

  it('upsertMatch stores best_track; metrics expose per-track counts', async () => {
    const jobId = randomUUID();
    await db
      .insertInto('job')
      .values({
        id: jobId,
        canonical_hash: `s24-${jobId}`,
        title: 'S24 track job',
        employer: 'Fixture Corp',
        city: 'edmonton',
        province: 'AB',
        remote: false,
        url: `https://example.invalid/${jobId}`,
        urls: [],
        source: 'jobbank',
        source_job_id: `s24-${jobId}`,
        posted_at: new Date(),
        salary_currency: 'CAD',
        ingested_at: new Date(),
      })
      .execute();

    await upsertMatch(db, jobId, 1, { score: 88, reasons: ['r'], risks: [], noc_guess: '21231', best_track: 'voki-games' }, 'v6');

    const row = await db
      .selectFrom('job_match')
      .select(['best_track', 'score'])
      .where('job_id', '=', jobId)
      .orderBy('id', 'desc')
      .executeTakeFirstOrThrow();
    expect(row.best_track).toBe('voki-games');
    expect(row.score).toBe(88);

    // metrics: no throw, counters still present (quality section untouched)
    const m = await getMetrics(db);
    expect(m.funnel.scored).toBeGreaterThanOrEqual(1);

    await db.deleteFrom('job_match').where('job_id', '=', jobId).execute();
    await db.deleteFrom('job').where('id', '=', jobId).execute();
  });

  it('upsertMatch without best_track stores null (backward compatible)', async () => {
    const jobId = randomUUID();
    await db
      .insertInto('job')
      .values({
        id: jobId,
        canonical_hash: `s24n-${jobId}`,
        title: 'S24 no-track job',
        employer: 'Fixture Corp',
        city: 'edmonton',
        province: 'AB',
        remote: false,
        url: `https://example.invalid/${jobId}`,
        urls: [],
        source: 'jobbank',
        source_job_id: `s24n-${jobId}`,
        posted_at: new Date(),
        salary_currency: 'CAD',
        ingested_at: new Date(),
      })
      .execute();

    await upsertMatch(db, jobId, 1, { score: 60, reasons: ['r'], risks: [], noc_guess: null }, 'v5');
    const row = await db
      .selectFrom('job_match')
      .select('best_track')
      .where('job_id', '=', jobId)
      .orderBy('id', 'desc')
      .executeTakeFirstOrThrow();
    expect(row.best_track).toBeNull();

    await db.deleteFrom('job_match').where('job_id', '=', jobId).execute();
    await db.deleteFrom('job').where('id', '=', jobId).execute();
  });
});
