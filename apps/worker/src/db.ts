import { Kysely, PostgresDialect, sql, type Generated } from 'kysely';
import { Pool } from 'pg';
import type { Job } from '@chinook/contracts';

export interface JobRow {
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
  salary_min: number | null;
  salary_max: number | null;
  salary_currency: string;
  noc_code: string | null;
  raw: unknown;
  ingested_at: Date;
  updated_at: Date;
}

export interface IngestRunRow {
  id: Generated<number>;
  started_at: Date;
  finished_at: Date | null;
  source: string;
  fetched: number;
  unique_jobs: number;
  merged: number;
  inserted: number;
  updated: number;
  error: string | null;
}

export interface Database {
  job: JobRow;
  ingest_run: IngestRunRow;
}

export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS job (
  id UUID PRIMARY KEY,
  canonical_hash TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  employer TEXT NOT NULL,
  city TEXT NOT NULL,
  province TEXT NOT NULL,
  remote BOOLEAN NOT NULL DEFAULT false,
  url TEXT NOT NULL,
  urls JSONB NOT NULL,
  source TEXT NOT NULL,
  source_job_id TEXT,
  posted_at TIMESTAMPTZ,
  salary_min NUMERIC,
  salary_max NUMERIC,
  salary_currency TEXT NOT NULL DEFAULT 'CAD',
  noc_code TEXT,
  raw JSONB,
  ingested_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS job_canonical_hash_idx ON job (canonical_hash);
CREATE INDEX IF NOT EXISTS job_posted_at_idx ON job (posted_at DESC);
CREATE TABLE IF NOT EXISTS ingest_run (
  id BIGSERIAL PRIMARY KEY,
  started_at TIMESTAMPTZ NOT NULL,
  finished_at TIMESTAMPTZ,
  source TEXT NOT NULL,
  fetched INT NOT NULL DEFAULT 0,
  unique_jobs INT NOT NULL DEFAULT 0,
  merged INT NOT NULL DEFAULT 0,
  inserted INT NOT NULL DEFAULT 0,
  updated INT NOT NULL DEFAULT 0,
  error TEXT
);
`;

export function createDb(connectionString: string): Kysely<Database> {
  return new Kysely<Database>({
    dialect: new PostgresDialect({ pool: new Pool({ connectionString }) }),
  });
}

export async function ensureSchema(db: Kysely<Database>): Promise<void> {
  await db.executeQuery({ sql: SCHEMA_SQL, parameters: [] } as never);
}

/** Upserts by canonical_hash: urls merged+deduped, earliest posted_at kept, first non-null salary kept. */
export async function upsertJobs(
  db: Kysely<Database>,
  jobs: Job[],
): Promise<{ inserted: number; updated: number }> {
  const existing = new Set(
    (
      await db.selectFrom('job').select('canonical_hash').execute()
    ).map((row) => row.canonical_hash),
  );
  let inserted = 0;
  let updated = 0;
  for (const job of jobs) {
    const isNew = !existing.has(job.canonicalHash);
    await db
      .insertInto('job')
      .values({
        id: job.id,
        canonical_hash: job.canonicalHash,
        title: job.title,
        employer: job.employer,
        city: job.location.city,
        province: job.location.province,
        remote: job.location.remote,
        url: job.url,
        urls: sql`${JSON.stringify(job.urls)}::jsonb`,
        source: job.source,
        source_job_id: job.sourceJobId,
        posted_at: job.postedAt ? new Date(job.postedAt) : null,
        salary_min: job.salaryMin,
        salary_max: job.salaryMax,
        salary_currency: job.salaryCurrency,
        noc_code: job.nocCode,
        raw: job.raw == null ? null : sql`${JSON.stringify(job.raw)}::jsonb`,
        ingested_at: new Date(job.ingestedAt),
        updated_at: new Date(),
      })
      .onConflict((oc) =>
        oc
          .column('canonical_hash')
          .doUpdateSet({
            urls: sql`(SELECT COALESCE(jsonb_agg(DISTINCT e), '[]'::jsonb) FROM jsonb_array_elements(job.urls || EXCLUDED.urls) AS t(e))`,
            posted_at: sql`LEAST(job.posted_at, EXCLUDED.posted_at)`,
            salary_min: sql`COALESCE(job.salary_min, EXCLUDED.salary_min)`,
            salary_max: sql`COALESCE(job.salary_max, EXCLUDED.salary_max)`,
            updated_at: new Date(),
          }),
      )
      .executeTakeFirst();
    existing.add(job.canonicalHash);
    if (isNew) inserted += 1;
    else updated += 1;
  }
  return { inserted, updated };
}

export async function countJobs(db: Kysely<Database>): Promise<number> {
  const row = await db
    .selectFrom('job')
    .select((eb) => eb.fn.countAll<number>().as('count'))
    .executeTakeFirstOrThrow();
  return Number(row.count);
}
