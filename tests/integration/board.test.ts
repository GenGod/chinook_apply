import { describe, it, expect, beforeAll } from 'vitest';
import { runIngest } from '@chinook/worker';
import {
  createDb,
  ensureSchema,
  listJobs,
  getBoard,
  setApplicationStatus,
  markAppliedManually,
  TransitionError,
} from '@chinook/core';

/**
 * S7 AC1/AC2/AC5: board columns, transition validation, legacy migration.
 */
const databaseUrl = process.env.DATABASE_URL ?? 'postgres://chinook:chinook_dev@localhost:5433/chinook';

describe('board integration (S7)', () => {
  beforeAll(async () => {
    await runIngest({ fixtures: true, fresh: true, close: false });
  });

  it('legacy applied_manual migrates to applied/manual (AC5)', async () => {
    const db = createDb(databaseUrl);
    const jobs = await listJobs(db, { rule: 'relevant', limit: 1 });
    const job = jobs[0]!;
    // simulate a legacy row
    await db
      .insertInto('application')
      .values({ job_id: job.id, status: 'applied_manual', channel: 'external_link' })
      .execute();
    await ensureSchema(db); // runs the v5 migration UPDATEs
    const migrated = await db
      .selectFrom('application')
      .where('job_id', '=', job.id)
      .selectAll()
      .execute();
    expect(migrated[0]!.status).toBe('applied');
    expect(migrated[0]!.channel).toBe('manual');
    await db.deleteFrom('application').execute();
    await db.destroy();
  });

  it('getBoard: New filled with relevant unapplied, capped with total (AC1)', async () => {
    const db = createDb(databaseUrl);
    await ensureSchema(db);
    const board = await getBoard(db);
    expect(board.columns.map((c) => c.status)).toEqual([
      'new', 'applying', 'applied_manual', 'applied_auto', 'interview', 'rejected',
    ]);
    const newCol = board.columns[0]!;
    expect(newCol.cards.length).toBeGreaterThan(5);
    expect(newCol.total).toBeGreaterThanOrEqual(newCol.cards.length);
    expect(newCol.cards.every((c) => c.ruleStatus === 'relevant')).toBe(true);
    await db.destroy();
  });

  it('moves new→applying→applied(manual); card follows columns (AC1/AC2)', async () => {
    const db = createDb(databaseUrl);
    const jobs = await listJobs(db, { rule: 'relevant', limit: 1 });
    const job = jobs[0]!;

    const applying = await setApplicationStatus(db, job.id, { status: 'applying' });
    expect(applying.status).toBe('applying');
    let board = await getBoard(db);
    expect(board.columns.find((c) => c.status === 'applying')!.cards.some((c) => c.id === job.id)).toBe(true);
    expect(board.columns.find((c) => c.status === 'new')!.cards.some((c) => c.id === job.id)).toBe(false);

    const applied = await setApplicationStatus(db, job.id, { status: 'applied', channel: 'manual' });
    expect(applied.status).toBe('applied');
    expect(applied.channel).toBe('manual');
    board = await getBoard(db);
    expect(board.columns.find((c) => c.status === 'applied_manual')!.cards.some((c) => c.id === job.id)).toBe(true);

    await db.destroy();
  });

  it('rejects forbidden transitions and wrong channels (AC2)', async () => {
    const db = createDb(databaseUrl);
    const jobs = await listJobs(db, { rule: 'relevant', limit: 2 });
    const job = jobs[1]!;

    await expect(setApplicationStatus(db, job.id, { status: 'interview' })).rejects.toBeInstanceOf(TransitionError);
    await expect(setApplicationStatus(db, job.id, { status: 'applied' })).rejects.toBeInstanceOf(TransitionError); // channel missing
    await expect(setApplicationStatus(db, job.id, { status: 'applying', channel: 'manual' })).rejects.toBeInstanceOf(
      TransitionError,
    );

    // idempotent repeat
    await setApplicationStatus(db, job.id, { status: 'applying' });
    const again = await setApplicationStatus(db, job.id, { status: 'applying' });
    expect(again.status).toBe('applying');
    await db.destroy();
  });

  it('markAppliedManually lands in applied_manual column (S1a compat)', async () => {
    const db = createDb(databaseUrl);
    const jobs = await listJobs(db, { rule: 'relevant', limit: 3 });
    const job = jobs[2]!;
    const row = await markAppliedManually(db, job.id);
    expect(row.status).toBe('applied');
    expect(row.channel).toBe('manual');
    const board = await getBoard(db);
    expect(board.columns.find((c) => c.status === 'applied_manual')!.cards.some((c) => c.id === job.id)).toBe(true);
    await db.deleteFrom('application').execute();
    await db.destroy();
  });
});
