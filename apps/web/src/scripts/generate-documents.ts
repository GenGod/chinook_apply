// S5 golden run (T9): live glm-5.3 generation for the top v5-scored relevant
// jobs. Metrics only on stdout — artifact content and violation details never
// leave the database (Constitution 3.2); invalid artifacts print violation
// KINDS only. Artifacts persist to the live DB for PO review in the UI.
// Run from apps/web so the static master-profile path resolves:
//   pnpm --filter @chinook/web generate:documents
import process from 'node:process';
import type { Kysely } from 'kysely';
import type { Database } from '@chinook/core';
import { createDb } from '@chinook/core';
import { createLlm, createPgLlmDb } from '@chinook/llm';
import {
  generateDocuments,
  GenerationLimitError,
  JobNotEligibleError,
} from '../lib/generation-service';

const GOLDEN_JOBS = 4;

interface GoldenJob {
  jobId: string;
  score: number;
  title: string;
}

interface JobResult {
  title: string;
  resume: string;
  cover: string;
  invalidKinds: string[];
  calls: number;
  costUsd: number;
}

async function maxLlmRunId(db: Kysely<Database>): Promise<number> {
  const row = await db
    .selectFrom('llm_run')
    .select((eb) => eb.fn.max<number | null>('llm_run.id').as('maxId'))
    .executeTakeFirst();
  return Number(row?.maxId ?? 0);
}

async function windowMetrics(db: Kysely<Database>, afterId: number): Promise<{ calls: number; costUsd: number }> {
  const rows = await db
    .selectFrom('llm_run')
    .where('llm_run.id', '>', afterId)
    .select(['llm_run.cost_usd'])
    .execute();
  return { calls: rows.length, costUsd: rows.reduce((a, r) => a + Number(r.cost_usd), 0) };
}

/** Violation KINDS from the stored validation JSONB ({valid, violations:[{kind,detail}]}). */
async function violationKinds(db: Kysely<Database>, artifactId: string): Promise<string[]> {
  const row = await db
    .selectFrom('artifact')
    .where('artifact.id', '=', artifactId)
    .select(['artifact.validation'])
    .executeTakeFirst();
  const violations = (row?.validation as { violations?: Array<{ kind?: unknown }> } | null)?.violations;
  if (!Array.isArray(violations)) return [];
  return violations.map((v) => (typeof v?.kind === 'string' ? v.kind : 'unknown'));
}

async function main(): Promise<void> {
  const db = createDb(process.env.DATABASE_URL ?? 'postgres://chinook:chinook_dev@localhost:5433/chinook');
  const llm = createLlm({ db: createPgLlmDb(db) });

  const rows = await db
    .selectFrom('job_match')
    .innerJoin('job', 'job.id', 'job_match.job_id')
    .where('job_match.prompt_version', '=', 'v5')
    .where('job.rule_status', '=', 'relevant')
    .orderBy('job_match.score', 'desc')
    .select(['job_match.job_id as jobId', 'job_match.score as score', 'job.title as title'])
    .execute();
  // upsertMatch appends — keep the max-score row per job (latest wins)
  const best = new Map<string, GoldenJob>();
  for (const r of rows) {
    const prev = best.get(r.jobId);
    if (!prev || r.score > prev.score) best.set(r.jobId, { jobId: r.jobId, score: r.score, title: r.title });
  }
  const jobs = [...best.values()].sort((a, b) => b.score - a.score).slice(0, GOLDEN_JOBS);
  if (jobs.length === 0) {
    console.log('golden-generation: no v5-scored relevant jobs — nothing to do');
    await db.destroy();
    return;
  }
  console.log(`golden-generation: ${jobs.length} jobs (top v5 scores)`);
  for (const j of jobs) console.log(`  score=${j.score} ${j.title.slice(0, 60)}`);

  const results: JobResult[] = [];
  for (const job of jobs) {
    const before = await maxLlmRunId(db);
    try {
      const { artifacts } = await generateDocuments(db, llm, job.jobId, ['resume', 'cover_letter']);
      const m = await windowMetrics(db, before);
      const fmt = (kind: string): string => {
        const a = artifacts.find((x) => x.kind === kind);
        return a ? `${a.status} v${a.version}` : 'missing';
      };
      const invalidKinds: string[] = [];
      for (const a of artifacts) {
        if (a.status === 'invalid') invalidKinds.push(...(await violationKinds(db, a.id)));
      }
      results.push({
        title: job.title,
        resume: fmt('resume'),
        cover: fmt('cover_letter'),
        invalidKinds,
        calls: m.calls,
        costUsd: m.costUsd,
      });
    } catch (error) {
      if (error instanceof GenerationLimitError) {
        console.log(`  STOP: ${error.message}`);
        break;
      }
      if (error instanceof JobNotEligibleError) {
        console.log(`  SKIP (not eligible): ${job.title.slice(0, 50)}`);
        continue;
      }
      console.log(`  FAIL ${job.title.slice(0, 50)}: ${String(error).slice(0, 120)}`);
    }
  }

  console.log('\n=== GOLDEN RUN (metrics only — no artifact content, PII stays in DB) ===');
  console.log('job                                 | resume        | cover         | calls | cost USD');
  for (const r of results) {
    const kinds = r.invalidKinds.length > 0 ? ` [invalid: ${r.invalidKinds.join(',')}]` : '';
    console.log(
      `${r.title.slice(0, 35).padEnd(35)} | ${r.resume.padEnd(13)} | ${r.cover.padEnd(13)} | ${String(r.calls).padStart(5)} | ${r.costUsd.toFixed(6)}${kinds}`,
    );
  }
  const totalCalls = results.reduce((a, r) => a + r.calls, 0);
  const totalCost = results.reduce((a, r) => a + r.costUsd, 0);
  console.log(`\ntotal: ${results.length}/${jobs.length} jobs, ${totalCalls} llm calls, cost $${totalCost.toFixed(6)}`);
  await db.destroy();
}

main().catch((error: unknown) => {
  console.error(`FATAL: ${String(error).slice(0, 300)}`);
  process.exitCode = 1;
});
