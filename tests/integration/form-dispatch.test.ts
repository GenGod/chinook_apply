import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { mkdtemp, rm, readdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createDb,
  ensureSchema,
  saveArtifact,
  saveRenderArtifact,
  type Database,
} from '@chinook/core';
import type { Kysely } from 'kysely';
import {
  sendWebFormApplication,
  FormNotConfiguredError,
  FormCaptchaStoppedError,
  FormBrowserUnavailableError,
} from '../../apps/web/src/lib/form-dispatch-service';
import { MOCK_FORM_HTML, CAPTCHA_FORM_HTML } from '../../apps/web/src/lib/mock-form';

/**
 * S9 T2 (red→green): browser form dispatch against the LOCAL mock form served
 * by this suite's own http server — real chromium, real navigation, no
 * external sites. Constitution 11: captcha stop before filling, screenshots
 * to the gitignored artifacts dir, audit rows for every attempt.
 */
const db: Kysely<Database> = createDb(
  process.env.DATABASE_URL ?? 'postgres://chinook:chinook_dev@localhost:5433/chinook_test',
);

let jobId = '';
let artifactsDir = '';
let server: Server | undefined;
let submitCount = 0;
let baseUrl = '';

const RESUME_PDF = Buffer.concat([Buffer.from('%PDF-1.4\n', 'latin1'), Buffer.alloc(120, 9)]);

beforeAll(async () => {
  await ensureSchema(db);
  jobId = randomUUID();
  await db
    .insertInto('job')
    .values({
      id: jobId,
      canonical_hash: `s9-${jobId}`,
      title: 'S9 form test job',
      employer: 'Fixture Corp',
      city: 'edmonton',
      province: 'AB',
      remote: false,
      url: 'https://example.invalid/s9',
      urls: [],
      source: 'jobbank',
      source_job_id: `s9-${jobId}`,
      posted_at: new Date(),
      salary_currency: 'CAD',
      ingested_at: new Date(),
      raw: {
        formConfig: {
          url: '', // patched per-test once the server is listening
          selectors: {},
          successText: 'Thank you for your application!',
        },
      },
    })
    .execute();

  artifactsDir = await mkdtemp(join(tmpdir(), 'chinook-form-'));

  server = createServer((req, res) => {
    if (req.url?.startsWith('/submit')) {
      submitCount += 1;
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(MOCK_FORM_HTML);
      return;
    }
    if (req.url?.startsWith('/captcha')) {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(CAPTCHA_FORM_HTML);
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(MOCK_FORM_HTML);
  });
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  const address = server!.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  baseUrl = `http://127.0.0.1:${port}`;

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
  await saveRenderArtifact(db, {
    jobId,
    sourceArtifactId: src.id,
    sourceKind: 'resume',
    sourceVersion: 1,
    format: 'pdf',
    contentPath: `${jobId}/resume-v1.pdf`,
    version: 1,
  });
  const { writeFile, mkdir } = await import('node:fs/promises');
  await mkdir(join(artifactsDir, jobId), { recursive: true });
  await writeFile(join(artifactsDir, jobId, 'resume-v1.pdf'), RESUME_PDF);
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => server?.close((e) => (e ? reject(e) : resolve())));
  if (artifactsDir !== '') await rm(artifactsDir, { recursive: true, force: true });
  if (!db || !jobId) return;
  await db.deleteFrom('dispatch_log').where('job_id', '=', jobId).execute();
  await db.deleteFrom('application').where('job_id', '=', jobId).execute();
  await db.deleteFrom('artifact').where('job_id', '=', jobId).execute();
  await db.deleteFrom('job').where('id', '=', jobId).execute();
  await db.destroy();
});

async function setFormUrl(url: string): Promise<void> {
  await db
    .updateTable('job')
    .set({
      raw: {
        formConfig: { url, selectors: {}, successText: 'Thank you for your application!' },
      },
    })
    .where('id', '=', jobId)
    .execute();
}

describe('form dispatch service (S9 T2)', () => {
  it('fills and submits the mock form; audits sent with three screenshots', async () => {
    submitCount = 0;
    await setFormUrl(`${baseUrl}/form`);
    const result = await sendWebFormApplication(db, jobId, { artifactsDir });

    expect(result.outcome).toBe('sent');
    expect(result.screenshots).toHaveLength(3);
    expect(result.screenshots.some((p) => p.includes('-before.png'))).toBe(true);
    expect(result.screenshots.some((p) => p.includes('-filled.png'))).toBe(true);
    expect(result.screenshots.some((p) => p.includes('-submitted.png'))).toBe(true);
    for (const rel of result.screenshots) {
      const info = await stat(join(artifactsDir, rel));
      expect(info.size).toBeGreaterThan(500);
    }
    expect(submitCount).toBe(1);

    const log = await db
      .selectFrom('dispatch_log')
      .selectAll()
      .where('job_id', '=', jobId)
      .where('outcome', '=', 'sent')
      .executeTakeFirstOrThrow();
    expect(log.channel).toBe('form');
    const app = await db
      .selectFrom('application')
      .selectAll()
      .where('job_id', '=', jobId)
      .executeTakeFirst();
    expect(app?.status).toBe('applied');
    expect(app?.channel).toBe('auto');
    const dirNames = await readdir(join(artifactsDir, 'form'));
    expect(dirNames.length).toBeGreaterThanOrEqual(3);
  });

  it('stops before filling when a captcha marker is present (art. 11.3)', async () => {
    submitCount = 0;
    await setFormUrl(`${baseUrl}/captcha`);
    await expect(
      sendWebFormApplication(db, jobId, { artifactsDir }),
    ).rejects.toBeInstanceOf(FormCaptchaStoppedError);
    expect(submitCount).toBe(0); // nothing was submitted
    const skipped = await db
      .selectFrom('dispatch_log')
      .selectAll()
      .where('job_id', '=', jobId)
      .where('outcome', '=', 'skipped')
      .executeTakeFirstOrThrow();
    expect(String(skipped.error)).toContain('captcha');
  });

  it('503 with a clear message when the browser cannot launch', async () => {
    await setFormUrl(`${baseUrl}/form`);
    const failingLauncher = async () => {
      throw new Error('Executable does not exist');
    };
    await expect(
      sendWebFormApplication(db, jobId, { artifactsDir, launchBrowser: failingLauncher }),
    ).rejects.toBeInstanceOf(FormBrowserUnavailableError);
  });

  it('409 when the job has no formConfig', async () => {
    await db.updateTable('job').set({ raw: {} }).where('id', '=', jobId).execute();
    await expect(sendWebFormApplication(db, jobId, { artifactsDir })).rejects.toBeInstanceOf(
      FormNotConfiguredError,
    );
    // restore for other suites
    await setFormUrl(`${baseUrl}/form`);
  });
});
