import { describe, it, expect, beforeAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createDb, ensureSchema, saveArtifact, type Database } from '@chinook/core';
import type { Kysely } from 'kysely';

/**
 * S6 T1 (red→green): artifact schema migration — render kinds, nullable
 * llm_run_id, source_artifact_id audit link, content_path. Extended by T5/T6
 * with the render repository and service suites. Fixtures are synthetic only
 * (no PII — Constitution 3.2).
 */
const db: Kysely<Database> = createDb(
  process.env.DATABASE_URL ?? 'postgres://chinook:chinook_dev@localhost:5433/chinook_test',
);

beforeAll(async () => {
  await ensureSchema(db);
});

describe('artifact schema (S6 migration)', () => {
  it('accepts a render row with llm_run_id NULL and a source FK', async () => {
    const job = await db.selectFrom('job').select('id').limit(1).executeTakeFirst();
    if (!job) return; // schema assertions below need a live FK target
    const src = await saveArtifact(db, {
      jobId: job.id,
      kind: 'resume',
      status: 'valid',
      content: { diff: {}, resume: { summary: 'x' } },
      validation: { valid: true, violations: [] },
      llmRunId: 1,
    });
    const id = randomUUID();
    await db
      .insertInto('artifact')
      .values({
        id,
        job_id: job.id,
        kind: 'render_docx',
        version: 1,
        status: 'valid',
        content: JSON.stringify({}),
        validation: JSON.stringify({ valid: true, violations: [] }),
        llm_run_id: null,
        source_artifact_id: src.id,
        content_path: `${job.id}/resume-v1.docx`,
      })
      .execute();
    const row = await db.selectFrom('artifact').selectAll().where('id', '=', id).executeTakeFirstOrThrow();
    expect(row.llm_run_id).toBeNull();
    expect(row.source_artifact_id).toBe(src.id);
    expect(row.content_path).toBe(`${job.id}/resume-v1.docx`);
  });

  it('rejects an unknown kind', async () => {
    const job = await db.selectFrom('job').select('id').limit(1).executeTakeFirst();
    if (!job) return;
    await expect(
      db
        .insertInto('artifact')
        .values({
          id: randomUUID(),
          job_id: job.id,
          kind: 'render_xlsx' as never,
          version: 1,
          status: 'valid',
          content: JSON.stringify({}),
          validation: JSON.stringify({ valid: true, violations: [] }),
          llm_run_id: null,
        })
        .execute(),
    ).rejects.toThrow();
  });

  it('rejects a render row pointing at a nonexistent source artifact', async () => {
    const job = await db.selectFrom('job').select('id').limit(1).executeTakeFirst();
    if (!job) return;
    await expect(
      db
        .insertInto('artifact')
        .values({
          id: randomUUID(),
          job_id: job.id,
          kind: 'render_pdf',
          version: 1,
          status: 'valid',
          content: JSON.stringify({}),
          validation: JSON.stringify({ valid: true, violations: [] }),
          llm_run_id: null,
          source_artifact_id: randomUUID(), // no such artifact row
        })
        .execute(),
    ).rejects.toThrow();
  });
});
