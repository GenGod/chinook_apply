import { sql } from 'kysely';
import type { Kysely } from 'kysely';
import type { Database } from './db.js';
import type { Job, JobSourceId } from '@chinook/contracts';

export interface JobFilters {
  source?: JobSourceId;
  days?: number;
  salaryMin?: number;
  sort?: 'posted' | 'salary';
  limit?: number;
}

/** Job plus the manual-application flag for the Jobs Explorer screen. */
export interface JobListItem extends Job {
  appliedManually: boolean;
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
  };
}

/** Filtered, sorted job list with the manual-application flag (LEFT JOIN application). */
export async function listJobs(db: Kysely<Database>, filters: JobFilters): Promise<JobListItem[]> {
  const { source, days, salaryMin, sort = 'posted', limit = 50 } = filters;

  let query = db
    .selectFrom('job')
    .leftJoin('application', (join) =>
      join
        .onRef('application.job_id', '=', 'job.id')
        .on('application.status', '=', 'applied_manual')
        .on('application.channel', '=', 'external_link'),
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
    ]);

  if (source) {
    query = query.where('job.source', '=', source);
  }
  if (days !== undefined) {
    query = query.where('job.posted_at', '>=', new Date(Date.now() - days * 24 * 3600 * 1000));
  }
  if (salaryMin !== undefined) {
    // null salaries are kept ("unknown"), known ones must pass the threshold
    query = query.where((eb) =>
      eb.or([eb('job.salary_min', 'is', null), eb('job.salary_min', '>=', salaryMin)]),
    );
  }

  query =
    sort === 'salary'
      ? query.orderBy(sql`job.salary_min DESC NULLS LAST`)
      : query.orderBy('job.posted_at', 'desc').orderBy('job.canonical_hash', 'asc');

  const rows = await query.limit(Math.min(limit, 200)).execute();
  return rows.map((row) => toJob(row as ListRow));
}

/** Idempotently records a manual application via the external link. */
export async function markAppliedManually(db: Kysely<Database>, jobId: string): Promise<ApplicationRow> {
  const inserted = await db
    .insertInto('application')
    .values({ job_id: jobId, status: 'applied_manual', channel: 'external_link' })
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
    .where('status', '=', 'applied_manual')
    .where('channel', '=', 'external_link')
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
