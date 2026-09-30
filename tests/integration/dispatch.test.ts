import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import {
  createDb,
  ensureSchema,
  saveArtifact,
  saveDispatchLog,
  countSentToday,
  latestRenderArtifactByKind,
  saveRenderArtifact,
  type Database,
} from '@chinook/core';
import type { Kysely } from 'kysely';
import {
  sendApplicationEmail,
  InvalidRecipientError,
  DispatchNotFoundError,
  DispatchLimitError,
  DispatchNotReadyError,
  DispatchSendError,
  type TransportLike,
} from '../../apps/web/src/lib/dispatch-service';

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


// --- S8 T3: dispatch service ---

interface CapturedMail {
  to: string | string[];
  envelope?: { to: string[] };
  subject: string;
  text: string;
  attachments: Array<{ filename: string; contentType?: string }>;
}

function fakeTransport(): { transport: TransportLike; mails: CapturedMail[] } {
  const mails: CapturedMail[] = [];
  return {
    mails,
    transport: {
      async sendMail(mail: unknown) {
        mails.push(mail as CapturedMail);
        return { messageId: '<fixture@local>' };
      },
    } as TransportLike,
  };
}

describe('dispatch service (S8 T3)', () => {
  // Own job: version counters must not collide with the T1 suite's rows.
  let jobId = '';
  beforeAll(async () => {
    process.env.SMTP_FROM = 'Alex Fixture <alex.fixture@example.com>'; // env-config path
    jobId = await createSyntheticJob('s8-svc');
    const src = await saveArtifact(db, {
      jobId,
      kind: 'resume',
      status: 'valid',
      content: {
        diff: {},
        resume: { summary: 'Engineer.', keywords: [], skills: [], experience: [], education: [] },
        identity: { fullName: 'Alex Fixture', email: 'alex.fixture@example.com' },
      },
      validation: { valid: true, violations: [] },
      llmRunId: 1,
    });
    const docx = await saveRenderArtifact(db, {
      jobId, sourceArtifactId: src.id, sourceKind: 'resume', sourceVersion: 1,
      format: 'docx', contentPath: `${jobId}/resume-v1.docx`, version: 1,
    });
    const pdf = await saveRenderArtifact(db, {
      jobId, sourceArtifactId: src.id, sourceKind: 'resume', sourceVersion: 1,
      format: 'pdf', contentPath: `${jobId}/resume-v1.pdf`, version: 1,
    });
    void docx;
    void pdf;
    // fixture files for readRenderFile
    const { mkdtemp, writeFile, mkdir } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const dir = await mkdtemp(join(tmpdir(), 'chinook-dispatch-'));
    process.env.ARTIFACTS_DIR = dir;
    await mkdir(join(dir, jobId), { recursive: true });
    await writeFile(join(dir, jobId, 'resume-v1.docx'), Buffer.alloc(200, 7));
    await writeFile(join(dir, jobId, 'resume-v1.pdf'), Buffer.alloc(150, 7));
  });

  it('dry-run: header To keeps the recipient, envelope routes to the sink; audit + application created', async () => {
    const fake = fakeTransport();
    const result = await sendApplicationEmail(
      db,
      jobId,
      { to: 'jobs@fixture.example', kinds: ['render_docx', 'render_pdf'] },
      { mode: 'dry-run', createTransport: () => fake.transport, loadMaster: () => null, limit: 10 },
    );
    expect(result.envelopeTo).toBe('dispatch-sink@localhost');
    const mail = fake.mails[0]!;
    expect(mail.to).toBe('jobs@fixture.example');            // visible header
    expect(mail.envelope?.to).toEqual(['dispatch-sink@localhost']); // safety
    expect(mail.subject).toContain('S8 dispatch test job');
    expect(mail.attachments.map((a) => a.filename).sort()).toEqual(['resume-v1.docx', 'resume-v1.pdf']);

    // application row created (applied/auto)
    const app = (await db
      .selectFrom('application')
      .selectAll()
      .where('job_id', '=', jobId)
      .executeTakeFirst()) as { status: string; channel: string } | undefined;
    expect(app?.status).toBe('applied');
    expect(app?.channel).toBe('auto');
  });

  it('live mode: envelope goes to the real recipient', async () => {
    const fake = fakeTransport();
    await sendApplicationEmail(
      db, jobId,
      { to: 'jobs@fixture.example', kinds: ['render_docx'] },
      { mode: 'live', createTransport: () => fake.transport, loadMaster: () => null, limit: 10 },
    );
    expect(fake.mails[0]!.envelope?.to).toEqual(['jobs@fixture.example']);
  });

  it('transport failure logs a failed dispatch and throws 502', async () => {
    const failing: TransportLike = {
      async sendMail() {
        throw new Error('smtp connection refused');
      },
    };
    await expect(
      sendApplicationEmail(db, jobId, { to: 'jobs@fixture.example', kinds: ['render_docx'] }, {
        mode: 'dry-run', createTransport: () => failing, loadMaster: () => null, limit: 10,
      }),
    ).rejects.toBeInstanceOf(DispatchSendError);
    const failed = await db
      .selectFrom('dispatch_log')
      .selectAll()
      .where('job_id', '=', jobId)
      .where('outcome', '=', 'failed')
      .execute();
    expect(failed.length).toBeGreaterThanOrEqual(1);
  });

  it('daily limit stops before transport (429)', async () => {
    const fake = fakeTransport();
    await expect(
      sendApplicationEmail(db, jobId, { to: 'jobs@fixture.example', kinds: ['render_docx'] }, {
        mode: 'dry-run', createTransport: () => fake.transport, loadMaster: () => null, limit: 0,
      }),
    ).rejects.toBeInstanceOf(DispatchLimitError);
    expect(fake.mails).toHaveLength(0);
  });

  it('no renders → 409; invalid recipient → 400; unknown job → 404', async () => {
    const fake = fakeTransport();
    const emptyJob = await createSyntheticJob('s8-empty');
    await expect(
      sendApplicationEmail(db, emptyJob, { to: 'jobs@fixture.example', kinds: ['render_docx'] }, {
        mode: 'dry-run', createTransport: () => fake.transport, loadMaster: () => null,
      }),
    ).rejects.toBeInstanceOf(DispatchNotReadyError);

    await expect(
      sendApplicationEmail(db, jobId, { to: 'not-an-email', kinds: ['render_docx'] }, {
        mode: 'dry-run', createTransport: () => fake.transport, loadMaster: () => null,
      }),
    ).rejects.toBeInstanceOf(InvalidRecipientError);

    await expect(
      sendApplicationEmail(db, randomUUID(), { to: 'jobs@fixture.example', kinds: ['render_docx'] }, {
        mode: 'dry-run', createTransport: () => fake.transport, loadMaster: () => null,
      }),
    ).rejects.toBeInstanceOf(DispatchNotFoundError);
    await db.deleteFrom('job').where('id', '=', emptyJob).execute();
  });

  afterAll(async () => {
    await db.deleteFrom('dispatch_log').where('job_id', '=', jobId).execute();
    await db.deleteFrom('application').where('job_id', '=', jobId).execute();
    await db.deleteFrom('artifact').where('job_id', '=', jobId).execute();
    await db.deleteFrom('job').where('id', '=', jobId).execute();
  });
});
