// Vitest setup: point integration suites at an isolated database so the live
// containerized scheduler (ingesting into `chinook` every 30 min) can never
// race with local test runs. CI keeps its own DATABASE_URL (service container).
import process from 'node:process';
import { Client } from 'pg';

const TEST_URL = process.env.CHINOOK_TEST_DATABASE_URL ?? 'postgres://chinook:chinook_dev@localhost:5433/chinook_test';

if (!process.env.DATABASE_URL || process.env.DATABASE_URL.includes('localhost:5433')) {
  const admin = new Client({ connectionString: TEST_URL.replace(/\/[^/]+$/, '/postgres') });
  await admin.connect();
  await admin.query('CREATE DATABASE chinook_test').catch(() => {});
  await admin.end();
  process.env.DATABASE_URL = TEST_URL;
}
