import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { sql } from 'kysely';
import { createDb, ensureSchema } from '@chinook/core';

/**
 * S5 T1 (red→green): artifact table migration — ensureSchema creates the table,
 * a row can be inserted and read back, and UNIQUE (job_id, kind, version) is
 * enforced. A minimal job row is seeded so the FK target exists even on an
 * otherwise empty integration database; it is removed again in afterAll so
 * reruns stay deterministic.
 */
const databaseUrl = process.env.DATABASE_URL ?? 'postgres://chinook:chinook_dev@localhost:5433/chinook_test';

interface ArtifactSelectRow {
  kind: string;
  version: number;
  status: string;
  created_at: Date;
}

describe('artifact table (S5 T1)', () => {
  let db: ReturnType<typeof createDb>;
  let jobId: string;

  beforeAll(async () => {
    db = createDb(databaseUrl);
    await ensureSchema(db);
    jobId = crypto.randomUUID();
    await sql`
      insert into job (id, canonical_hash, title, employer, city, province, remote, url, urls, source, salary_currency, raw, ingested_at, updated_at)
      values (${jobId}, ${'s5-t1-' + jobId}, 'S5 artifact test job', 'Chinook Test Inc.', 'toronto', 'ON', false,
              'https://example.com/s5-t1', '[]'::jsonb, 'jobbank', 'CAD', '{}'::jsonb, now(), now())
      on conflict (id) do nothing
    `.execute(db);
    await sql`delete from artifact where job_id = ${jobId}`.execute(db);
  });

  afterAll(async () => {
    if (!db || !jobId) return;
    await sql`delete from artifact where job_id = ${jobId}`.execute(db);
    await sql`delete from job where id = ${jobId}`.execute(db);
    await db.destroy();
  });

  it('exists after ensureSchema and accepts a row', async () => {
    await sql`
      insert into artifact (job_id, kind, version, status, content, validation, llm_run_id)
      values (${jobId}, 'resume', 1, 'valid', '{"summary":"x"}'::jsonb, '[]'::jsonb, 1)
    `.execute(db);
    const row = (
      await sql`select kind, version, status, created_at from artifact where job_id = ${jobId}`.execute(db)
    ).rows[0] as ArtifactSelectRow | undefined;
    expect(row).toBeDefined();
    expect(row!.kind).toBe('resume');
    expect(row!.version).toBe(1);
    expect(row!.status).toBe('valid');
    expect(row!.created_at).toBeInstanceOf(Date);
  });

  it('enforces unique (job_id, kind, version)', async () => {
    await sql`delete from artifact where job_id = ${jobId}`.execute(db);
    const insert = () =>
      sql`
        insert into artifact (job_id, kind, version, status, content, validation, llm_run_id)
        values (${jobId}, 'resume', 1, 'valid', '{}'::jsonb, '[]'::jsonb, 1)
      `.execute(db);
    await insert(); // first insert with (job_id, 'resume', 1) succeeds
    await expect(insert()).rejects.toThrow(); // duplicate is rejected
  });
});
