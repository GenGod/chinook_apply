import { describe, it, expect, beforeAll } from 'vitest';
import { sql } from 'kysely';
import { createDb, ensureSchema } from '@chinook/core';
import { createLlm, createPgLlmDb } from '@chinook/llm';
import { z } from 'zod';

/**
 * S3 AC3: llm_run/llm_cache against real Postgres (fake fetch; no live calls).
 */
const databaseUrl = process.env.DATABASE_URL ?? 'postgres://chinook:chinook_dev@localhost:5433/chinook_test';

function okResponse(body: unknown) {
  return { ok: true, status: 200, json: async () => body } as Response;
}

describe('pg LlmDb integration (S3)', () => {
  let db: ReturnType<typeof createDb>;

  beforeAll(async () => {
    db = createDb(databaseUrl);
    await ensureSchema(db); // migration v6 (llm_run, llm_cache)
    await sql`TRUNCATE llm_run`.execute(db);
    await sql`TRUNCATE llm_cache`.execute(db);
  });

  it('persists runs and cache roundtrip through real tables', async () => {
    const llm = createLlm({
      db: createPgLlmDb(db),
      apiKey: 'it-key',
      fetchImpl: (async () =>
        okResponse({
          choices: [{ message: { content: '{"v": "pg"}' } }],
          usage: { prompt_tokens: 5, completion_tokens: 7 },
        })) as unknown as typeof fetch,
      sleepImpl: async () => {},
    });

    const first = await llm.call({
      role: 'flash', stage: 'it_stage', system: 's', user: 'u',
      schema: z.object({ v: z.string() }),
    });
    expect(first.cached).toBe(false);
    expect(first.data).toEqual({ v: 'pg' });
    expect(first.runId).toBeGreaterThan(0);

    const second = await llm.call({
      role: 'flash', stage: 'it_stage', system: 's', user: 'u',
      schema: z.object({ v: z.string() }),
    });
    expect(second.cached).toBe(true);
    expect(second.usage.costUsd).toBe(0);

    const runs = (
      await sql`select stage, cache_hit, ok from llm_run where stage = 'it_stage'`.execute(db)
    ).rows as Array<{ stage: string; cache_hit: boolean; ok: boolean }>;
    const stageRuns = runs;
    expect(stageRuns.length).toBe(2);
    expect(stageRuns.filter((r) => r.cache_hit).length).toBe(1);
    expect(stageRuns.every((r) => r.ok)).toBe(true);
  });
});
