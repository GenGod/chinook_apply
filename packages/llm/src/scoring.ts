import { z } from 'zod';
import type { Llm, LlmResult } from './gateway.js';
import type { ProfileSummary } from './profile-context.js';
import type { CareerTrack } from '@chinook/core';

export const SCORING_PROMPT_VERSION = 'v6';

export const MatchScoreSchema = z.object({
  score: z.number().min(0).max(100).int(),
  reasons: z.array(z.string().min(1)).min(1).max(8),
  risks: z.array(z.string()).max(6).default([]),
  noc_guess: z.union([z.string(), z.number()]).nullable().transform((v) => (v === null ? null : String(v))).default(null),
  // S24: track-aware scoring (optional for backward compatibility). The
  // refinement below restricts best_track to the ids actually provided.
  best_track: z.string().optional(),
  track_scores: z
    .array(z.object({ track_id: z.string(), score: z.number().min(0).max(100).int() }))
    .max(10)
    .optional(),
});
export type MatchScore = z.infer<typeof MatchScoreSchema>;

/** Refinement: with tracks in play, best_track must reference a provided id
 *  and every track_scores entry must do the same. */
export const TrackAwareMatchScoreSchema = (trackIds: string[]) =>
  MatchScoreSchema.superRefine((value, ctx) => {
    // Only validate membership when the model emitted the field — flash
    // sometimes omits best_track on sparse postings; omission is acceptable.
    if (value.best_track !== undefined && !trackIds.includes(value.best_track)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['best_track'],
        message: 'best_track must be one of the provided track ids',
      });
    }
    for (const [i, ts] of (value.track_scores ?? []).entries()) {
      if (!trackIds.includes(ts.track_id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['track_scores', i],
          message: 'track_id must be one of the provided track ids',
        });
      }
    }
  });

export interface ScoringJob {
  title: string;
  employer: string;
  location: string;
  salaryMin: number | null;
  salaryMax: number | null;
  description?: string;
}

/** Builds the system/user prompt pair for match_llm (S4 R1). Tracks (S24)
 *  optionally extend the profile: the model also picks the best-fitting track. */
export function buildScoringPrompt(profile: ProfileSummary, job: ScoringJob, tracks?: CareerTrack[]): { system: string; user: string } {
  const tracksBlock =
    tracks && tracks.length > 0
      ? `\n\nCANDIDATE CAREER TRACKS (canonical resume emphases; pick the best fit):\n${tracks
          .map((t) => `- id="${t.id}" · ${t.title} · skills: ${t.skills.slice(0, 8).join(', ')}`)
          .join('\n')}`
      : '';
  const schemaLine =
    tracks && tracks.length > 0
      ? `{"score": <integer 0-100>, "reasons": [...], "risks": [...], "noc_guess": ... or null, "best_track": "<track id above>", "track_scores": [{"track_id": "...", "score": <0-100>}]}`
      : `{"score": <integer 0-100>, "reasons": [<3-6 concise strings explaining the score>], "risks": [<0-5 strings noting concerns>], "noc_guess": "<best NOC 2021 code guess, e.g. '21231'>" or null}`;
  const system = `You are an expert technical recruiter evaluating job postings against a candidate profile. Score the match from 0 (completely irrelevant) to 100 (perfect match). Consider: skills overlap, seniority alignment, domain relevance, location fit, and growth potential.

WORK AUTHORIZATION EVALUATION (the candidate requires employer-sponsored work authorization / LMIA):
- HARD FAIL (score below 20): Posting explicitly requires "Canadian citizenship only", "must be a Canadian citizen" (without OR work permit alternative), "Permanent Resident status required" (without alternatives), or explicitly states "no sponsorship available".
- MODERATE PENALTY (reduce by 15-25 points): Posting says "must have a valid work permit" or "must be eligible to work in Canada" WITHOUT mentioning sponsorship/LMIA. The candidate doesn't yet have a work permit — they need the employer to sponsor one. This is a chicken-and-egg problem. Add risk: "Work permit required but no sponsorship mentioned — may not be obtainable without employer support".
- POSITIVE BONUS (add 5-10 points): Posting explicitly states sponsorship/LMIA support, "we sponsor visas", "work permit support provided", "LMIA offered", mentions relocation with work authorization, or mentions provincial nomination programs (PNP/AINP/OINP etc).
- NEUTRAL (no adjustment): Posting does not mention work authorization at all. Many employers don't state it. Add brief risk: "Work authorization not addressed".
- NOTE: "Must be a Canadian citizen OR PR OR have a valid work permit" = moderate penalty (not hard fail) because the work permit path exists but requires sponsorship the posting doesn't offer.

${tracksBlock}

Respond with STRICTLY valid JSON matching this schema:
${schemaLine}

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
${job.description ? `**Description (full posting text):** ${job.description.slice(0, 6000)}` : ''}

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
