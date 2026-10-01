import { describe, it, expect } from 'vitest';
import { buildResumePrompt, type GenerationJob } from '../src/generation.js';
import type { CareerTrack } from '@chinook/core';

// Synthetic master — no PII.
const master = {
  summary: 'Engineer with 11 years of platform experience.',
  skills: {
    frontend: ['React', 'Webpack'],
    platform_and_ai: ['Ollama', 'LangChain'],
  },
  experience: [],
  education: [],
};

const job: GenerationJob = { title: 'Senior Developer', employer: 'Fixture Corp' };

const aiTrack: CareerTrack = { id: 'voki-games', title: 'AI Engineer', skills: ['Ollama', 'LangChain'] };

describe('track-emphasized resume prompt (S24 T3)', () => {
  it('embeds the track emphasis block when a track is passed', () => {
    const { system } = buildResumePrompt(master, job, { track: aiTrack });
    expect(system).toContain('TRACK EMPHASIS');
    expect(system).toContain('AI Engineer');
    expect(system).toContain('Ollama');
    expect(system).toContain('LangChain');
  });

  it('no track → no emphasis block (backward compatible)', () => {
    const { system } = buildResumePrompt(master, job);
    expect(system).not.toContain('TRACK EMPHASIS');
  });

  it('track block instructs emphasis, not invention', () => {
    const { system } = buildResumePrompt(master, job, { track: aiTrack });
    expect(system.toLowerCase()).toContain('emphasize');
    expect(system.toLowerCase()).toContain('do not invent');
  });
});
