// Postgres adapter for the LlmDb seam (llm_run / llm_cache, migration v6).
import { sql } from 'kysely';
import type { Kysely } from 'kysely';
import type { Database } from '@chinook/core';
import type { LlmDb } from './gateway.js';

export interface LlmStatsSummary {
  byStage: Array<{ stage: string; role: string; calls: number; tokens: number; costUsd: number; cacheHits: number }>;
}

export function createPgLlmDb(db: Kysely<Database>): LlmDb {
  return {
    async insertIntoRun(row: Record<string, unknown>) {
      const result = (
        await sql`insert into llm_run
          (stage, role, model, prompt_tokens, completion_tokens, cost_usd, latency_ms, cache_hit, ok, error, input_hash)
          values (
            ${String(row.stage)}, ${String(row.role)}, ${String(row.model)},
            ${Number(row.prompt_tokens ?? 0)}, ${Number(row.completion_tokens ?? 0)},
            ${Number(row.cost_usd ?? 0)}, ${Number(row.latency_ms ?? 0)},
            ${Boolean(row.cache_hit)}, ${Boolean(row.ok)},
            ${row.error == null ? null : String(row.error)}, ${String(row.input_hash ?? '')}
          ) returning id`.execute(db)
      ).rows[0] as { id: number };
      return Number(result.id);
    },

    async findCache(key: string) {
      const row = (
        await sql`select response, usage from llm_cache where key = ${key} limit 1`.execute(db)
      ).rows[0] as { response: unknown; usage: { promptTokens: number; completionTokens: number; costUsd: number } } | undefined;
      return row ?? null;
    },

    async saveCache(key: string, value: { response: unknown; usage: { promptTokens: number; completionTokens: number; costUsd: number } }) {
      await sql`insert into llm_cache (key, response, usage, hits)
        values (${key}, ${JSON.stringify(value.response)}::jsonb, ${JSON.stringify(value.usage)}::jsonb, 0)
        on conflict (key) do nothing`.execute(db);
    },

    async incrementCacheHits(key: string) {
      await sql`update llm_cache set hits = hits + 1 where key = ${key}`.execute(db);
    },
  };
}
