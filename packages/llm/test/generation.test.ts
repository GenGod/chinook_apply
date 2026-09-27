import { describe, it, expect } from 'vitest';
import {
  buildResumePrompt,
  buildCoverPrompt,
  RESUME_PROMPT_VERSION,
  COVER_PROMPT_VERSION,
  ResumeDiffSchema,
  CoverSchema,
} from '../src/generation.js';
import type { GenerationJob } from '../src/generation.js';
import type { MasterProfileLike, Violation } from '@chinook/core';

// Synthetic master profile — no real PII (G1: prompts carry professional content only).
const master: MasterProfileLike = {
  summary: 'Senior full-stack engineer with 8 years building payment and checkout platforms.',
  skills: {
    frontend: ['TypeScript', 'React'],
    backend: ['Node.js', 'PostgreSQL'],
  },
  experience: [
    {
      id: 'acme',
      employer: 'Acme Corp',
      title: 'Senior Developer',
      start: '2019-01',
      end: '2022-06',
      bullets: [
        'Reduced build times by 40 percent across 12 services.',
        'Led a team of five engineers on the checkout platform.',
      ],
      technology: ['React', 'Node.js'],
    },
    {
      id: 'globex',
      employer: 'Globex Inc',
      title: 'Developer',
      start: '2016-03',
      end: '2018-12',
      bullets: ['Migrated a legacy API to Node.js serving 2 million requests per day.'],
    },
  ],
  education: [],
};

const job: GenerationJob = {
  title: 'Senior Backend Engineer',
  employer: 'ExampleCorp',
  description: 'Building payment APIs with Node.js and PostgreSQL.',
  score: 82,
  reasons: ['Strong TypeScript overlap', 'Seniority match'],
};

const violations: Violation[] = [
  { kind: 'entity_mismatch', detail: '"built 15 services" vs "built 12 services"' },
  { kind: 'unknown_skill', detail: 'Rust' },
];

describe('buildResumePrompt (S5 AC1)', () => {
  const { system, user } = buildResumePrompt(master, job, { violations: [] });

  it('system contains role, hard constraints, JSON instruction, and version at the end', () => {
    expect(system).toContain('senior technical resume writer');
    expect(system).toContain('STRICTLY valid JSON');
    expect(system.trim().endsWith(RESUME_PROMPT_VERSION)).toBe(true);
  });

  it('system states the select/reorder/rephrase-only rule with verbatim entity preservation', () => {
    expect(system).toMatch(/select[,\s]+reorder[,\s]+(?:and\s+)?rephrase/i);
    expect(system).toMatch(/must be preserved verbatim/i);
    expect(system).toMatch(/numbers.*years.*employer names/is);
  });

  it('system forbids new employers/roles/dates/numbers/proper nouns and names the validation rejection', () => {
    expect(system).toContain('FORBIDDEN');
    expect(system).toMatch(/proper nouns?/i);
    expect(system).toMatch(/validation rejection/i);
  });

  it('system restricts the summary to facts present in the master profile', () => {
    expect(system).toMatch(/summary.*only facts.*master/is);
  });

  it('user contains master sections with indexed bullets and experience ids', () => {
    expect(user).toContain('[0]');
    expect(user).toContain('[1]');
    expect(user).toContain('- [0] Reduced build times by 40 percent across 12 services.');
    expect(user).toContain('acme');
    expect(user).toContain('globex');
    expect(user).toContain('Acme Corp');
    expect(user).toContain('Senior full-stack engineer with 8 years building payment and checkout platforms.');
  });

  it('user contains skills grouped by category', () => {
    expect(user).toContain('frontend');
    expect(user).toContain('backend');
    expect(user).toContain('TypeScript, React');
    expect(user).toContain('Node.js, PostgreSQL');
  });

  it('user contains job title, employer, description, score, and reasons', () => {
    expect(user).toContain('Senior Backend Engineer');
    expect(user).toContain('ExampleCorp');
    expect(user).toContain('Building payment APIs with Node.js and PostgreSQL.');
    expect(user).toContain('82');
    expect(user).toContain('Strong TypeScript overlap');
    expect(user).toContain('Seniority match');
  });

  it('description passes through in full up to 6000 chars (no shorter truncation)', () => {
    const full: GenerationJob = { ...job, description: 'x'.repeat(800) };
    const { user: u } = buildResumePrompt(master, full);
    expect(u).toContain('x'.repeat(800));
    const huge: GenerationJob = { ...job, description: 'x'.repeat(7000) };
    const { user: uh } = buildResumePrompt(master, huge);
    expect(uh).not.toContain('x'.repeat(6001));
  });

  it('user excludes identity and PII markers (G1: professional content only)', () => {
    expect(user).not.toMatch(/@/);
    expect(user.toLowerCase()).not.toContain('identity');
    expect(user.toLowerCase()).not.toContain('email');
  });

  it('different jobs produce different prompts (cache key separation)', () => {
    const other = buildResumePrompt(master, { ...job, title: 'Data Analyst' });
    expect(other.user).not.toEqual(user);
  });

  it('injects a PREVIOUS ATTEMPT FAILED block with each violation detail', () => {
    const { user: u } = buildResumePrompt(master, job, { violations });
    expect(u).toContain('PREVIOUS ATTEMPT FAILED');
    expect(u).toMatch(/fix exactly/i);
    expect(u).toContain('"built 15 services" vs "built 12 services"');
    expect(u).toContain('Rust');
    expect(u).toContain('entity_mismatch');
  });

  it('omits the violations block when violations are absent or empty', () => {
    expect(user).not.toContain('PREVIOUS ATTEMPT');
    const empty = buildResumePrompt(master, job, { violations: [] });
    expect(empty.user).not.toContain('PREVIOUS ATTEMPT');
  });
});

describe('buildCoverPrompt (S5 AC1)', () => {
  const { system, user } = buildCoverPrompt(master, job);

  it('system contains Canadian business tone, word limit, paragraph structure, JSON schema, and version at the end', () => {
    expect(system).toMatch(/canadian business/i);
    expect(system).toMatch(/300 words/i);
    expect(system).toMatch(/3-4 paragraphs/i);
    expect(system).toContain('STRICTLY valid JSON');
    expect(system).toContain('"letter"');
    expect(system.trim().endsWith(COVER_PROMPT_VERSION)).toBe(true);
  });

  it('system hard rules: facts only, no salary expectations, no negativity, no invented proper nouns', () => {
    expect(system).toMatch(/facts only/i);
    expect(system).toMatch(/no salary/i);
    expect(system).toMatch(/negativ/i);
    expect(system).toMatch(/proper nouns?/i);
  });

  it('user contains master content and job fields', () => {
    expect(user).toContain('Acme Corp');
    expect(user).toContain('TypeScript');
    expect(user).toContain('Senior Backend Engineer');
    expect(user).toContain('ExampleCorp');
    expect(user).toContain('Building payment APIs with Node.js and PostgreSQL.');
  });

  it('user excludes identity and PII markers (G1: professional content only)', () => {
    expect(user).not.toMatch(/@/);
    expect(user.toLowerCase()).not.toContain('identity');
  });

  it('different jobs produce different prompts (cache key separation)', () => {
    const other = buildCoverPrompt(master, { ...job, employer: 'Initech' });
    expect(other.user).not.toEqual(user);
  });

  it('injects a PREVIOUS ATTEMPT FAILED block when violations are passed', () => {
    const { user: u } = buildCoverPrompt(master, job, violations);
    expect(u).toContain('PREVIOUS ATTEMPT FAILED');
    expect(u).toMatch(/fix exactly/i);
    expect(u).toContain('Rust');
  });

  it('omits the violations block when violations are undefined or empty', () => {
    expect(user).not.toContain('PREVIOUS ATTEMPT');
    const empty = buildCoverPrompt(master, job, []);
    expect(empty.user).not.toContain('PREVIOUS ATTEMPT');
  });
});

describe('ResumeDiffSchema (S5 Контракт)', () => {
  const validDiff = {
    summary: 'Senior engineer with 8 years in payments; led five engineers; TypeScript and Node.js expert.',
    skills_order: ['TypeScript', 'Node.js', 'PostgreSQL'],
    bullets: [
      { experience_id: 'acme', bullet_index: 0 },
      { experience_id: 'acme', bullet_index: 1, rephrase: 'Directed five engineers building the checkout platform.' },
      { experience_id: 'globex', bullet_index: 0 },
    ],
    keywords: ['payments', 'platform'],
  };

  it('accepts a valid diff with all fields', () => {
    const result = ResumeDiffSchema.safeParse(validDiff);
    expect(result.success).toBe(true);
  });

  it('defaults keywords to [] when omitted', () => {
    const withoutKeywords = {
      summary: validDiff.summary,
      skills_order: validDiff.skills_order,
      bullets: validDiff.bullets,
    };
    const result = ResumeDiffSchema.parse(withoutKeywords);
    expect(result.keywords).toEqual([]);
  });

  it('rejects fewer than 3 bullets', () => {
    const result = ResumeDiffSchema.safeParse({ ...validDiff, bullets: validDiff.bullets.slice(0, 2) });
    expect(result.success).toBe(false);
  });

  it('rejects fewer than 3 skills_order entries', () => {
    const result = ResumeDiffSchema.safeParse({ ...validDiff, skills_order: ['TypeScript', 'Node.js'] });
    expect(result.success).toBe(false);
  });

  it('rejects summary below 50 and above 1200 chars', () => {
    expect(ResumeDiffSchema.safeParse({ ...validDiff, summary: 'Too short summary.' }).success).toBe(false);
    expect(ResumeDiffSchema.safeParse({ ...validDiff, summary: 's'.repeat(1201) }).success).toBe(false);
  });

  it('rejects rephrase below 20 chars', () => {
    const result = ResumeDiffSchema.safeParse({
      ...validDiff,
      bullets: [...validDiff.bullets.slice(0, 2), { experience_id: 'globex', bullet_index: 0, rephrase: 'Short one.' }],
    });
    expect(result.success).toBe(false);
  });

  it('rejects non-integer or negative bullet_index', () => {
    expect(
      ResumeDiffSchema.safeParse({ ...validDiff, bullets: [{ experience_id: 'acme', bullet_index: -1 }] }).success,
    ).toBe(false);
    expect(
      ResumeDiffSchema.safeParse({ ...validDiff, bullets: [{ experience_id: 'acme', bullet_index: 1.5 }] }).success,
    ).toBe(false);
  });

  it('rejects more than 15 keywords', () => {
    const result = ResumeDiffSchema.safeParse({ ...validDiff, keywords: Array.from({ length: 16 }, (_, i) => `k${i}`) });
    expect(result.success).toBe(false);
  });
});

describe('CoverSchema (S5 Контракт)', () => {
  it('accepts a letter of 200+ chars', () => {
    const result = CoverSchema.safeParse({ letter: 'Dear Hiring Manager, I am excited to apply. '.repeat(5) });
    expect(result.success).toBe(true);
  });

  it('rejects a letter below 200 chars', () => {
    expect(CoverSchema.safeParse({ letter: 'Too short.' }).success).toBe(false);
  });

  it('does not enforce the word limit itself (validator, not schema, owns the 300-word cap)', () => {
    const longLetter = 'word '.repeat(600);
    expect(CoverSchema.safeParse({ letter: longLetter }).success).toBe(true);
  });
});
