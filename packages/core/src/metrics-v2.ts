// S10: metrics v2 aggregate helpers — LLM usage/cost (DESIGN §5.1), the full
// pipeline funnel (§5.3) and quality proxies (§5.2). Kysely query builders
// (typed, parameterized) — same data as the S13 aggregates in metrics.ts.
import type { Kysely } from 'kysely';
import type { Database } from './db';
import type { MetricsSummary } from './metrics';

/** Full pipeline funnel steps: scored → drafted → dispatched → applied. */
export async function funnelV2(db: Kysely<Database>): Promise<{
  scored: number;
  drafted: number;
  dispatchedSent: number;
  appliedTotal: number;
}> {
  const scoredRow = await db
    .selectFrom('job_match')
    .select((eb) => eb.fn.agg<number>('count', ['job_id']).distinct().as('c'))
    .executeTakeFirst();
  const draftedRow = await db
    .selectFrom('artifact')
    .where('kind', 'in', ['resume', 'cover_letter'])
    .where('status', '=', 'valid')
    .select((eb) => eb.fn.agg<number>('count', ['job_id']).distinct().as('c'))
    .executeTakeFirst();
  const dispatchedRow = await db
    .selectFrom('dispatch_log')
    .where('outcome', '=', 'sent')
    .select((eb) => eb.fn.count<number>('id').as('c'))
    .executeTakeFirst();
  const appliedRow = await db
    .selectFrom('application')
    .where('status', '=', 'applied')
    .select((eb) => eb.fn.agg<number>('count', ['job_id']).distinct().as('c'))
    .executeTakeFirst();
  return {
    scored: Number(scoredRow?.c ?? 0),
    drafted: Number(draftedRow?.c ?? 0),
    dispatchedSent: Number(dispatchedRow?.c ?? 0),
    appliedTotal: Number(appliedRow?.c ?? 0),
  };
}

interface LlmStageRow {
  stage: string;
  calls: number;
  cache_hits: number;
  cost_usd: number;
  avg_latency_ms: number;
}

/** LLM usage/cost totals and per-stage breakdown (tokens, cache, latency). */
export async function llmAggregates(db: Kysely<Database>): Promise<MetricsSummary['llm']> {
  const byStageRows = (
    await db
      .selectFrom('llm_run')
      .select((eb) => [
        'stage',
        eb.fn.countAll<number>().as('calls'),
        eb.fn.count<number>('id').filterWhere('cache_hit', '=', true).as('cache_hits'),
        eb.fn.sum<number>('cost_usd').as('cost_usd'),
        eb.fn.avg<number>('latency_ms').as('avg_latency_ms'),
      ])
      .groupBy('stage')
      .orderBy('stage')
      .execute()
  ).map((r) => {
    const row = r as unknown as LlmStageRow;
    return {
      stage: row.stage,
      calls: Number(row.calls),
      cacheHits: Number(row.cache_hits),
      costUsd: Math.round(Number(row.cost_usd ?? 0) * 1e6) / 1e6,
      avgLatencyMs: Math.round(Number(row.avg_latency_ms ?? 0)),
    };
  });

  const totalsRow = (
    await db
      .selectFrom('llm_run')
      .select((eb) => [
        eb.fn.countAll<number>().as('calls'),
        eb.fn.count<number>('id').filterWhere('cache_hit', '=', true).as('cache_hits'),
        eb.fn.sum<number>('cost_usd').as('cost_usd'),
        eb.fn.sum<number>('prompt_tokens').as('prompt_tokens'),
        eb.fn.sum<number>('completion_tokens').as('completion_tokens'),
      ])
      .executeTakeFirst()
  ) as unknown as {
    calls: string | number;
    cache_hits: string | number;
    cost_usd: string | number | null;
    prompt_tokens: string | number | null;
    completion_tokens: string | number | null;
  };

  const totalCost = byStageRows.reduce((a, r) => a + r.costUsd, 0);
  return {
    calls: Number(totalsRow?.calls ?? 0),
    cacheHits: Number(totalsRow?.cache_hits ?? 0),
    costUsd: Math.round(totalCost * 1e6) / 1e6,
    promptTokens: Number(totalsRow?.prompt_tokens ?? 0),
    completionTokens: Number(totalsRow?.completion_tokens ?? 0),
    byStage: byStageRows,
  };
}

/** Dispatch outcomes by channel (S8 email + S9 form audit). */
export async function dispatchAggregates(db: Kysely<Database>): Promise<MetricsSummary['dispatch']> {
  const rows = await db
    .selectFrom('dispatch_log')
    .select((eb) => [
      'channel',
      eb.fn.count<number>('id').filterWhere('outcome', '=', 'sent').as('sent'),
      eb.fn.count<number>('id').filterWhere('outcome', '=', 'failed').as('failed'),
      eb.fn.count<number>('id').filterWhere('outcome', '=', 'skipped').as('skipped'),
    ])
    .groupBy('channel')
    .orderBy('channel')
    .execute();
  const byChannel = rows.map((r) => {
    const row = r as unknown as { channel: string; sent: string | number; failed: string | number; skipped: string | number };
    return {
      channel: row.channel,
      sent: Number(row.sent),
      failed: Number(row.failed),
      skipped: Number(row.skipped),
    };
  });
  return {
    sent: byChannel.reduce((a, r) => a + r.sent, 0),
    failed: byChannel.reduce((a, r) => a + r.failed, 0),
    skipped: byChannel.reduce((a, r) => a + r.skipped, 0),
    byChannel,
  };
}

/** Quality proxies: invalid artifact share + captcha stops (§5.2). */
export async function qualityAggregates(db: Kysely<Database>): Promise<MetricsSummary['quality']> {
  const artifactsRow = (
    await db
      .selectFrom('artifact')
      .where('kind', 'in', ['resume', 'cover_letter'])
      .select((eb) => [
        eb.fn.countAll<number>().as('total'),
        eb.fn.count<number>('id').filterWhere('status', '=', 'invalid').as('invalid'),
      ])
      .executeTakeFirst()
  ) as unknown as { total: string | number; invalid: string | number };
  const total = Number(artifactsRow?.total ?? 0);
  const invalid = Number(artifactsRow?.invalid ?? 0);

  // Captcha stops counted from the raw rows — no LIKE pattern in SQL.
  const skippedRows = await db
    .selectFrom('dispatch_log')
    .where('outcome', '=', 'skipped')
    .select('error')
    .execute();
  const captchaStops = skippedRows.filter((r) => (r.error ?? '').startsWith('captcha')).length;

  return {
    artifactsTotal: total,
    artifactsInvalid: invalid,
    invalidShare: total > 0 ? invalid / total : null,
    captchaStops,
  };
}
