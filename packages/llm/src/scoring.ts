import { z } from 'zod';
import type { Llm, LlmResult } from './gateway.js';
import type { ProfileSummary } from './profile-context.js';

export const SCORING_PROMPT_VERSION = 'v1';

export const MatchScoreSchema = z.object({
  score: z.number().min(0).max(100).int(),
  reasons: z.array(z.string().min(1)).min(1).max(5),
  risks: z.array(z.string()).max(3).default([]),
  noc_guess: z.string().nullable().default(null),
});
export type MatchScore = z.infer<typeof MatchScoreSchema>;

export interface ScoringJob {
  title: string;
  employer: string;
  location: string;
  salaryMin: number | null;
  salaryMax: number | null;
  description?: string;
}

/** Builds the system/user prompt pair for match_llm (S4 R1). */
export function buildScoringPrompt(profile: ProfileSummary, job: ScoringJob): { system: string; user: string } {
  const system = `You are an expert technical recruiter evaluating job postings against a candidate profile. Score the match from 0 (completely irrelevant) to 100 (perfect match). Consider: skills overlap, seniority alignment, domain relevance, location fit, and growth potential.

Respond with STRICTLY valid JSON matching this schema:
{"score": <integer 0-100>, "reasons": [<3-5 concise strings explaining the score>], "risks": [<0-3 strings noting concerns>], "noc_guess": "<best NOC 2021 code guess, e.g. '21231'>" or null}

Prompt version: ${SCORING_PROMPT_VERSION}`;

  const salary =
    job.salaryMin !== null && job.salaryMax !== null
      ? `$${Math.round(job.salaryMin / 1000)}k–$${Math.round(job.salaryMax / 1000)}k/yr`
      : job.salaryMin !== null
        ? `$${Math.round(job.salaryMin / 1000)}k+/yr`
        : 'not stated';

  const user = `## Candidate Profile
**Summary:** ${profile.summary}
**Core Skills:** ${profile.skills.join(', ')}
**Target Roles:** ${profile.targetTitles.join(', ')}
**Target NOC Codes:** ${profile.nocCodes.join(', ')}
**Location Preference:** ${profile.location}

## Job Posting
**Title:** ${job.title}
**Employer:** ${job.employer}
**Location:** ${job.location}
**Salary:** ${salary}
${job.description ? `**Description (excerpt):** ${job.description.slice(0, 500)}` : ''}

Score this match.`;

  return { system, user };
}

export async function scoreJob(
  llm: Llm,
  profile: ProfileSummary,
  job: ScoringJob,
): Promise<LlmResult<MatchScore>> {
  const { system, user } = buildScoringPrompt(profile, job);
  return llm.call<MatchScore>({
    role: 'flash',
    stage: 'match_llm',
    system,
    user,
    schema: MatchScoreSchema,
    temperature: 0,
  });
}
