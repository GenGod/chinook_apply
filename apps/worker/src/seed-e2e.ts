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

// S11: fixture master profile for the /profile e2e (synthetic, no PII).
const { writeFile, mkdir } = await import('node:fs/promises');
const { dirname, join, sep } = await import('node:path');
const repoRoot = process.cwd().split(sep).slice(0, -2).join(sep);
const fixtureMaster = join(repoRoot, 'data', 'artifacts-e2e', 'master-profile-e2e.json');
await mkdir(dirname(fixtureMaster), { recursive: true });
await writeFile(
  fixtureMaster,
  JSON.stringify(
    {
      version: 1,
      identity: { full_name: 'E2E Fixture' },
      search_config: { noc_codes: ['21231'] },
      summary: 'Fixture engineer for e2e.',
      skills: { languages: ['TypeScript'] },
      experience: [
        { id: 'fx:Fixture Corp', employer: 'Fixture Corp', title: 'Developer', start: '2020-01', end: null, bullets: [], technology: [] },
      ],
      education: [],
    },
    null,
    2,
  ),
);
console.log('e2e seed: fixture master profile written');

const { seedE2eExtras } = await import('@chinook/core');
// S8 dispatch fixtures need the e2e artifacts dir (same dir the e2e webServer
// uses via ARTIFACTS_DIR). cwd is apps/worker under pnpm --filter → repo root
// is two levels up; navigate the split path (no traversal literals).
await seedE2eExtras(join(repoRoot, 'data', 'artifacts-e2e'));
