import { describe, it, expect } from 'vitest';
import { unzipSync } from 'fflate';
import { encodeResumeDocx, encodeCoverDocx } from '../src/render-docx.js';
import {
  buildResumeRenderModel,
  buildCoverRenderModel,
  type RenderIdentity,
} from '../src/render-model.js';
import type { TailoredResume } from '../src/generation-validators.js';

// Synthetic fixtures only — no real PII (Constitution 3.2). Same data shape
// as render-model.test.ts so both encoders gate the same model.

const identity: RenderIdentity = {
  fullName: 'Alex Fixture',
  headline: 'Senior Developer',
  email: 'alex.fixture@example.com',
  location: 'Alberta, Canada',
};

const tailored: TailoredResume = {
  summary: 'Platform engineer with 10 years of experience.',
  keywords: [],
  skills: ['TypeScript', 'PostgreSQL'],
  experience: [
    {
      employer: 'Fixture Corp',
      title: 'Senior Developer',
      start: '2020',
      end: 'present',
      technology: ['TypeScript'],
      bullets: ['Owned the platform serving 40k users.'],
    },
  ],
  education: [{ degree: 'B.Sc. Computer Science', institution: 'Fixture University', year: '2014' }],
};

const resumeModel = buildResumeRenderModel(
  identity,
  tailored,
  { frontend: ['TypeScript'], backend: ['PostgreSQL'] },
);
const coverModel = buildCoverRenderModel(
  identity,
  'Dear Hiring Manager,\n\nI am applying for the Senior Developer role at Fixture Corp.\n\nThank you.',
);

function docXml(buf: Buffer): string {
  const files = unzipSync(new Uint8Array(buf));
  const xml = files['word/document.xml'];
  if (!xml) throw new Error('word/document.xml missing from docx package');
  return new TextDecoder().decode(xml);
}

describe('encodeResumeDocx', () => {
  it('is a zip whose document.xml contains identity, summary, bullet and employer text', async () => {
    const buf = await encodeResumeDocx(resumeModel);
    expect(buf.subarray(0, 2).toString('latin1')).toBe('PK');
    const xml = docXml(buf);
    expect(xml).toContain('Alex Fixture');
    expect(xml).toContain('Senior Developer');
    expect(xml).toContain('alex.fixture@example.com');
    expect(xml).toContain('Platform engineer with 10 years of experience.');
    expect(xml).toContain('Owned the platform serving 40k users.');
    expect(xml).toContain('Fixture Corp');
    expect(xml).toContain('Frontend'); // grouped skills label
    expect(xml).toContain('Fixture University'); // education line
  });

  it('is deterministic (same model → same bytes)', async () => {
    expect(await encodeResumeDocx(resumeModel)).toEqual(await encodeResumeDocx(resumeModel));
  });
});

describe('encodeCoverDocx', () => {
  it('is a zip whose document.xml contains the header and every paragraph', async () => {
    const buf = await encodeCoverDocx(coverModel);
    expect(buf.subarray(0, 2).toString('latin1')).toBe('PK');
    const xml = docXml(buf);
    expect(xml).toContain('Alex Fixture');
    expect(xml).toContain('Dear Hiring Manager,');
    expect(xml).toContain('I am applying for the Senior Developer role at Fixture Corp.');
    expect(xml).toContain('Thank you.');
  });

  it('is deterministic (same model → same bytes)', async () => {
    expect(await encodeCoverDocx(coverModel)).toEqual(await encodeCoverDocx(coverModel));
  });
});
