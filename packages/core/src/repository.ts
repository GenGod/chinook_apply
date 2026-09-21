import { sql } from 'kysely';
import type { Kysely } from 'kysely';
import type { Database } from './db';
import type { Job, JobSourceId } from '@chinook/contracts';
import type { RuleStatus } from './rules';
import type { ProvinceCode } from './normalize';

export interface JobFilters {
  source?: JobSourceId;
  days?: number;
  salaryMin?: number;
  sort?: 'posted' | 'salary' | 'score';
  rule?: RuleStatus;
  province?: ProvinceCode;
  remoteOnly?: boolean;
  minScore?: number;
  limit?: number;
}

/** Job plus the manual-application flag, rule status and LLM match score. */
export interface JobListItem extends Job {
  appliedManually: boolean;
  ruleStatus: RuleStatus | null;
  matchScore: number | null;
}

export interface ApplicationRow {
  id: number;
  jobId: string;
  status: string;
  channel: string;
  createdAt: string;
}

type ListRow = {
  id: string;
  canonical_hash: string;
  title: string;
  employer: string;
  city: string;
  province: string;
  remote: boolean;
  url: string;
  urls: unknown;
  source: string;
  source_job_id: string | null;
  posted_at: Date | null;
  salary_min: string | number | null;
  salary_max: string | number | null;
  salary_currency: string;
  noc_code: string | null;
  raw: unknown;
  ingested_at: Date;
  applied_manually: boolean | null;
  rule_status: string | null;
  match_score: number | null;
};

function toJob(row: ListRow): JobListItem {
  return {
    id: row.id,
    canonicalHash: row.canonical_hash,
    title: row.title,
    employer: row.employer,
    location: { city: row.city, province: row.province, remote: row.remote },
    url: row.url,
    urls: Array.isArray(row.urls) ? (row.urls as string[]) : [],
    source: row.source as JobSourceId,
    sourceJobId: row.source_job_id,
    postedAt: row.posted_at ? row.posted_at.toISOString() : null,
    salaryMin: row.salary_min === null ? null : Number(row.salary_min),
    salaryMax: row.salary_max === null ? null : Number(row.salary_max),
    salaryCurrency: 'CAD',
    nocCode: row.noc_code,
    raw: row.raw,
    ingestedAt: row.ingested_at.toISOString(),
    appliedManually: row.applied_manually != null,
    ruleStatus: (row.rule_status as RuleStatus | null) ?? null,
    matchScore: row.match_score ?? null,
  };
}

/** Filtered, sorted job list with the manual-application flag, rule status and match score. */
export async function listJobs(db: Kysely<Database>, filters: JobFilters): Promise<JobListItem[]> {
  const { source, days, salaryMin, sort = 'posted', rule, province, remoteOnly, minScore, limit = 50 } = filters;

  let query = db
    .selectFrom('job')
    .leftJoin('application', (join) =>
      join
        .onRef('application.job_id', '=', 'job.id')
        .on('application.status', '=', 'applied')
        .on('application.channel', '=', 'manual'),
    )
    .select([
      'job.id as id',
      'job.canonical_hash as canonical_hash',
      'job.title as title',
      'job.employer as employer',
      'job.city as city',
      'job.province as province',
      'job.remote as remote',
      'job.url as url',
      'job.urls as urls',
      'job.source as source',
      'job.source_job_id as source_job_id',
      'job.posted_at as posted_at',
      'job.salary_min as salary_min',
      'job.salary_max as salary_max',
      'job.salary_currency as salary_currency',
      'job.noc_code as noc_code',
      'job.raw as raw',
      'job.ingested_at as ingested_at',
      'application.id as applied_manually',
      'job.rule_status as rule_status',
    ]);

  if (source) {
    query = query.where('job.source', '=', source);
  }
  if (rule) {
    query = query.where('job.rule_status', '=', rule);
  }
  if (province) {
    query = query.where('job.province', '=', province);
  }
  if (remoteOnly) {
    query = query.where('job.remote', '=', true);
  }
  if (days !== undefined) {
    query = query.where('job.posted_at', '>=', new Date(Date.now() - days * 24 * 3600 * 1000));
  }
  if (salaryMin !== undefined) {
    query = query.where('job.salary_min', '>=', salaryMin);
  }

  // fetch limit ×2 to have headroom for post-score filtering
  const rows = await query.limit(Math.min(limit * 2, 400)).execute();
  const jobIds = rows.map((r) => r.id);

  // fetch latest match scores in one query (avoids complex JOIN in the main query)
  const scoreMap = new Map<string, number>();
  if (jobIds.length > 0) {
    const scores = await db
      .selectFrom('job_match')
      .where('job_match.job_id', 'in', jobIds)
      .select(['job_match.job_id as job_id', 'job_match.score as score'])
      .orderBy('job_match.id', 'desc')
      .execute();
    for (const s of scores) {
      if (!scoreMap.has(s.job_id)) scoreMap.set(s.job_id, s.score);
    }
  }

  let items = rows.map((row) => ({
    ...toJob(row as ListRow),
    matchScore: scoreMap.get(row.id) ?? null,
  }));

  if (minScore !== undefined) {
    items = items.filter((i) => i.matchScore !== null && i.matchScore >= minScore);
  }
  if (sort === 'score') {
    items.sort((a, b) => (b.matchScore ?? -1) - (a.matchScore ?? -1));
  } else if (sort === 'salary') {
    items.sort((a, b) => (b.salaryMin ?? -1) - (a.salaryMin ?? -1));
  } else {
    // default: posted_at DESC, canonical_hash ASC tie-break (matches previous SQL behavior)
    items.sort((a, b) => {
      const ta = a.postedAt ?? '';
      const tb = b.postedAt ?? '';
      if (ta !== tb) return ta > tb ? -1 : 1;
      return a.canonicalHash < b.canonicalHash ? -1 : 1;
    });
  }

  return items.slice(0, limit);
}

/** Idempotently records a manual application (S7 model: status applied + channel manual). */
export async function markAppliedManually(db: Kysely<Database>, jobId: string): Promise<ApplicationRow> {
  const inserted = await db
    .insertInto('application')
    .values({ job_id: jobId, status: 'applied', channel: 'manual' })
    .onConflict((oc) => oc.columns(['job_id', 'status', 'channel']).doNothing())
    .returningAll()
    .executeTakeFirst();

  if (inserted) {
    return {
      id: Number(inserted.id),
      jobId: inserted.job_id,
      status: inserted.status,
      channel: inserted.channel,
      createdAt: inserted.created_at.toISOString(),
    };
  }
  const existing = await db
    .selectFrom('application')
    .where('job_id', '=', jobId)
    .where('status', '=', 'applied')
    .where('channel', '=', 'manual')
    .selectAll()
    .executeTakeFirstOrThrow();
  return {
    id: Number(existing.id),
    jobId: existing.job_id,
    status: existing.status,
    channel: existing.channel,
    createdAt: existing.created_at.toISOString(),
  };
}

export interface UnscoredJob {
  id: string;
  title: string;
  employer: string;
  city: string;
  province: string;
  remote: boolean;
  salaryMin: number | null;
  salaryMax: number | null;
  raw: unknown;
}

/** Jobs in the given rule baskets without a current-prompt-version match score. */
export async function listUnscoredJobs(
  db: Kysely<Database>,
  opts: { baskets: RuleStatus[]; promptVersion: string; limit: number },
): Promise<UnscoredJob[]> {
  const rows = await db
    .selectFrom('job')
    .where((eb) =>
      eb.and([
        eb('job.rule_status', 'in', opts.baskets as string[]),
        eb.not(
          eb.exists(
            eb.selectFrom('job_match').whereRef('job_match.job_id', '=', 'job.id')
              .where('job_match.prompt_version', '=', opts.promptVersion),
          ),
        ),
      ]),
    )
    .select([
      'job.id as id',
      'job.title as title',
      'job.employer as employer',
      'job.city as city',
      'job.province as province',
      'job.remote as remote',
      'job.raw as raw',
    ])
    .orderBy('job.posted_at', 'desc')
    .limit(opts.limit)
    .execute();

  return rows.map((r) => ({
    ...r,
    salaryMin: null,
    salaryMax: null,
  }));
}

/** Records an LLM match score (append-only; latest wins in listJobs). */
export async function upsertMatch(
  db: Kysely<Database>,
  jobId: string,
  llmRunId: number,
  match: { score: number; reasons: string[]; risks: string[]; noc_guess: string | null },
  promptVersion: string,
): Promise<void> {
  await db
    .insertInto('job_match')
    .values({
      job_id: jobId,
      llm_run_id: llmRunId,
      score: match.score,
      reasons: JSON.stringify(match.reasons),
      risks: JSON.stringify(match.risks),
      noc_guess: match.noc_guess,
      prompt_version: promptVersion,
    })
    .execute();
}
