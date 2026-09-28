import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import {
  createDb,
  ensureSchema,
  saveArtifact,
  saveRenderArtifact,
  findRenderArtifact,
  type Database,
} from '@chinook/core';
import type { Kysely } from 'kysely';

/**
 * S6 T1 (red→green): artifact schema migration — render kinds, nullable
 * llm_run_id, source_artifact_id audit link, content_path. Extended by T5/T6
 * with the render repository and service suites. Fixtures are synthetic only
 * (no PII — Constitution 3.2); the suite owns a synthetic job row and cleans
 * up after itself so re-runs stay idempotent (UNIQUE(job_id, kind, version)).
 */
const db: Kysely<Database> = createDb(
  process.env.DATABASE_URL ?? 'postgres://chinook:chinook_dev@localhost:5433/chinook_test',
);

let jobId = '';

beforeAll(async () => {
  await ensureSchema(db);
  jobId = randomUUID();
  await db
    .insertInto('job')
    .values({
      id: jobId,
      canonical_hash: `s6-${jobId}`,
      title: 'S6 render test job',
      employer: 'Chinook Test Inc.',
      city: 'edmonton',
      province: 'AB',
      remote: false,
      url: 'https://example.invalid/s6',
      urls: [],
      source: 'jobbank',
      source_job_id: `s6-${jobId}`,
      posted_at: new Date(),
      salary_currency: 'CAD',
      ingested_at: new Date(),
    })
    .execute();
});

afterAll(async () => {
  if (!db || !jobId) return;
  await db.deleteFrom('artifact').where('job_id', '=', jobId).execute();
  await db.deleteFrom('job').where('id', '=', jobId).execute();
  await db.destroy();
});

describe('artifact schema (S6 migration)', () => {
  it('accepts a render row with llm_run_id NULL and a source FK', async () => {
    const src = await saveArtifact(db, {
      jobId,
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
        job_id: jobId,
        kind: 'render_docx',
        version: 1,
        status: 'valid',
        content: JSON.stringify({}),
        validation: JSON.stringify({ valid: true, violations: [] }),
        llm_run_id: null,
        source_artifact_id: src.id,
        content_path: `${jobId}/resume-v1.docx`,
      })
      .execute();
    const row = await db.selectFrom('artifact').selectAll().where('id', '=', id).executeTakeFirstOrThrow();
    expect(row.llm_run_id).toBeNull();
    expect(row.source_artifact_id).toBe(src.id);
    expect(row.content_path).toBe(`${jobId}/resume-v1.docx`);
  });

  it('rejects an unknown kind', async () => {
    await expect(
      db
        .insertInto('artifact')
        .values({
          id: randomUUID(),
          job_id: jobId,
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
    await expect(
      db
        .insertInto('artifact')
        .values({
          id: randomUUID(),
          job_id: jobId,
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

describe('render artifact repository (S6 T5)', () => {
  it('saveRenderArtifact creates version-1 rows keyed by (source, format); re-save upserts', async () => {
    const src = await saveArtifact(db, {
      jobId,
      kind: 'cover_letter',
      status: 'valid',
      content: { letter: 'Dear Hiring Manager,' },
      validation: { valid: true, violations: [] },
      llmRunId: 7,
    });

    const first = await saveRenderArtifact(db, {
      jobId,
      sourceArtifactId: src.id,
      sourceKind: 'cover_letter',
      sourceVersion: src.version,
      format: 'docx',
      contentPath: `${jobId}/cover-letter-v1.docx`,
    });
    expect(first.kind).toBe('render_docx');
    expect(first.version).toBe(1);
    expect(first.status).toBe('valid');
    expect(first.violations).toEqual([]);
    expect(first.sourceArtifactId).toBe(src.id);

    const found = await findRenderArtifact(db, src.id, 'docx');
    expect(found?.id).toBe(first.id);

    // Re-render (same source, same format): the same row is updated in place,
    // not versioned again — renders are derived and deterministic.
    const again = await saveRenderArtifact(db, {
      jobId,
      sourceArtifactId: src.id,
      sourceKind: 'cover_letter',
      sourceVersion: src.version,
      format: 'docx',
      contentPath: `${jobId}/cover-letter-v1.docx`,
    });
    expect(again.id).toBe(first.id);
    expect(again.version).toBe(1);

    // The other format is an independent row.
    const pdf = await saveRenderArtifact(db, {
      jobId,
      sourceArtifactId: src.id,
      sourceKind: 'cover_letter',
      sourceVersion: src.version,
      format: 'pdf',
      contentPath: `${jobId}/cover-letter-v1.pdf`,
    });
    expect(pdf.kind).toBe('render_pdf');
    expect(pdf.id).not.toBe(first.id);

    await findRenderArtifact(db, src.id, 'pdf').then((row) => expect(row?.kind).toBe('render_pdf'));
    expect(await findRenderArtifact(db, randomUUID(), 'docx')).toBeNull();
  });
});
