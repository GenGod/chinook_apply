// S5 T6: generation orchestration — tailored resume / cover letter documents via
// the LLM gateway (S3) with fact-check validation (S5 T2/T3), artifact
// persistence (S5 T5), a violations-injected retry (S5 R4) and a daily cost cap
// (mirrors scoring-batch). Runs inside the Next.js web app; the route handler
// supplies the Kysely db and the gateway instance.
//
// G1: identity/PII never enters prompts — the master profile handed to the
// prompt builders carries professional content only.
import { readFileSync } from 'node:fs';
import process from 'node:process';
import type { Kysely } from 'kysely';
import {
  saveArtifact,
  validateResumeDiff,
  validateCoverLetter,
  assembleResume,
  UnknownReferenceError,
  type ArtifactView,
  type Database,
  type MasterProfileLike,
  type Violation,
} from '@chinook/core';
import {
  buildResumePrompt,
  buildCoverPrompt,
  ResumeDiffSchema,
  CoverSchema,
  type CoverLetter,
  type GenerationJob,
  type Llm,
  type ResumeDiff,
} from '@chinook/llm';

/** HTTP 402 — today's generation spend has reached the daily cap. */
export class GenerationLimitError extends Error {
  readonly status = 402;
  constructor(message: string) {
    super(message);
    this.name = 'GenerationLimitError';
  }
}

/** HTTP 409 — job unknown or excluded by the eligibility rules. */
export class JobNotEligibleError extends Error {
  readonly status = 409;
  constructor(message: string) {
    super(message);
    this.name = 'JobNotEligibleError';
  }
}

const GENERATION_STAGES = ['generate_resume', 'generate_cover'];
const DEFAULT_DAILY_LIMIT_USD = 1.0;

// The master profile on disk is gitignored PII (Constitution art. 3) and
// `data/` is dockerignored — it is never baked into code or images. Dev default
// and the Docker layout share one convention (WORKDIR apps/web → ../.. is the
// repo root); Docker mounts data/profile read-only at exactly that path. The
// path is a static literal with NO dynamic fragments — this loader must never
// double as an arbitrary file read (its output goes into LLM prompts). Tests
// and alternative deployments pass opts.master instead.
const DEFAULT_MASTER_PATH = '../../data/profile/master_profile.json';

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((s): s is string => typeof s === 'string') : [];
}

/** Normalizes master_profile.json into MasterProfileLike; null current end becomes "Present". */
function normalizeMaster(raw: unknown): MasterProfileLike | null {
  if (raw == null || typeof raw !== 'object') return null;
  const m = raw as Record<string, unknown>;
  if (typeof m.summary !== 'string' || m.skills == null || typeof m.skills !== 'object') return null;
  const skills: Record<string, string[]> = {};
  for (const [category, list] of Object.entries(m.skills as Record<string, unknown>)) {
    const arr = asStringArray(list);
    if (arr.length > 0) skills[category] = arr;
  }
  if (!Array.isArray(m.experience)) return null;
  const experience: MasterProfileLike['experience'] = [];
  for (const e of m.experience) {
    if (e == null || typeof e !== 'object') continue;
    const entry = e as Record<string, unknown>;
    if (typeof entry.id !== 'string' || typeof entry.employer !== 'string' || typeof entry.title !== 'string') continue;
    experience.push({
      id: entry.id,
      employer: entry.employer,
      title: entry.title,
      start: typeof entry.start === 'string' ? entry.start : '',
      end: typeof entry.end === 'string' ? entry.end : 'Present',
      bullets: asStringArray(entry.bullets),
      ...(entry.technology !== undefined ? { technology: asStringArray(entry.technology) } : {}),
    });
  }
  return {
    summary: m.summary,
    skills,
    experience,
    education: Array.isArray(m.education) ? m.education : [],
  };
}

/**
 * Loads the master profile from the static repo-layout path. Returns null when
 * the file is absent/unusable (e.g. CI) — callers must then supply their own
 * master via opts.master.
 */
export function loadMasterProfile(): MasterProfileLike | null {
  try {
    return normalizeMaster(JSON.parse(readFileSync(DEFAULT_MASTER_PATH, 'utf8')));
  } catch {
    return null;
  }
}

/** Extracts description text from the raw job payload. Prefers the enriched
 *  fullDescription (jobbank posting page / adzuna details JSON-LD); falls back
 *  to the feed/API snippet capped at 2000 chars. Local copy of the scoring-batch
 *  logic — the web app must not depend on the worker package. */
function descriptionFrom(raw: unknown): string | null {
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

/** Today's generate_* spend in USD (cost rows are written by the gateway on every llm.call). */
async function todayGenerationSpendUsd(db: Kysely<Database>): Promise<number> {
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const row = await db
    .selectFrom('llm_run')
    .where('llm_run.ts', '>=', todayStart)
    .where('llm_run.stage', 'in', GENERATION_STAGES)
    .select((eb) => eb.fn.sum<number>('llm_run.cost_usd').as('total'))
    .executeTakeFirst();
  return Number(row?.total ?? 0);
}

function resolveDailyLimit(explicit?: number): number {
  if (explicit !== undefined) return explicit;
  const env = Number(process.env.GEN_DAILY_LIMIT_USD);
  if (Number.isFinite(env) && env > 0) return env;
  return DEFAULT_DAILY_LIMIT_USD;
}

function round6(usd: number): string {
  return (Math.round(usd * 1e6) / 1e6).toFixed(6);
}

function unknownRefViolation(error: UnknownReferenceError): Violation {
  if (error.message.startsWith('unknown skill')) return { kind: 'unknown_skill', detail: error.message };
  if (error.message.startsWith('unknown bullet')) return { kind: 'unknown_bullet', detail: error.message };
  return { kind: 'unknown_experience', detail: error.message };
}

interface Budget {
  canSpend(): boolean;
  addCost(usd: number): void;
}

/**
 * Runs one document kind: up to 2 llm attempts (attempt 2 re-runs with the
 * validator violations injected into the prompt). Valid → saveArtifact 'valid'
 * (resume content {diff, resume} after code assembly; cover content {letter}).
 * Both attempts invalid → saveArtifact 'invalid' with the last validation
 * report. Budget exhausted before an attempt → null (nothing saved for the
 * kind). Attempt 1 alone is never persisted as invalid.
 */
async function generateOne(
  db: Kysely<Database>,
  llm: Llm,
  master: MasterProfileLike,
  jobId: string,
  kind: 'resume' | 'cover_letter',
  genJob: GenerationJob,
  description: string,
  budget: Budget,
): Promise<ArtifactView | null> {
  const stage = kind === 'resume' ? 'generate_resume' : 'generate_cover';
  let violations: Violation[] = [];

  for (let attempt = 1; attempt <= 2; attempt += 1) {
    if (!budget.canSpend()) return null; // cap reached — stop, keep what is already saved
    const prompt =
      kind === 'resume'
        ? buildResumePrompt(master, genJob, { violations })
        : buildCoverPrompt(master, genJob, violations);
    // two call forms (not a ternary schema) so each branch keeps its own zod output type
    const result =
      kind === 'resume'
        ? await llm.call({
            role: 'main',
            stage,
            system: prompt.system,
            user: prompt.user,
            schema: ResumeDiffSchema,
            temperature: 0.2,
          })
        : await llm.call({
            role: 'main',
            stage,
            system: prompt.system,
            user: prompt.user,
            schema: CoverSchema,
            temperature: 0.2,
          });
    budget.addCost(result.usage.costUsd);

    if (kind === 'resume') {
      const diff = result.data as ResumeDiff;
      const report = validateResumeDiff(master, diff);
      if (report.valid) {
        try {
          const resume = assembleResume(master, diff);
          return await saveArtifact(db, {
            jobId,
            kind,
            status: 'valid',
            content: { diff, resume },
            validation: { valid: true, violations: [] },
            llmRunId: result.runId,
          });
        } catch (error) {
          // The assembler re-checks the same references as the validator, so
          // this is defense in depth (brief requirement): treat the attempt as
          // invalid and feed the message back as a violation.
          if (!(error instanceof UnknownReferenceError)) throw error;
          const violation = unknownRefViolation(error);
          violations = [violation];
          if (attempt === 2) {
            return await saveArtifact(db, {
              jobId,
              kind,
              status: 'invalid',
              content: { diff },
              validation: { valid: false, violations: [violation] },
              llmRunId: result.runId,
            });
          }
          continue;
        }
      }
      violations = report.violations;
      if (attempt === 2) {
        return await saveArtifact(db, {
          jobId,
          kind,
          status: 'invalid',
          content: { diff },
          validation: report,
          llmRunId: result.runId,
        });
      }
    } else {
      const letter = (result.data as CoverLetter).letter;
      const report = validateCoverLetter(letter, master, {
        title: genJob.title,
        employer: genJob.employer,
        description,
      });
      if (report.valid) {
        return await saveArtifact(db, {
          jobId,
          kind,
          status: 'valid',
          content: { letter },
          validation: { valid: true, violations: [] },
          llmRunId: result.runId,
        });
      }
      if (attempt === 2) {
        return await saveArtifact(db, {
          jobId,
          kind,
          status: 'invalid',
          content: { letter },
          validation: report,
          llmRunId: result.runId,
        });
      }
      violations = report.violations;
    }
  }
  return null; // unreachable: every loop path returns
}

/**
 * Generates tailored documents for one job, persisted as artifact versions.
 * Throws GenerationLimitError (402) before any llm.call when today's
 * generate_* spend is already at the cap; stops between attempts (returning
 * what is saved) when the cap is reached mid-run. Throws JobNotEligibleError
 * (409) for a missing or rule-excluded job.
 */
export async function generateDocuments(
  db: Kysely<Database>,
  llm: Llm,
  jobId: string,
  kinds: Array<'resume' | 'cover_letter'>,
  opts?: { dailyLimitUsd?: number; master?: MasterProfileLike },
): Promise<{ artifacts: ArtifactView[] }> {
  const limit = resolveDailyLimit(opts?.dailyLimitUsd);
  const master = opts?.master ?? loadMasterProfile();
  if (!master) {
    throw new Error(
      'Master profile unavailable: pass opts.master, or place data/profile/master_profile.json at the repo root (Docker: mount it read-only)',
    );
  }

  const job = await db
    .selectFrom('job')
    .select(['id', 'title', 'employer', 'raw', 'rule_status'])
    .where('id', '=', jobId)
    .executeTakeFirst();
  if (!job) throw new JobNotEligibleError(`job ${jobId} not found`);
  if (job.rule_status === 'excluded') {
    throw new JobNotEligibleError(`job ${jobId} is excluded by the eligibility rules`);
  }

  const spent = await todayGenerationSpendUsd(db);
  if (spent >= limit) {
    throw new GenerationLimitError(
      `daily generation spend $${round6(spent)} has reached the $${round6(limit)} cap`,
    );
  }

  const raw = (job.raw ?? {}) as Record<string, unknown>;
  const description = descriptionFrom(raw) ?? '';
  const genJob: GenerationJob = { title: job.title, employer: job.employer };
  if (description) genJob.description = description;
  const match = await db
    .selectFrom('job_match')
    .select(['score', 'reasons'])
    .where('job_id', '=', jobId)
    .orderBy('id', 'desc')
    .executeTakeFirst();
  if (match) {
    // renderJob shows reasons only alongside a score — pass both or neither (T4 note)
    genJob.score = match.score;
    genJob.reasons = Array.isArray(match.reasons) ? match.reasons.map(String) : [];
  }

  let runCost = 0;
  const artifacts: ArtifactView[] = [];
  for (const kind of kinds) {
    const saved = await generateOne(db, llm, master, jobId, kind, genJob, description, {
      canSpend: () => spent + runCost < limit,
      addCost: (usd) => {
        runCost += usd;
      },
    });
    if (saved) artifacts.push(saved);
  }
  return { artifacts };
}
