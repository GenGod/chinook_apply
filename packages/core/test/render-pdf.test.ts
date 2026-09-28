import { describe, it, expect } from 'vitest';
import { encodeResumePdf, encodeCoverPdf } from '../src/render-pdf.js';
import {
  buildResumeRenderModel,
  buildCoverRenderModel,
  type RenderIdentity,
} from '../src/render-model.js';
import type { TailoredResume } from '../src/generation-validators.js';

// Synthetic fixtures only — no real PII (Constitution 3.2).

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

const resumeModel = buildResumeRenderModel(identity, tailored, { frontend: ['TypeScript'] });
const coverModel = buildCoverRenderModel(
  identity,
  'Dear Hiring Manager,\n\nI am applying for the Senior Developer role at Fixture Corp.\n\nThank you.',
);

// compress:false → content streams are plain text. pdfkit writes text as
// kerning-split HEX chunks inside TJ arrays (e.g. [<416c65> 15 <78>] TJ), so
// the helper decodes every BT/ET block's hex chunks into reconstructed lines.
function pdfText(buf: Buffer): string {
  const raw = buf.toString('latin1');
  const blocks = raw.split('ET').map((block) => {
    const hex = [...block.matchAll(/<([0-9A-Fa-f]+)>/g)].map((m) => m[1]).join('');
    let out = '';
    for (let i = 0; i + 1 < hex.length; i += 2) {
      out += String.fromCharCode(parseInt(hex.slice(i, i + 2), 16));
    }
    return out;
  });
  return blocks.join('\n');
}

describe('encodeResumePdf', () => {
  it('has PDF magic and contains identity, summary, bullet and employer text', async () => {
    const buf = await encodeResumePdf(resumeModel);
    expect(buf.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    const text = pdfText(buf);
    expect(text).toContain('Alex Fixture');
    expect(text).toContain('Platform engineer');
    expect(text).toContain('Owned the platform serving 40k users.');
    expect(text).toContain('Fixture Corp');
    expect(text).toContain('Fixture University');
    expect(text).toContain('Frontend');
  });

  it('is deterministic (same model → same bytes)', async () => {
    expect(await encodeResumePdf(resumeModel)).toEqual(await encodeResumePdf(resumeModel));
  });

  it('paginates: many experience entries produce more than one page', async () => {
    const many: TailoredResume = {
      ...tailored,
      experience: Array.from({ length: 14 }, (_, i) => ({
        employer: `Corp ${i}`,
        title: 'Developer',
        start: '2020',
        end: 'present',
        technology: ['TypeScript'],
        bullets: ['Did things with care.', 'Did more things.'],
      })),
    };
    const buf = await encodeResumePdf(buildResumeRenderModel(identity, many));
    // Page objects live in the raw PDF structure, not in decoded text blocks.
    const pages = [...buf.toString('latin1').matchAll(/\/Type\s*\/Page\b(?!s)/g)].length;
    expect(pages).toBeGreaterThan(1);
  });
});

describe('encodeCoverPdf', () => {
  it('has PDF magic and contains header and paragraph text', async () => {
    const buf = await encodeCoverPdf(coverModel);
    expect(buf.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    const text = pdfText(buf);
    expect(text).toContain('Alex Fixture');
    expect(text).toContain('Dear Hiring Manager,');
    expect(text).toContain('I am applying for the Senior Developer role at Fixture Corp.');
    expect(text).toContain('Thank you.');
  });

  it('is deterministic (same model → same bytes)', async () => {
    expect(await encodeCoverPdf(coverModel)).toEqual(await encodeCoverPdf(coverModel));
  });
});
