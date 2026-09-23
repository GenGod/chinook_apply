import { z } from 'zod';
import type { Llm, LlmResult } from './gateway.js';
import type { ProfileSummary } from './profile-context.js';

export const SCORING_PROMPT_VERSION = 'v3';

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

WORK AUTHORIZATION EVALUATION (the candidate requires employer-sponsored work authorization):
- HARD FAIL (score below 20): Posting explicitly requires "Canadian citizenship", "Permanent Resident status", or "must be a Canadian citizen/PR" with NO mention of sponsorship, LMIA, or work-permit support.
- POSITIVE BONUS: Posting explicitly states sponsorship/LMIA support is available, mentions "we sponsor", "visa sponsorship offered", "LMIA supported", "relocation assistance with work permit", or mentions provincial nomination programs (PNP/AINP/OINP etc).
- NEUTRAL (no adjustment): Posting says "eligible to work in Canada" or "must have valid work permit" (this INCLUDES work-permit holders — the candidate could qualify if they get a permit through sponsorship).
- SLIGHT RISK (note in risks, no score penalty): Posting does not mention work authorization at all — this is common and should NOT reduce the score significantly. Add a brief risk note only.

Do NOT penalize jobs for not mentioning sponsorship — many employers simply don't state it but are open to it. Only hard-fail jobs that explicitly EXCLUDE non-citizens/PRs.

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
**Work Authorization:** ${profile.workAuthorization}

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
