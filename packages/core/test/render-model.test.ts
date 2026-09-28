import { describe, it, expect } from 'vitest';
import {
  buildResumeRenderModel,
  buildCoverRenderModel,
  renderIdentityFromMaster,
  renderIdentityFromContent,
  type RenderIdentity,
} from '../src/render-model.js';
import type { TailoredResume } from '../src/generation-validators.js';

// Synthetic fixtures only — real master_profile.json is gitignored PII and is
// never loaded in tests (Constitution 3.2).

const identity: RenderIdentity = {
  fullName: 'Alex Fixture',
  headline: 'Senior Developer',
  email: 'alex.fixture@example.com',
  location: 'Alberta, Canada · Open to relocation across Canada',
};

const tailored: TailoredResume = {
  summary: 'Senior Developer with 10 years of experience delivering a platform serving 40k users.',
  keywords: ['distributed systems', 'TypeScript'],
  skills: ['TypeScript', 'React', 'PostgreSQL', 'Docker', 'Playwright'],
  experience: [
    {
      employer: 'Fixture Games',
      title: 'Senior Developer',
      start: '2020-03',
      end: 'present',
      technology: ['TypeScript', 'React'],
      bullets: ['Built a platform serving 40k users with 99.9% uptime.', 'Cut batch latency by 60%.'],
    },
    {
      employer: 'Old Corp',
      title: 'Developer',
      start: '2016',
      end: '2020-02',
      technology: [],
      bullets: [],
    },
  ],
  education: [
    { degree: 'B.Sc. Computer Science', institution: 'Fixture University', year: 2014 },
    'garbage-entry',
    { school: 'Second School' },
  ],
};

const masterSkills = {
  frontend: ['React', 'TypeScript'],
  backend: ['PostgreSQL', 'Docker'],
  quality: ['Playwright'],
};

describe('buildResumeRenderModel', () => {
  it('snapshots the full structure (identity, groups, experience, education)', () => {
    const model = buildResumeRenderModel(identity, tailored, masterSkills);
    expect(model).toMatchInlineSnapshot(`
      {
        "education": [
          {
            "line": "B.Sc. Computer Science — Fixture University · 2014",
          },
          {
            "line": "Second School",
          },
        ],
        "experience": [
          {
            "bullets": [
              "Built a platform serving 40k users with 99.9% uptime.",
              "Cut batch latency by 60%.",
            ],
            "employer": "Fixture Games",
            "period": "2020-03 — present",
            "technology": [
              "TypeScript",
              "React",
            ],
            "title": "Senior Developer",
          },
          {
            "bullets": [],
            "employer": "Old Corp",
            "period": "2016 — 2020-02",
            "technology": [],
            "title": "Developer",
          },
        ],
        "identity": {
          "email": "alex.fixture@example.com",
          "fullName": "Alex Fixture",
          "headline": "Senior Developer",
          "location": "Alberta, Canada · Open to relocation across Canada",
        },
        "skillGroups": [
          {
            "items": [
              "TypeScript",
              "React",
            ],
            "label": "Frontend",
          },
          {
            "items": [
              "PostgreSQL",
              "Docker",
            ],
            "label": "Backend",
          },
          {
            "items": [
              "Playwright",
            ],
            "label": "Quality & Testing",
          },
        ],
        "summary": "Senior Developer with 10 years of experience delivering a platform serving 40k users.",
      }
    `);
  });

  it('groups skills by master categories, keeps tailored order inside a group', () => {
    const model = buildResumeRenderModel(identity, tailored, masterSkills);
    const flat = model.skillGroups.flatMap((g) => g.items);
    // Frontend (tailored order within group: TypeScript before React), then
    // Backend, then Quality; no skill lost, no duplicates.
    expect(model.skillGroups.map((g) => g.label)).toEqual(['Frontend', 'Backend', 'Quality & Testing']);
    expect(flat).toEqual(['TypeScript', 'React', 'PostgreSQL', 'Docker', 'Playwright']);
  });

  it('tailored-order skills missing from master categories land in Other', () => {
    const model = buildResumeRenderModel(identity, { ...tailored, skills: ['Exotic Tool', 'React'] }, masterSkills);
    expect(model.skillGroups.map((g) => g.label)).toEqual(['Frontend', 'Other']);
    expect(model.skillGroups[1]?.items).toEqual(['Exotic Tool']);
  });

  it('without masterSkills renders a single Skills group in tailored order', () => {
    const model = buildResumeRenderModel(identity, tailored);
    expect(model.skillGroups).toEqual([{ label: 'Skills', items: ['TypeScript', 'React', 'PostgreSQL', 'Docker', 'Playwright'] }]);
  });

  it('tolerates missing optional identity fields and empty sections', () => {
    const model = buildResumeRenderModel({ fullName: 'Solo' }, {
      ...tailored,
      summary: '',
      skills: [],
      experience: [],
      education: [],
    });
    expect(model.identity).toEqual({ fullName: 'Solo' });
    expect(model.skillGroups).toEqual([]);
    expect(model.experience).toEqual([]);
    expect(model.education).toEqual([]);
    expect(model.summary).toBe('');
  });
});

describe('buildCoverRenderModel', () => {
  it('splits the letter into non-empty paragraphs (snapshot)', () => {
    const model = buildCoverRenderModel(identity, [
      'Dear Hiring Manager,',
      'I am applying for the Senior Developer role at Fixture Games. My background covers TypeScript, PostgreSQL and building a platform serving 40k users.',
      '',
      'Thank you for your consideration.',
    ].join('\n\n'));
    expect(model).toMatchInlineSnapshot(`
      {
        "identity": {
          "email": "alex.fixture@example.com",
          "fullName": "Alex Fixture",
          "headline": "Senior Developer",
          "location": "Alberta, Canada · Open to relocation across Canada",
        },
        "paragraphs": [
          "Dear Hiring Manager,",
          "I am applying for the Senior Developer role at Fixture Games. My background covers TypeScript, PostgreSQL and building a platform serving 40k users.",
          "Thank you for your consideration.",
        ],
      }
    `);
  });

  it('drops whitespace-only paragraphs and tolerates single newlines', () => {
    const model = buildCoverRenderModel(identity, 'First\n \nSecond\n\n\nThird');
    expect(model.paragraphs).toEqual(['First', 'Second', 'Third']);
  });
});

describe('renderIdentityFromMaster', () => {
  it('builds identity from master_profile.json shape', () => {
    const raw = {
      identity: {
        full_name: 'Alex Fixture',
        headline: 'Senior Full-Stack Engineer',
        email: 'alex.fixture@example.com',
        location_constraints: {
          target_province: 'Alberta',
          relocation: 'Open to relocation across Canada',
        },
      },
      summary: 'x',
    };
    expect(renderIdentityFromMaster(raw)).toEqual({
      fullName: 'Alex Fixture',
      headline: 'Senior Full-Stack Engineer',
      email: 'alex.fixture@example.com',
      location: 'Alberta, Canada · Open to relocation across Canada',
    });
  });

  it('returns null without a full name and tolerates missing extras', () => {
    expect(renderIdentityFromMaster({ identity: { email: 'x@y.z' } })).toBeNull();
    expect(renderIdentityFromMaster({})).toBeNull();
    expect(renderIdentityFromMaster(null)).toBeNull();
    expect(renderIdentityFromMaster({ identity: { full_name: 'Solo' } })).toEqual({ fullName: 'Solo' });
    expect(renderIdentityFromMaster({ identity: { full_name: 'Solo', location_constraints: {} } })).toEqual({
      fullName: 'Solo', // empty constraints → no location line at all
    });
  });
});

describe('renderIdentityFromContent', () => {
  it('extracts the identity snapshot stored by generation', () => {
    const content = { diff: {}, resume: {}, identity: { fullName: 'Alex Fixture', email: 'a@b.c' } };
    expect(renderIdentityFromContent(content)).toEqual({ fullName: 'Alex Fixture', email: 'a@b.c' });
  });

  it('returns null for legacy artifacts without an identity snapshot', () => {
    expect(renderIdentityFromContent({ diff: {}, resume: {} })).toBeNull();
    expect(renderIdentityFromContent(null)).toBeNull();
    expect(renderIdentityFromContent({ identity: { email: 'x' } })).toBeNull(); // fullName required
    expect(renderIdentityFromContent({ identity: 'nope' })).toBeNull();
  });
});
