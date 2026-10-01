// S23 R3: auto-draft — the scheduler drafts documents for top-scored relevant
// jobs so the user wakes up to a review queue instead of clicking Generate.
// Generation is an INTERNAL action (Constitution 1.1 governs outgoing sends —
// dispatch stays manual-approve only); costs are capped by GEN_DAILY_LIMIT_USD
// inside generateDocuments plus the AUTO_DRAFT_JOBS_PER_DAY job-count cap here.
// Lives in @chinook/llm next to the generation orchestration it drives (core
// must not depend on llm — that build cycle was broken in S23).
import type { Kysely } from 'kysely';
import type { Database, MasterProfileLike, RenderIdentity } from '@chinook/core';
import type { Llm } from './gateway';
import { generateDocuments, GenerationLimitError, JobNotEligibleError } from './document-generation';

export const DEFAULT_AUTODRAFT_SCORE = 85;
export const DEFAULT_AUTODRAFT_JOBS_PER_DAY = 10;

export interface AutoDraftCandidate {
  jobId: string;
  title: string;
  score: number;
}

export function autodraftEnabled(): boolean {
  return (process.env.AUTO_DRAFT ?? '1') !== '0';
}

function autodraftScoreMin(): number {
  const raw = Number(process.env.AUTO_DRAFT_SCORE);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_AUTODRAFT_SCORE;
}

function autodraftJobsPerDay(): number {
  const raw = Number(envValue('AUTO_DRAFT_JOBS_PER_DAY'));
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_AUTODRAFT_JOBS_PER_DAY;
}

function envValue(name: string): string | undefined {
  return process.env[name];
}

/** Auto-drafted artifact rows created today (content flag, resume kind). */
async function autodraftedToday(db: Kysely<Database>): Promise<number> {
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const rows = await db
    .selectFrom('artifact')
    .where('kind', '=', 'resume')
    .where('created_at', '>=', todayStart)
    .select('content')
    .execute();
  return rows.filter((r) => {
    const flag = (r.content as { autodraft?: unknown } | null)?.autodraft;
    return flag === true || flag === 'true';
  }).length;
}

/**
 * Top relevant jobs worth drafting: best match score ≥ threshold, no
 * application row yet (still "new" on the board) and no valid resume
 * artifact. Ordered by score desc, capped by the remaining daily budget.
 */
export async function selectAutoDraftCandidates(
  db: Kysely<Database>,
  opts?: { scoreMin?: number; limit?: number },
): Promise<AutoDraftCandidate[]> {
  const scoreMin = opts?.scoreMin ?? autodraftScoreMin();
  const limit =
    opts?.limit ?? Math.max(0, autodraftJobsPerDay() - (await autodraftedToday(db)));
  if (limit <= 0) return [];

  const rows = await db
    .selectFrom('job')
    .innerJoin('job_match', 'job_match.job_id', 'job.id')
    .where('job.rule_status', '=', 'relevant')
    .where('job_match.score', '>=', scoreMin)
    .where((eb) => eb.not(eb.exists(eb.selectFrom('application').select('id').whereRef('application.job_id', '=', 'job.id'))))
    .where((eb) =>
      eb.not(
        eb.exists(
          eb
            .selectFrom('artifact')
            .select('id')
            .whereRef('artifact.job_id', '=', 'job.id')
            .where('artifact.kind', '=', 'resume')
            .where('artifact.status', '=', 'valid'),
        ),
      ),
    )
    .select((eb) => ['job.id as jobId', 'job.title as title', eb.fn.max('job_match.score').as('score')])
    .groupBy(['job.id', 'job.title'])
    .orderBy('score', 'desc')
    .limit(limit)
    .execute();
  return rows.map((r) => ({ jobId: r.jobId, title: r.title, score: Number(r.score) }));
}

export interface AutoDraftSummary {
  considered: number;
  drafted: number;
  skipped: number;
  errors: number;
}

/**
 * Drafts resume + cover letter for every selected candidate. Per-candidate
 * errors (LLM hiccup, invalid content) are logged and skipped — one bad job
 * never stops the batch. The USD cap inside generateDocuments may stop the
 * whole run (GenerationLimitError) — reported, not thrown.
 */
export async function runAutoDraft(
  db: Kysely<Database>,
  llm: Llm,
  opts?: {
    candidates?: AutoDraftCandidate[];
    /** Test/alternative-deployment hooks forwarded to generateDocuments. */
    master?: MasterProfileLike;
    loadIdentity?: () => RenderIdentity | null;
  },
): Promise<AutoDraftSummary> {
  const candidates = opts?.candidates ?? (await selectAutoDraftCandidates(db));
  const summary: AutoDraftSummary = { considered: candidates.length, drafted: 0, skipped: 0, errors: 0 };
  for (const candidate of candidates) {
    try {
      const { artifacts } = await generateDocuments(db, llm, candidate.jobId, ['resume', 'cover_letter'], {
        autodraft: true,
        ...(opts?.master !== undefined ? { master: opts.master } : {}),
        ...(opts?.loadIdentity !== undefined ? { loadIdentity: opts.loadIdentity } : {}),
      });
      if (artifacts.length > 0) {
        summary.drafted += 1;
      } else {
        summary.skipped += 1; // budget stopped mid-run
      }
    } catch (error) {
      if (error instanceof GenerationLimitError) {
        summary.skipped += 1;
        break; // USD cap reached — stop the batch for today
      }
      if (error instanceof JobNotEligibleError) {
        summary.skipped += 1;
        continue;
      }
      summary.errors += 1;
      console.error(`[auto-draft] job ${candidate.jobId} failed:`, error instanceof Error ? error.message : error);
    }
  }
  return summary;
}
