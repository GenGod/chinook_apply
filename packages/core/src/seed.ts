// E2E extra fixtures (S19/S20 synthetic rows) — lives in core so the
// env-sourced connection string flows through the guarded createDb path
// (assertSafeDatabaseUrl host allowlist). Database bootstrap stays in the
// worker seed script; this module only seeds rows.
import process from 'node:process';
import type { Job } from '@chinook/contracts';
import { createDb, ensureSchema, upsertJobs, DEV_DATABASE_URL } from './db';

function e2eUrl(): string {
  const base = process.env.DATABASE_URL ?? DEV_DATABASE_URL;
  const explicit = process.env.E2E_DATABASE_URL;
  return explicit ?? base.replace(/\/[^/]+$/, '/chinook_e2e');
}

function s19Row(n: number, hash: string, title: string, city: string, province: string, remote: boolean): Job {
  return {
    id: `${n}${n}${n}${n}${n}${n}${n}${n}-${n}${n}${n}${n}-4${n}${n}${n}-8${n}${n}${n}-${n}${n}${n}${n}${n}${n}${n}${n}${n}${n}${n}${n}`,
    canonicalHash: hash,
    title,
    employer: 'Chinook Fixtures Inc.',
    location: { city, province, remote },
    url: `https://www.jobbank.gc.ca/jobsearch/jobposting/9100000${n}`,
    urls: [],
    source: 'jobbank',
    sourceJobId: `9100000${n}`,
    postedAt: '2026-09-01T12:00:00Z',
    salaryMin: 90000 + n,
    salaryMax: null,
    salaryCurrency: 'CAD',
    nocCode: null,
    raw: null,
    ingestedAt: '2026-09-01T12:00:00Z',
  };
}

const longDescription = Array.from({ length: 6 }, (_, i) =>
  `Paragraph ${i + 1} of the S20 e2e long description: duties include designing job-search dashboards, writing TypeScript &amp; SQL, and reviewing pull requests with care&nbsp;— repeated to exceed the old 1200-char truncation for deterministic preview tests.`,
).join('<br><br>');

/** Inserts the S19/S20 synthetic rows into the e2e database. */
export async function seedE2eExtras(): Promise<void> {
  const db = createDb(e2eUrl());
  await ensureSchema(db);
  await upsertJobs(db, [
    { ...s19Row(1, 's19-e2e-on-developer', 'S19 e2e Ontario developer', 'toronto', 'ON', false), raw: { description: longDescription } },
    s19Row(2, 's19-e2e-remote-developer', 'S19 e2e remote developer', '', '', true),
  ]);
  await db
    .updateTable('job')
    .set({ rule_status: 'relevant' })
    .where('canonical_hash', 'in', ['s19-e2e-on-developer', 's19-e2e-remote-developer'])
    .execute();
  await db.destroy();
  console.log('e2e seed: +2 S19 synthetic rows (ON relevant, remote relevant)');
}
