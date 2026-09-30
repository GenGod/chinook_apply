// E2E extra fixtures (S19/S20 synthetic rows, S5 artifact versions, S8 dispatch
// render files) — lives in core so the env-sourced connection string flows
// through the guarded createDb path (assertSafeDatabaseUrl host allowlist).
// Database bootstrap stays in the worker seed script; this module seeds rows
// and writes synthetic render files (tiny headers + padding — no real PII).
import process from 'node:process';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Job } from '@chinook/contracts';
import { createDb, ensureSchema, upsertJobs, DEV_DATABASE_URL } from './db';
import { saveRenderArtifact } from './artifacts';

function e2eUrl(): string {
  const base = process.env.DATABASE_URL ?? DEV_DATABASE_URL;
  const explicit = process.env.E2E_DATABASE_URL;
  return explicit ?? base.replace(/\/[^/]+$/, '/chinook_e2e');
}

function s19Row(n: number, hash: string, title: string, city: string, province: string, remote: boolean): Job {
  return {
    id: `${n}${n}${n}${n}${n}${n}${n}${n}-${n}${n}${n}${n}-4${n}${n}${n}-8${n}${n}${n}-${n}${n}${n}${n}${n}${n}${n}${n}${n}${n}${n}${n}`,
    canonicalHash: hash,
    title,
    employer: 'Chinook Fixtures Inc.',
    location: { city, province, remote },
    url: `https://www.jobbank.gc.ca/jobsearch/jobposting/9100000${n}`,
    urls: [],
    source: 'jobbank',
    sourceJobId: `9100000${n}`,
    postedAt: '2026-09-01T12:00:00Z',
    salaryMin: 90000 + n,
    salaryMax: null,
    salaryCurrency: 'CAD',
    nocCode: null,
    raw: null,
    ingestedAt: '2026-09-01T12:00:00Z',
  };
}

const longDescription = Array.from({ length: 6 }, (_, i) =>
  `Paragraph ${i + 1} of the S20 e2e long description: duties include designing job-search dashboards, writing TypeScript &amp; SQL, and reviewing pull requests with care&nbsp;— repeated to exceed the old 1200-char truncation for deterministic preview tests.`,
).join('<br><br>');

/**
 * Synthetic artifact contents for the S5 Documents-section e2e (no real PII —
 * Constitution 3.2; the marker bullet 'platform serving 40k users' is asserted
 * in tests). Shapes mirror the real pipeline: resume content {diff, resume}
 * after code assembly (S5 T3), cover content {letter}.
 */
/** Synthetic identity for S6 render fixtures — never the real master profile (PII, art. 3.2). */
const SYNTHETIC_IDENTITY = {
  fullName: 'Alex Fixture',
  headline: 'Senior Developer',
  email: 'alex.fixture@example.com',
  location: 'Alberta, Canada',
};

function syntheticResumeContent(): unknown {
  return {
    identity: SYNTHETIC_IDENTITY, // S6: renders need a header; stored at generation time
    diff: {
      summary:
        'Senior Developer with 10 years of experience delivering a platform serving 40k users across web and batch workloads.',
      skills_order: ['TypeScript', 'React', 'PostgreSQL'],
      bullets: [],
      keywords: ['distributed systems', 'TypeScript', 'PostgreSQL'],
    },
    resume: {
      summary:
        'Senior Developer with 10 years of experience delivering a platform serving 40k users, from schema design to batch reporting.',
      keywords: ['distributed systems', 'TypeScript', 'PostgreSQL'],
      skills: ['TypeScript', 'React', 'PostgreSQL'],
      experience: [
        {
          employer: 'Chinook Fixtures Inc.',
          title: 'Senior Developer',
          start: '2020',
          end: 'present',
          technology: ['TypeScript', 'PostgreSQL'],
          bullets: [
            'Built a platform serving 40k users with 99.9% uptime.',
            'Cut batch reporting latency by 60% through query redesign.',
          ],
        },
      ],
      education: [{ degree: 'B.Sc. Computer Science', school: 'University of Fixtures', year: '2014' }],
    },
  };
}

function syntheticCoverContent(): unknown {
  return {
    identity: SYNTHETIC_IDENTITY,
    letter: [
      'Dear Hiring Manager,',
      'I am applying for the Senior Developer role at Chinook Fixtures Inc. My background covers TypeScript, PostgreSQL and building a platform serving 40k users.',
      'Thank you for your consideration.',
    ].join('\n\n'),
  };
}

/** S22: parameterizable artifact fixture — a row as the e2e seed inserts it. */
export interface ArtifactFixture {
  kind: 'resume' | 'cover_letter' | 'render_docx' | 'render_pdf';
  version?: number;
  status: 'valid' | 'invalid';
  content: unknown;
  validation?: { valid: boolean; violations: Array<{ kind: string; detail: string }> };
  createdAt?: Date;
}

/**
 * S22: inserts artifact fixtures on an explicit job (direct insertInto mirrors
 * saveArtifact without the version-derivation transaction; llm_run_id points
 * at the always-present first run slot — no FK on artifact.llm_run_id).
 * Previous fixtures on the job are replaced.
 */
export async function seedArtifactsOnJob(
  db: ReturnType<typeof createDb>,
  jobId: string,
  fixtures: ArtifactFixture[],
): Promise<void> {
  await db.deleteFrom('artifact').where('job_id', '=', jobId).execute();
  await db
    .insertInto('artifact')
    .values(
      fixtures.map((f) => ({
        id: randomUUID(),
        job_id: jobId,
        kind: f.kind,
        version: f.version ?? 1,
        status: f.status,
        content: JSON.stringify(f.content),
        validation: JSON.stringify(
          f.validation ?? { valid: f.status === 'valid', violations: [] },
        ),
        llm_run_id: 1,
        created_at: f.createdAt ?? new Date(),
      })),
    )
    .execute();
}

/** S8: synthetic render file bytes (magic headers + padding, no real content). */
function renderFileBytes(format: 'docx' | 'pdf'): Buffer {
  if (format === 'docx') {
    return Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(180, 7)]);
  }
  return Buffer.concat([Buffer.from([0x25, 0x50, 0x44, 0x46]), Buffer.alloc(150, 7)]);
}

/** S8: seeds render rows + synthetic files for the dispatch e2e. The caller
 * supplies the e2e artifacts dir as an ABSOLUTE path (computed by the worker
 * seed script from its own cwd) — core never derives filesystem paths itself.
 */
async function seedDispatchFixtures(
  db: ReturnType<typeof createDb>,
  jobId: string,
  artifactsDir: string,
): Promise<void> {
  if (!/^(?:[A-Za-z]:)?[\\/]/.test(artifactsDir)) return; // absolute paths only
  const source = await db
    .selectFrom('artifact')
    .where('job_id', '=', jobId)
    .where('kind', '=', 'resume')
    .where('status', '=', 'valid')
    .orderBy('version', 'desc')
    .select(['id', 'version'])
    .executeTakeFirst();
  if (!source) return;
  for (const format of ['docx', 'pdf'] as const) {
    const fileName = `resume-v${source.version}.${format}`;
    await saveRenderArtifact(db, {
      jobId,
      sourceArtifactId: source.id,
      sourceKind: 'resume',
      sourceVersion: source.version,
      format,
      contentPath: `${jobId}/${fileName}`,
      version: 1,
    });
    await mkdir(join(artifactsDir, jobId), { recursive: true });
    await writeFile(join(artifactsDir, jobId, fileName), renderFileBytes(format));
  }
  console.log('e2e seed: +render fixtures (docx/pdf files) for dispatch');
}

/**
 * Seeds two artifact versions on the FIRST relevant job (the row a
 * `/?rule=relevant` first-title click opens — page order is posted_at desc,
 * canonical_hash asc): resume v1 valid + cover_letter v1 invalid.
 */
async function seedArtifacts(db: ReturnType<typeof createDb>): Promise<void> {
  const firstRelevant = await db
    .selectFrom('job')
    .select(['job.id'])
    .where('rule_status', '=', 'relevant')
    .orderBy('job.posted_at', 'desc')
    .orderBy('job.canonical_hash', 'asc')
    .executeTakeFirst();
  if (!firstRelevant) return;

  await seedArtifactsOnJob(db, firstRelevant.id, [
    {
      kind: 'cover_letter',
      status: 'invalid',
      content: syntheticCoverContent(),
      validation: {
        valid: false,
        violations: [
          { kind: 'word_limit', detail: 'word_limit: 342 words exceeds the 300 word limit' },
        ],
      },
      createdAt: new Date('2026-09-21T10:00:00Z'),
    },
    {
      kind: 'resume',
      status: 'valid',
      content: syntheticResumeContent(),
      createdAt: new Date('2026-09-20T10:00:00Z'),
    },
  ]);
  console.log('e2e seed: +2 artifact versions on first relevant job (resume v1 valid, cover_letter v1 invalid)');
}

/** Inserts the S19/S20 synthetic rows plus S5 artifact fixtures into the e2e database.
 * artifactsDir (absolute, optional) enables the S8 dispatch render-file fixtures. */
export async function seedE2eExtras(artifactsDir?: string): Promise<void> {
  const db = createDb(e2eUrl());
  await ensureSchema(db);
  await upsertJobs(db, [
    { ...s19Row(1, 's19-e2e-on-developer', 'S19 e2e Ontario developer', 'toronto', 'ON', false), raw: { description: longDescription } },
    s19Row(2, 's19-e2e-remote-developer', 'S19 e2e remote developer', '', '', true),
  ]);
  await db
    .updateTable('job')
    .set({ rule_status: 'relevant' })
    .where('canonical_hash', 'in', ['s19-e2e-on-developer', 's19-e2e-remote-developer'])
    .execute();
  await seedArtifacts(db);
  const firstRelevant = await db
    .selectFrom('job')
    .select(['job.id'])
    .where('rule_status', '=', 'relevant')
    .orderBy('job.posted_at', 'desc')
    .orderBy('job.canonical_hash', 'asc')
    .executeTakeFirst();
  if (firstRelevant) {
    // S9: form dispatch fixture — targets the app's own /mock-form page.
    await db
      .updateTable('job')
      .set({
        raw: {
          formConfig: {
            url: 'http://localhost:3999/mock-form',
            selectors: {},
            successText: 'Thank you for your application!',
          },
        },
      })
      .where('id', '=', firstRelevant.id)
      .execute();
    console.log('e2e seed: +formConfig (mock-form) on first relevant job');
  }
  if (artifactsDir && firstRelevant) await seedDispatchFixtures(db, firstRelevant.id, artifactsDir);
  await db.destroy();
  console.log('e2e seed: +2 S19 synthetic rows (ON relevant, remote relevant)');
}
