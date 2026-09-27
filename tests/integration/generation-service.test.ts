import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { sql } from 'kysely';
import { createDb, ensureSchema, getArtifactContent, type MasterProfileLike } from '@chinook/core';
import type { Llm } from '@chinook/llm';
import {
  generateDocuments,
  GenerationLimitError,
  JobNotEligibleError,
} from '../../apps/web/src/lib/generation-service';

/**
 * S5 T6 (red→green): generation orchestration — generateDocuments against real
 * Postgres with a mocked Llm (routed through llm.call). Covers: valid first try,
 * violations-injected retry (attempt 2 prompt contains "PREVIOUS ATTEMPT FAILED"),
 * double-fail → invalid artifact with persisted violations, daily cost cap
 * (GenerationLimitError before any call; mid-run stop returning saved artifacts),
 * job eligibility (JobNotEligibleError for missing/excluded jobs). Synthetic
 * master/job fixtures only — the real master profile is gitignored PII and is
 * never loaded in tests.
 */
const databaseUrl = process.env.DATABASE_URL ?? 'postgres://chinook:chinook_dev@localhost:5433/chinook_test';

// --- synthetic fixtures (no PII) ---

const master: MasterProfileLike = {
  summary:
    'Senior full-stack engineer with 11 years of experience building TypeScript platforms for fintech and gaming, spanning catalog search, data pipelines and platform tooling.',
  skills: {
    frontend: ['TypeScript', 'React', 'Next.js'],
    backend: ['Node.js', 'NestJS', 'PostgreSQL'],
  },
  experience: [
    {
      id: 'exp-games',
      employer: 'VOKI Games',
      title: 'Senior Full-Stack Engineer',
      start: '2026-07',
      end: 'Present',
      bullets: [
        'Owned architecture and delivery of an internal platform covering catalog search and level analysis for 9325 levels.',
        'Built the React front end and Node APIs on PostgreSQL, recording p95 response times of 28 ms.',
        'Introduced Git-based review workflows adopted by three teams.',
      ],
      technology: ['TypeScript', 'React', 'Node.js'],
    },
    {
      id: 'exp-fintech',
      employer: 'NorthPay',
      title: 'Backend Engineer',
      start: '2019-01',
      end: '2026-06',
      bullets: [
        'Modernized the payment API serving 1.2 million requests per day with 99.95 percent uptime.',
        'Cut build times from 14 minutes to 4 minutes by restructuring the monorepo pipeline.',
      ],
    },
  ],
  education: [],
};

const validDiff = {
  summary:
    'Senior full-stack engineer with 11 years of experience building TypeScript platforms for fintech and gaming; strong in catalog search and data pipelines.',
  skills_order: ['TypeScript', 'React', 'Node.js'],
  bullets: [
    { experience_id: 'exp-games', bullet_index: 0 },
    { experience_id: 'exp-fintech', bullet_index: 0 },
    { experience_id: 'exp-games', bullet_index: 2 },
  ],
  keywords: ['typescript', 'react', 'node'],
};

const invalidSkillDiff = {
  ...validDiff,
  skills_order: ['TypeScript', 'React', 'Kubernetes Sorcery'],
};

const ghostExperienceDiff = {
  summary: validDiff.summary,
  skills_order: ['TypeScript', 'React', 'Node.js'],
  bullets: [
    { experience_id: 'exp-ghost', bullet_index: 0 },
    { experience_id: 'exp-ghost', bullet_index: 1 },
    { experience_id: 'exp-ghost', bullet_index: 2 },
  ],
  keywords: [],
};

const validLetter = `Dear Hiring Manager,

I am applying for the open engineering role at Chinook Systems. With 11 years of experience building TypeScript platforms for fintech and gaming, I have owned architecture and delivery of internal platforms covering catalog search, data pipelines and developer tooling.

In my current role I built React front ends and Node APIs on PostgreSQL with p95 response times of 28 ms, and I previously modernized a payment API serving 1.2 million requests per day. I would bring the same delivery focus to your team in Alberta.

Sincerely,`;

const salaryLetter = `${validLetter} My salary expectations are flexible.`;

const FULL_DESCRIPTION =
  'We are hiring a senior engineer for our Calgary platform team. The role covers TypeScript services, React front ends and PostgreSQL data pipelines at scale.';

// --- mocked Llm routed through llm.call ---

interface RecordedCall {
  stage: string;
  system: string;
  user: string;
}

function makeMockLlm(handler: (input: RecordedCall, nth: number) => unknown): { llm: Llm; call: ReturnType<typeof vi.fn> } {
  let nth = 0;
  const call = vi.fn(async (input: RecordedCall) => {
    const i = nth;
    nth += 1;
    return {
      data: handler(input, i),
      runId: 100 + i,
      cached: false,
      usage: { costUsd: 0.001, promptTokens: 1, completionTokens: 1, totalTokens: 2, latencyMs: 1 },
      model: 'mock',
    };
  });
  const llm = { call, breakerState: () => ({ open: false, consecutiveFailures: 0 }) } as unknown as Llm;
  return { llm, call };
}

describe('generateDocuments (S5 T6)', () => {
  let db: ReturnType<typeof createDb>;
  const jobIds: string[] = [];

  const seedJob = async (overrides: { ruleStatus?: string | null; employer?: string } = {}): Promise<string> => {
    const id = crypto.randomUUID();
    await sql`
      insert into job (id, canonical_hash, title, employer, city, province, remote, url, urls, source, salary_currency, raw, ingested_at, updated_at, rule_status)
      values (
        ${id}, ${'s5-t6-' + id}, 'Senior Full-Stack Engineer', ${overrides.employer ?? 'Chinook Systems'},
        'calgary', 'AB', true, ${'https://example.com/s5-t6-' + id}, '[]'::jsonb, 'jobbank', 'CAD',
        ${JSON.stringify({ fullDescription: FULL_DESCRIPTION, description: '<p>snippet description fallback</p>' })}::jsonb,
        now(), now(), ${overrides.ruleStatus ?? 'relevant'}::text
      )
      on conflict (id) do nothing
    `.execute(db);
    jobIds.push(id);
    return id;
  };

  const seedMatch = async (jobId: string, score: number, reason: string): Promise<void> => {
    await sql`
      insert into job_match (job_id, llm_run_id, score, reasons, risks, prompt_version)
      values (${jobId}, 1, ${score}, ${JSON.stringify([reason])}::jsonb, '[]'::jsonb, 'v1')
    `.execute(db);
  };

  beforeAll(async () => {
    db = createDb(databaseUrl);
    await ensureSchema(db);
    // rerun-safe: clear generation spend rows and stale fixtures
    await sql`delete from llm_run where stage in ('generate_resume', 'generate_cover')`.execute(db);
  });

  afterAll(async () => {
    if (!db) return;
    await sql`delete from llm_run where stage in ('generate_resume', 'generate_cover')`.execute(db);
    for (const id of jobIds) {
      await sql`delete from artifact where job_id = ${id}`.execute(db);
      await sql`delete from job_match where job_id = ${id}`.execute(db);
      await sql`delete from job where id = ${id}`.execute(db);
    }
    await db.destroy();
  });

  it('resume valid on first attempt: 1 call, valid artifact, content {diff, resume}, score+description in prompt', async () => {
    const jobId = await seedJob();
    await seedMatch(jobId, 61, 'Old reason');
    await seedMatch(jobId, 87, 'Strong TypeScript match'); // latest by id desc wins
    const { llm, call } = makeMockLlm(() => validDiff);

    const { artifacts } = await generateDocuments(db, llm, jobId, ['resume'], { master });

    expect(call).toHaveBeenCalledTimes(1);
    const input = call.mock.calls[0]![0] as RecordedCall;
    expect(input.stage).toBe('generate_resume');
    expect(input.user).toContain('**Match Score:** 87/100');
    expect(input.user).toContain('- Strong TypeScript match');
    expect(input.user).not.toContain('Old reason');
    expect(input.user).toContain('Calgary platform team'); // fullDescription preferred
    expect(input.user).not.toContain('snippet description fallback');

    expect(artifacts).toHaveLength(1);
    expect(artifacts[0]).toMatchObject({ jobId, kind: 'resume', version: 1, status: 'valid', violations: [] });

    const content = await getArtifactContent(db, artifacts[0]!.id);
    const payload = content!.content as { diff: typeof validDiff; resume: { skills: string[]; experience: Array<{ employer: string; bullets: string[] }> } };
    expect(payload.diff).toEqual(validDiff);
    expect(payload.resume.skills.slice(0, 3)).toEqual(['TypeScript', 'React', 'Node.js']);
    const games = payload.resume.experience.find((e) => e.employer === 'VOKI Games');
    expect(games!.bullets).toHaveLength(2); // bullet_index 0 and 2 selected
  });

  it('cover letter valid on first attempt: stage generate_cover, content {letter}, no match row → no score line', async () => {
    const jobId = await seedJob(); // no job_match rows
    const { llm, call } = makeMockLlm(() => ({ letter: validLetter }));

    const { artifacts } = await generateDocuments(db, llm, jobId, ['cover_letter'], { master });

    expect(call).toHaveBeenCalledTimes(1);
    const input = call.mock.calls[0]![0] as RecordedCall;
    expect(input.stage).toBe('generate_cover');
    expect(input.user).not.toContain('Match Score'); // score+reasons passed together or not at all

    expect(artifacts).toHaveLength(1);
    expect(artifacts[0]!.status).toBe('valid');
    const content = await getArtifactContent(db, artifacts[0]!.id);
    expect(content!.content).toEqual({ letter: validLetter });
  });

  it('resume invalid then valid: 2 calls, retry prompt contains PREVIOUS ATTEMPT FAILED and the violation detail', async () => {
    const jobId = await seedJob();
    const { llm, call } = makeMockLlm((_input, nth) => (nth === 0 ? invalidSkillDiff : validDiff));

    const { artifacts } = await generateDocuments(db, llm, jobId, ['resume'], { master });

    expect(call).toHaveBeenCalledTimes(2);
    const second = call.mock.calls[1]![0] as RecordedCall;
    expect(second.user).toContain('PREVIOUS ATTEMPT FAILED');
    expect(second.user).toContain('Kubernetes Sorcery');

    expect(artifacts).toHaveLength(1);
    expect(artifacts[0]!.status).toBe('valid');
    expect(artifacts[0]!.version).toBe(1); // invalid attempt 1 is not persisted
  });

  it('resume double-fail on unknown experience: artifact invalid with persisted violations', async () => {
    const jobId = await seedJob();
    const { llm, call } = makeMockLlm(() => ghostExperienceDiff);

    const { artifacts } = await generateDocuments(db, llm, jobId, ['resume'], { master });

    expect(call).toHaveBeenCalledTimes(2);
    const second = call.mock.calls[1]![0] as RecordedCall;
    expect(second.user).toContain('PREVIOUS ATTEMPT FAILED');
    expect(second.user).toContain('exp-ghost');

    expect(artifacts).toHaveLength(1);
    expect(artifacts[0]!.status).toBe('invalid');
    const content = await getArtifactContent(db, artifacts[0]!.id);
    expect(content!.status).toBe('invalid');
    expect(content!.violations).toContain('exp-ghost');
    expect((content!.content as { diff: { bullets: unknown[] } }).diff.bullets.length).toBe(3);
  });

  it('cover letter double-fail (salary pattern): artifact invalid with violations persisted', async () => {
    const jobId = await seedJob();
    const { llm, call } = makeMockLlm(() => ({ letter: salaryLetter }));

    const { artifacts } = await generateDocuments(db, llm, jobId, ['cover_letter'], { master });

    expect(call).toHaveBeenCalledTimes(2);
    const second = call.mock.calls[1]![0] as RecordedCall;
    expect(second.user).toContain('PREVIOUS ATTEMPT FAILED');
    expect(second.user).toContain('salary expectation'); // validator detail string (regex match)

    expect(artifacts).toHaveLength(1);
    expect(artifacts[0]!.status).toBe('invalid');
    const content = await getArtifactContent(db, artifacts[0]!.id);
    expect(content!.violations).toContain('salary expectation'); // validator detail string (regex match)
  });

  it('daily limit already spent: GenerationLimitError before any llm call', async () => {
    const jobId = await seedJob();
    await sql`delete from llm_run where stage in ('generate_resume', 'generate_cover')`.execute(db);
    await sql`
      insert into llm_run (stage, role, model, cost_usd, ts)
      values ('generate_resume', 'main', 'mock', 1.0, now())
    `.execute(db);
    const { llm, call } = makeMockLlm(() => validDiff);

    await expect(generateDocuments(db, llm, jobId, ['resume'], { master })).rejects.toBeInstanceOf(GenerationLimitError);
    expect(call).not.toHaveBeenCalled();
    await sql`delete from llm_run where stage in ('generate_resume', 'generate_cover')`.execute(db);
  });

  it('stops between artifact attempts when the limit is reached mid-run, returning what is saved', async () => {
    const jobId = await seedJob();
    await sql`delete from llm_run where stage in ('generate_resume', 'generate_cover')`.execute(db);
    await sql`
      insert into llm_run (stage, role, model, cost_usd, ts)
      values ('generate_cover', 'main', 'mock', 0.9995, now())
    `.execute(db);
    const { llm, call } = makeMockLlm(() => validDiff);

    const { artifacts } = await generateDocuments(db, llm, jobId, ['resume', 'cover_letter'], { master });

    expect(call).toHaveBeenCalledTimes(1); // resume attempt 1 only; cover is stopped by the budget check
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0]!.kind).toBe('resume');
    expect(artifacts[0]!.status).toBe('valid');
  });

  it('excluded job: JobNotEligibleError', async () => {
    const jobId = await seedJob({ ruleStatus: 'excluded' });
    const { llm, call } = makeMockLlm(() => validDiff);
    await expect(generateDocuments(db, llm, jobId, ['resume'], { master })).rejects.toBeInstanceOf(JobNotEligibleError);
    expect(call).not.toHaveBeenCalled();
  });

  it('missing job: JobNotEligibleError', async () => {
    const { llm, call } = makeMockLlm(() => validDiff);
    await expect(generateDocuments(db, llm, crypto.randomUUID(), ['resume'], { master })).rejects.toBeInstanceOf(JobNotEligibleError);
    expect(call).not.toHaveBeenCalled();
  });
});
