import { describe, it, expect } from 'vitest';
import { buildSuperprofileProposal } from '../src/superprofile.js';
import type { ProfileFactRow } from '../src/profile-store.js';

// Synthetic master + facts — no real PII (Constitution 3.2).

const master = {
  version: 1,
  identity: { full_name: 'Alex Fixture' },
  search_config: { noc_codes: ['21231'] },
  summary: 'Engineer.',
  skills: { languages: ['TypeScript'] },
  experience: [
    { id: 'fx:Fixture Corp', employer: 'Fixture Corp', title: 'Developer', start: '2020-01', end: null, bullets: [], technology: [] },
  ],
  education: [{ degree: 'B.Sc.', institution: 'Fixture University', year: 2016 }],
};

function fact(id: string, kind: ProfileFactRow['kind'], payload: unknown, excerpt = 'source excerpt for the fact'): ProfileFactRow {
  return { id, sourceId: 'src1', kind, payload, excerpt, createdAt: '2026-10-01T00:00:00Z' };
}

describe('buildSuperprofileProposal (S11 T5)', () => {
  it('adds new skills (existing and new categories) and dedupes by name', () => {
    const { proposed, diff } = buildSuperprofileProposal(master, [
      fact('f1', 'skill', { category: 'languages', name: 'Go' }),
      fact('f2', 'skill', { category: 'languages', name: 'typescript' }), // dup, different case
      fact('f3', 'skill', { category: 'data_engineering', name: 'Airflow' }),
    ]);
    const skills = proposed.skills as Record<string, string[]>;
    expect(skills.languages).toEqual(['TypeScript', 'Go']);
    expect(skills.data_engineering).toEqual(['Airflow']);
    const ops = diff.map((d) => d.op);
    expect(ops).toContain('add_skill');
    expect(ops).toContain('new_category');
    expect(diff.filter((d) => d.op === 'add_skill').length).toBe(2); // Go + Airflow, not the dup
    expect(diff.find((d) => d.op === 'new_category')!.line).toContain('data_engineering');
  });

  it('adds a new experience, flags a conflicting one, skips an exact duplicate', () => {
    const { proposed, diff } = buildSuperprofileProposal(master, [
      fact('f1', 'experience', { employer: 'Other Corp', title: 'Lead', start: '2018-05', end: '2020-01', bullets: ['Led a team of five engineers.'] }),
      fact('f2', 'experience', { employer: 'Fixture Corp', title: 'SENIOR Developer', start: '2020-01', end: null, bullets: [] }), // same key, divergent title
      fact('f3', 'experience', { employer: 'Fixture Corp', title: 'Developer', start: '2020-01', end: null, bullets: [] }), // exact dup
    ]);
    const experience = proposed.experience as Array<{ employer: string; title: string }>;
    expect(experience.length).toBe(2); // original + Other Corp
    expect(experience.find((e) => e.employer === 'Other Corp')!.title).toBe('Lead');
    const conflict = diff.find((d) => d.op === 'conflict');
    expect(conflict).toBeTruthy();
    expect(conflict!.line).toContain('Fixture Corp');
    expect(diff.filter((d) => d.op === 'add_experience').length).toBe(1);
  });

  it('education and certifications: dedupe keys, create the certifications section', () => {
    const { proposed, diff } = buildSuperprofileProposal(master, [
      fact('f1', 'education', { degree: 'b.sc.', institution: 'fixture university' }), // dup key (case-insensitive)
      fact('f2', 'education', { degree: 'M.Sc.', institution: 'Other University', year: 2020 }),
      fact('f3', 'certification', { name: 'AWS Developer', issuer: 'AWS' }),
      fact('f4', 'certification', { name: 'aws developer' }), // dup
    ]);
    expect((proposed.education as unknown[]).length).toBe(2);
    expect((proposed.certifications as Array<{ name: string }>).map((c) => c.name)).toEqual(['AWS Developer']);
    expect(diff.filter((d) => d.op === 'add_education').length).toBe(1);
    expect(diff.filter((d) => d.op === 'add_certification').length).toBe(1);
  });

  it('summary facts never mutate the master summary; identity/search_config/version pass through', () => {
    const { proposed } = buildSuperprofileProposal(master, [
      fact('f1', 'summary', { text: 'A different professional summary that must not be applied automatically by the merge.' }),
    ]);
    expect(proposed.summary).toBe('Engineer.');
    expect(proposed.identity).toEqual(master.identity);
    expect(proposed.search_config).toEqual(master.search_config);
    expect(proposed.version).toBe(2);
    expect(typeof proposed.updated_at).toBe('string');
  });
});
