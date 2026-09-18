// Seeds fixtures into the dedicated e2e database (isolated from the live
// scheduler, which keeps ingesting into `chinook` while tests run).
import process from 'node:process';
import { Client } from 'pg';

const E2E_URL = process.env.E2E_DATABASE_URL ?? 'postgres://chinook:chinook_dev@localhost:5433/chinook_e2e';

const admin = new Client({ connectionString: E2E_URL.replace(/\/[^/]+$/, '/postgres') });
await admin.connect();
await admin.query('CREATE DATABASE chinook_e2e').catch(() => {});
await admin.end();

process.env.DATABASE_URL = E2E_URL;
const { runIngest } = await import('./ingest.js');
const summary = await runIngest({ fixtures: true, fresh: true });
console.log(`e2e seed: ${summary.uniqueJobs} jobs, buckets ${JSON.stringify(summary.ruleBuckets)}`);
