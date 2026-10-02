import { describe, it, expect } from 'vitest';
import { buildTracksProposal } from '../src/superprofile.js';
import type { ProfileFactRow } from '../src/profile-store.js';

// Synthetic facts — track derivation must be deterministic regrouping of
// already-provenanced facts, never invention (B-002 p.3).

function fact(id: string, kind: ProfileFactRow['kind'], payload: unknown): ProfileFactRow {
  return { id, sourceId: 'src1', kind, payload, excerpt: 'source excerpt', createdAt: '2026-10-01T00:00:00Z' };
}

const master = {
  version: 1,
  identity: { full_name: 'Alex Fixture' },
  skills: { languages: ['TypeScript'] },
  experience: [],
};

describe('buildTracksProposal (S24 T1)', () => {
  it('derives one track per experience fact from title + technology + bullet-skill intersections', () => {
    const facts = [
      fact('e1', 'experience', {
        employer: 'VOKI Games', title: 'AI Engineer', start: '2023-01', end: null,
        bullets: ['Built AI delivery pipelines with Ollama and LangChain.'],
        technology: ['Ollama', 'LangChain'],
      }),
      fact('e2', 'experience', {
        employer: 'TradingView', title: 'Frontend Infrastructure Lead', start: '2019-02', end: '2023-01',
        bullets: ['Owned build systems: Webpack and Rspack migrations.'],
        technology: ['Webpack'],
      }),
      fact('s1', 'skill', { category: 'platform_and_ai', name: 'Ollama' }),
      fact('s2', 'skill', { category: 'frontend', name: 'Rspack' }),
    ];
    const { proposed, diff } = buildTracksProposal(master, facts);

    const tracks = proposed.tracks as Array<{ id: string; title: string; skills: string[] }>;
    expect(tracks).toHaveLength(2);
    const voki = tracks.find((t) => t.id === 'voki-games')!;
    expect(voki.title).toBe('AI Engineer');
    expect(voki.skills).toContain('Ollama');     // from technology
    expect(voki.skills).toContain('LangChain');  // from technology
    expect(voki.skills).toContain('Ollama');     // no duplicates
    const tv = tracks.find((t) => t.id === 'tradingview')!;
    expect(tv.title).toBe('Frontend Infrastructure Lead');
    expect(tv.skills).toContain('Webpack');
    expect(tv.skills).toContain('Rspack');       // skill fact whose name is in bullets

    expect(diff.every((d) => d.op === 'add_track')).toBe(true);
    expect(diff.length).toBe(2);
    // master untouched fields stay
    expect(proposed.identity).toEqual(master.identity);
    expect(proposed.version).toBe(2);
  });

  it('a skill fact not mentioned in any experience bullets creates no track', () => {
    const facts = [
      fact('s1', 'skill', { category: 'quality', name: 'Playwright' }),
    ];
    const { proposed, diff } = buildTracksProposal(master, facts);
    expect(proposed.tracks).toBeUndefined();
    expect(diff).toHaveLength(0);
  });

  it('experience facts without technology still get a track from bullet-skill matches', () => {
    const facts = [
      fact('e1', 'experience', {
        employer: 'NDA Company', title: 'Technical Lead', start: '2017-01', end: '2019-01',
        bullets: ['Led TypeScript platform team of seven engineers.'],
      }),
      fact('s1', 'skill', { category: 'languages', name: 'TypeScript' }),
    ];
    const { proposed, diff } = buildTracksProposal(master, facts);
    const tracks = proposed.tracks as Array<{ id: string; skills: string[] }>;
    expect(tracks).toHaveLength(1);
    expect(tracks[0]!.skills).toEqual(['TypeScript']);
    expect(diff).toHaveLength(1);
  });

  it('existing tracks in the master are preserved, not duplicated', () => {
    const withTracks = { ...master, tracks: [{ id: 'tradingview', title: 'Frontend Infrastructure Lead', skills: ['Webpack'] }] };
    const facts = [
      fact('e1', 'experience', {
        employer: 'VOKI Games', title: 'AI Engineer', start: '2023-01', end: null,
        bullets: ['Built AI delivery pipelines.'], technology: ['Ollama'],
      }),
      fact('e2', 'experience', {
        employer: 'TradingView', title: 'Frontend Infrastructure Lead', start: '2019-02', end: '2023-01',
        bullets: ['Owned build systems.'], technology: ['Webpack'],
      }),
    ];
    const { proposed, diff } = buildTracksProposal(withTracks, facts);
    const tracks = proposed.tracks as Array<{ id: string }>;
    expect(tracks).toHaveLength(2); // existing TradingView kept, only VOKI added
    expect(diff).toHaveLength(1);
    expect(diff[0]!.line).toContain('VOKI Games');
  });
});
