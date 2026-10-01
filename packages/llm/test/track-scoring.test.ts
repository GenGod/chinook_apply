import { describe, it, expect } from 'vitest';
import { buildScoringPrompt, MatchScoreSchema, TrackAwareMatchScoreSchema, type ScoringJob } from '../src/scoring.js';
import type { CareerTrack } from '@chinook/core';

const job: ScoringJob = {
  title: 'Senior Full-Stack Developer',
  employer: 'Fixture Corp',
  location: 'Calgary, AB',
  salaryMin: null,
  salaryMax: null,
  description: 'TypeScript, React and Node.js platform work.',
};

const tracks: CareerTrack[] = [
  { id: 'voki-games', title: 'AI Engineer', skills: ['Ollama', 'LangChain'] },
  { id: 'tradingview', title: 'Frontend Infrastructure Lead', skills: ['Webpack', 'Rspack'] },
];

describe('track-aware scoring (S24 T2)', () => {
  it('prompt embeds the tracks block when tracks are passed', () => {
    const { system } = buildScoringPrompt(
      { summary: 'Engineer.', skills: ['TypeScript'], targetTitles: ['Senior Developer'], nocCodes: ['21231'], location: 'Alberta', workAuthorization: 'w' },
      job,
      tracks,
    );
    expect(system).toContain('CANDIDATE CAREER TRACKS');
    expect(system).toContain('AI Engineer');
    expect(system).toContain('Ollama');
    expect(system).toContain('Frontend Infrastructure Lead');
  });

  it('prompt has no tracks block without tracks (backward compatible)', () => {
    const { system } = buildScoringPrompt(
      { summary: 'Engineer.', skills: ['TypeScript'], targetTitles: ['Senior Developer'], nocCodes: ['21231'], location: 'Alberta', workAuthorization: 'w' },
      job,
    );
    expect(system).not.toContain('Candidate career tracks');
  });

  it('schema: best_track/track_scores optional; best_track must be one of provided ids', () => {
    const base = { score: 80, reasons: ['r'], risks: [], noc_guess: '21231' };
    expect(() => MatchScoreSchema.parse(base)).not.toThrow();
    expect(() =>
      MatchScoreSchema.parse({ ...base, best_track: 'voki-games', track_scores: [{ track_id: 'voki-games', score: 85 }] }),
    ).not.toThrow();
    // Refinement (ids-aware) — only TrackAwareMatchScoreSchema enforces membership:
    const Schema = TrackAwareMatchScoreSchema(tracks.map((t) => t.id));
    expect(() => Schema.parse({ ...base, best_track: 'unknown-id' })).toThrow();
    expect(() =>
      Schema.parse({ ...base, best_track: 'voki-games', track_scores: [{ track_id: 'other', score: 10 }] }),
    ).toThrow();
  });
});
