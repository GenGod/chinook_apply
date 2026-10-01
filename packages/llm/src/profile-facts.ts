// S11: fact extraction prompt + zod schema for multi-resume ingest (B-002 p.1).
// The LLM NEVER writes the profile — it emits atomic facts, each anchored to a
// VERBATIM excerpt of the source text; the provenance gate (web ingest service)
// verifies excerpt ⊆ document text before anything is stored.
import { z } from 'zod';

export const FACTS_PROMPT_VERSION = 'v1';

const excerpt = z.string().min(10).max(800);

const SkillPayload = z.object({ category: z.string().min(2).max(40), name: z.string().min(1).max(60) });

const ExperiencePayload = z.object({
  employer: z.string().min(2).max(120),
  title: z.string().min(2).max(120),
  start: z.string().min(4).max(10), // YYYY or YYYY-MM
  end: z.string().min(4).max(10).nullable(),
  bullets: z.array(z.string().min(10).max(300)).max(12),
  technology: z.array(z.string().min(1).max(40)).max(20).optional(),
});

const EducationPayload = z.object({
  degree: z.string().min(2).max(160),
  institution: z.string().min(2).max(160),
  year: z.union([z.number().int().min(1950).max(2100), z.string().max(10)]).optional(),
});

const CertificationPayload = z.object({
  name: z.string().min(2).max(160),
  issuer: z.string().max(120).optional(),
  year: z.union([z.number().int().min(1950).max(2100), z.string().max(10)]).optional(),
});

const SummaryPayload = z.object({ text: z.string().min(50).max(1200) });

export const ProfileFactsSchema = z.object({
  facts: z
    .array(
      z.union([
        z.object({ kind: z.literal('skill'), payload: SkillPayload, excerpt }),
        z.object({ kind: z.literal('experience'), payload: ExperiencePayload, excerpt }),
        z.object({ kind: z.literal('education'), payload: EducationPayload, excerpt }),
        z.object({ kind: z.literal('certification'), payload: CertificationPayload, excerpt }),
        z.object({ kind: z.literal('summary'), payload: SummaryPayload, excerpt }),
      ]),
    )
    .min(1)
    .max(150),
});

export type ProfileFacts = z.infer<typeof ProfileFactsSchema>;
export type ExtractedFact = ProfileFacts['facts'][number];

const MAX_DOC_CHARS = 18_000;

/** System+user pair for flash-role fact extraction from one resume document. */
export function buildFactExtractionPrompt(documentText: string): { system: string; user: string } {
  const system = [
    'You are a meticulous resume fact extractor. You receive the plain text of one resume document.',
    'Extract ATOMIC facts a job-application profile can be built from. Categories:',
    '- skill: a technology/tool/language the candidate used (payload: category from languages|frontend|backend|data_and_cloud|quality|platform_and_ai when clear, otherwise the closest sensible label; name as written).',
    '- experience: one employment entry (employer, title, start YYYY or YYYY-MM, end or null when current, bullets copied/condensed from the document, technology list when present).',
    '- education: one degree/diploma (degree, institution, year when stated).',
    '- certification: one certification (name, issuer/year when stated).',
    '- summary: a professional summary sentence PARAGRAPH present in the document.',
    'HARD RULES:',
    '1. Only facts present in the document. NEVER invent, infer, or embellish employers, dates, titles, numbers or skills.',
    '2. For EVERY fact set "excerpt" to a SHORT passage copied VERBATIM (character-for-character) from the document text that proves the fact. Excerpts are checked mechanically; a mismatch discards the fact.',
    '3. Do not merge different employers or periods into one experience fact.',
    '4. Output facts in document order.',
    'OUTPUT SHAPE — every fact object MUST use exactly these keys: "kind" (one of skill|experience|education|certification|summary), "payload" (the structured object for that kind), "excerpt" (verbatim quote).',
    'Example: {"facts":[{"kind":"skill","payload":{"category":"languages","name":"TypeScript"},"excerpt":"Skills: TypeScript, React"}]}',
    `Respond as JSON matching the schema. ${FACTS_PROMPT_VERSION}`,
  ].join('\n');

  const user = `DOCUMENT TEXT:\n${documentText.slice(0, MAX_DOC_CHARS)}${documentText.length > MAX_DOC_CHARS ? '\n[truncated]' : ''}`;
  return { system, user };
}
