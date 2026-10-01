// S5 T4: prompt builders + zod schemas for tailored resume / cover letter generation
// (S5 R1 hybrid diff, R4 violations-injected retry). Prompt style follows scoring.ts:
// {system, user} pair, prompt version at the end of the system prompt, description
// passed through up to 6000 chars. G1 decision: identity (name, contacts, PII) never
// enters the prompts — MasterProfileLike carries professional content only.
import { z } from 'zod';
import type { CareerTrack, MasterProfileLike, Violation } from '@chinook/core';

export const RESUME_PROMPT_VERSION = 'v1';
export const COVER_PROMPT_VERSION = 'v1';

export const ResumeDiffSchema = z.object({
  summary: z.string().min(50).max(1200),
  skills_order: z.array(z.string()).min(3),
  bullets: z
    .array(
      z.object({
        experience_id: z.string(),
        bullet_index: z.number().int().min(0),
        rephrase: z.string().min(20).optional(),
      }),
    )
    .min(3),
  keywords: z.array(z.string()).max(15).default([]),
});
export type ResumeDiff = z.infer<typeof ResumeDiffSchema>;

// The 300-word cap is enforced by validateCoverLetter (packages/core), not here.
export const CoverSchema = z.object({ letter: z.string().min(200) });
export type CoverLetter = z.infer<typeof CoverSchema>;

export interface GenerationJob {
  title: string;
  employer: string;
  description?: string;
  score?: number;
  reasons?: string[];
}

// Master content shared by both prompts: summary, skills grouped by category,
// experience entries with bullets INDEXED ([0], [1], ...) so the diff can
// reference (experience_id, bullet_index). No identity/PII section (G1).
function renderMasterContent(master: MasterProfileLike): string {
  const skills = Object.entries(master.skills)
    .map(([category, list]) => `- ${category}: ${list.join(', ')}`)
    .join('\n');
  const experience = master.experience
    .map(exp => {
      const tech = exp.technology && exp.technology.length > 0 ? `\nTechnologies: ${exp.technology.join(', ')}` : '';
      const bullets = exp.bullets.map((bullet, i) => `- [${i}] ${bullet}`).join('\n');
      return `#### ${exp.id} — ${exp.title} at ${exp.employer} (${exp.start} to ${exp.end})${tech}\n${bullets}`;
    })
    .join('\n\n');
  return `## Master Profile (professional content only)

### Summary
${master.summary}

### Skills
${skills}

### Experience
${experience}`;
}

function renderJob(job: GenerationJob): string {
  let score = '';
  if (job.score !== undefined) {
    score += `\n**Match Score:** ${job.score}/100`;
    if (job.reasons && job.reasons.length > 0) {
      score += `\n**Match Reasons:**\n${job.reasons.map(reason => `- ${reason}`).join('\n')}`;
    }
  }
  return `## Job Posting
**Title:** ${job.title}
**Employer:** ${job.employer}${score}
${job.description ? `**Description (full posting text):** ${job.description.slice(0, 6000)}` : ''}`;
}

// R4 attempt 2: the retry prompt lists every validator violation to fix.
function renderViolations(violations: Violation[]): string {
  const list = violations.map(v => `- [${v.kind}] ${v.detail}`).join('\n');
  return `## PREVIOUS ATTEMPT FAILED
Your previous attempt was rejected by fact-check validation. Fix EXACTLY these violations — and change nothing else:
${list}`;
}

/** Builds the system/user prompt pair for generate_resume (S5 R1). */
export function buildResumePrompt(
  master: MasterProfileLike,
  job: GenerationJob,
  opts?: { violations?: Violation[]; track?: CareerTrack },
): { system: string; user: string } {
  // S24: track emphasis — reorder/rephrase towards the track, never invent.
  const trackBlock = opts?.track
    ? `
TRACK EMPHASIS: This job best fits the candidate's "${opts.track.title}" track. Emphasize and front-load the track's existing skills where the master content supports it: ${opts.track.skills.join(', ')}. Do not invent new skills — only reorder and rephrase existing master content to highlight these.`
    : '';
  const system = `You are a senior technical resume writer tailoring an existing master resume to a specific job posting. The final resume document is assembled by code from the master profile and your diff, then fact-checked by a validator — you never write the document itself and you never invent content.
${trackBlock}

HARD RULES (a violation causes automatic validation rejection):
- ONLY select, reorder and rephrase existing master content; you cannot add, remove or merge experience entries.
- In any rephrase, ALL numbers, years and employer names from the original bullet must be preserved verbatim — exactly as written, no rounding, no reformatting, no synonyms for proper nouns.
- Introducing new employers, roles, dates, numbers or proper nouns (company names, product names, certifications) is FORBIDDEN — every such addition triggers a validation rejection.
- The summary may use only facts present in the master profile; you may weave in keywords from the job posting, but every factual claim (numbers, years, employers, products) must come from the master.
- skills_order entries must be copied verbatim from the master profile skill lists; keywords may only contain terms that appear in the job posting.
- Do not include the candidate's name or contact details anywhere (identity is added at render time).

Respond with STRICTLY valid JSON matching this schema:
{"summary": "<50-1200 chars, tailored to the job, facts only from the master profile>", "skills_order": ["<3+ skill names copied verbatim from the master profile, most job-relevant first>"], "bullets": [{"experience_id": "<id from the profile>", "bullet_index": <0-based index of an indexed bullet>, "rephrase": "<optional, min 20 chars, keeps ALL numbers/years/employer names verbatim>"}], "keywords": ["<up to 15 terms from the job posting>"]}

Prompt version: ${RESUME_PROMPT_VERSION}`;

  const user = `${renderMasterContent(master)}

${renderJob(job)}

Produce the tailored resume diff as JSON now: select the most relevant existing bullets for this job (at least 3), order skills with the most job-relevant first, optionally rephrase selected bullets preserving ALL numbers, years and employer names verbatim, and list keywords from the job posting to weave into the summary and skills order.`;

  const violations = opts?.violations ?? [];
  return { system, user: violations.length > 0 ? `${user}\n\n${renderViolations(violations)}` : user };
}

/** Builds the system/user prompt pair for generate_cover (S5 R4). */
export function buildCoverPrompt(
  master: MasterProfileLike,
  job: GenerationJob,
  violations?: Violation[],
): { system: string; user: string } {
  const system = `You are an expert cover letter writer for the Canadian job market. Write a formal cover letter in Canadian business English for the given job posting.

HARD RULES (a violation causes automatic validation rejection):
- Formal Canadian business tone; at most 300 words; 3-4 paragraphs.
- Facts only from the provided profile and the job posting: do not invent employers, roles, dates, numbers or any proper nouns (company names, product names, certifications) — invented entities trigger a validation rejection.
- No salary expectations and no compensation discussion.
- No negativity about past employers or colleagues.
- Begin with the salutation "Dear Hiring Manager," on its own line; do not add a signature name (identity is added at render time); close with "Sincerely,".

Respond with STRICTLY valid JSON matching this schema:
{"letter": "<the full cover letter text>"}

Prompt version: ${COVER_PROMPT_VERSION}`;

  const user = `${renderMasterContent(master)}

${renderJob(job)}

Write the cover letter as JSON now.`;

  const list = violations ?? [];
  return { system, user: list.length > 0 ? `${user}\n\n${renderViolations(list)}` : user };
}
