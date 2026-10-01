import { describe, it, expect } from 'vitest';
import { ProfileFactsSchema, buildFactExtractionPrompt, FACTS_PROMPT_VERSION } from '../src/profile-facts.js';

describe('ProfileFactsSchema (S11 T3)', () => {
  const valid = {
    facts: [
      {
        kind: 'skill',
        payload: { category: 'languages', name: 'Go' },
        excerpt: 'Languages: Go, Rust, TypeScript',
      },
      {
        kind: 'experience',
        payload: { employer: 'Fixture Corp', title: 'Developer', start: '2020-01', end: null, bullets: ['Built things.'], technology: ['Go'] },
        excerpt: 'Fixture Corp — Developer, 2020-01: Built things.',
      },
      {
        kind: 'education',
        payload: { degree: 'B.Sc.', institution: 'Fixture University', year: 2016 },
        excerpt: 'B.Sc. from Fixture University, 2016',
      },
      {
        kind: 'certification',
        payload: { name: 'AWS Developer' },
        excerpt: 'Certified AWS Developer',
      },
      {
        kind: 'summary',
        payload: { text: 'Developer with 10 years of experience building platforms, pipelines and teams across fintech and gaming.' },
        excerpt: 'Developer with 10 years of experience.',
      },
    ],
  };

  it('accepts all five fact kinds', () => {
    expect(() => ProfileFactsSchema.parse(valid)).not.toThrow();
  });

  it('rejects malformed payloads and bad excerpts', () => {
    expect(() =>
      ProfileFactsSchema.parse({ facts: [{ kind: 'skill', payload: { category: 'x' }, excerpt: 'a'.repeat(20) }] }),
    ).toThrow(); // name missing
    expect(() =>
      ProfileFactsSchema.parse({ facts: [{ kind: 'hobby', payload: {}, excerpt: 'a'.repeat(20) }] }),
    ).toThrow(); // unknown kind
    expect(() =>
      ProfileFactsSchema.parse({ facts: [{ kind: 'summary', payload: { text: 'x' }, excerpt: 'short' }] }),
    ).toThrow(); // excerpt < 10 chars
    expect(() => ProfileFactsSchema.parse({ facts: [] })).toThrow(); // at least one
  });
});

describe('buildFactExtractionPrompt (S11 T3)', () => {
  it('embeds verbatim-excerpt rules, kinds list and the document text', () => {
    const { system, user } = buildFactExtractionPrompt('Fixture Corp — Developer. Skills: Go.');
    expect(system).toContain(FACTS_PROMPT_VERSION);
    expect(system.toLowerCase()).toContain('verbatim');
    expect(system).toContain('excerpt');
    expect(system).toContain('experience');
    expect(system).toContain('certification');
    expect(user).toContain('Fixture Corp — Developer. Skills: Go.');
  });

  it('caps very long documents', () => {
    const long = 'word '.repeat(20_000);
    const { user } = buildFactExtractionPrompt(long);
    expect(user.length).toBeLessThan(long.length + 2_000);
  });

  it('different documents produce different prompts (cache key)', () => {
    expect(buildFactExtractionPrompt('doc A').user).not.toBe(buildFactExtractionPrompt('doc B').user);
  });
});
