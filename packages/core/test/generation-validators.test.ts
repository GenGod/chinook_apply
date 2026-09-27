import { describe, it, expect } from 'vitest';
import { extractEntities, validateResumeDiff } from '../src/generation-validators.js';

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
