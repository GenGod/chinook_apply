import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  createDb,
  ensureSchema,
  saveArtifact,
  saveRenderArtifact,
  findRenderArtifact,
  nextRenderVersion,
  listArtifacts,
  type Database,
} from '@chinook/core';
import type { Kysely } from 'kysely';
import {
  renderArtifact,
  readRenderFile,
  resolveRenderIdentity,
  RenderSourceNotFoundError,
  RenderNotRenderableError,
  RenderIdentityUnavailableError,
} from '../../apps/web/src/lib/render-service';
import { renderFolderName, safeJoin } from '../../apps/web/src/lib/render-storage';

/**
 * S6 T1 (red→green): artifact schema migration — render kinds, nullable
 * llm_run_id, source_artifact_id audit link, content_path. Extended by T5/T6
 * with the render repository and service suites. Fixtures are synthetic only
 * (no PII — Constitution 3.2); the suite owns a synthetic job row and cleans
 * up after itself so re-runs stay idempotent (UNIQUE(job_id, kind, version)).
 */
const db: Kysely<Database> = createDb(
  process.env.DATABASE_URL ?? 'postgres://chinook:chinook_dev@localhost:5433/chinook_test',
);

// Each describe owns a synthetic job so render-version counters never
// interleave between suites sharing the test database.
async function createSyntheticJob(prefix: string): Promise<string> {
  const id = randomUUID();
  await db
    .insertInto('job')
    .values({
      id,
      canonical_hash: `${prefix}-${id}`,
      title: 'S21 render test job',
      employer: 'Fixture Corp',
      city: 'edmonton',
      province: 'AB',
      remote: false,
      url: 'https://example.invalid/s21',
      urls: [],
      source: 'jobbank',
      source_job_id: `${prefix}-${id}`,
      posted_at: new Date(),
      salary_currency: 'CAD',
      ingested_at: new Date(),
    })
    .execute();
  return id;
}

async function deleteSyntheticJob(jobId: string): Promise<void> {
  await db.deleteFrom('artifact').where('job_id', '=', jobId).execute();
  await db.deleteFrom('job').where('id', '=', jobId).execute();
}

let jobId = '';

beforeAll(async () => {
  await ensureSchema(db);
  jobId = await createSyntheticJob('s6');
});

afterAll(async () => {
  if (!db || !jobId) return;
  await deleteSyntheticJob(jobId);
  await db.destroy();
});

describe('artifact schema (S6 migration)', () => {
  it('accepts a render row with llm_run_id NULL and a source FK', async () => {
    const src = await saveArtifact(db, {
      jobId,
      kind: 'resume',
      status: 'valid',
      content: { diff: {}, resume: { summary: 'x' } },
      validation: { valid: true, violations: [] },
      llmRunId: 1,
    });
    const id = randomUUID();
    await db
      .insertInto('artifact')
      .values({
        id,
        job_id: jobId,
        kind: 'render_docx',
        version: 1,
        status: 'valid',
        content: JSON.stringify({}),
        validation: JSON.stringify({ valid: true, violations: [] }),
        llm_run_id: null,
        source_artifact_id: src.id,
        content_path: `${jobId}/resume-v1.docx`,
      })
      .execute();
    const row = await db.selectFrom('artifact').selectAll().where('id', '=', id).executeTakeFirstOrThrow();
    expect(row.llm_run_id).toBeNull();
    expect(row.source_artifact_id).toBe(src.id);
    expect(row.content_path).toBe(`${jobId}/resume-v1.docx`);
  });

  it('rejects an unknown kind', async () => {
    await expect(
      db
        .insertInto('artifact')
        .values({
          id: randomUUID(),
          job_id: jobId,
          kind: 'render_xlsx' as never,
          version: 1,
          status: 'valid',
          content: JSON.stringify({}),
          validation: JSON.stringify({ valid: true, violations: [] }),
          llm_run_id: null,
        })
        .execute(),
    ).rejects.toThrow();
  });

  it('rejects a render row pointing at a nonexistent source artifact', async () => {
    await expect(
      db
        .insertInto('artifact')
        .values({
          id: randomUUID(),
          job_id: jobId,
          kind: 'render_pdf',
          version: 1,
          status: 'valid',
          content: JSON.stringify({}),
          validation: JSON.stringify({ valid: true, violations: [] }),
          llm_run_id: null,
          source_artifact_id: randomUUID(), // no such artifact row
        })
        .execute(),
    ).rejects.toThrow();
  });
});

describe('render artifact repository (S21 T2: append versions)', () => {
  let jobId = '';
  beforeAll(async () => { jobId = await createSyntheticJob('s21-repo'); });
  afterAll(async () => { await deleteSyntheticJob(jobId); });

  it('saveRenderArtifact stores explicit versions; nextRenderVersion counts; findRenderArtifact returns the latest', async () => {
    const src = await saveArtifact(db, {
      jobId,
      kind: 'cover_letter',
      status: 'valid',
      content: { letter: 'Dear Hiring Manager,' },
      validation: { valid: true, violations: [] },
      llmRunId: 7,
    });

    const input = {
      jobId,
      sourceArtifactId: src.id,
      sourceKind: 'cover_letter' as const,
      sourceVersion: src.version,
      format: 'docx' as const,
    };
    const v1 = await saveRenderArtifact(db, { ...input, version: 1, contentPath: `${jobId}/cover-letter-v1.docx` });
    expect(v1.kind).toBe('render_docx');
    expect(v1.version).toBe(1);
    expect(v1.sourceArtifactId).toBe(src.id);

    // S21: re-rendering APPENDS a new version — the v1 row/file stay intact.
    const v2 = await saveRenderArtifact(db, { ...input, version: 2, contentPath: `${jobId}/cover-letter-v2.docx` });
    expect(v2.id).not.toBe(v1.id);
    expect(v2.version).toBe(2);

    expect(await nextRenderVersion(db, jobId, 'render_docx')).toBe(3);

    // findRenderArtifact = the latest render of (source, format).
    expect((await findRenderArtifact(db, src.id, 'docx'))?.version).toBe(2);
    expect(await findRenderArtifact(db, randomUUID(), 'docx')).toBeNull();

    // UNIQUE(job_id, kind, version) still guards duplicates.
    await expect(
      saveRenderArtifact(db, { ...input, version: 2, contentPath: `${jobId}/cover-letter-v2-again.docx` }),
    ).rejects.toThrow();
  });
});

describe('render folder convention (S21 T1)', () => {
  const JOB = 'a1b2c3d4-5e6f-4777-8888-999900001111';
  const UTC_NOON = new Date('2026-09-28T12:00:00Z');

  it('builds "date_employer-slug_job8" folders (UTC date, slugged employer)', () => {
    expect(renderFolderName(UTC_NOON, 'Neo Financial', JOB)).toBe('2026-09-28_neo-financial_a1b2c3d4');
  });

  it('slugs punctuation and whitespace collapses; non-latin names fall back to "job"', () => {
    expect(renderFolderName(UTC_NOON, 'ACME  Corp! (EU)', JOB)).toBe('2026-09-28_acme-corp-eu_a1b2c3d4');
    // no transliteration (YAGNI): non-[a-z0-9] names slug to nothing → 'job'
    expect(renderFolderName(UTC_NOON, '  --Строймаш--  ', JOB)).toBe('2026-09-28_job_a1b2c3d4');
  });

  it('falls back to "job" when the employer slugs to nothing', () => {
    expect(renderFolderName(UTC_NOON, '???', JOB)).toBe('2026-09-28_job_a1b2c3d4');
    expect(renderFolderName(UTC_NOON, '', JOB)).toBe('2026-09-28_job_a1b2c3d4');
  });

  it('safeJoin accepts legacy uuid folders and the dated scheme, rejects the rest', () => {
    const root = resolve('/tmp/root'); // contract: root arrives pre-resolved (resolveArtifactsDir)
    // positive: legacy uuid folder (S6) and the S21 dated scheme
    expect(safeJoin(root, 'a1b2c3d4-5e6f-4777-8888-999900001111', 'resume-v1.docx')).not.toBeNull();
    expect(safeJoin(root, '2026-09-28_neo-financial_a1b2c3d4', 'resume-v1.docx')).not.toBeNull();
    // negative: traversal, arbitrary strings, wrong file names
    expect(safeJoin(root, '../etc', 'passwd.docx')).toBeNull();
    expect(safeJoin(root, 'not-a-scheme', 'resume-v1.docx')).toBeNull();
    expect(safeJoin(root, '2026-09-28_neo-financial_a1b2c3d4', 'resume-v1.xlsx')).toBeNull();
  });
});

describe('render service (S6 T6)', () => {
  // Regression S6 T9 (golden run): the file loader already returns a parsed
  // RenderIdentity — it must be used as-is, never re-parsed as raw master JSON
  // (the double-parse made every master-file fallback 503).
  it('resolveRenderIdentity prefers content, then raw opts.master, then the file identity', () => {
    const content = { identity: { fullName: 'From Content' } };
    const rawMaster = { identity: { full_name: 'From Raw Master' } };
    const fileIdentity = { fullName: 'From File' };
    expect(resolveRenderIdentity(content, rawMaster, fileIdentity)).toEqual({ fullName: 'From Content' });
    expect(resolveRenderIdentity({}, rawMaster, fileIdentity)).toEqual({ fullName: 'From Raw Master' });
    // THE regression: no opts.master → the parsed file identity is returned directly.
    expect(resolveRenderIdentity({}, undefined, fileIdentity)).toEqual({ fullName: 'From File' });
    expect(resolveRenderIdentity({}, undefined, null)).toBeNull();
    // opts.master explicitly null (tests without the PII file) skips the raw-parse path.
    expect(resolveRenderIdentity({}, null, fileIdentity)).toEqual({ fullName: 'From File' });
  });

  // Synthetic identity + resume — never the real master profile (PII, art. 3.2).
  const contentIdentity = { fullName: 'Alex Fixture', headline: 'Senior Developer', email: 'alex.fixture@example.com', location: 'Alberta, Canada' };
  const resumeContent = {
    diff: { summary: 'x', skills_order: [], bullets: [], keywords: [] },
    resume: {
      summary: 'Platform engineer with 10 years of experience.',
      keywords: [],
      skills: ['TypeScript', 'PostgreSQL'],
      experience: [
        {
          employer: 'Fixture Corp',
          title: 'Senior Developer',
          start: '2020',
          end: 'present',
          technology: ['TypeScript'],
          bullets: ['Owned the platform serving 40k users.'],
        },
      ],
      education: [{ degree: 'B.Sc.', institution: 'Fixture University', year: '2014' }],
    },
    identity: contentIdentity,
  };
  const rawMaster = {
    identity: { full_name: 'Alex Fixture', headline: 'Senior Developer', email: 'alex.fixture@example.com', location_constraints: { target_province: 'Alberta' } },
    skills: { frontend: ['TypeScript'], backend: ['PostgreSQL'] },
    experience: [],
    education: [],
  };

  let artifactsDir = '';

  beforeAll(async () => {
    artifactsDir = await mkdtemp(join(tmpdir(), 'chinook-render-'));
  });

  afterAll(async () => {
    if (artifactsDir !== '') await rm(artifactsDir, { recursive: true, force: true });
  });

  it('renders a valid resume with an identity snapshot into both formats', async () => {
    const src = await saveArtifact(db, {
      jobId,
      kind: 'resume',
      status: 'valid',
      content: resumeContent,
      validation: { valid: true, violations: [] },
      llmRunId: 1,
    });
    const now = new Date('2026-09-28T12:00:00Z');
    const { artifacts } = await renderArtifact(db, src.id, { artifactsDir, now });
    expect(artifacts.map((a) => a.kind).sort()).toEqual(['render_docx', 'render_pdf']);
    expect(artifacts.every((a) => a.sourceArtifactId === src.id)).toBe(true);
    for (const view of artifacts) {
      const file = await readRenderFile(db, view.id, { artifactsDir });
      expect(file).not.toBeNull();
      expect(file!.buffer.length).toBeGreaterThan(100);
      if (view.kind === 'render_docx') {
        expect(file!.contentType).toContain('wordprocessingml');
        expect(file!.filename).toBe(`resume-v${view.version}.docx`);
        expect(file!.buffer.subarray(0, 2).toString('latin1')).toBe('PK');
      } else {
        expect(file!.contentType).toBe('application/pdf');
        expect(file!.filename).toBe(`resume-v${view.version}.pdf`);
        expect(file!.buffer.subarray(0, 5).toString('latin1')).toBe('%PDF-');
      }
    }
    // S21: files land under the dated convention folder <date>_fixture-corp_<job8>/
    const docxView = artifacts.find((a) => a.kind === 'render_docx')!;
    expect(docxView.violations).toEqual([]);
    const folder = renderFolderName(now, 'Fixture Corp', jobId);
    const docxPath = join(artifactsDir, folder, `resume-v${docxView.version}.docx`);
    await readFile(docxPath); // throws when missing
  });

  it('appends history: re-render adds new version rows and keeps both files readable', async () => {
    const src = await saveArtifact(db, {
      jobId,
      kind: 'cover_letter',
      status: 'valid',
      content: { letter: 'Dear Hiring Manager,\n\nI am applying for the role at Fixture Corp.', identity: contentIdentity },
      validation: { valid: true, violations: [] },
      llmRunId: 1,
    });
    const first = await renderArtifact(db, src.id, { artifactsDir, now: new Date('2026-09-28T10:00:00Z') });
    const again = await renderArtifact(db, src.id, { artifactsDir, now: new Date('2026-09-29T10:00:00Z') });
    // New ids; each format's version increments by exactly 1 (counters are
    // per job+kind and earlier tests in this suite may have rendered already).
    expect(again.artifacts.every((a) => !first.artifacts.some((b) => b.id === a.id))).toBe(true);
    for (const format of ['render_docx', 'render_pdf'] as const) {
      const before = first.artifacts.find((a) => a.kind === format)!.version;
      expect(again.artifacts.find((a) => a.kind === format)!.version).toBe(before + 1);
    }
    const list = await listArtifacts(db, jobId);
    const docxRenders = list.filter((a) => a.kind === 'render_docx' && a.sourceArtifactId === src.id);
    expect(docxRenders).toHaveLength(2);
    // Both historical versions stay downloadable, each from its dated folder.
    for (const view of docxRenders) {
      const file = await readRenderFile(db, view.id, { artifactsDir });
      expect(file?.filename).toBe(`cover-letter-v${view.version}.docx`);
    }
  });

  it('falls back to the master profile for legacy artifacts without an identity snapshot', async () => {
    const src = await saveArtifact(db, {
      jobId,
      kind: 'resume',
      status: 'valid',
      content: { diff: resumeContent.diff, resume: resumeContent.resume }, // legacy S5 shape
      validation: { valid: true, violations: [] },
      llmRunId: 1,
    });
    const { artifacts } = await renderArtifact(db, src.id, { artifactsDir, master: rawMaster });
    expect(artifacts).toHaveLength(2);
    const docx = await readRenderFile(db, artifacts.find((a) => a.kind === 'render_docx')!.id, { artifactsDir });
    expect(docx?.buffer.length).toBeGreaterThan(100);
  });

  it('throws RenderIdentityUnavailableError without identity in content and master', async () => {
    const src = await saveArtifact(db, {
      jobId,
      kind: 'cover_letter',
      status: 'valid',
      content: { letter: 'Dear Hiring Manager,' },
      validation: { valid: true, violations: [] },
      llmRunId: 1,
    });
    await expect(renderArtifact(db, src.id, { artifactsDir, master: null })).rejects.toBeInstanceOf(RenderIdentityUnavailableError);
  });

  it('throws RenderNotRenderableError for invalid artifacts and render-kind sources', async () => {
    const invalid = await saveArtifact(db, {
      jobId,
      kind: 'resume',
      status: 'invalid',
      content: resumeContent,
      validation: { valid: false, violations: [{ kind: 'entity_mismatch', detail: 'x' }] },
      llmRunId: 1,
    });
    await expect(renderArtifact(db, invalid.id, { artifactsDir })).rejects.toBeInstanceOf(RenderNotRenderableError);

    const render = await saveRenderArtifact(db, {
      jobId,
      sourceArtifactId: invalid.id,
      sourceKind: 'resume',
      sourceVersion: 1,
      format: 'docx',
      contentPath: `${jobId}/x.docx`,
      version: 9001, // high: outside the counters other tests in this suite use
    });
    await expect(renderArtifact(db, render.id, { artifactsDir })).rejects.toBeInstanceOf(RenderNotRenderableError);
  });

  it('throws RenderSourceNotFoundError for an unknown artifact id', async () => {
    await expect(renderArtifact(db, randomUUID(), { artifactsDir })).rejects.toBeInstanceOf(RenderSourceNotFoundError);
  });

  it('readRenderFile refuses paths escaping the artifacts root (traversal guard)', async () => {
    const src = await saveArtifact(db, {
      jobId,
      kind: 'resume',
      status: 'valid',
      content: resumeContent,
      validation: { valid: true, violations: [] },
      llmRunId: 1,
    });
    const evil = await saveRenderArtifact(db, {
      jobId,
      sourceArtifactId: src.id,
      sourceKind: 'resume',
      sourceVersion: 1,
      format: 'docx',
      contentPath: '../../../etc/passwd.docx',
      version: 9002, // high: outside the counters other tests in this suite use
    });
    expect(await readRenderFile(db, evil.id, { artifactsDir })).toBeNull();
    // and for an artifact id that does not exist at all
    expect(await readRenderFile(db, randomUUID(), { artifactsDir })).toBeNull();
  });
});
