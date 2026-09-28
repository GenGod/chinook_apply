// S6: render model — the pure intermediate representation shared by the DOCX
// and PDF encoders. Rendering is deterministic: identical inputs produce
// identical documents, and the document text is byte-for-byte the artifact
// content from the database (no rewriting here).
//
// Identity (Constitution 3.2 / G1 of S5): the identity snapshot is stored in
// the artifact content at generation time and NEVER enters LLM prompts; these
// parsers only serve rendering of already-generated documents.
import type { TailoredResume } from './generation-validators';

export interface RenderIdentity {
  fullName: string;
  headline?: string;
  email?: string;
  location?: string;
}

export interface RenderResumeModel {
  identity: RenderIdentity;
  summary: string;
  skillGroups: Array<{ label: string; items: string[] }>;
  experience: Array<{
    title: string;
    employer: string;
    period: string;
    technology: string[];
    bullets: string[];
  }>;
  education: Array<{ line: string }>;
}

export interface RenderCoverModel {
  identity: RenderIdentity;
  paragraphs: string[];
}

/** Human labels for master skill categories (order = master order). */
const SKILL_LABELS: Record<string, string> = {
  languages: 'Languages',
  frontend: 'Frontend',
  backend: 'Backend',
  data_and_cloud: 'Data & Cloud',
  quality: 'Quality & Testing',
  platform_and_ai: 'Platform & AI',
};

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((s): s is string => typeof s === 'string') : [];
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value != null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * Skills grouped by master category (master order), tailored order within a
 * category, leftovers in a trailing "Other" group. Without masterSkills the
 * tailored order is kept as a single "Skills" group.
 */
export function groupSkills(
  tailoredSkills: string[],
  masterSkills?: Record<string, string[]>,
): Array<{ label: string; items: string[] }> {
  if (!masterSkills) {
    return tailoredSkills.length > 0 ? [{ label: 'Skills', items: [...tailoredSkills] }] : [];
  }
  const remaining = [...tailoredSkills];
  const groups: Array<{ label: string; items: string[] }> = [];
  for (const [category, label] of Object.entries(SKILL_LABELS)) {
    const items = remaining.filter((s) => (masterSkills[category] ?? []).includes(s));
    if (items.length > 0) {
      groups.push({ label, items });
      for (const s of items) remaining.splice(remaining.indexOf(s), 1);
    }
  }
  if (remaining.length > 0) groups.push({ label: 'Other', items: remaining });
  return groups;
}

function periodOf(start: string, end: string): string {
  return start && end ? `${start} — ${end}` : start || end;
}

function educationLine(entry: unknown): string | null {
  const rec = asRecord(entry);
  if (!rec) return null; // non-object garbage entries are skipped, never rendered
  const parts: string[] = [];
  const degree = typeof rec.degree === 'string' ? rec.degree : '';
  const school = typeof rec.institution === 'string' ? rec.institution : typeof rec.school === 'string' ? rec.school : '';
  if (degree && school) parts.push(`${degree} — ${school}`);
  else if (degree || school) parts.push(degree || school);
  const year = typeof rec.year === 'string' || typeof rec.year === 'number' ? String(rec.year) : '';
  if (year) parts.push(parts.length > 0 ? `· ${year}` : year);
  return parts.length > 0 ? parts.join(' ') : null;
}

export function buildResumeRenderModel(
  identity: RenderIdentity,
  resume: TailoredResume,
  masterSkills?: Record<string, string[]>,
): RenderResumeModel {
  return {
    identity: { ...identity },
    summary: resume.summary,
    skillGroups: groupSkills(resume.skills, masterSkills),
    experience: resume.experience.map((e) => ({
      title: e.title,
      employer: e.employer,
      period: periodOf(e.start, e.end),
      technology: [...e.technology],
      bullets: [...e.bullets],
    })),
    education: resume.education
      .map(educationLine)
      .filter((line): line is string => line !== null)
      .map((line) => ({ line })),
  };
}

export function buildCoverRenderModel(identity: RenderIdentity, letter: string): RenderCoverModel {
  const paragraphs = letter
    .split(/\n+/)
    .map((p) => p.trim())
    .filter((p) => p !== '');
  return { identity: { ...identity }, paragraphs };
}

/**
 * Parses the identity block of master_profile.json (raw shape). Location is
 * composed from location_constraints: "<province>, Canada[ · <relocation>]".
 * Availability and work_authorization stay off the document (S6 spec, open
 * question 1 — v1 default).
 */
export function renderIdentityFromMaster(raw: unknown): RenderIdentity | null {
  const root = asRecord(raw);
  const identity = root ? asRecord(root.identity) : null;
  if (!identity || typeof identity.full_name !== 'string' || identity.full_name.trim() === '') return null;
  const out: RenderIdentity = { fullName: identity.full_name };
  if (typeof identity.headline === 'string' && identity.headline !== '') out.headline = identity.headline;
  if (typeof identity.email === 'string' && identity.email !== '') out.email = identity.email;
  const constraints = asRecord(identity.location_constraints);
  if (constraints) {
    const parts: string[] = [];
    const province = typeof constraints.target_province === 'string' ? constraints.target_province : '';
    if (province !== '') parts.push(`${province}, Canada`);
    if (typeof constraints.relocation === 'string' && constraints.relocation !== '') {
      parts.push(constraints.relocation);
    }
    if (parts.length > 0) out.location = parts.join(' · ');
  }
  return out;
}

/**
 * Extracts the identity snapshot that S6 generation stores in artifact
 * content ({diff, resume, identity} / {letter, identity}). Returns null for
 * legacy artifacts (S5) — the caller falls back to the master file.
 */
export function renderIdentityFromContent(content: unknown): RenderIdentity | null {
  const root = asRecord(content);
  const identity = root ? asRecord(root.identity) : null;
  if (!identity || typeof identity.fullName !== 'string' || identity.fullName.trim() === '') return null;
  const out: RenderIdentity = { fullName: identity.fullName };
  if (typeof identity.headline === 'string' && identity.headline !== '') out.headline = identity.headline;
  if (typeof identity.email === 'string' && identity.email !== '') out.email = identity.email;
  if (typeof identity.location === 'string' && identity.location !== '') out.location = identity.location;
  return out;
}

// --- Untrusted content normalization (Constitution 7.1) ---
// Artifact JSONB was produced by an LLM pipeline: treat it as untrusted input
// and rebuild plain, validated render inputs instead of casting blindly.

/** Rebuilds a TailoredResume from untrusted artifact content; null when malformed. */
export function normalizeTailoredResume(content: unknown): TailoredResume | null {
  const root = asRecord(content);
  const resume = root ? asRecord(root.resume) : null;
  if (!resume) return null;
  if (typeof resume.summary !== 'string' || !Array.isArray(resume.skills) || !Array.isArray(resume.experience) || !Array.isArray(resume.education)) {
    return null;
  }
  const experience: TailoredResume['experience'] = [];
  for (const entry of resume.experience) {
    const rec = asRecord(entry);
    if (!rec) return null;
    if (typeof rec.employer !== 'string' || typeof rec.title !== 'string' || !Array.isArray(rec.bullets)) return null;
    experience.push({
      employer: rec.employer,
      title: rec.title,
      start: typeof rec.start === 'string' ? rec.start : '',
      end: typeof rec.end === 'string' ? rec.end : '',
      technology: asStringArray(rec.technology),
      bullets: asStringArray(rec.bullets),
    });
  }
  return {
    summary: resume.summary,
    keywords: asStringArray(resume.keywords),
    skills: asStringArray(resume.skills),
    experience,
    education: resume.education,
  };
}

/** Extracts the cover letter text from untrusted artifact content. */
export function normalizeLetter(content: unknown): string | null {
  const root = asRecord(content);
  const letter = root?.letter;
  return typeof letter === 'string' ? letter : null;
}
