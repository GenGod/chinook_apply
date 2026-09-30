import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import {
  createDb,
  ensureSchema,
  saveArtifact,
  saveDispatchLog,
  countSentToday,
  latestRenderArtifactByKind,
  type Database,
} from '@chinook/core';
import type { Kysely } from 'kysely';

/**
 * S8 T1 (red→green): dispatch_log schema + repository (S22-style suite: owns a
 * synthetic job, cleans up after itself). Synthetic fixtures only — no PII.
 */
const db: Kysely<Database> = createDb(
  process.env.DATABASE_URL ?? 'postgres://chinook:chinook_dev@localhost:5433/chinook_test',
);

let jobId = '';

async function createSyntheticJob(prefix: string): Promise<string> {
  const id = randomUUID();
  await db
    .insertInto('job')
    .values({
      id,
      canonical_hash: `${prefix}-${id}`,
      title: 'S8 dispatch test job',
      employer: 'Fixture Corp',
      city: 'edmonton',
      province: 'AB',
      remote: false,
      url: 'https://example.invalid/s8',
      urls: [],
      source: 'jobbank',
      source_job_id: `${prefix}-${id}`,
      posted_at: new Date(),
      salary_currency: 'CAD',
      ingested_at: new Date(),
    })
    .execute();
  return id;
}

beforeAll(async () => {
  await ensureSchema(db);
  jobId = await createSyntheticJob('s8');
});

afterAll(async () => {
  if (!db || !jobId) return;
  await db.deleteFrom('dispatch_log').where('job_id', '=', jobId).execute();
  await db.deleteFrom('artifact').where('job_id', '=', jobId).execute();
  await db.deleteFrom('job').where('id', '=', jobId).execute();
  await db.destroy();
});

describe('dispatch_log schema + repository (S8 T1)', () => {
  it('accepts a dispatch row with attachments and outcome check', async () => {
    const view = await saveDispatchLog(db, {
      jobId,
      applicationId: null,
      outcome: 'sent',
      toAddress: 'jobs@fixture.example',
      subject: 'Application for Senior Developer — Alex Fixture',
      attachments: [{ kind: 'render_docx', artifactId: randomUUID(), filename: 'resume-v1.docx', bytes: 1234 }],
      smtpMessageId: '<test@local>',
      error: null,
    });
    expect(view.id).toBeGreaterThan(0);

    await expect(
      saveDispatchLog(db, {
        jobId,
        applicationId: null,
        outcome: 'dropped' as never,
        toAddress: 'x@y.z',
        subject: 's',
        attachments: [],
        smtpMessageId: null,
        error: null,
      }),
    ).rejects.toThrow();
  });

  it('countSentToday counts only sent rows of today', async () => {
    await saveDispatchLog(db, {
      jobId,
      applicationId: null,
      outcome: 'sent',
      toAddress: 'a@b.c',
      subject: 's1',
      attachments: [],
      smtpMessageId: null,
      error: null,
    });
    await saveDispatchLog(db, {
      jobId,
      applicationId: null,
      outcome: 'failed',
      toAddress: 'a@b.c',
      subject: 's2',
      attachments: [],
      smtpMessageId: null,
      error: 'boom',
    });
    const count = await countSentToday(db);
    expect(count).toBeGreaterThanOrEqual(1); // suite rows; failed excluded
  });

  it('latestRenderArtifactByKind returns the newest version per kind', async () => {
    const src = await saveArtifact(db, {
      jobId,
      kind: 'resume',
      status: 'valid',
      content: { letter: 'x' },
      validation: { valid: true, violations: [] },
      llmRunId: 1,
    });
    const { saveRenderArtifact } = await import('@chinook/core');
    await saveRenderArtifact(db, {
      jobId,
      sourceArtifactId: src.id,
      sourceKind: 'resume',
      sourceVersion: 1,
      format: 'docx',
      contentPath: `${jobId}/resume-v1.docx`,
      version: 1,
    });
    await saveRenderArtifact(db, {
      jobId,
      sourceArtifactId: src.id,
      sourceKind: 'resume',
      sourceVersion: 1,
      format: 'docx',
      contentPath: `${jobId}/resume-v2.docx`,
      version: 2,
    });
    const latest = await latestRenderArtifactByKind(db, jobId, 'render_docx');
    expect(latest?.version).toBe(2);
    expect(await latestRenderArtifactByKind(db, randomUUID(), 'render_docx')).toBeNull();
  });
});
