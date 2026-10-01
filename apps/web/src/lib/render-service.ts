// S6 T6: render orchestration — deterministic DOCX/PDF rendering of valid
// generated artifacts (S5). No LLM: renders cost $0 and create no llm_run.
//
// Untrusted content (Constitution 7.1): artifact JSONB was produced by an LLM
// pipeline, so it is normalized into plain validated render inputs
// (normalizeTailoredResume / normalizeLetter) before any use — nothing raw
// flows onward.
//
// Identity (Constitution 3.2 / S6 spec R4): documents need a header, so the
// renderer resolves RenderIdentity from the artifact content snapshot stored
// at generation time; legacy S5 artifacts fall back to the master profile
// file. Both paths stay synthetic-safe in tests via opts.master.
//
// All filesystem access goes through render-storage.ts (validated paths,
// gitignored data/artifacts) — this module is orchestration only.
import type { Kysely } from 'kysely';
import {
  encodeCoverDocx,
  encodeCoverPdf,
  encodeResumeDocx,
  encodeResumePdf,
  getArtifactContent,
  saveRenderArtifact,
  nextRenderVersion,
  buildCoverRenderModel,
  buildResumeRenderModel,
  renderIdentityFromContent,
  renderIdentityFromMaster,
  normalizeTailoredResume,
  normalizeLetter,
  type ArtifactView,
  type Database,
  type RenderFormat,
  type RenderIdentity,
  type TailoredResume,
} from '@chinook/core';
import { loadMasterIdentity } from './generation-service';
import { loadRenderFile, renderFolderName, resolveArtifactsDir, saveRenderFile } from './render-storage';

/** HTTP 404 — the artifact id is unknown. */
export class RenderSourceNotFoundError extends Error {
  readonly status = 404;
  constructor(message: string) {
    super(message);
    this.name = 'RenderSourceNotFoundError';
  }
}

/** HTTP 409 — the artifact exists but cannot be rendered (not valid / not a document). */
export class RenderNotRenderableError extends Error {
  readonly status = 409;
  constructor(message: string) {
    super(message);
    this.name = 'RenderNotRenderableError';
  }
}

/** HTTP 503 — no identity available (neither content snapshot nor master profile). */
export class RenderIdentityUnavailableError extends Error {
  readonly status = 503;
  constructor(message: string) {
    super(message);
    this.name = 'RenderIdentityUnavailableError';
  }
}

/** Render format → HTTP content type for download responses. */
export const RENDER_CONTENT_TYPES: Record<RenderFormat, string> = {
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  pdf: 'application/pdf',
};

const SOURCE_KIND_DASH: Record<'resume' | 'cover_letter', string> = {
  resume: 'resume',
  cover_letter: 'cover-letter',
};

const FORMAT_BY_RENDER_KIND: Record<string, RenderFormat> = {
  render_docx: 'docx',
  render_pdf: 'pdf',
};

/** Renders one format's version and stores it; returns the relative content_path. */
async function renderOne(
  source: { jobId: string; kind: 'resume' | 'cover_letter' },
  identity: RenderIdentity,
  resume: TailoredResume | null,
  letter: string | null,
  masterSkills: Record<string, string[]> | undefined,
  format: RenderFormat,
  folder: string,
  version: number,
  rootDir: string,
): Promise<string> {
  const fileName = `${SOURCE_KIND_DASH[source.kind]}-v${version}.${format}`;
  const buffer =
    resume !== null
      ? format === 'docx'
        ? await encodeResumeDocx(buildResumeRenderModel(identity, resume, masterSkills))
        : await encodeResumePdf(buildResumeRenderModel(identity, resume, masterSkills))
      : format === 'docx'
        ? await encodeCoverDocx(buildCoverRenderModel(identity, letter ?? ''))
        : await encodeCoverPdf(buildCoverRenderModel(identity, letter ?? ''));
  return saveRenderFile(rootDir, folder, fileName, buffer);
}

/**
 * Identity resolution order (S6 R4): the artifact content snapshot first
 * (self-contained, audit-stable), then opts.master parsed as RAW master JSON
 * (tests / alternative deployments), then the identity loaded from the master
 * profile FILE (already a RenderIdentity — never re-parsed; regression S6 T9:
 * the golden run caught the double-parse that made every render 503).
 */
export function resolveRenderIdentity(
  content: unknown,
  optsMaster: unknown,
  fileIdentity: RenderIdentity | null,
): RenderIdentity | null {
  const fromOpts = optsMaster !== undefined ? renderIdentityFromMaster(optsMaster) : null;
  return renderIdentityFromContent(content) ?? fromOpts ?? fileIdentity;
}

/**
 * Renders one valid generated artifact (resume | cover_letter) into both
 * formats and APPENDS a new version pair (S21 history): files land under
 * data/artifacts/<UTC-date>_<employer-slug>_<jobId8>/, rows get
 * version = max+1 per (job, render kind); nothing is overwritten.
 */
export async function renderArtifact(
  db: Kysely<Database>,
  artifactId: string,
  opts?: { artifactsDir?: string; master?: unknown; now?: Date },
): Promise<{ artifacts: ArtifactView[] }> {
  const source = await getArtifactContent(db, artifactId);
  if (!source) throw new RenderSourceNotFoundError(`artifact ${artifactId} not found`);
  if (source.status !== 'valid' || (source.kind !== 'resume' && source.kind !== 'cover_letter')) {
    throw new RenderNotRenderableError(
      `artifact ${artifactId} (kind=${source.kind}, status=${source.status}) is not renderable`,
    );
  }

  // Untrusted artifact JSONB → validated render inputs (constitution 7.1).
  const resume = source.kind === 'resume' ? normalizeTailoredResume(source.content) : null;
  const letter = source.kind === 'cover_letter' ? normalizeLetter(source.content) : null;
  if (resume === null && letter === null) {
    throw new RenderNotRenderableError(`artifact ${artifactId} content does not match its kind (${source.kind})`);
  }

  // Identity: content snapshot → opts.master (raw JSON; explicit null disables
  // the file fallback for tests) → master file loader.
  const identity = resolveRenderIdentity(
    source.content,
    opts?.master,
    opts?.master !== undefined ? null : loadMasterIdentity(),
  );
  if (!identity) {
    throw new RenderIdentityUnavailableError(
      'no identity available: artifact content has no identity snapshot and the master profile is unavailable',
    );
  }

  const masterRecord =
    opts?.master != null && typeof opts.master === 'object' ? (opts.master as Record<string, unknown>) : null;
  const masterSkills =
    masterRecord?.skills != null && typeof masterRecord.skills === 'object'
      ? (masterRecord.skills as Record<string, string[]>)
      : undefined;

  // S21 folder convention needs the employer for the human-readable slug.
  const job = await db.selectFrom('job').select(['employer']).where('id', '=', source.jobId).executeTakeFirst();
  const folder = renderFolderName(opts?.now ?? new Date(), job?.employer ?? '', source.jobId);

  const rootDir = resolveArtifactsDir(opts?.artifactsDir);
  const sourceRef = { jobId: source.jobId, kind: source.kind as 'resume' | 'cover_letter' };
  const artifacts: ArtifactView[] = [];
  for (const format of ['docx', 'pdf'] as const) {
    const kind = `render_${format}` as const;
    const version = await nextRenderVersion(db, source.jobId, kind);
    const contentPath = await renderOne(sourceRef, identity, resume, letter, masterSkills, format, folder, version, rootDir);
    const view = await saveRenderArtifact(db, {
      jobId: source.jobId,
      sourceArtifactId: artifactId,
      sourceKind: sourceRef.kind,
      sourceVersion: source.version,
      format,
      contentPath,
      version,
    });
    artifacts.push(view);
  }
  return { artifacts };
}

/**
 * Reads a render artifact's file bytes for download. Returns null when the id
 * is not a render artifact or the stored file is missing/invalid (the stored
 * content_path is validated inside render-storage before any read).
 */
export async function readRenderFile(
  db: Kysely<Database>,
  artifactId: string,
  opts?: { artifactsDir?: string },
): Promise<{ buffer: Buffer; contentType: string; filename: string } | null> {
  const artifact = await getArtifactContent(db, artifactId);
  const contentPath = artifact?.contentPath;
  if (!artifact || !contentPath) return null;
  const format = FORMAT_BY_RENDER_KIND[artifact.kind];
  if (!format) return null;

  const file = await loadRenderFile(resolveArtifactsDir(opts?.artifactsDir), contentPath);
  if (!file) return null;
  return { buffer: file.buffer, contentType: RENDER_CONTENT_TYPES[format], filename: file.filename };
}
