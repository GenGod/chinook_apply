import { describe, it, expect } from 'vitest';
import { extractEmailCandidates, buildDispatchEmail } from '../src/dispatch.js';
import type { RenderIdentity } from '../src/render-model.js';

// Synthetic fixtures only — no real PII (Constitution 3.2).

const identity: RenderIdentity = { fullName: 'Alex Fixture', email: 'alex.fixture@example.com' };

describe('extractEmailCandidates', () => {
  it('extracts mailto: addresses first, then bare addresses, deduped in order', () => {
    const raw = {
      fullDescription: 'Apply online or E-mail: <a href="mailto:jobs@fixture.example">jobs@fixture.example</a>. CC: hr@fixture.example',
      summary: { '#text': 'backup mail jobs@fixture.example or careers@other.example' },
    };
    expect(extractEmailCandidates(raw)).toEqual([
      'jobs@fixture.example',
      'hr@fixture.example',
      'careers@other.example',
    ]);
  });

  it('returns [] for non-object raw and raw without emails', () => {
    expect(extractEmailCandidates(null)).toEqual([]);
    expect(extractEmailCandidates('string')).toEqual([]);
    expect(extractEmailCandidates({ description: 'no contacts here' })).toEqual([]);
  });

  it('scans fullDescription, summary text and description string fields', () => {
    expect(extractEmailCandidates({ description: 'send to apply@fixture.example please' })).toEqual([
      'apply@fixture.example',
    ]);
    expect(extractEmailCandidates({ summary: { '#text': 'mail: team@corp.example' } })).toEqual([
      'team@corp.example',
    ]);
  });
});

describe('buildDispatchEmail', () => {
  const job = { title: 'Senior Developer', employer: 'Fixture Corp' };

  it('builds subject with title and name, body from cover letter paragraphs', () => {
    const email = buildDispatchEmail(job, identity, 'Dear Hiring Manager,\n\nI am applying for the Senior Developer role.\n\nThank you.');
    expect(email.subject).toBe('Application for Senior Developer — Alex Fixture');
    expect(email.text.split('\n\n')).toEqual([
      'Dear Hiring Manager,',
      'I am applying for the Senior Developer role.',
      'Thank you.',
    ]);
  });

  it('falls back to a deterministic note when no cover letter exists', () => {
    const email = buildDispatchEmail(job, identity, null);
    expect(email.subject).toBe('Application for Senior Developer — Alex Fixture');
    expect(email.text).toContain('I am applying for the Senior Developer role at Fixture Corp.');
    expect(email.text).toContain('Alex Fixture');
    // deterministic: same inputs → same bytes
    expect(buildDispatchEmail(job, identity, null).text).toBe(email.text);
  });

  it('throws when identity has no full name', () => {
    expect(() => buildDispatchEmail(job, { fullName: '' }, null)).toThrow();
  });
});
