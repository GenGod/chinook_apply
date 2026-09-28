// S6 golden run: deterministic rendering of every valid generated artifact in
// the live database into DOCX + PDF. No LLM calls, $0 cost. Metrics only on
// stdout — file bytes stay in data/artifacts (gitignored), content never
// reaches the console (Constitution 3.2). Run from apps/web so the artifacts
// root and the static master-profile path resolve:
//   pnpm --filter @chinook/web render:documents
import process from 'node:process';
import { createDb, ensureSchema, findRenderArtifact } from '@chinook/core';
import { renderArtifact, readRenderFile, RenderNotRenderableError, RenderIdentityUnavailableError } from '../lib/render-service';

interface Row {
  kind: string;
  label: string;
  status: string;
  files: string;
}

/** All valid, not-yet-superseded resume/cover artifacts, newest version per (job, kind). */
async function latestValidArtifacts(db: ReturnType<typeof createDb>): Promise<Array<{ id: string; kind: string; version: number; jobId: string }>> {
  const rows = await db
    .selectFrom('artifact')
    .where('artifact.status', '=', 'valid')
    .where('artifact.kind', 'in', ['resume', 'cover_letter'])
    .orderBy('artifact.created_at', 'desc')
    .select(['artifact.id', 'artifact.kind', 'artifact.version', 'artifact.job_id as jobId'])
    .limit(200)
    .execute();
  const seen = new Set<string>();
  const out: Array<{ id: string; kind: string; version: number; jobId: string }> = [];
  for (const r of rows) {
    const key = `${r.jobId}/${r.kind}`;
    if (seen.has(key)) continue; // newest version wins (rows are created-desc)
    seen.add(key);
    out.push(r);
  }
  return out;
}

async function main(): Promise<void> {
  const db = createDb(process.env.DATABASE_URL ?? 'postgres://chinook:chinook_dev@localhost:5433/chinook');
  // Idempotent S6 migration (render kinds, source_artifact_id, content_path) —
  // the script must work against databases created before S6.
  await ensureSchema(db);
  const sources = await latestValidArtifacts(db);
  if (sources.length === 0) {
    console.log('golden-render: no valid resume/cover artifacts — nothing to do');
    await db.destroy();
    return;
  }
  console.log(`golden-render: ${sources.length} latest valid artifacts (resume + cover)`);

  const rows: Row[] = [];
  let rendered = 0;
  let skipped = 0;
  let failed = 0;
  for (const src of sources) {
    // S21: renders append history — re-running the script must not pile up
    // duplicate versions, so sources that already have a render are skipped.
    if (await findRenderArtifact(db, src.id, 'docx')) {
      skipped += 1;
      rows.push({ kind: src.kind, label: `v${src.version}`, status: 'skip', files: 'already rendered' });
      continue;
    }
    try {
      const { artifacts } = await renderArtifact(db, src.id);
      rendered += 1;
      const files: string[] = [];
      for (const view of artifacts) {
        const file = await readRenderFile(db, view.id);
        if (!file) {
          files.push(`${view.kind}: MISSING`);
          continue;
        }
        const size = file.buffer.length;
        files.push(`${view.kind === 'render_docx' ? 'DOCX' : 'PDF'} ${(size / 1024).toFixed(1)}kB`);
      }
      rows.push({ kind: src.kind, label: `v${src.version}`, status: 'ok', files: files.join(' + ') });
    } catch (error) {
      failed += 1;
      const message = error instanceof RenderNotRenderableError || error instanceof RenderIdentityUnavailableError
        ? error.name
        : String(error).slice(0, 80);
      rows.push({ kind: src.kind, label: `v${src.version}`, status: 'fail', files: message });
    }
  }

  console.log('\n=== GOLDEN RENDER (metrics only — no document content, PII stays in data/artifacts) ===');
  console.log('kind          | ver  | status | files');
  for (const r of rows) {
    console.log(`${r.kind.padEnd(13)} | ${r.label.padEnd(4)} | ${r.status.padEnd(6)} | ${r.files}`);
  }
  console.log(`\ntotal: ${rendered}/${sources.length} rendered, ${failed} failed, 0 llm calls, $0`);
  await db.destroy();
}

main().catch((error: unknown) => {
  console.error(`FATAL: ${String(error).slice(0, 300)}`);
  process.exitCode = 1;
});
