// Seeds fixtures into the dedicated e2e database (isolated from the live
// scheduler, which keeps ingesting into `chinook` while tests run).
import process from 'node:process';
import { Client } from 'pg';

// derive from the environment (CI service is 5432, local compose is 5433)
const BASE_URL = process.env.DATABASE_URL ?? 'postgres://chinook:chinook_dev@localhost:5433/chinook';
const E2E_URL = process.env.E2E_DATABASE_URL ?? BASE_URL.replace(/\/[^/]+$/, '/chinook_e2e');

const admin = new Client({ connectionString: E2E_URL.replace(/\/[^/]+$/, '/postgres') });
await admin.connect();
await admin.query('CREATE DATABASE chinook_e2e').catch(() => {});
await admin.end();

process.env.DATABASE_URL = E2E_URL;
const { runIngest } = await import('./ingest.js');
const summary = await runIngest({ fixtures: true, fresh: true });
console.log(`e2e seed: ${summary.uniqueJobs} jobs, buckets ${JSON.stringify(summary.ruleBuckets)}`);

// S19: deterministic non-AB relevant + remote jobs — fixtures are Alberta-only (e2e-only rows)
const { createDb, ensureSchema, upsertJobs } = await import('@chinook/core');
const db = createDb(E2E_URL);
await ensureSchema(db);
const s19 = (n: number, hash: string, title: string, city: string, province: string, remote: boolean) => ({
  id: `${n}${n}${n}${n}${n}${n}${n}${n}-${n}${n}${n}${n}-4${n}${n}${n}-8${n}${n}${n}-${n}${n}${n}${n}${n}${n}${n}${n}${n}${n}${n}${n}`,
  canonicalHash: hash,
  title,
  employer: 'Chinook Fixtures Inc.',
  location: { city, province, remote },
  url: `https://www.jobbank.gc.ca/jobsearch/jobposting/9100000${n}`,
  urls: [],
  source: 'jobbank' as const,
  sourceJobId: `9100000${n}`,
  postedAt: '2026-09-01T12:00:00Z',
  salaryMin: 90000 + n,
  salaryMax: null,
  salaryCurrency: 'CAD' as const,
  nocCode: null,
  raw: null,
  ingestedAt: '2026-09-01T12:00:00Z',
});
const longDescription = Array.from({ length: 6 }, (_, i) =>
  `Paragraph ${i + 1} of the S20 e2e long description: duties include designing job-search dashboards, writing TypeScript &amp; SQL, and reviewing pull requests with care&nbsp;— repeated to exceed the old 1200-char truncation for deterministic preview tests.`,
).join('<br><br>');
await upsertJobs(db, [
  { ...s19(1, 's19-e2e-on-developer', 'S19 e2e Ontario developer', 'toronto', 'ON', false), raw: { description: longDescription } },
  s19(2, 's19-e2e-remote-developer', 'S19 e2e remote developer', '', '', true),
]);
await db
  .updateTable('job')
  .set({ rule_status: 'relevant' })
  .where('canonical_hash', 'in', ['s19-e2e-on-developer', 's19-e2e-remote-developer'])
  .execute();
await db.destroy();
console.log('e2e seed: +2 S19 synthetic rows (ON relevant, remote relevant)');
