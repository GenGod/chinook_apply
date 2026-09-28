// E2E extra fixtures (S19/S20 synthetic rows, S5 artifact versions) — lives in
// core so the env-sourced connection string flows through the guarded createDb
// path (assertSafeDatabaseUrl host allowlist). Database bootstrap stays in the
// worker seed script; this module only seeds rows.
import process from 'node:process';
import { randomUUID } from 'node:crypto';
import type { Job } from '@chinook/contracts';
import { createDb, ensureSchema, upsertJobs, DEV_DATABASE_URL } from './db';

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

/**
 * Seeds two artifact versions on the FIRST relevant job (the row a
 * `/?rule=relevant` first-title click opens — page order is posted_at desc,
 * canonical_hash asc): resume v1 valid + cover_letter v1 invalid. Direct
 * insertInto mirrors saveArtifact (packages/core/artifacts.ts) without the
 * version-derivation transaction; llm_run_id points at the always-present
 * first run slot (no FK on artifact.llm_run_id).
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

  await db.deleteFrom('artifact').where('job_id', '=', firstRelevant.id).execute();
  await db
    .insertInto('artifact')
    .values([
      {
        id: randomUUID(),
        job_id: firstRelevant.id,
        kind: 'cover_letter',
        version: 1,
        status: 'invalid',
        content: JSON.stringify(syntheticCoverContent()),
        validation: JSON.stringify({
          valid: false,
          violations: [
            { kind: 'word_limit', detail: 'word_limit: 342 words exceeds the 300 word limit' },
          ],
        }),
        llm_run_id: 1,
        created_at: new Date('2026-09-21T10:00:00Z'),
      },
      {
        id: randomUUID(),
        job_id: firstRelevant.id,
        kind: 'resume',
        version: 1,
        status: 'valid',
        content: JSON.stringify(syntheticResumeContent()),
        validation: JSON.stringify({ valid: true, violations: [] }),
        llm_run_id: 1,
        created_at: new Date('2026-09-20T10:00:00Z'),
      },
    ])
    .execute();
  console.log('e2e seed: +2 artifact versions on first relevant job (resume v1 valid, cover_letter v1 invalid)');
}

/** Inserts the S19/S20 synthetic rows plus S5 artifact fixtures into the e2e database. */
export async function seedE2eExtras(): Promise<void> {
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
  await db.destroy();
  console.log('e2e seed: +2 S19 synthetic rows (ON relevant, remote relevant)');
}
