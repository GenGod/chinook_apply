// S22 R2: one-off migration of S6 legacy render layout — uuid folders
// (<uuid>/resume-v1.docx) → the S21 dated convention
// (<date>_<employer-slug>_<job8>/resume-vN.docx).
//
// Safety order (spec R2):
//   1. re-render every source that has legacy render rows via renderArtifact
//      (append — new versions in dated folders; content is identical because
//      renders are deterministic and the identity fallback reads the live
//      master profile);
//   2. verify every new file exists and is non-empty (readRenderFile);
//   3. ONLY THEN (with --apply) delete the exact legacy render rows by id and
//      remove uuid folders that are no longer referenced by ANY content_path.
// Dry-run is the default: without --apply nothing is written.
//
// Run from apps/web so the artifacts root and master profile resolve:
//   pnpm --filter @chinook/web migrate:render-layout           (dry-run)
//   pnpm --filter @chinook/web exec tsx --env-file-if-exists=../../.env src/scripts/migrate-render-layout.ts --apply
import process from 'node:process';
import { readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { createDb, ensureSchema } from '@chinook/core';
import { readRenderFile, renderArtifact } from '../lib/render-service';
import { resolveArtifactsDir } from '../lib/render-storage';

const UUID_FOLDER_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const UUID_PATH_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\//i;
const APPLY = process.argv.includes('--apply');

interface LegacyRenderRow {
  id: string;
  sourceArtifactId: string | null;
  contentPath: string;
}

async function main(): Promise<void> {
  const db = createDb(process.env.DATABASE_URL ?? 'postgres://chinook:chinook_dev@localhost:5433/chinook');
  await ensureSchema(db);

  const allRenders = await db
    .selectFrom('artifact')
    .where('kind', 'in', ['render_docx', 'render_pdf'])
    .select(['id', 'source_artifact_id', 'content_path'])
    .execute();
  const legacy: LegacyRenderRow[] = allRenders
    .filter((row) => typeof row.content_path === 'string' && UUID_PATH_RE.test(row.content_path))
    .map((row) => ({ id: row.id, sourceArtifactId: row.source_artifact_id, contentPath: row.content_path as string }));

  console.log(`migrate-render-layout: ${legacy.length} legacy render rows, mode=${APPLY ? 'APPLY' : 'dry-run'}`);
  if (legacy.length === 0) {
    await db.destroy();
    return;
  }

  // 1+2: re-render (per UNIQUE source — renderArtifact covers both formats)
  // and verify every new file before anything is deleted.
  const sources = [...new Set(legacy.map((row) => row.sourceArtifactId).filter((id): id is string => id !== null))];
  if (APPLY) {
    for (const sourceId of sources) {
      const { artifacts } = await renderArtifact(db, sourceId);
      for (const view of artifacts) {
        const file = await readRenderFile(db, view.id);
        if (!file || file.buffer.length < 100) {
          console.error(`FATAL: new render ${view.id} (${view.kind}) unreadable — aborting before any deletion`);
          await db.destroy();
          process.exit(1);
        }
      }
    }
    console.log(`re-rendered + verified ${sources.length} sources (new versions in dated folders)`);
  } else {
    for (const sourceId of sources) console.log(`  would re-render source ${sourceId}`);
  }

  // 3a: delete exactly the legacy rows by id (never a pattern delete — new
  // dated rows must survive regardless of path shape).
  if (APPLY) {
    await db.deleteFrom('artifact').where('id', 'in', legacy.map((row) => row.id)).execute();
  }

  // 3b: remove uuid folders that no DB content_path references anymore.
  const root = resolveArtifactsDir();
  const livePaths = (await db.selectFrom('artifact').select('content_path').execute()).map((row) => row.content_path ?? '');
  const liveFolders = new Set(livePaths.map((p) => p.split(/[\\/]/)[0]).filter((f) => UUID_FOLDER_RE.test(f)));
  const folders = await readdir(root);
  let removedFolders = 0;
  for (const folder of folders) {
    if (!UUID_FOLDER_RE.test(folder) || liveFolders.has(folder)) continue;
    if (APPLY) await rm(join(root, folder), { recursive: true, force: true });
    removedFolders += 1;
    console.log(`  ${APPLY ? 'removed' : 'would remove'} folder ${folder} (no references left)`);
  }

  console.log(`\ndone: mode=${APPLY ? 'APPLY' : 'dry-run'}, legacy rows ${APPLY ? 'deleted' : 'kept'} (${legacy.length}), folders ${APPLY ? 'removed' : 'to remove'}: ${removedFolders}`);
  await db.destroy();
}

main().catch((error: unknown) => {
  console.error(`FATAL: ${String(error).slice(0, 300)}`);
  process.exitCode = 1;
});
