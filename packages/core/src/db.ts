import { Kysely, PostgresDialect, sql, type Generated } from 'kysely';
export type { Kysely } from 'kysely';
import { Pool } from 'pg';
import type { Job } from '@chinook/contracts';
import type { RuleResult } from './rules';

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
  rule_status: string | null;
  rule_reasons: unknown;
  rule_scored_at: Date | null;
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

export interface ApplicationTable {
  id: Generated<number>;
  job_id: string;
  status: string;
  channel: string;
  created_at: Generated<Date>;
}

export interface Database {
  job: JobRow;
  ingest_run: IngestRunRow;
  application: ApplicationTable;
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
CREATE INDEX IF NOT EXISTS job_province_idx ON job (province);
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
CREATE TABLE IF NOT EXISTS application (
  id BIGSERIAL PRIMARY KEY,
  job_id UUID NOT NULL REFERENCES job(id) ON DELETE CASCADE,
  status TEXT NOT NULL,
  channel TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (job_id, status, channel)
);
CREATE INDEX IF NOT EXISTS application_job_idx ON application (job_id);
ALTER TABLE application ADD COLUMN IF NOT EXISTS channel TEXT;
UPDATE application SET status = 'applied', channel = 'manual' WHERE status = 'applied_manual';
UPDATE application SET channel = 'none' WHERE channel IS NULL;
ALTER TABLE application ALTER COLUMN channel SET NOT NULL;
ALTER TABLE job ADD COLUMN IF NOT EXISTS rule_status TEXT;
ALTER TABLE job ADD COLUMN IF NOT EXISTS rule_reasons JSONB;
ALTER TABLE job ADD COLUMN IF NOT EXISTS rule_scored_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS job_rule_status_idx ON job (rule_status);
`;

/** Local docker-compose default (port 5433 — host 5432 is taken by a native service). */
export const DEV_DATABASE_URL = 'postgres://chinook:chinook_dev@localhost:5433/chinook';

/** Allowed pg hosts: local compose/dev only — arbitrary connection strings from env are rejected. */
const ALLOWED_DB_HOSTS = new Set(['localhost', '127.0.0.1', '::1', 'postgres']);

export function assertSafeDatabaseUrl(connectionString: string): void {
  let host: string;
  try {
    host = new URL(connectionString).hostname;
  } catch {
    throw new Error('DATABASE_URL is not a valid URL');
  }
  if (!ALLOWED_DB_HOSTS.has(host)) {
    throw new Error(`DATABASE_URL host "${host}" is not allowed (local/compose hosts only)`);
  }
}

export function createDb(connectionString: string): Kysely<Database> {
  assertSafeDatabaseUrl(connectionString);
  return new Kysely<Database>({
    dialect: new PostgresDialect({ pool: new Pool({ connectionString }) }),
  });
}

/** Resolves DATABASE_URL with a dev fallback so local/CI wiring stays trivial. */
export function resolveDatabaseUrl(): string {
  return process.env.DATABASE_URL ?? DEV_DATABASE_URL;
}

export function createDbFromEnv(): Kysely<Database> {
  return createDb(resolveDatabaseUrl());
}

export async function ensureSchema(db: Kysely<Database>): Promise<void> {
  await sql.raw(SCHEMA_SQL).execute(db);
}

/** Upserts by canonical_hash: urls merged+deduped, earliest posted_at kept, first non-null salary kept; rule_* always overwritten by the latest scoring. */
export async function upsertJobs(
  db: Kysely<Database>,
  jobs: Job[],
  rules?: Map<string, RuleResult>,
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
    const rule = rules?.get(job.id);
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
        rule_status: rule?.status ?? null,
        rule_reasons: rule ? sql`${JSON.stringify(rule.reasons)}::jsonb` : null,
        rule_scored_at: rule ? new Date() : null,
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
            rule_status: sql`EXCLUDED.rule_status`,
            rule_reasons: sql`EXCLUDED.rule_reasons`,
            rule_scored_at: sql`EXCLUDED.rule_scored_at`,
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
