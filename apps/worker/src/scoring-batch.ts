// S4: post-ingest LLM scoring batch (scheduler hook).
// Scores unscored relevant/review jobs via the gateway, respecting a daily cost cap.
import process from 'node:process';
import type { Kysely } from 'kysely';
import type { Database, RuleStatus } from '@chinook/core';
import { listUnscoredJobs, upsertMatch } from '@chinook/core';

const DEFAULT_DAILY_LIMIT_USD = Number(process.env.LLM_SCORING_DAILY_LIMIT_USD ?? 0.5);

/** Extracts description text from raw job payload. Prefers the enriched full
 *  description (jobbank posting page / adzuna details JSON-LD); falls back to
 *  the feed/API snippet capped at 2000 chars. */
export function descriptionFrom(raw: unknown): string | null {
  if (raw == null || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const full = r.fullDescription;
  if (typeof full === 'string' && full.trim().length > 100) return full.trim();
  const summary = typeof r.summary === 'object' && r.summary !== null ? (r.summary as { '#text'?: string })['#text'] : undefined;
  if (typeof summary === 'string') return summary.replace(/<[^>]+>/g, ' ').trim().slice(0, 2000) || null;
  const desc = (r as { description?: unknown }).description;
  if (typeof desc === 'string') return desc.replace(/<[^>]+>/g, ' ').trim().slice(0, 2000) || null;
  return null;
}

import type { Llm } from '@chinook/llm';
import { fetchPostingDescription, fetchAdzunaFullDescription } from '@chinook/adapters';

/** Fetches the full posting description for truncated jobs and caches it in
 *  job.raw.fullDescription. One fetch per job; failures fall back to the feed
 *  snippet (scoring proceeds either way). */
async function enrichDescription(
  db: Kysely<Database>,
  job: { id: string; source: string; url: string; raw: unknown },
): Promise<Record<string, unknown>> {
  const raw = (job.raw ?? {}) as Record<string, unknown>;
  if (typeof raw.fullDescription === 'string' && raw.fullDescription.length > 100) return raw;
  let full: string | null = null;
  try {
    if (job.source === 'jobbank') full = await fetchPostingDescription(job.url);
    else if (job.source === 'adzuna') full = await fetchAdzunaFullDescription(job.url);
  } catch {
    return raw; // enrichment is best-effort
  }
  if (typeof full !== 'string' || full.length < 200) return raw;
  const updated = { ...raw, fullDescription: full };
  await db.updateTable('job')
    .set({ raw: updated })
    .where('job.id', '=', job.id)
    .execute();
  return updated;
}

/** Scores unscored jobs; returns count scored and cost incurred. */
export async function scoreUnscoredBatch(
  db: Kysely<Database>,
  llm: Llm,
  opts: { promptVersion: string; profileSummary: { summary: string; skills: string[]; targetTitles: string[]; nocCodes: string[]; location: string; workAuthorization: string }; dailyLimitUsd?: number },
): Promise<{ scored: number; skipped: number; costUsd: number }> {
  const dailyLimit = opts.dailyLimitUsd ?? DEFAULT_DAILY_LIMIT_USD;

  // check today's LLM spend
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const spendRows = await db
    .selectFrom('llm_run')
    .where('llm_run.ts', '>=', todayStart)
    .where('llm_run.stage', '=', 'match_llm')
    .select((eb) => eb.fn.sum<number>('llm_run.cost_usd').as('total'))
    .executeTakeFirst();
  const spent = Number(spendRows?.total ?? 0);
  if (spent >= dailyLimit) {
    return { scored: 0, skipped: -1, costUsd: 0 }; // -1 = daily limit reached
  }

  const baskets: RuleStatus[] = ['relevant', 'review'];
  const jobs = await listUnscoredJobs(db, { baskets, promptVersion: opts.promptVersion, limit: 20 });
  let scored = 0;
  let cost = 0;

  for (const job of jobs) {
    if (spent + cost >= dailyLimit) break;
    const raw = await enrichDescription(db, job);
    const { buildScoringPrompt, MatchScoreSchema } = await import('@chinook/llm');
    const scoringJob = {
      title: job.title,
      employer: job.employer,
      location: `${job.city}${job.province ? `, ${job.province}` : ''}${job.remote ? ' (remote)' : ''}`,
      salaryMin: job.salaryMin,
      salaryMax: job.salaryMax,
      description: descriptionFrom(raw) ?? undefined,
    };
    const { system, user } = buildScoringPrompt(opts.profileSummary, scoringJob as import('@chinook/llm').ScoringJob);
    const result = await llm.call({
      role: 'flash',
      stage: 'match_llm',
      system,
      user,
      schema: MatchScoreSchema,
      temperature: 0,
    });
    await upsertMatch(db, job.id, result.runId, result.data, opts.promptVersion);
    scored += 1;
    cost += result.usage.costUsd;
  }

  return { scored, skipped: jobs.length - scored, costUsd: Math.round(cost * 1e6) / 1e6 };
}
