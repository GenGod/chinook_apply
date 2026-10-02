// S24 golden run, stage 2: re-score the TOP unscored-for-v6 jobs with the
// track-aware prompt (v6) so best_track lands in job_match. Metrics only.
import process from 'node:process';
import { readFileSync } from 'node:fs';
import { createDb, ensureSchema, upsertMatch, type CareerTrack } from '@chinook/core';
import { masterProfileFilePath } from '@chinook/core';
import { createLlm, createPgLlmDb, buildScoringPrompt, TrackAwareMatchScoreSchema, extractProfileSummary, type ScoringJob } from '@chinook/llm';

const TOP_N = 5;

async function main(): Promise<void> {
  const db = createDb(process.env.DATABASE_URL ?? 'postgres://chinook:chinook_dev@localhost:5433/chinook');
  await ensureSchema(db);
  const llm = createLlm({ db: createPgLlmDb(db) });

  const master = JSON.parse(readFileSync(masterProfileFilePath(), 'utf8')) as {
    tracks?: CareerTrack[];
  };
  const tracks = Array.isArray(master.tracks) ? master.tracks : [];
  if (tracks.length === 0) {
    console.log('no tracks in the master — run golden:tracks (approve) first');
    await db.destroy();
    return;
  }
  console.log(`tracks: ${tracks.map((t) => t.id).join(', ')}`);

  // top jobs by their best existing v5 score that have no v6 row yet
  const rows = (
    await db
      .selectFrom('job_match')
      .innerJoin('job', 'job.id', 'job_match.job_id')
      .where('job_match.prompt_version', '=', 'v5')
      .where((eb) =>
        eb.not(
          eb.exists(
            eb.selectFrom('job_match as m2').select('id').whereRef('m2.job_id', '=', 'job.id').where('m2.prompt_version', '=', 'v6'),
          ),
        ),
      )
      .select((eb) => ['job.id as job_id', 'job.title as title', 'job.employer as employer', 'job.raw as raw', eb.fn.max('job_match.score').as('score')])
      .groupBy(['job.id', 'job.title', 'job.employer', 'job.raw'])
      .orderBy('score', 'desc')
      .limit(TOP_N)
      .execute()
  ) as Array<{ job_id: string; title: string; employer: string; raw: unknown; score: number }>;

  const profile = extractProfileSummary(master as Parameters<typeof extractProfileSummary>[0]);
  let cost = 0;
  for (const row of rows) {
    const raw = (row.raw ?? {}) as Record<string, unknown>;
    const desc = typeof raw.fullDescription === 'string' ? raw.fullDescription : typeof raw.description === 'string' ? raw.description : '';
    const scoringJob: ScoringJob = {
      title: row.title,
      employer: row.employer,
      location: 'AB',
      salaryMin: null,
      salaryMax: null,
      ...(desc ? { description: desc.slice(0, 6000) } : {}),
    };
    const { system, user } = buildScoringPrompt(profile, scoringJob, tracks);
    const schema = TrackAwareMatchScoreSchema(tracks.map((t) => t.id));
    const result = await llm.call({ role: 'flash', stage: 'match_llm', system, user, schema, temperature: 0 });
    await upsertMatch(db, row.job_id, result.runId, result.data, 'v6');
    cost += result.usage.costUsd;
    console.log(`v6: ${row.title.slice(0, 48).padEnd(48)} v5=${row.score} v6=${result.data.score} track=${result.data.best_track ?? '—'}`);
  }
  console.log(`\nrescored ${rows.length} jobs, cost $${cost.toFixed(6)}`);
  await db.destroy();
}
main().catch((error: unknown) => {
  console.error(`FATAL: ${String(error).slice(0, 300)}`);
  process.exitCode = 1;
});
