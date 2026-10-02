// S11: deterministic superprofile merge (B-002 p.2). Pure code, no LLM —
// the same discipline as assembleResume (S5): the model extracts facts, CODE
// decides what enters the proposed master. Conflicting facts (same employer+
// start, divergent details) NEVER enter the proposal — they surface as a
// decision queue for the PO. identity/search_config pass through untouched
// (Constitution 2.3: automation does not edit identity).
// S24: career-track derivation (B-002 p.3) — tracks are a DETERMINISTIC
// regrouping of provenance facts (one per experience; skills from its
// technology list + skill facts named in its bullets). No invention.
import type { ProfileFactRow } from './profile-store';

export type SuperprofileDiffOp =
  | 'add_skill'
  | 'add_experience'
  | 'add_education'
  | 'add_certification'
  | 'new_category'
  | 'add_track'
  | 'conflict';

export interface SuperprofileDiffEntry {
  op: SuperprofileDiffOp;
  line: string;
  factIds: string[];
  excerpts: string[];
}

export interface SuperprofileProposal {
  proposed: Record<string, unknown>;
  diff: SuperprofileDiffEntry[];
}

export interface CareerTrack {
  id: string;
  title: string;
  skills: string[];
}

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim();

interface SkillPayload {
  category: string;
  name: string;
}
interface ExperiencePayload {
  employer: string;
  title: string;
  start: string;
  end: string | null;
  bullets: string[];
  technology?: string[];
}
interface EducationPayload {
  degree: string;
  institution: string;
  year?: number | string;
}
interface CertificationPayload {
  name: string;
  issuer?: string;
  year?: number | string;
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return v != null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

/**
 * Merges extracted facts into a proposal for the next master version.
 * Dedupe keys: skill=name, experience=employer+start, education=degree+
 * institution, certification=name. Everything else is an addition; key
 * matches with divergent payloads become conflicts.
 */
export function buildSuperprofileProposal(
  masterRaw: Record<string, unknown>,
  facts: ProfileFactRow[],
): SuperprofileProposal {
  const proposed: Record<string, unknown> = structuredClone(masterRaw);
  const diff: SuperprofileDiffEntry[] = [];

  // --- skills ---
  const skills = asRecord(proposed.skills) ?? {};
  const knownSkills = new Set<string>();
  for (const list of Object.values(skills)) {
    if (!Array.isArray(list)) continue;
    for (const s of list) if (typeof s === 'string') knownSkills.add(norm(s));
  }

  // --- experience keys ---
  const experience = Array.isArray(proposed.experience) ? [...proposed.experience] : [];
  const expIndex = new Map<string, Record<string, unknown>>();
  for (const e of experience) {
    const rec = asRecord(e);
    if (!rec) continue;
    expIndex.set(expKey(String(rec.employer ?? ''), String(rec.start ?? '')), rec);
  }

  // --- education keys ---
  const education = Array.isArray(proposed.education) ? [...proposed.education] : [];
  const eduKeys = new Set<string>();
  for (const e of education) {
    const rec = asRecord(e);
    if (!rec) continue;
    eduKeys.add(eduKey(String(rec.degree ?? ''), String(rec.institution ?? '')));
  }

  const certifications = Array.isArray(proposed.certifications) ? [...(proposed.certifications as unknown[])] : [];
  const certKeys = new Set<string>(certifications.map((c) => norm(String((asRecord(c) ?? { name: c }).name ?? c))));

  for (const fact of facts) {
    const payload = asRecord(fact.payload);
    if (!payload) continue;

    if (fact.kind === 'skill') {
      const p = payload as unknown as SkillPayload;
      if (typeof p.name !== 'string' || typeof p.category !== 'string') continue;
      if (knownSkills.has(norm(p.name))) continue;
      const category = p.category.trim();
      const isNewCategory = !(category in skills);
      if (isNewCategory) {
        skills[category] = [];
        diff.push({
          op: 'new_category',
          line: `new skill category "${category}"`,
          factIds: [fact.id],
          excerpts: [fact.excerpt],
        });
      }
      const list = skills[category];
      if (!Array.isArray(list)) continue;
      list.push(p.name);
      knownSkills.add(norm(p.name));
      diff.push({
        op: 'add_skill',
        line: `${p.name} → ${category}`,
        factIds: [fact.id],
        excerpts: [fact.excerpt],
      });
      continue;
    }

    if (fact.kind === 'experience') {
      const p = payload as unknown as ExperiencePayload;
      if (typeof p.employer !== 'string' || typeof p.title !== 'string' || typeof p.start !== 'string') continue;
      const key = expKey(p.employer, p.start);
      const existingRec = expIndex.get(key);
      if (existingRec) {
        const diverges =
          norm(String(existingRec.title ?? '')) !== norm(p.title) ||
          String(existingRec.end ?? '') !== String(p.end ?? '');
        if (diverges) {
          diff.push({
            op: 'conflict',
            line: `experience "${p.employer}" (${p.start}): existing "${String(existingRec.title)}" vs fact "${p.title}"`,
            factIds: [fact.id],
            excerpts: [fact.excerpt],
          });
        }
        continue; // same key, same shape → duplicate, nothing to add
      }
      const entry = {
        id: `${norm(p.employer).replace(/[^a-z0-9]+/g, '-').slice(0, 24)}:${p.employer}`,
        employer: p.employer,
        title: p.title,
        start: p.start,
        end: p.end ?? null,
        bullets: Array.isArray(p.bullets) ? p.bullets : [],
        ...(Array.isArray(p.technology) ? { technology: p.technology } : {}),
      };
      experience.push(entry);
      expIndex.set(key, entry as unknown as Record<string, unknown>);
      diff.push({
        op: 'add_experience',
        line: `${p.employer} — ${p.title} (${p.start})`,
        factIds: [fact.id],
        excerpts: [fact.excerpt],
      });
      continue;
    }

    if (fact.kind === 'education') {
      const p = payload as unknown as EducationPayload;
      if (typeof p.degree !== 'string' || typeof p.institution !== 'string') continue;
      const key = eduKey(p.degree, p.institution);
      if (eduKeys.has(key)) continue;
      eduKeys.add(key);
      const entry: Record<string, unknown> = { degree: p.degree, institution: p.institution };
      if (p.year !== undefined) entry.year = p.year;
      education.push(entry);
      diff.push({
        op: 'add_education',
        line: `${p.degree}, ${p.institution}`,
        factIds: [fact.id],
        excerpts: [fact.excerpt],
      });
      continue;
    }

    if (fact.kind === 'certification') {
      const p = payload as unknown as CertificationPayload;
      if (typeof p.name !== 'string') continue;
      const key = norm(p.name);
      if (certKeys.has(key)) continue;
      certKeys.add(key);
      const entry: Record<string, unknown> = { name: p.name };
      if (p.issuer !== undefined) entry.issuer = p.issuer;
      if (p.year !== undefined) entry.year = p.year;
      certifications.push(entry);
      diff.push({
        op: 'add_certification',
        line: p.name,
        factIds: [fact.id],
        excerpts: [fact.excerpt],
      });
      continue;
    }

    // summary facts: intentionally NOT applied (spec R5) — they stay in the
    // fact store as candidate summaries for a manual PO decision.
  }

  proposed.skills = skills;
  proposed.experience = experience;
  proposed.education = education;
  if (certifications.length > 0) proposed.certifications = certifications;
  proposed.version = (typeof masterRaw.version === 'number' ? masterRaw.version : 1) + 1;
  proposed.updated_at = new Date().toISOString().slice(0, 10);
  return { proposed, diff };
}

function expKey(employer: string, start: string): string {
  return `${norm(employer)}|${start.slice(0, 4)}`;
}

function eduKey(degree: string, institution: string): string {
  return `${norm(degree)}|${norm(institution)}`;
}

// --- S24: career tracks (B-002 p.3) ---

/**
 * Derives career tracks from experience + skill facts: one track per
 * experience fact; the track's skills are the experience's technology list
 * plus every skill fact whose name appears in that experience's bullets.
 * Tracks already present in the master (by id) are kept untouched. Pure
 * regrouping of provenance facts — no invention.
 */
export function buildTracksProposal(
  masterRaw: Record<string, unknown>,
  facts: ProfileFactRow[],
): SuperprofileProposal {
  const proposed: Record<string, unknown> = structuredClone(masterRaw);
  const diff: SuperprofileDiffEntry[] = [];

  const experienceFacts = facts.filter((f) => f.kind === 'experience');
  const skillFacts = facts
    .filter((f) => f.kind === 'skill')
    .map((f) => {
      const payload = asRecord(f.payload) as { name?: unknown } | null;
      const name = typeof payload?.name === 'string' ? payload.name : null;
      return name ? { fact: f, name, key: norm(name) } : null;
    })
    .filter((s): s is { fact: ProfileFactRow; name: string; key: string } => s !== null);

  const existingTracks = Array.isArray(proposed.tracks)
    ? [...(proposed.tracks as Array<Record<string, unknown>>)]
    : [];
  const trackIds = new Set(existingTracks.map((t) => norm(String(t.id ?? ''))));

  for (const exp of experienceFacts) {
    const payload = asRecord(exp.payload);
    if (!payload) continue;
    const employer = typeof payload.employer === 'string' ? payload.employer : '';
    const title = typeof payload.title === 'string' ? payload.title : '';
    if (employer === '' || title === '') continue;

    const id = slugId(employer);
    if (trackIds.has(norm(id))) continue; // existing track kept as-is
    trackIds.add(norm(id));

    const bullets = Array.isArray(payload.bullets)
      ? payload.bullets.filter((b): b is string => typeof b === 'string')
      : [];
    const bulletText = norm(bullets.join(' '));
    const tech = Array.isArray(payload.technology)
      ? payload.technology.filter((t): t is string => typeof t === 'string')
      : [];

    const skills: string[] = [];
    const seen = new Set<string>();
    for (const skill of [...tech, ...skillFacts.filter((s) => bulletText.includes(s.key)).map((s) => s.name)]) {
      const key = norm(skill);
      if (seen.has(key)) continue;
      seen.add(key);
      skills.push(skill);
    }

    existingTracks.push({ id, title, skills });
    diff.push({
      op: 'add_track',
      line: `${title} @ ${employer} · ${skills.length} skills`,
      factIds: [exp.id],
      excerpts: [exp.excerpt],
    });
  }

  if (existingTracks.length > 0) proposed.tracks = existingTracks;
  proposed.version = (typeof masterRaw.version === 'number' ? masterRaw.version : 1) + 1;
  proposed.updated_at = new Date().toISOString().slice(0, 10);
  return { proposed, diff };
}

function slugId(employer: string): string {
  return norm(employer).replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}
