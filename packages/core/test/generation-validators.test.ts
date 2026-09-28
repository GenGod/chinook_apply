import { describe, it, expect } from 'vitest';
import {
  extractEntities,
  validateResumeDiff,
  assembleResume,
  validateCoverLetter,
  UnknownReferenceError,
} from '../src/generation-validators.js';

const master = {
  summary: 'Engineer with 11 years experience',
  skills: { languages: ['TypeScript', 'C#'], frontend: ['React 19'] },
  experience: [
    { id: 'voki', employer: 'Voki Labs', title: 'Senior Engineer', start: '2020-03', end: 'present',
      bullets: ['Owned platform serving 40k users', 'Cut latency by 35%'], technology: ['React'] },
  ],
  education: [],
};

const validDiff = {
  summary: 'Engineer with 11 years experience building platforms',
  skills_order: ['TypeScript', 'React 19'],
  bullets: [{ experience_id: 'voki', bullet_index: 1, rephrase: 'Reduced latency by 35% across the platform' }],
  keywords: ['latency'],
};

describe('extractEntities', () => {
  it('collects numbers and known employers, normalized', () => {
    expect(extractEntities('Serving 40k users at Voki Labs since 2020', ['Voki Labs', 'Acme']))
      .toEqual(['40', '2020', 'voki labs']);
  });
  it('is case-insensitive on employers', () => {
    expect(extractEntities('worked at VOKI LABS', ['Voki Labs'])).toEqual(['voki labs']);
  });
});

describe('validateResumeDiff', () => {
  it('accepts a valid diff', () => {
    expect(validateResumeDiff(master, validDiff).valid).toBe(true);
  });
  it('unknown_experience when experience_id not in master', () => {
    const r = validateResumeDiff(master, { ...validDiff, bullets: [{ experience_id: 'nope', bullet_index: 0 }] });
    expect(r.violations.map(v => v.kind)).toContain('unknown_experience');
  });
  it('unknown_bullet on out-of-range index', () => {
    const r = validateResumeDiff(master, { ...validDiff, bullets: [{ experience_id: 'voki', bullet_index: 9 }] });
    expect(r.violations.map(v => v.kind)).toContain('unknown_bullet');
  });
  it('unknown_skill on skill not in master', () => {
    const r = validateResumeDiff(master, { ...validDiff, skills_order: ['Golang'] });
    expect(r.violations.map(v => v.kind)).toContain('unknown_skill');
  });
  it('entity_mismatch when rephrase changes a number', () => {
    const r = validateResumeDiff(master, { ...validDiff,
      bullets: [{ experience_id: 'voki', bullet_index: 1, rephrase: 'Cut latency by 45%' }] });
    expect(r.violations.map(v => v.kind)).toContain('entity_mismatch');
  });
  it('entity_mismatch when rephrase introduces new employer not in bullet', () => {
    const r = validateResumeDiff(master, { ...validDiff,
      bullets: [{ experience_id: 'voki', bullet_index: 1, rephrase: 'Cut latency by 35% at Acme Corp' }] });
    expect(r.violations.map(v => v.kind)).toContain('entity_mismatch');
  });
  it('summary_entity when summary invents a year', () => {
    const r = validateResumeDiff(master, { ...validDiff, summary: 'Engineer since 1999' });
    expect(r.violations.map(v => v.kind)).toContain('summary_entity');
  });
});

const master2 = {
  summary: 'Engineer with 11 years experience',
  skills: { languages: ['TypeScript', 'C#'], frontend: ['React 19'], backend: ['Node.js'] },
  experience: [
    { id: 'voki', employer: 'Voki Labs', title: 'Senior Engineer', start: '2020-03', end: 'present',
      bullets: ['Owned platform serving 40k users', 'Cut latency by 35%'], technology: ['React'] },
    { id: 'acme', employer: 'Acme Corp', title: 'Engineer', start: '2017-01', end: '2020-02',
      bullets: ['Built REST APIs', 'Mentored 3 juniors'] },
  ],
  education: [{ degree: 'BSc' }],
};

const diff2 = {
  summary: 'Engineer with 11 years experience building platforms',
  skills_order: ['React 19', 'TypeScript'],
  bullets: [
    { experience_id: 'acme', bullet_index: 1, rephrase: 'Mentored 3 junior engineers' },
    { experience_id: 'voki', bullet_index: 1 },
    { experience_id: 'voki', bullet_index: 0, rephrase: 'Owned platform serving 40k users across regions' },
  ],
  keywords: ['platforms'],
};

describe('assembleResume', () => {
  it('assembles valid diff: skills reordered, rephrase substituted, bullets in diff order grouped by experience', () => {
    expect(assembleResume(master2, diff2)).toEqual({
      summary: 'Engineer with 11 years experience building platforms',
      keywords: ['platforms'],
      skills: ['React 19', 'TypeScript', 'C#', 'Node.js'],
      experience: [
        { employer: 'Voki Labs', title: 'Senior Engineer', start: '2020-03', end: 'present', technology: ['React'],
          bullets: ['Cut latency by 35%', 'Owned platform serving 40k users across regions'] },
        { employer: 'Acme Corp', title: 'Engineer', start: '2017-01', end: '2020-02', technology: [],
          bullets: ['Mentored 3 junior engineers'] },
      ],
      education: [{ degree: 'BSc' }],
    });
  });
  it('throws UnknownReferenceError on unknown experience_id', () => {
    expect(() => assembleResume(master2, { ...diff2, bullets: [{ experience_id: 'nope', bullet_index: 0 }] }))
      .toThrow(UnknownReferenceError);
  });
  it('throws UnknownReferenceError on out-of-range bullet_index', () => {
    expect(() => assembleResume(master2, { ...diff2, bullets: [{ experience_id: 'voki', bullet_index: 9 }] }))
      .toThrow(UnknownReferenceError);
  });
  it('throws UnknownReferenceError on unknown skill in skills_order', () => {
    expect(() => assembleResume(master2, { ...diff2, skills_order: ['Golang'] })).toThrow(UnknownReferenceError);
  });
});

const job = { title: 'Senior Engineer', employer: 'Voki Labs', description: 'Build scalable platforms with TypeScript and React.' };
const fillerWords = (n: number) => Array.from({ length: n }, () => 'word').join(' ');
const validLetterBody = [
  'Applying for the Senior Engineer position at Voki Labs.',
  'Since 2020 I have built platforms at Voki Labs, cutting latency by 35% while serving 40k users.',
  'I would welcome the opportunity to discuss my application and how my experience aligns with the requirements of this role.',
].join(' ');
const validLetter = validLetterBody + ' ' + fillerWords(120 - validLetterBody.trim().split(/\s+/).length);

describe('validateCoverLetter', () => {
  it('accepts a valid 120-word letter', () => {
    expect(validLetter.trim().split(/\s+/).length).toBe(120);
    const r = validateCoverLetter(validLetter, master, job);
    expect(r.valid).toBe(true);
    expect(r.violations).toEqual([]);
  });
  it('word_limit at 301 words but not at 300', () => {
    const over = validateCoverLetter(fillerWords(301), master, job);
    expect(over.violations.map(v => v.kind)).toContain('word_limit');
    const exact = validateCoverLetter(fillerWords(300), master, job);
    expect(exact.violations.map(v => v.kind)).not.toContain('word_limit');
    expect(exact.valid).toBe(true);
  });
  it('year_not_in_sources on a 4-digit year absent from master and job', () => {
    const r = validateCoverLetter('Since 2035 I have wanted to join Voki Labs.', master, job);
    expect(r.violations).toContainEqual({ kind: 'year_not_in_sources', detail: '2035' });
  });
  it('unknown_entity on an employer name not in master or job', () => {
    const r = validateCoverLetter(
      'I am applying for the Senior Engineer role at Voki Labs, having also worked at Acme Corp.',
      master, job);
    expect(r.violations).toContainEqual({ kind: 'unknown_entity', detail: 'Acme Corp' });
  });
  it('forbidden_pattern on salary expectations', () => {
    const r = validateCoverLetter('My salary expectation is flexible for the right role at Voki Labs.', master, job);
    expect(r.violations.map(v => v.kind)).toContain('forbidden_pattern');
  });
  it('forbidden_pattern on negativity about a past employer', () => {
    const r = validateCoverLetter('I left because of a terrible manager at Voki Labs.', master, job);
    expect(r.violations.map(v => v.kind)).toContain('forbidden_pattern');
  });
  it('does not flag benign "negotiation skills" as forbidden_pattern', () => {
    const r = validateCoverLetter(
      'I bring strong negotiation skills and would love to join Voki Labs as a Senior Engineer.',
      master, job);
    expect(r.violations.map(v => v.kind)).not.toContain('forbidden_pattern');
    expect(r.valid).toBe(true);
  });
  it('accepts a standard Dear salutation without flagging it as an unknown entity', () => {
    const r = validateCoverLetter('Dear Hiring Manager,\n\n' + validLetter, master, job);
    expect(r.valid).toBe(true);
  });
});
