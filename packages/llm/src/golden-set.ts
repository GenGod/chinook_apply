// S4 golden-set: scores 30 jobs via live LLM, outputs results for Spearman.
// Usage: npx tsx src/golden-set.ts
import { createDb, ensureSchema, listUnscoredJobs, upsertMatch } from '@chinook/core';
import { createLlm } from './gateway.js';
import { createPgLlmDb } from './llm-db.js';
import { buildScoringPrompt, MatchScoreSchema, SCORING_PROMPT_VERSION } from './scoring.js';
import { extractProfileSummary } from './profile-context.js';
import { readFileSync } from 'node:fs';
import process from 'node:process';

const db = createDb(process.env.DATABASE_URL ?? 'postgres://chinook:chinook_dev@localhost:5433/chinook');
await ensureSchema(db);
const llm = createLlm({ db: createPgLlmDb(db) });

const profileData = JSON.parse(readFileSync('../../data/profile/master_profile.json', 'utf8'));
const profile = extractProfileSummary(profileData);

// get ALL relevant + review jobs (golden set = everything in these baskets)
const jobs = await listUnscoredJobs(db, { baskets: ['relevant', 'review'], promptVersion: SCORING_PROMPT_VERSION, limit: 60 });
console.log(`golden-set: scoring ${jobs.length} jobs (relevant+review)`);

function descriptionFrom(raw: unknown): string | undefined {
  if (raw == null || typeof raw !== 'object') return undefined;
  const r = raw as Record<string, unknown>;
  const full = r.fullDescription;
  if (typeof full === 'string' && full.trim().length > 100) return full.trim();
  const summary = typeof r.summary === 'object' && r.summary !== null ? (r.summary as { '#text'?: string })['#text'] : undefined;
  if (typeof summary === 'string') return summary.replace(/<[^>]+>/g, ' ').trim().slice(0, 2000) || undefined;
  const desc = (r as { description?: unknown }).description;
  if (typeof desc === 'string') return desc.replace(/<[^>]+>/g, ' ').trim().slice(0, 2000) || undefined;
  return undefined;
}

const results: Array<{ id: string; title: string; rule: string; llmScore: number; reasons: string[] }> = [];
let totalCost = 0;

for (const job of jobs) {
  const scoringJob = {
    title: job.title,
    employer: job.employer,
    location: `${job.city}${job.province ? `, ${job.province}` : ''}`,
    salaryMin: job.salaryMin,
    salaryMax: job.salaryMax,
    description: descriptionFrom(job.raw),
  };
  const { system, user } = buildScoringPrompt(profile, scoringJob as never);
  try {
    const result = await llm.call({
      role: 'flash', stage: 'match_llm', system, user, schema: MatchScoreSchema, temperature: 0,
    });
    await upsertMatch(db, job.id, result.runId, result.data, SCORING_PROMPT_VERSION);
    totalCost += result.usage.costUsd;
    results.push({ id: job.id, title: job.title, rule: 'n/a', llmScore: result.data.score, reasons: result.data.reasons });
    console.log(`  ${result.data.score}>3  ${job.title.slice(0, 50)} | ${result.data.reasons[0]?.slice(0, 60)}`);
  } catch (error) {
    console.error(`  FAIL: ${job.title.slice(0, 40)} — ${String(error).slice(0, 80)}`);
  }
}

console.log(`\nscored: ${results.length}/${jobs.length}, cost: $${totalCost.toFixed(6)}`);
await db.destroy();
