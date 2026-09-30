// Seeds fixtures into the dedicated e2e database (isolated from the live
// scheduler, which keeps ingesting into `chinook` while tests run).
// Row-level seeding lives in @chinook/core (guarded createDb path); this
// script only bootstraps the database and delegates.
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

const { seedE2eExtras } = await import('@chinook/core');
// S8 dispatch fixtures need the e2e artifacts dir (same dir the e2e webServer
// uses via ARTIFACTS_DIR). cwd is apps/worker under pnpm --filter → repo root
// is two levels up; navigate the split path (no traversal literals).
const { sep } = await import('node:path');
const repoRoot = process.cwd().split(sep).slice(0, -2).join(sep);
await seedE2eExtras(`${repoRoot}${sep}data${sep}artifacts-e2e`);
