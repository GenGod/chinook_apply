import process from 'node:process';
import { readFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Job, JobSourceId, RawJob } from '@chinook/contracts';
import { normalizeJob, dedupe } from '@chinook/core';
import { jobbankAdapter } from '@chinook/adapters/jobbank';
import { adzunaAdapter } from '@chinook/adapters/adzuna';
import { createDbFromEnv, ensureSchema, upsertJobs, countJobs } from '@chinook/core';

export interface IngestSummary {
  sources: Array<{
    source: JobSourceId;
    fetched: number;
    error: string | null;
  }>;
  totalFetched: number;
  uniqueJobs: number;
  merged: number;
  inserted: number;
  updated: number;
  jobsInDb: number;
  fuzzyPairs: number;
}

interface RawFeed {
  source: JobSourceId;
  raws: RawJob[];
  error?: string;
}

const ADAPTERS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../packages/adapters/test/fixtures',
);

async function loadFixtures(): Promise<RawFeed[]> {
  const [feedXml, adzunaJson] = await Promise.all([
    readFile(path.join(ADAPTERS_DIR, 'jobbank/feed.xml'), 'utf8'),
    readFile(path.join(ADAPTERS_DIR, 'adzuna/search-alberta.json'), 'utf8'),
  ]);
  return [
    { source: 'jobbank', raws: jobbankAdapter.parse(feedXml) },
    { source: 'adzuna', raws: adzunaAdapter.parse(JSON.parse(adzunaJson)) },
  ];
}

async function fetchLive(query: string): Promise<RawFeed[]> {
  const feeds: RawFeed[] = [];

  try {
    const xml = await jobbankAdapter.fetch(query);
    feeds.push({ source: 'jobbank', raws: jobbankAdapter.parse(xml) });
  } catch (error) {
    feeds.push({ source: 'jobbank', raws: [], error: String(error) });
  }

  const appId = process.env.ADZUNA_APP_ID;
  const appKey = process.env.ADZUNA_APP_KEY;
  if (appId && appKey) {
    try {
      const payload = await adzunaAdapter.fetch({ appId, appKey }, query);
      feeds.push({ source: 'adzuna', raws: adzunaAdapter.parse(payload) });
    } catch (error) {
      feeds.push({ source: 'adzuna', raws: [], error: String(error) });
    }
  } else {
    feeds.push({ source: 'adzuna', raws: [], error: 'ADZUNA_APP_ID/KEY not set' });
  }
  return feeds;
}

export async function runIngest(opts: { fixtures?: boolean; query?: string; close?: boolean }): Promise<IngestSummary> {
  const { fixtures = false, query = 'software developer', close = true } = opts;
  const db = createDbFromEnv();
  await ensureSchema(db);

  const feeds = fixtures ? await loadFixtures() : await fetchLive(query);
  const sourceSummaries: IngestSummary['sources'] = [];
  const allJobs: Job[] = [];
  let totalFetched = 0;

  for (const feed of feeds) {
    const raws = feed.raws ?? [];
    sourceSummaries.push({
      source: feed.source,
      fetched: raws.length,
      error: (feed as { error?: string }).error ?? null,
    });
    totalFetched += raws.length;
    allJobs.push(...raws.map((raw) => normalizeJob(raw, feed.source)));
  }

  const { unique, merged, fuzzyPairs } = dedupe(allJobs);
  const { inserted, updated } = await upsertJobs(db, unique);
  const jobsInDb = await countJobs(db);

  for (const s of sourceSummaries) {
    await db.insertInto('ingest_run').values({
      started_at: new Date(),
      finished_at: new Date(),
      source: s.source,
      fetched: s.fetched,
      unique_jobs: unique.filter((j) => j.source === s.source).length,
      merged,
      inserted,
      updated,
      error: s.error,
    });
  }

  if (close) await db.destroy();
  return {
    sources: sourceSummaries,
    totalFetched,
    uniqueJobs: unique.length,
    merged,
    inserted,
    updated,
    jobsInDb,
    fuzzyPairs: fuzzyPairs.length,
  };
}

const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].replaceAll('\\', '/'));

const EMBEDDED_VAR = /[A-Z][A-Z0-9_]{3,}=/;

/**
 * Loads root .env (KEY=VALUE lines) without dependencies; tsx ignores node's --env-file.
 * Guards against merged lines (a var appended without a leading newline corrupts
 * the previous value — this exact bug poisoned ADZUNA_APP_KEY once).
 */
export function loadRootEnv(envPath: string, target: Record<string, string | undefined> = process.env): string[] {
  const warnings: string[] = [];
  let content: string;
  try {
    content = readFileSync(envPath, 'utf8');
  } catch {
    return warnings; // no .env — rely on real environment variables
  }
  for (const line of content.split('\n')) {
    const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (!match) continue;
    const [, key, value] = match as unknown as [string, string, string];
    if (EMBEDDED_VAR.test(value)) {
      warnings.push(`${key}: value contains another VAR= assignment (merged line?) — skipped`);
      continue;
    }
    if (target[key] === undefined) target[key] = value;
  }
  return warnings;
}

if (isMain) {
  const warnings = loadRootEnv(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../.env'));
  for (const w of warnings) console.error(`env warning: ${w}`);
  const fixtures = process.argv.includes('--fixtures');
  const queryFlag = process.argv.indexOf('--query');
  const queryArg = queryFlag > 0 ? process.argv[queryFlag + 1] : undefined;
  const started = Date.now();
  const summary = await runIngest({ fixtures, ...(queryArg ? { query: queryArg } : {}) });
  console.log(JSON.stringify({ ...summary, ms: Date.now() - started, envWarnings: warnings.length }, null, 2));
}
