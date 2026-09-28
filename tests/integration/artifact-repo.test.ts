import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { sql } from 'kysely';
import {
  createDb,
  ensureSchema,
  saveArtifact,
  listArtifacts,
  getArtifactContent,
  type ValidationReport,
} from '@chinook/core';

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

/**
 * S5 T5 (red→green): artifact repository — saveArtifact (version = max+1 per
 * (job_id, kind) inside a transaction, whole ValidationReport stored as JSONB),
 * listArtifacts (all versions, created DESC, no content — PII only via
 * getArtifactContent), getArtifactContent (content + violation detail strings
 * by id, null for an unknown uuid).
 */
describe('artifact repository (S5 T5)', () => {
  let db: ReturnType<typeof createDb>;
  let jobId: string;

  const cleanArtifacts = async () => {
    await sql`delete from artifact where job_id = ${jobId}`.execute(db);
  };

  beforeAll(async () => {
    db = createDb(databaseUrl);
    await ensureSchema(db);
    jobId = crypto.randomUUID();
    await sql`
      insert into job (id, canonical_hash, title, employer, city, province, remote, url, urls, source, salary_currency, raw, ingested_at, updated_at)
      values (${jobId}, ${'s5-t5-' + jobId}, 'S5 artifact repo test job', 'Chinook Test Inc.', 'calgary', 'AB', true,
              'https://example.com/s5-t5', '[]'::jsonb, 'jobbank', 'CAD', '{}'::jsonb, now(), now())
      on conflict (id) do nothing
    `.execute(db);
    await cleanArtifacts();
  });

  afterAll(async () => {
    if (!db || !jobId) return;
    await sql`delete from artifact where job_id = ${jobId}`.execute(db);
    await sql`delete from job where id = ${jobId}`.execute(db);
    await db.destroy();
  });

  it('saveArtifact assigns versions 1,2 per (job,kind); view shape + violation details round-trip', async () => {
    await cleanArtifacts();
    const report: ValidationReport = {
      valid: false,
      violations: [
        { kind: 'unknown_bullet', detail: 'bullet 3 not in master profile' },
        { kind: 'unknown_skill', detail: 'skill "wasm-gc" not in profile' },
      ],
    };
    const v1 = await saveArtifact(db, {
      jobId,
      kind: 'resume',
      status: 'invalid',
      content: { summary: 'v1 summary', bullets: ['a'] },
      validation: report,
      llmRunId: 101,
    });
    expect(v1).toEqual({
      id: expect.stringMatching(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/),
      jobId,
      kind: 'resume',
      version: 1,
      status: 'invalid',
      created: expect.any(String),
      violations: ['bullet 3 not in master profile', 'skill "wasm-gc" not in profile'],
      sourceArtifactId: null, // S6: render rows only
    });
    expect(Number.isNaN(Date.parse(v1.created))).toBe(false);
    expect('content' in v1).toBe(false); // PII leaves the repo only via getArtifactContent

    const v2 = await saveArtifact(db, {
      jobId,
      kind: 'resume',
      status: 'valid',
      content: { summary: 'v2 summary', bullets: ['a', 'b'] },
      validation: { valid: true, violations: [] },
      llmRunId: 102,
    });
    expect(v2.version).toBe(2);
    expect(v2.status).toBe('valid');
    expect(v2.violations).toEqual([]);
    expect(v2.id).not.toBe(v1.id);
  });

  it('listArtifacts returns all versions across kinds ordered created DESC, without content', async () => {
    await cleanArtifacts();
    const empty: ValidationReport = { valid: true, violations: [] };
    await saveArtifact(db, { jobId, kind: 'resume', status: 'valid', content: { v: 1 }, validation: empty, llmRunId: 111 });
    await saveArtifact(db, {
      jobId, kind: 'cover_letter', status: 'valid', content: { v: 2 }, validation: empty, llmRunId: 112,
    });
    await saveArtifact(db, { jobId, kind: 'resume', status: 'invalid', content: { v: 3 }, validation: empty, llmRunId: 113 });

    const list = await listArtifacts(db, jobId);
    expect(list.map((a) => `${a.kind}:${a.version}`)).toEqual(['resume:2', 'cover_letter:1', 'resume:1']);
    for (const view of list) {
      expect(view).not.toHaveProperty('content');
      expect(view.jobId).toBe(jobId);
      expect(typeof view.created).toBe('string');
    }
  });

  it('getArtifactContent returns content + violation details by id; null for unknown uuid', async () => {
    await cleanArtifacts();
    const saved = await saveArtifact(db, {
      jobId,
      kind: 'cover_letter',
      status: 'invalid',
      content: { body: 'Dear Hiring Team, ...' },
      validation: {
        valid: false,
        violations: [{ kind: 'forbidden_pattern', detail: 'mentions salary expectations' }],
      },
      llmRunId: 121,
    });
    const got = await getArtifactContent(db, saved.id);
    expect(got).toEqual({
      kind: 'cover_letter',
      version: 1,
      status: 'invalid',
      content: { body: 'Dear Hiring Team, ...' },
      violations: ['mentions salary expectations'],
    });
    expect(await getArtifactContent(db, crypto.randomUUID())).toBeNull();
  });
});
