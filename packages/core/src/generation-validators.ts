// S5 T2: entity extraction + resume diff fact-check validator.
// Pure functions — no I/O, no dependencies. All data synthetic in tests.

export type ViolationKind =
  | 'unknown_experience'
  | 'unknown_bullet'
  | 'unknown_skill'
  | 'entity_mismatch'
  | 'summary_entity';

export interface Violation {
  kind: ViolationKind;
  detail: string;
}

export interface ValidationReport {
  valid: boolean;
  violations: Violation[];
}

export interface MasterProfileLike {
  summary: string;
  skills: Record<string, string[]>;
  experience: Array<{
    id: string;
    employer: string;
    title: string;
    start: string;
    end: string;
    bullets: string[];
    technology?: string[];
  }>;
  education: unknown[];
}

export interface ResumeDiffLike {
  summary: string;
  skills_order: string[];
  bullets: Array<{ experience_id: string; bullet_index: number; rephrase?: string }>;
  keywords: string[];
}

const NUMBER_TOKEN = /\d+(?:\.\d+)?/g;

// Employer-like proper noun phrases: two or more consecutive capitalized
// words (e.g. "Acme Corp"). Catches invented employers that are not in the
// known list. Single capitalized words are ignored (sentence starts).
const PROPER_NOUN_PHRASE = /\b[A-Z][a-z]+(?:\s+[A-Z][a-z]+)+\b/g;

export function extractEntities(text: string, knownEmployers: string[]): string[] {
  const out = new Set<string>();
  const m = text.match(NUMBER_TOKEN);
  if (m) for (const n of m) out.add(n);
  const lower = ' ' + text.toLowerCase().replace(/\s+/g, ' ') + ' ';
  for (const emp of knownEmployers) {
    if (emp.length < 3) continue;
    if (lower.includes(' ' + emp.toLowerCase() + ' ')) out.add(emp.toLowerCase());
  }
  return [...out];
}

function report(violations: Violation[]): ValidationReport {
  return { valid: violations.length === 0, violations };
}

export function validateResumeDiff(master: MasterProfileLike, diff: ResumeDiffLike): ValidationReport {
  const employers = master.experience.map(e => e.employer);
  const allSkills = new Set(Object.values(master.skills).flat());
  const masterEntityText = [master.summary, ...master.experience.flatMap(e => [e.employer, e.title, e.start, e.end, ...e.bullets, ...(e.technology ?? [])])].join(' ');
  const masterEntities = new Set(extractEntities(masterEntityText, employers));
  const violations: Violation[] = [];

  for (const b of diff.bullets) {
    const exp = master.experience.find(e => e.id === b.experience_id);
    if (!exp) { violations.push({ kind: 'unknown_experience', detail: b.experience_id }); continue; }
    const original = exp.bullets[b.bullet_index];
    if (original === undefined) { violations.push({ kind: 'unknown_bullet', detail: `${b.experience_id}[${b.bullet_index}]` }); continue; }
    if (b.rephrase !== undefined) {
      const a = extractEntities(original, employers).sort().join('|');
      const b2 = extractEntities(b.rephrase, employers).sort().join('|');
      const inventedEmployers = (b.rephrase.match(PROPER_NOUN_PHRASE) ?? [])
        .map(s => s.toLowerCase())
        .filter(s => !original.toLowerCase().includes(s));
      if (a !== b2 || inventedEmployers.length > 0) violations.push({ kind: 'entity_mismatch', detail: `"${b.rephrase.slice(0, 80)}" vs "${original.slice(0, 80)}"` });
    }
  }
  for (const s of diff.skills_order) {
    if (!allSkills.has(s)) violations.push({ kind: 'unknown_skill', detail: s });
  }
  for (const e of extractEntities(diff.summary, employers)) {
    if (!masterEntities.has(e)) violations.push({ kind: 'summary_entity', detail: e });
  }
  return report(violations);
}
