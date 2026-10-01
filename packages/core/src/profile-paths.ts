// S11: canonical profile filesystem locations. Env-first (e2e/CI isolation);
// defaults derive from THIS module's location (packages/core/src → three up =
// repo root locally, image root in Docker) so web and worker agree without
// per-service configuration.
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(MODULE_DIR, '..', '..', '..');

/** Absolute path of the master profile file (MASTER_PROFILE_PATH wins). */
export function masterProfileFilePath(): string {
  const env = process.env.MASTER_PROFILE_PATH;
  if (env && env.trim() !== '') return path.resolve(env);
  return path.join(REPO_ROOT, 'data', 'profile', 'master_profile.json');
}

/** Absolute directory for ingested resume documents (PROFILE_SOURCES_DIR wins). */
export function profileSourcesDir(explicit?: string): string {
  const raw = explicit ?? process.env.PROFILE_SOURCES_DIR;
  if (raw && raw.trim() !== '') return path.resolve(raw);
  return path.join(REPO_ROOT, 'data', 'profile', 'sources');
}

/**
 * Safe join for a stored source file: the name must match the strict
 * storage convention and the resolved path must stay inside the dir.
 */
export function safeSourceFilePath(dir: string, storageName: string): string | null {
  if (!/^\d{10,14}-[0-9a-f]{8}\.(docx|pdf|txt)$/.test(storageName)) return null;
  const resolvedDir = path.resolve(dir);
  const resolved = path.resolve(dir, storageName);
  if (resolved !== resolvedDir && !resolved.startsWith(resolvedDir + path.sep)) return null;
  return resolved;
}
