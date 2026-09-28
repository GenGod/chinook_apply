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
import { loadRenderFile, resolveArtifactsDir, saveRenderFile } from './render-storage';

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

/** Renders one format's file and stores it; returns the relative content_path. */
async function renderOne(
  source: { jobId: string; kind: 'resume' | 'cover_letter'; version: number },
  identity: RenderIdentity,
  resume: TailoredResume | null,
  letter: string | null,
  masterSkills: Record<string, string[]> | undefined,
  format: RenderFormat,
  rootDir: string,
): Promise<string> {
  const fileName = `${SOURCE_KIND_DASH[source.kind]}-v${source.version}.${format}`;
  const buffer =
    resume !== null
      ? format === 'docx'
        ? await encodeResumeDocx(buildResumeRenderModel(identity, resume, masterSkills))
        : await encodeResumePdf(buildResumeRenderModel(identity, resume, masterSkills))
      : format === 'docx'
        ? await encodeCoverDocx(buildCoverRenderModel(identity, letter ?? ''))
        : await encodeCoverPdf(buildCoverRenderModel(identity, letter ?? ''));
  return saveRenderFile(rootDir, source.jobId, fileName, buffer);
}

/**
 * Renders one valid generated artifact (resume | cover_letter) into both
 * formats, writing the files and upserting the two render artifact rows.
 * Idempotent: re-rendering the same source updates the same rows and files.
 */
export async function renderArtifact(
  db: Kysely<Database>,
  artifactId: string,
  opts?: { artifactsDir?: string; master?: unknown },
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

  // Identity: content snapshot first (self-contained, audit-stable), then the
  // master profile file for legacy S5 artifacts.
  const masterRaw = opts?.master ?? loadMasterIdentity();
  const identity = renderIdentityFromContent(source.content) ?? renderIdentityFromMaster(masterRaw);
  if (!identity) {
    throw new RenderIdentityUnavailableError(
      'no identity available: artifact content has no identity snapshot and the master profile is unavailable',
    );
  }

  const masterRecord =
    masterRaw != null && typeof masterRaw === 'object' ? (masterRaw as Record<string, unknown>) : null;
  const masterSkills =
    masterRecord?.skills != null && typeof masterRecord.skills === 'object'
      ? (masterRecord.skills as Record<string, string[]>)
      : undefined;

  const rootDir = resolveArtifactsDir(opts?.artifactsDir);
  const sourceRef = { jobId: source.jobId, kind: source.kind as 'resume' | 'cover_letter', version: source.version };
  const artifacts: ArtifactView[] = [];
  for (const format of ['docx', 'pdf'] as const) {
    const contentPath = await renderOne(sourceRef, identity, resume, letter, masterSkills, format, rootDir);
    const view = await saveRenderArtifact(db, {
      jobId: source.jobId,
      sourceArtifactId: artifactId,
      sourceKind: sourceRef.kind,
      sourceVersion: source.version,
      format,
      contentPath,
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
