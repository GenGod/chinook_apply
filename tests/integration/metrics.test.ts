import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { runIngest } from '@chinook/worker';
import { createDb, ensureSchema, getMetrics, markAppliedManually, listJobs } from '@chinook/core';

/**
 * S13 AC1: getMetrics on a controlled seed — exact funnel numbers, source
 * health (avg over 5 runs, dedup ratio), history cap.
 */
const databaseUrl = process.env.DATABASE_URL ?? 'postgres://chinook:chinook_dev@localhost:5433/chinook';

describe('getMetrics (S13)', () => {
  beforeAll(async () => {
    await runIngest({ fixtures: true, fresh: true, close: false });
    const db = createDb(databaseUrl);
    await ensureSchema(db);
    // two manual applications for the funnel
    const jobs = await listJobs(db, { limit: 2 });
    for (const j of jobs) await markAppliedManually(db, j.id);
    // deterministic health seed: 5 jobbank runs with known fetched/unique
    await db.deleteFrom('ingest_run').where('source', '=', 'jobbank').execute();
    for (let i = 0; i < 5; i += 1) {
      await db
        .insertInto('ingest_run')
        .values({
          started_at: new Date(Date.now() - i * 60_000),
          finished_at: new Date(),
          source: 'jobbank',
          fetched: 10,
          unique_jobs: 7,
          merged: 3,
          inserted: 7,
          updated: 0,
          error: null,
        })
        .execute();
    }
    await db.destroy();
  });

  it('funnel counts match the seed exactly (AC1)', async () => {
    const db = createDb(databaseUrl);
    const m = await getMetrics(db);
    expect(m.funnel.total).toBe(27); // fixtures unique
    expect(m.funnel.relevant + m.funnel.review + m.funnel.excluded).toBe(m.funnel.total);
    expect(m.funnel.appliedManual).toBe(2);
    await db.destroy();
  });

  it('source health: avg over 5 runs, dedup ratio, interval defaults (AC1)', async () => {
    const db = createDb(databaseUrl);
    const m = await getMetrics(db);
    const jb = m.sources.find((s) => s.source === 'jobbank')!;
    expect(jb).toBeTruthy();
    expect(jb.intervalMin).toBe(30);
    expect(jb.avgFetched).toBe(10);
    expect(jb.avgUnique).toBe(7);
    expect(jb.dedupRatio).toBeCloseTo(0.3, 5);
    expect(jb.failuresInRow).toBe(0);
    expect(jb.lastRunAt).toBeTruthy();

    const az = m.sources.find((s) => s.source === 'adzuna')!;
    expect(az.intervalMin).toBe(120);
    await db.destroy();
  });

  it('history capped at 10, newest first (AC1)', async () => {
    const db = createDb(databaseUrl);
    const m = await getMetrics(db);
    expect(m.history.length).toBeLessThanOrEqual(10);
    const times = m.history.map((h) => h.startedAt);
    expect([...times].sort().reverse()).toEqual(times);
    expect(m.history[0]!.source).toBe('jobbank'); // newest run is jobbank seed
    await db.destroy();
  });
});

// --- S10: metrics v2 (self-contained synthetic seed) ---
import { randomUUID } from 'node:crypto';

describe('getMetrics v2 (S10)', () => {
  let jobId = '';
  let baselineLlm = { calls: 0, cacheHits: 0 };
  let baselineScoring = { calls: 0, cacheHits: 0, costUsd: 0, avgLatencyMs: 0 };
  let baselineGen = { calls: 0, cacheHits: 0, costUsd: 0, avgLatencyMs: 0 };

  beforeAll(async () => {
    await runIngest({ fixtures: true, fresh: true, close: false });
    const db = createDb(databaseUrl);
    await ensureSchema(db);
    jobId = randomUUID();
    await db
      .insertInto('job')
      .values({
        id: jobId,
        canonical_hash: `s10-${jobId}`,
        title: 'S10 metrics job',
        employer: 'Fixture Corp',
        city: 'edmonton',
        province: 'AB',
        remote: false,
        url: 'https://example.invalid/s10',
        urls: [],
        source: 'jobbank',
        source_job_id: `s10-${jobId}`,
        posted_at: new Date(),
        salary_currency: 'CAD',
        rule_status: 'relevant',
        ingested_at: new Date(),
      })
      .execute();
    // Baseline llm counts BEFORE our synthetic rows (fixture ingest seeds some).
    const baselineMetrics = await getMetrics(db);
    baselineLlm = { calls: baselineMetrics.llm.calls, cacheHits: baselineMetrics.llm.cacheHits };
    baselineScoring = baselineMetrics.llm.byStage.find((s) => s.stage === 'match_llm') ?? { calls: 0, cacheHits: 0, costUsd: 0, avgLatencyMs: 0 };
    baselineGen = baselineMetrics.llm.byStage.find((s) => s.stage === 'generate_resume') ?? { calls: 0, cacheHits: 0, costUsd: 0, avgLatencyMs: 0 };

    // llm_run: 2 scoring calls (1 cache hit) + 1 generation call
    const runs = await db.insertInto('llm_run').values([
      { stage: 'match_llm', role: 'flash', model: 'glm-5.3-flash', prompt_tokens: 1000, completion_tokens: 100, cost_usd: 0.006, latency_ms: 1000, cache_hit: false, ok: true },
      { stage: 'match_llm', role: 'flash', model: 'glm-5.3-flash', prompt_tokens: 1000, completion_tokens: 100, cost_usd: 0.005, latency_ms: 2000, cache_hit: true, ok: true },
      { stage: 'generate_resume', role: 'main', model: 'glm-5.3', prompt_tokens: 2000, completion_tokens: 500, cost_usd: 0.01, latency_ms: 3000, cache_hit: false, ok: true },
    ]).returningAll().execute();
    const runIds = runs.map((r) => Number(r.id));
    // job_match: the scored funnel step
    await db.insertInto('job_match').values({
      job_id: jobId, score: 88, reasons: JSON.stringify(['r']), risks: JSON.stringify([]),
      noc_guess: '21231', prompt_version: 'v5', llm_run_id: runIds[0]!,
    }).execute();

    // artifacts: one valid resume + one invalid cover
    await db.insertInto('artifact').values([
      { id: randomUUID(), job_id: jobId, kind: 'resume', version: 1, status: 'valid', content: JSON.stringify({ x: 1 }), validation: JSON.stringify({ valid: true, violations: [] }), llm_run_id: runIds[2]! },
      { id: randomUUID(), job_id: jobId, kind: 'cover_letter', version: 1, status: 'invalid', content: JSON.stringify({ x: 2 }), validation: JSON.stringify({ valid: false, violations: [{ kind: 'word_limit', detail: 'x' }] }), llm_run_id: runIds[2]! },
    ]).execute();
    // application applied/auto + dispatch rows: email sent, form sent, email failed, form skipped
    const app = await db.insertInto('application').values({ job_id: jobId, status: 'applied', channel: 'auto' }).returningAll().executeTakeFirstOrThrow();
    await db.insertInto('dispatch_log').values([
      { job_id: jobId, application_id: Number(app.id), channel: 'email', outcome: 'sent', to_address: 'a@b.c', subject: 's', attachments: JSON.stringify([]), smtp_message_id: '<x>', error: null },
      { job_id: jobId, application_id: Number(app.id), channel: 'form', outcome: 'sent', to_address: 'https://f.example', subject: 's', attachments: JSON.stringify([]), smtp_message_id: null, error: null },
      { job_id: jobId, application_id: null, channel: 'email', outcome: 'failed', to_address: 'a@b.c', subject: 's', attachments: JSON.stringify([]), smtp_message_id: null, error: 'boom' },
      { job_id: jobId, application_id: null, channel: 'form', outcome: 'skipped', to_address: 'https://f.example', subject: 's', attachments: JSON.stringify([]), smtp_message_id: null, error: 'captcha detected' },
    ]).execute();
  });

  afterAll(async () => {
    const db = createDb(databaseUrl);
    await db.deleteFrom('dispatch_log').where('job_id', '=', jobId).execute();
    await db.deleteFrom('artifact').where('job_id', '=', jobId).execute();
    await db.deleteFrom('application').where('job_id', '=', jobId).execute();
    await db.deleteFrom('job_match').where('job_id', '=', jobId).execute();
    await db.deleteFrom('llm_run').where('id', 'in', runIds).execute(); // synthetic rows only
    await db.deleteFrom('job').where('id', '=', jobId).execute();
    await db.destroy();
  });

  it('llm aggregates by stage, cache hits and cost totals', async () => {
    const db = createDb(databaseUrl);
    const m = await getMetrics(db);
    // The S13 seed re-creates its own llm_run rows (fresh ingest); assert on
    // the DELTA our seed contributes: 3 calls (1 cache hit) on top of the
    // fixture baseline captured in beforeAll.
    expect(m.llm.calls).toBe(baselineLlm.calls + 3);
    expect(m.llm.cacheHits).toBe(baselineLlm.cacheHits + 1);
    const scoring = m.llm.byStage.find((s) => s.stage === 'match_llm')!;
    expect(scoring.calls).toBe(baselineScoring.calls + 2);
    expect(scoring.cacheHits).toBe(baselineScoring.cacheHits + 1);
    expect(scoring.costUsd).toBeCloseTo(baselineScoring.costUsd + 0.011, 6);
    expect(scoring.avgLatencyMs).toBe(1500); // our 1s+2s rows dominate the avg
    const gen = m.llm.byStage.find((s) => s.stage === 'generate_resume')!;
    expect(gen.calls).toBe(baselineGen.calls + 1);
    const totalCost = m.llm.byStage.reduce((acc, s) => acc + s.costUsd, 0);
    expect(m.llm.costUsd).toBeCloseTo(totalCost, 6);
    await db.destroy();
  });

  it('funnel v2 — scored/drafted/dispatchedSent/appliedTotal', async () => {
    const db = createDb(databaseUrl);
    const m = await getMetrics(db);
    expect(m.funnel.scored).toBeGreaterThanOrEqual(1);
    expect(m.funnel.drafted).toBeGreaterThanOrEqual(1);
    expect(m.funnel.dispatchedSent).toBe(2);
    expect(m.funnel.appliedTotal).toBeGreaterThanOrEqual(1);
    await db.destroy();
  });

  it('dispatch stats by channel and quality invalid share', async () => {
    const db = createDb(databaseUrl);
    const m = await getMetrics(db);
    expect(m.dispatch.sent).toBe(2);
    expect(m.dispatch.failed).toBe(1);
    expect(m.dispatch.skipped).toBe(1);
    const email = m.dispatch.byChannel.find((c) => c.channel === 'email')!;
    expect(email.sent).toBe(1);
    const form = m.dispatch.byChannel.find((c) => c.channel === 'form')!;
    expect(form.sent).toBe(1);
    expect(m.quality.artifactsTotal).toBe(2);
    expect(m.quality.artifactsInvalid).toBe(1);
    expect(m.quality.invalidShare).toBeCloseTo(0.5, 5);
    expect(m.quality.captchaStops).toBe(1);
    await db.destroy();
  });
});
