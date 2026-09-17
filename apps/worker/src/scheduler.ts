import process from 'node:process';
import { sql } from 'kysely';
import type { Kysely } from 'kysely';
import type { Database } from '@chinook/core';
import { createDbFromEnv, ensureSchema, planSources, nextDue, type SourceSchedule } from '@chinook/core';
import type { JobSourceId } from '@chinook/contracts';
import { runIngest } from './ingest.js';
import { loadRootEnv } from './ingest.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const LOCK_KEY = "hashtext('chinook:ingest')";

export function defaultSchedules(): SourceSchedule[] {
  return [
    { source: 'jobbank', intervalMin: Number(process.env.SCHED_JOBBANK_MIN ?? 30), jitterRatio: 0.2 },
    { source: 'adzuna', intervalMin: Number(process.env.SCHED_ADZUNA_MIN ?? 120), jitterRatio: 0.2 },
  ];
}

/**
 * Runs `work` under the ingest advisory lock on a single pinned pg session
 * (db.connection holds one connection for the whole critical section; a lock
 * acquired in a scope that has returned to the pool is worthless).
 * Returns false when another ingest already holds the lock.
 */
export async function withIngestLock(
  db: Kysely<Database>,
  work: () => Promise<void>,
): Promise<boolean> {
  return db.connection().execute(async (conn) => {
    const lockResult = await sql`select pg_try_advisory_lock(${sql.raw(LOCK_KEY)}) as ok`.execute(conn);
    const ok = (lockResult.rows[0] as { ok: boolean } | undefined)?.ok;
    if (!ok) return false;
    try {
      await work();
    } finally {
      await sql`select pg_advisory_unlock(${sql.raw(LOCK_KEY)})`.execute(conn);
    }
    return true;
  });
}

/** Last attempt per source (success or failure alike). */
export async function lastRunPerSource(db: Kysely<Database>): Promise<Record<string, Date>> {
  const rows = await sql<{ source: string; last: Date }>`select source, max(started_at) as last from ingest_run group by source`.execute(db);
  const out: Record<string, Date> = {};
  for (const row of rows.rows) {
    if (row.source && row.last) out[row.source] = new Date(row.last);
  }
  return out;
}

/** Consecutive failed attempts per source, counted from the newest row backwards. */
export async function consecutiveFailures(db: Kysely<Database>): Promise<Record<string, number>> {
  const rows = await db
    .selectFrom('ingest_run')
    .select(['source', 'error', 'started_at'])
    .orderBy('started_at', 'desc')
    .execute();
  const out: Record<string, number> = {};
  for (const row of rows) {
    if (!row.source) continue;
    if (row.error == null) out[row.source] ??= 0;
    else if (out[row.source] === undefined) out[row.source] = (out[row.source] ?? 0) + 1;
  }
  return out;
}

export interface SchedulerHandle {
  stop(): Promise<void>;
}

export function startScheduler(opts: {
  db?: Kysely<Database>;
  schedules?: SourceSchedule[];
  tickMs?: number;
  runIngestFn?: typeof runIngest;
  log?: (line: string) => void;
}): SchedulerHandle {
  const { schedules = defaultSchedules(), tickMs = 60_000, runIngestFn = runIngest } = opts;
  const log = opts.log ?? ((line: string) => console.log(`[${new Date().toISOString()}] ${line}`));
  const cooldowns = new Map<string, Date>();
  let stopped = false;
  let inFlight: Promise<void> | null = null;
  let db = opts.db;

  const tick = async (): Promise<void> => {
    if (stopped || inFlight) return;
    inFlight = (async () => {
      const dbRef: Kysely<Database> = (db ??= createDbFromEnv());
      await ensureSchema(dbRef);
      const ran = await withIngestLock(dbRef, async () => {
        const now = new Date();
        const history = await lastRunPerSource(dbRef);
        const due = planSources(now, schedules, history).filter(
          (s) => !cooldowns.has(s.source) || now >= (cooldowns.get(s.source) as Date),
        );
        if (due.length === 0) {
          log('tick: nothing due');
          return;
        }
        for (const s of due) {
          if (stopped) break;
          log(`run: ${s.source} (interval ${s.intervalMin}m)`);
          try {
            const summary = await runIngestFn({ sources: [s.source], close: false });
            const src = summary.sources[0];
            log(
              `ok: ${s.source} fetched=${src?.fetched ?? 0} unique=${summary.uniqueJobs} ` +
                `buckets=${JSON.stringify(summary.ruleBuckets)}${src?.error ? ` error=${src.error}` : ''}`,
            );
          } catch (error) {
            log(`error: ${s.source} ${String(error)}`);
          }
          cooldowns.set(s.source, nextDue(new Date(), s));
        }
      });
      if (!ran) log('skip: another ingest holds the advisory lock');
    })();
    try {
      await inFlight;
    } finally {
      inFlight = null;
    }
  };

  const timer = setInterval(() => void tick(), tickMs);
  void tick(); // immediate first tick

  const onSignal = (signal: string) => {
    log(`signal ${signal}: finishing current work…`);
    void (async () => {
      await stop();
      process.exit(0);
    })();
  };
  process.on('SIGINT', () => onSignal('SIGINT'));
  process.on('SIGTERM', () => onSignal('SIGTERM'));

  async function stop(): Promise<void> {
    stopped = true;
    clearInterval(timer);
    if (inFlight) await inFlight;
  }

  return { stop };
}

const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].replaceAll('\\', '/'));

if (isMain) {
  loadRootEnv(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../.env'));
  const db = createDbFromEnv();
  await ensureSchema(db);

  if (process.argv.includes('--status')) {
    const [last, failures] = await Promise.all([lastRunPerSource(db), consecutiveFailures(db)]);
    for (const s of defaultSchedules()) {
      const l = last[s.source];
      const ageMin = l ? Math.round((Date.now() - l.getTime()) / 60_000) : null;
      const degraded = failures[s.source] ?? 0;
      console.log(
        `${s.source}: last=${l ? l.toISOString() : 'never'} age=${ageMin ?? '∞'}min ` +
          `interval=${s.intervalMin}m failures_in_a_row=${degraded}${degraded >= 3 ? '  ⚠ source degraded' : ''}`,
      );
    }
    await db.destroy();
  } else if (process.argv.includes('--once')) {
    const flag = process.argv.indexOf('--source');
    const source = flag > 0 ? (process.argv[flag + 1] as JobSourceId) : undefined;
    const schedules = defaultSchedules().filter((s) => !source || s.source === source);
    const ran = await withIngestLock(db, async () => {
      for (const s of schedules) {
        const summary = await runIngest({ sources: [s.source], close: false });
        console.log(JSON.stringify(summary, null, 2));
      }
    });
    if (!ran) console.error('another ingest holds the lock');
    await db.destroy();
    if (!ran) process.exitCode = 1;
  } else {
    console.log('scheduler started; sources:', defaultSchedules().map((s) => `${s.source}=${s.intervalMin}m±20%`).join(' '));
    startScheduler({ db });
  }
}
