// S6: render file storage — the ONLY module that touches the filesystem for
// artifact renders. Files live under gitignored data/artifacts (Constitution
// 3.2 — PII never enters git); the database stores relative content_paths.
//
// Path safety: every path is built from a validated uuid job folder and a
// whitelisted render file name, then re-checked against the root. Stored
// content_paths from the DB are parsed into those same two segments before
// any read — nothing else is ever opened.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, join, resolve, sep } from 'node:path';
import process from 'node:process';

// The job folder must be a uuid (legacy S6 layout) or the S21 dated scheme
// ("2026-09-28_neo-financial_a1b2c3d4"); the file name must match the
// renderer's exact naming scheme ("resume-v3.docx", "cover-letter-v1.pdf").
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FOLDER_RE = /^\d{4}-\d{2}-\d{2}_[a-z0-9-]+_[0-9a-f]{8}$/;
const RENDER_FILE_RE = /^(resume|cover-letter)-v\d+\.(docx|pdf)$/;

/** data/artifacts root — same repo-layout convention as the master profile path. */
export function resolveArtifactsDir(explicit?: string): string {
  return resolve(explicit ?? process.env.ARTIFACTS_DIR ?? '../../data/artifacts');
}

/** Human-readable employer slug: [a-z0-9-] only; empty → "job" (no transliteration). */
export function employerSlug(employer: string): string {
  const slug = employer
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug === '' ? 'job' : slug;
}

/**
 * S21 folder convention: "YYYY-MM-DD_<employer-slug>_<jobId8>" — UTC date of
 * the render, first 8 hex chars of the job id for uniqueness.
 */
export function renderFolderName(now: Date, employer: string, jobId: string): string {
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, '0');
  const d = String(now.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}_${employerSlug(employer)}_${jobId.slice(0, 8)}`;
}

/** Resolves <root>/<folder>/<file> after validation; null when anything is off. */
export function safeJoin(rootDir: string, jobFolder: string, fileName: string): string | null {
  if (!(UUID_RE.test(jobFolder) || FOLDER_RE.test(jobFolder))) return null;
  if (!RENDER_FILE_RE.test(fileName)) return null;
  const absolutePath = resolve(rootDir, jobFolder, fileName);
  if (!absolutePath.startsWith(rootDir + sep)) return null;
  return absolutePath;
}

/**
 * Writes one rendered file under <root>/<jobId>/<fileName>; returns the
 * relative content_path ("<jobId>/<fileName>") for the artifact row.
 */
export async function saveRenderFile(
  rootDir: string,
  jobId: string,
  fileName: string,
  buffer: Buffer,
): Promise<string> {
  const absolutePath = safeJoin(rootDir, jobId, fileName);
  if (!absolutePath) throw new Error(`render path rejected for job ${jobId} file ${fileName}`);
  await mkdir(resolve(rootDir, jobId), { recursive: true });
  await writeFile(absolutePath, buffer);
  return `${jobId}/${fileName}`;
}

/**
 * Reads a stored render file back. The stored content_path must decompose
 * into "<uuid-job-folder>/<whitelisted-file-name>" — any other shape (traversal,
 * absolute path, extra segments) returns null instead of reading.
 */
export async function loadRenderFile(
  rootDir: string,
  contentPath: string,
): Promise<{ buffer: Buffer; filename: string } | null> {
  const segments = contentPath.split(/[\\/]/);
  if (segments.length !== 2) return null;
  const absolutePath = safeJoin(rootDir, segments[0] ?? '', segments[1] ?? '');
  if (!absolutePath) return null;
  try {
    const buffer = await readFile(absolutePath);
    return { buffer, filename: basename(absolutePath) };
  } catch {
    return null; // file missing (e.g. volume reset) — callers may re-render
  }
}

/** True when the folder exists check for the artifacts root passes (smoke). */
export async function ensureArtifactsDir(rootDir: string): Promise<void> {
  await mkdir(rootDir, { recursive: true });
}

export { join as joinPath };
