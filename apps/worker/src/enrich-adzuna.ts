// Backfill: fetch full descriptions for already-ingested jobs whose stored
// description is truncated (Adzuna API caps at 500 chars; Job Bank feed gives a
// short summary). Caches into job.raw.fullDescription. Idempotent — skips jobs
// that already have a cached full description. 2s politeness delay per fetch.
// Usage: pnpm --filter @chinook/worker enrich:descriptions [--limit 100]
import { createDb } from '@chinook/core';
import { fetchPostingDescription, fetchAdzunaFullDescription } from '@chinook/adapters';
import process from 'node:process';

const db = createDb(process.env.DATABASE_URL ?? 'postgres://chinook:chinook_dev@localhost:5433/chinook');

const limitArg = Number(process.argv.find((a) => a.startsWith('--limit='))?.slice(8) ?? 100);

const rows = await db.selectFrom('job')
  .where((eb) => eb.and([
    eb('job.rule_status', 'in', ['relevant', 'review']),
    eb.or([eb('job.source', '=', 'adzuna'), eb('job.source', '=', 'jobbank')]),
  ]))
  .select(['job.id', 'job.title', 'job.source', 'job.url', 'job.raw'])
  .orderBy('job.posted_at', 'desc')
  .limit(limitArg)
  .execute();

let fetched = 0;
let cached = 0;
let failed = 0;

for (const job of rows) {
  const raw = (job.raw ?? {}) as Record<string, unknown>;
  if (typeof raw.fullDescription === 'string' && raw.fullDescription.length > 100) {
    cached += 1;
    continue;
  }
  let full: string | null = null;
  try {
    if (job.source === 'jobbank') full = (await fetchPostingDescription(job.url)).description;
    else if (job.source === 'adzuna') full = await fetchAdzunaFullDescription(job.url);
  } catch (error) {
    failed += 1;
    console.error(`FAIL ${job.source} ${job.title.slice(0, 40)}: ${String(error).slice(0, 90)}`);
  }
  if (typeof full === 'string' && full.length >= 200) {
    await db.updateTable('job')
      .set({ raw: { ...raw, fullDescription: full } })
      .where('job.id', '=', job.id)
      .execute();
    fetched += 1;
    console.log(`OK   ${job.source} ${job.title.slice(0, 45).padEnd(45)} ${full.length} chars`);
  } else if (full === null && job.source === 'adzuna') {
    // details page gone or LD missing — nothing to cache
    failed += 1;
    console.error(`MISS ${job.source} ${job.title.slice(0, 40)}`);
  }
  await new Promise((r) => setTimeout(r, 2000));
}

console.log(`\nbackfill done: fetched=${fetched} cached=${cached} failed=${failed} of ${rows.length}`);
await db.destroy();
