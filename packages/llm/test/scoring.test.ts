import { describe, it, expect } from 'vitest';
import { buildScoringPrompt, SCORING_PROMPT_VERSION, MatchScoreSchema } from '../src/scoring.js';
import { extractProfileSummary } from '../src/profile-context.js';
import type { ScoringJob } from '../src/scoring.js';
import type { ProfileSummary } from '../src/profile-context.js';

const profile: ProfileSummary = {
  summary: 'Senior full-stack engineer with 11 years experience',
  skills: ['TypeScript', 'React', 'Node.js', 'PostgreSQL'],
  targetTitles: ['Senior Developer', 'Lead Developer'],
  nocCodes: ['21231', '21234'],
  location: 'Alberta, Canada (open to relocation)',
};

const job: ScoringJob = {
  title: 'Senior React Developer',
  employer: 'TechCorp',
  location: 'calgary AB',
  salaryMin: 110000,
  salaryMax: 140000,
  description: 'Building modern web applications with React and TypeScript.',
};

describe('buildScoringPrompt (S4 AC1)', () => {
  const { system, user } = buildScoringPrompt(profile, job);

  it('system contains role definition, JSON schema instruction, and prompt version', () => {
    expect(system).toContain('technical recruiter');
    expect(system).toContain('STRICTLY valid JSON');
    expect(system).toContain(SCORING_PROMPT_VERSION);
  });

  it('user contains profile skills, NOC codes, and job fields', () => {
    expect(user).toContain('TypeScript');
    expect(user).toContain('21231');
    expect(user).toContain('Senior React Developer');
    expect(user).toContain('TechCorp');
    expect(user).toContain('calgary AB');
    expect(user).toContain('$110k–$140k');
  });

  it('description excerpt truncated to 500 chars', () => {
    const long: ScoringJob = { ...job, description: 'x'.repeat(800) };
    const { user: u } = buildScoringPrompt(profile, long);
    expect(u).toContain('x'.repeat(500));
    expect(u).not.toContain('x'.repeat(501));
  });

  it('different jobs produce different prompts (cache key separation)', () => {
    const other = buildScoringPrompt(profile, { ...job, title: 'Data Analyst' });
    expect(other.user).not.toEqual(user);
  });
});

describe('extractProfileSummary', () => {
  it('flattens skill categories and maps search config', () => {
    const summary = extractProfileSummary({
      summary: 'Test summary',
      skills: { frontend: ['React'], backend: ['Node.js'] },
      search_config: { noc_codes: ['21231'], target_province: 'Alberta', seniority: ['Senior', 'Lead'] },
    });
    expect(summary.skills).toContain('React');
    expect(summary.skills).toContain('Node.js');
    expect(summary.nocCodes).toEqual(['21231']);
    expect(summary.targetTitles).toContain('Senior Developer');
    expect(summary.location).toContain('Alberta');
  });
});

describe('MatchScoreSchema (S4 AC1)', () => {
  it('accepts valid score with all fields', () => {
    const result = MatchScoreSchema.safeParse({
      score: 75,
      reasons: ['Good skills overlap', 'Right location', 'Seniority match'],
      risks: ['Salary not stated'],
      noc_guess: '21231',
    });
    expect(result.success).toBe(true);
  });

  it('rejects score outside 0–100', () => {
    expect(MatchScoreSchema.safeParse({ score: 150, reasons: ['r'] }).success).toBe(false);
    expect(MatchScoreSchema.safeParse({ score: -5, reasons: ['r'] }).success).toBe(false);
  });

  it('rejects empty reasons', () => {
    expect(MatchScoreSchema.safeParse({ score: 50, reasons: [] }).success).toBe(false);
  });

  it('defaults risks and noc_guess when omitted', () => {
    const result = MatchScoreSchema.parse({ score: 50, reasons: ['r'] });
    expect(result.risks).toEqual([]);
    expect(result.noc_guess).toBeNull();
  });
});
