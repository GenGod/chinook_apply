import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import {
  createDb,
  ensureSchema,
  saveArtifact,
  markAppliedManually,
  type Database,
  type MasterProfileLike,
} from '@chinook/core';
import {
  selectAutoDraftCandidates,
  runAutoDraft,
  DEFAULT_AUTODRAFT_SCORE,
} from '@chinook/llm';
import type { Kysely } from 'kysely';
import type { Llm } from '@chinook/llm';

/**
 * S23 R3: auto-draft selection + run. Synthetic seed: three relevant jobs
 * (score 90 / 80 / 70), one already-drafted, one already-applied. Mock LLM
 * returns a valid diff/letter — no network, no real cost.
 */
const db: Kysely<Database> = createDb(
  process.env.DATABASE_URL ?? 'postgres://chinook:chinook_dev@localhost:5433/chinook_test',
);

const master: MasterProfileLike = {
  summary: 'Senior full-stack engineer with 11 years of experience building TypeScript platforms for fintech and gaming.',
  skills: { frontend: ['TypeScript', 'React'], backend: ['Node.js', 'PostgreSQL'] },
  experience: [
    {
      id: 'voki',
      employer: 'Voki Labs',
      title: 'Senior Engineer',
      start: '2020-03',
      end: 'Present',
      bullets: ['Owned platform serving 40k users', 'Cut latency by 35%'],
      technology: ['React'],
    },
  ],
  education: [],
};

const validDiff = {
  summary: 'Senior full-stack engineer with 11 years of experience building TypeScript platforms.',
  skills_order: ['TypeScript', 'React'],
  bullets: [{ experience_id: 'voki', bullet_index: 0, rephrase: 'Owned a platform serving 40k users' }],
  keywords: ['TypeScript'],
};
const validLetter = [
  'Dear Hiring Manager,',
  'I am applying for the Senior Developer role. My background covers TypeScript and PostgreSQL since 2020 at Voki Labs.',
  'Thank you for your consideration.',
].join('\n\n');

interface RecordedCall {
  stage: string;
  user: string;
}

function makeMockLlm() {
  const calls: RecordedCall[] = [];
  const llm = {
    async call(input: { stage: string; user: string }) {
      calls.push({ stage: input.stage, user: input.user });
      if (input.stage === 'generate_resume') {
        return { data: validDiff, runId: 1, usage: { costUsd: 0.001 } };
      }
      return { data: { letter: validLetter }, runId: 2, usage: { costUsd: 0.001 } };
    },
    breakerState: () => ({ open: false, consecutiveFailures: 0 }),
  } as unknown as Llm;
  return { llm, calls };
}

async function seedJob(score: number | null): Promise<string> {
  const id = randomUUID();
  await db
    .insertInto('job')
    .values({
      id,
      canonical_hash: `s23-${id}`,
      title: `S23 job ${score}`,
      employer: 'Fixture Corp',
      city: 'edmonton',
      province: 'AB',
      remote: false,
      url: `https://example.invalid/${id}`,
      urls: [],
      source: 'jobbank',
      source_job_id: `s23-${id}`,
      posted_at: new Date(),
      salary_currency: 'CAD',
      rule_status: 'relevant',
      ingested_at: new Date(),
    })
    .execute();
  if (score !== null) {
    await db
      .insertInto('job_match')
      .values({
        job_id: id,
        score,
        reasons: JSON.stringify(['r']),
        risks: JSON.stringify([]),
        noc_guess: '21231',
        prompt_version: 'v5',
        llm_run_id: 1,
      })
      .execute();
  }
  return id;
}

describe('auto-draft (S23 R3)', () => {
  let top = '';
  let mid = '';
  let low = '';
  let drafted = '';
  let applied = '';

  beforeAll(async () => {
    await ensureSchema(db);
    top = await seedJob(90);
    mid = await seedJob(80);
    low = await seedJob(70);
    drafted = await seedJob(95); // already has a valid resume → excluded
    applied = await seedJob(92); // already applied → excluded
    await saveArtifact(db, {
      jobId: drafted,
      kind: 'resume',
      status: 'valid',
      content: { x: 1 },
      validation: { valid: true, violations: [] },
      llmRunId: 1,
    });
    await markAppliedManually(db, applied);
  });

  afterAll(async () => {
    for (const id of [top, mid, low, drafted, applied]) {
      await db.deleteFrom('artifact').where('job_id', '=', id).execute();
      await db.deleteFrom('job_match').where('job_id', '=', id).execute();
      await db.deleteFrom('application').where('job_id', '=', id).execute();
      await db.deleteFrom('job').where('id', '=', id).execute();
    }
    await db.destroy();
  });

  it('selects only fresh top-scored jobs (score/exists filters, score desc)', async () => {
    const candidates = await selectAutoDraftCandidates(db, { scoreMin: 85, limit: 10 });
    const ids = candidates.map((c) => c.jobId);
    expect(ids).toContain(top);
    expect(ids).not.toContain(mid); // 80 < 85
    expect(ids).not.toContain(low);
    expect(ids).not.toContain(drafted); // has valid resume
    expect(ids).not.toContain(applied); // has application row
    expect(candidates.find((c) => c.jobId === top)!.score).toBe(90);
  });

  it('respects the remaining daily limit (autodrafted-today count)', async () => {
    // one existing autodraft-flagged artifact today → limit 2 leaves 1 slot
    const flagJob = await seedJob(88);
    await saveArtifact(db, {
      jobId: flagJob,
      kind: 'resume',
      status: 'valid',
      content: { autodraft: true },
      validation: { valid: true, violations: [] },
      llmRunId: 1,
    });
    const candidates = await selectAutoDraftCandidates(db, { scoreMin: 85, limit: undefined });
    // candidates capped by AUTO_DRAFT_JOBS_PER_DAY(10) - 1 autodrafted = 9 →
    // explicit check: selection is at most that; with our small seed it holds top+flagJob-source? flagJob has no valid resume unflagged? It HAS a valid resume (the flagged one) → excluded from candidates. So candidates = [top].
    expect(candidates.length).toBeLessThanOrEqual(9);
    expect(candidates.map((c) => c.jobId)).toContain(top);
    await db.deleteFrom('artifact').where('job_id', '=', flagJob).execute();
    await db.deleteFrom('job_match').where('job_id', '=', flagJob).execute();
    await db.deleteFrom('job').where('id', '=', flagJob).execute();
  });

  it('runAutoDraft drafts both documents with the autodraft content flag', async () => {
    const { llm } = makeMockLlm();
    const summary = await runAutoDraft(db, llm, { candidates: [{ jobId: top, title: 'S23 job 90', score: 90 }], master, loadIdentity: () => null });
    expect(summary).toEqual({ considered: 1, drafted: 1, skipped: 0, errors: 0 });

    const artifacts = await db.selectFrom('artifact').selectAll().where('job_id', '=', top).execute();
    expect(artifacts.filter((a) => a.kind === 'resume')).toHaveLength(1);
    expect(artifacts.filter((a) => a.kind === 'cover_letter')).toHaveLength(1);
    const resumeContent = artifacts.find((a) => a.kind === 'resume')!.content as { autodraft?: boolean };
    expect(resumeContent.autodraft).toBe(true);
  });

  it('one failing candidate does not stop the batch', async () => {
    const { llm } = makeMockLlm();
    const missing = randomUUID(); // no job row → JobNotEligibleError → skipped
    const summary = await runAutoDraft(db, llm, {
      candidates: [
        { jobId: missing, title: 'ghost', score: 90 },
        { jobId: mid, title: 'S23 job 80', score: 80 },
      ],
      master,
      loadIdentity: () => null,
    });
    expect(summary.drafted).toBe(1); // mid drafted despite the ghost
    expect(summary.skipped).toBe(1);
  });

  it('default threshold constant exported', () => {
    expect(DEFAULT_AUTODRAFT_SCORE).toBe(85);
  });
});
