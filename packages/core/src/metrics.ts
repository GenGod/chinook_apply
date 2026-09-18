import { sql } from 'kysely';
import type { Kysely } from 'kysely';
import type { Database } from './db.js';

export interface SourceHealth {
  source: string;
  lastRunAt: string | null;
  intervalMin: number;
  failuresInRow: number;
  avgFetched: number;
  avgUnique: number;
  dedupRatio: number | null;
}

export interface HistoryRow {
  id: number;
  startedAt: string;
  source: string;
  fetched: number;
  uniqueJobs: number;
  error: string | null;
}

export interface MetricsSummary {
  funnel: {
    total: number;
    relevant: number;
    review: number;
    excluded: number;
    appliedManual: number;
  };
  sources: SourceHealth[];
  history: HistoryRow[];
}

export const DEFAULT_INTERVALS: Record<string, number> = { jobbank: 30, adzuna: 120 };
const AVG_WINDOW = 5;
const HISTORY_LIMIT = 10;

/** Single aggregate read for the metrics screen and /api/metrics (S13). */
export async function getMetrics(
  db: Kysely<Database>,
  intervals: Record<string, number> = DEFAULT_INTERVALS,
): Promise<MetricsSummary> {
  const funnelRow = (
    await sql`select
        count(*)::int as total,
        count(*) filter (where rule_status = 'relevant')::int as relevant,
        count(*) filter (where rule_status = 'review')::int as review,
        count(*) filter (where rule_status = 'excluded')::int as excluded
      from job`.execute(db)
  ).rows[0] as { total: number; relevant: number; review: number; excluded: number };

  const appliedManual = (
    (await sql`select count(*)::int as c from application where status = 'applied_manual'`.execute(db))
      .rows[0] as { c: number }
  ).c;

  const sources = Object.keys(intervals);
  const health: SourceHealth[] = [];
  for (const source of sources) {
    const runs = (
      await sql`select started_at, fetched, unique_jobs, error
        from ingest_run where source = ${source}
        order by started_at desc limit ${AVG_WINDOW}`.execute(db)
    ).rows as Array<{ started_at: Date; fetched: number; unique_jobs: number; error: string | null }>;

    let failuresInRow = 0;
    for (const run of runs) {
      if (run.error == null) break;
      failuresInRow += 1;
    }

    const avgFetched = runs.length ? runs.reduce((s, r) => s + r.fetched, 0) / runs.length : 0;
    const avgUnique = runs.length ? runs.reduce((s, r) => s + r.unique_jobs, 0) / runs.length : 0;

    health.push({
      source,
      lastRunAt: runs[0]?.started_at ? new Date(runs[0].started_at).toISOString() : null,
      intervalMin: intervals[source]!,
      failuresInRow,
      avgFetched: Math.round(avgFetched * 10) / 10,
      avgUnique: Math.round(avgUnique * 10) / 10,
      dedupRatio: avgFetched > 0 ? Math.round((1 - avgUnique / avgFetched) * 1000) / 1000 : null,
    });
  }

  const history = (
    await sql`select id, started_at, source, fetched, unique_jobs, error
      from ingest_run order by started_at desc limit ${HISTORY_LIMIT}`.execute(db)
  ).rows as Array<{
    id: number;
    started_at: Date;
    source: string;
    fetched: number;
    unique_jobs: number;
    error: string | null;
  }>;

  return {
    funnel: {
      total: funnelRow.total,
      relevant: funnelRow.relevant,
      review: funnelRow.review,
      excluded: funnelRow.excluded,
      appliedManual,
    },
    sources: health,
    history: history.map((h) => ({
      id: Number(h.id),
      startedAt: new Date(h.started_at).toISOString(),
      source: h.source,
      fetched: h.fetched,
      uniqueJobs: h.unique_jobs,
      error: h.error,
    })),
  };
}
