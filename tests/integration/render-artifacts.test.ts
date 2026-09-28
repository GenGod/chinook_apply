import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createDb,
  ensureSchema,
  saveArtifact,
  saveRenderArtifact,
  findRenderArtifact,
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

let jobId = '';

beforeAll(async () => {
  await ensureSchema(db);
  jobId = randomUUID();
  await db
    .insertInto('job')
    .values({
      id: jobId,
      canonical_hash: `s6-${jobId}`,
      title: 'S6 render test job',
      employer: 'Chinook Test Inc.',
      city: 'edmonton',
      province: 'AB',
      remote: false,
      url: 'https://example.invalid/s6',
      urls: [],
      source: 'jobbank',
      source_job_id: `s6-${jobId}`,
      posted_at: new Date(),
      salary_currency: 'CAD',
      ingested_at: new Date(),
    })
    .execute();
});

afterAll(async () => {
  if (!db || !jobId) return;
  await db.deleteFrom('artifact').where('job_id', '=', jobId).execute();
  await db.deleteFrom('job').where('id', '=', jobId).execute();
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

describe('render artifact repository (S6 T5)', () => {
  it('saveRenderArtifact creates version-1 rows keyed by (source, format); re-save upserts', async () => {
    const src = await saveArtifact(db, {
      jobId,
      kind: 'cover_letter',
      status: 'valid',
      content: { letter: 'Dear Hiring Manager,' },
      validation: { valid: true, violations: [] },
      llmRunId: 7,
    });

    const first = await saveRenderArtifact(db, {
      jobId,
      sourceArtifactId: src.id,
      sourceKind: 'cover_letter',
      sourceVersion: src.version,
      format: 'docx',
      contentPath: `${jobId}/cover-letter-v1.docx`,
    });
    expect(first.kind).toBe('render_docx');
    expect(first.version).toBe(1);
    expect(first.status).toBe('valid');
    expect(first.violations).toEqual([]);
    expect(first.sourceArtifactId).toBe(src.id);

    const found = await findRenderArtifact(db, src.id, 'docx');
    expect(found?.id).toBe(first.id);

    // Re-render (same source, same format): the same row is updated in place,
    // not versioned again — renders are derived and deterministic.
    const again = await saveRenderArtifact(db, {
      jobId,
      sourceArtifactId: src.id,
      sourceKind: 'cover_letter',
      sourceVersion: src.version,
      format: 'docx',
      contentPath: `${jobId}/cover-letter-v1.docx`,
    });
    expect(again.id).toBe(first.id);
    expect(again.version).toBe(1);

    // The other format is an independent row.
    const pdf = await saveRenderArtifact(db, {
      jobId,
      sourceArtifactId: src.id,
      sourceKind: 'cover_letter',
      sourceVersion: src.version,
      format: 'pdf',
      contentPath: `${jobId}/cover-letter-v1.pdf`,
    });
    expect(pdf.kind).toBe('render_pdf');
    expect(pdf.id).not.toBe(first.id);

    await findRenderArtifact(db, src.id, 'pdf').then((row) => expect(row?.kind).toBe('render_pdf'));
    expect(await findRenderArtifact(db, randomUUID(), 'docx')).toBeNull();
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
    const { artifacts } = await renderArtifact(db, src.id, { artifactsDir });
    expect(artifacts.map((a) => a.kind).sort()).toEqual(['render_docx', 'render_pdf']);
    expect(artifacts.every((a) => a.sourceArtifactId === src.id)).toBe(true);
    for (const view of artifacts) {
      const file = await readRenderFile(db, view.id, { artifactsDir });
      expect(file).not.toBeNull();
      expect(file!.buffer.length).toBeGreaterThan(100);
      if (view.kind === 'render_docx') {
        expect(file!.contentType).toContain('wordprocessingml');
        expect(file!.filename).toBe(`resume-v${src.version}.docx`);
        expect(file!.buffer.subarray(0, 2).toString('latin1')).toBe('PK');
      } else {
        expect(file!.contentType).toBe('application/pdf');
        expect(file!.filename).toBe(`resume-v${src.version}.pdf`);
        expect(file!.buffer.subarray(0, 5).toString('latin1')).toBe('%PDF-');
      }
    }
    // Files land under <artifactsDir>/<jobId>/
    const docxPath = join(artifactsDir, jobId, `resume-v${src.version}.docx`);
    await readFile(docxPath); // throws when missing
  });

  it('is idempotent: re-render upserts the same rows and rewrites the files', async () => {
    const src = await saveArtifact(db, {
      jobId,
      kind: 'cover_letter',
      status: 'valid',
      content: { letter: 'Dear Hiring Manager,\n\nI am applying for the role at Fixture Corp.', identity: contentIdentity },
      validation: { valid: true, violations: [] },
      llmRunId: 1,
    });
    const first = await renderArtifact(db, src.id, { artifactsDir });
    const again = await renderArtifact(db, src.id, { artifactsDir });
    expect(again.artifacts.map((a) => a.id).sort()).toEqual(first.artifacts.map((a) => a.id).sort());
    const list = await listArtifacts(db, jobId);
    const renderRows = list.filter((a) => a.kind.startsWith('render_'));
    expect(renderRows.filter((a) => a.kind === 'render_docx')).toHaveLength(1);
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
    });
    expect(await readRenderFile(db, evil.id, { artifactsDir })).toBeNull();
    // and for an artifact id that does not exist at all
    expect(await readRenderFile(db, randomUUID(), { artifactsDir })).toBeNull();
  });
});
