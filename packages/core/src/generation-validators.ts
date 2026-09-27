// S5 T2: entity extraction + resume diff fact-check validator.
// S5 T3: resume assembly + cover letter validator.
// Pure functions — no I/O, no dependencies. All data synthetic in tests.

export type ViolationKind =
  | 'unknown_experience'
  | 'unknown_bullet'
  | 'unknown_skill'
  | 'entity_mismatch'
  | 'summary_entity'
  | 'word_limit'
  | 'year_not_in_sources'
  | 'forbidden_pattern'
  | 'unknown_entity';

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

// All master text that facts in generated documents may reference.
function masterText(master: MasterProfileLike): string {
  return [master.summary, ...master.experience.flatMap(e => [e.employer, e.title, e.start, e.end, ...e.bullets, ...(e.technology ?? [])])].join(' ');
}

export function validateResumeDiff(master: MasterProfileLike, diff: ResumeDiffLike): ValidationReport {
  const employers = master.experience.map(e => e.employer);
  const allSkills = new Set(Object.values(master.skills).flat());
  const masterEntityText = masterText(master);
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

// --- S5 T3: deterministic resume assembly + cover letter validation ---

export class UnknownReferenceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnknownReferenceError';
  }
}

export interface TailoredResume {
  summary: string;
  keywords: string[];
  skills: string[];
  experience: Array<{
    employer: string;
    title: string;
    start: string;
    end: string;
    technology: string[];
    bullets: string[];
  }>;
  education: unknown[];
}

export function assembleResume(master: MasterProfileLike, diff: ResumeDiffLike): TailoredResume {
  const allSkills = Object.values(master.skills).flat();
  const seen = new Set<string>();
  const skills: string[] = [];
  for (const s of diff.skills_order) {
    if (!allSkills.includes(s)) throw new UnknownReferenceError(`unknown skill: ${s}`);
    if (!seen.has(s)) { seen.add(s); skills.push(s); }
  }
  for (const s of allSkills) {
    if (!seen.has(s)) { seen.add(s); skills.push(s); }
  }

  const bulletsByExp = new Map<string, string[]>();
  for (const b of diff.bullets) {
    const exp = master.experience.find(e => e.id === b.experience_id);
    if (!exp) throw new UnknownReferenceError(`unknown experience: ${b.experience_id}`);
    const original = exp.bullets[b.bullet_index];
    if (original === undefined) throw new UnknownReferenceError(`unknown bullet: ${b.experience_id}[${b.bullet_index}]`);
    const list = bulletsByExp.get(exp.id) ?? [];
    list.push(b.rephrase ?? original);
    bulletsByExp.set(exp.id, list);
  }

  return {
    summary: diff.summary,
    keywords: [...diff.keywords],
    skills,
    experience: master.experience.map(e => ({
      employer: e.employer,
      title: e.title,
      start: e.start,
      end: e.end,
      technology: e.technology ? [...e.technology] : [],
      bullets: bulletsByExp.get(e.id) ?? [],
    })),
    education: master.education,
  };
}

const WORD_LIMIT = 300;
const FOUR_DIGIT_YEAR = /^\d{4}$/;
const SALARY_PATTERN = /salary (expectation|requirement)|compensation (package|expectations?)|negotiat/i;
const NEGATIVE_PATTERN = /(terrible|awful|horrible) (boss|manager|employer|company)/i;
// Salutation lines ("Dear Hiring Manager,") are fixed-form politeness, not
// factual claims — excluded before employer-entity scanning.
const SALUTATION_LINE = /^\s*dear\b[^\n]*$/gim;

export function validateCoverLetter(
  letter: string,
  master: MasterProfileLike,
  job: { title: string; employer: string; description: string },
): ValidationReport {
  const violations: Violation[] = [];

  const words = letter.trim().split(/\s+/).length;
  if (words > WORD_LIMIT) violations.push({ kind: 'word_limit', detail: `${words} words > ${WORD_LIMIT}` });

  const sourceText = `${masterText(master)} ${job.title} ${job.employer} ${job.description}`;
  const sourceYears = new Set(extractEntities(sourceText, []).filter(t => FOUR_DIGIT_YEAR.test(t)));
  const letterYears = new Set(extractEntities(letter, []).filter(t => FOUR_DIGIT_YEAR.test(t)));
  for (const y of letterYears) {
    if (!sourceYears.has(y)) violations.push({ kind: 'year_not_in_sources', detail: y });
  }

  const knownEmployers = new Set(
    [...master.experience.map(e => e.employer), job.employer].map(s => s.toLowerCase()),
  );
  const sourceLower = ' ' + sourceText.toLowerCase().replace(/\s+/g, ' ') + ' ';
  const body = letter.replace(SALUTATION_LINE, ' ');
  for (const phrase of new Set(body.match(PROPER_NOUN_PHRASE) ?? [])) {
    const p = phrase.toLowerCase();
    if (knownEmployers.has(p) || sourceLower.includes(' ' + p + ' ')) continue;
    violations.push({ kind: 'unknown_entity', detail: phrase });
  }

  const forbidden = letter.match(SALARY_PATTERN) ?? letter.match(NEGATIVE_PATTERN);
  if (forbidden) violations.push({ kind: 'forbidden_pattern', detail: forbidden[0] });

  return report(violations);
}
