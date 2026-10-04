import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import {
  classifyPosting,
  extractApplyMethods,
  buildRevealPostBody,
  revealApplyMethods,
  httpRevealFetch,
  type RevealFetch,
} from '../src/jobbank-apply.js';

// S25 R1/R2: classification and apply-method extraction against the LIVE Job
// Bank panel markup (captured 2026-10-03, synthetic fixture — no real PII).
// Direct postings hide the apply panel behind a JSF postback; partner
// postings carry id="externalJobLink" instead.

const F = (name: string) => readFileSync(join(import.meta.dirname, 'fixtures/jobbank/apply', name), 'utf8');

describe('classifyPosting (S25 R1)', () => {
  it('partner: externalJobLink', () => {
    expect(classifyPosting(F('partner.html'))).toBe('partner');
  });

  it('direct: applynowbutton (panel hidden or revealed)', () => {
    expect(classifyPosting(F('direct-get.html'))).toBe('direct');
    expect(classifyPosting(F('direct-panel-email.html'))).toBe('direct');
  });

  it('expired/foreign markup → unknown', () => {
    expect(classifyPosting(F('expired.html'))).toBe('unknown');
  });

  it('empty → unknown', () => {
    expect(classifyPosting('')).toBe('unknown');
  });
});

describe('extractApplyMethods (S25 R2)', () => {
  it('GET view (panel not revealed) → null', () => {
    expect(extractApplyMethods(F('direct-get.html'))).toBeNull();
  });

  it('email + screening questions + notes + directApply', () => {
    const m = extractApplyMethods(F('direct-panel-email.html'));
    expect(m).not.toBeNull();
    expect(m!.email).toBe('careers@fixture.example');
    expect(m!.directApply).toBe(true);
    // Entities decoded; wrapper li ("Answers to…") with a nested ul is skipped.
    expect(m!.screeningQuestions).toEqual([
      "Do you have a valid driver's licence?",
      'Do you meet the language requirements (English or French)?',
    ]);
    expect(m!.notes).toEqual(['References attesting experience', 'Letter of recommendation']);
    expect(m!.webUrl).toBeNull();
    expect(m!.otherText).toBeNull();
  });

  it('Apply online → webUrl (external link, not jobbank)', () => {
    const m = extractApplyMethods(F('direct-panel-web.html'));
    expect(m!.webUrl).toBe('https://employer.example/apply/123');
    expect(m!.email).toBeNull();
    expect(m!.directApply).toBe(false);
  });

  it('in person / phone → otherText (без «Advertised until» — граница панели)', () => {
    const m = extractApplyMethods(F('direct-panel-inperson.html'));
    expect(m!.email).toBeNull();
    expect(m!.otherText).toContain('In person');
    expect(m!.otherText).toContain('By phone');
    expect(m!.otherText).not.toContain('Advertised until');
    expect(m!.otherText).not.toContain('2026-10-23');
  });
});

describe('buildRevealPostBody (S25 R1)', () => {
  it('exact JSF postback body', () => {
    expect(buildRevealPostBody('99990001')).toBe(
      'seekeractivity%3Ajobid=99990001&seekeractivity_SUBMIT=1&jakarta.faces.ViewState=stateless',
    );
  });
});

const POST_URL = 'https://www.jobbank.gc.ca/jobsearch/jobposting/99990001';

function fakeFetch(getBody: string, postBody: string, status = 200): RevealFetch & { posts: Array<{ url: string; body: string }> } {
  const posts: Array<{ url: string; body: string }> = [];
  return {
    posts,
    async get() {
      return { status, body: getBody };
    },
    async post(url, body) {
      posts.push({ url, body });
      return { status, body: postBody };
    },
  };
}

describe('revealApplyMethods (S25 R1/R4)', () => {
  it('direct: GET→POST→revealed, POST url and body exact', async () => {
    const f = fakeFetch(F('direct-get.html'), F('direct-panel-email.html'));
    const out = await revealApplyMethods(f, POST_URL, '99990001');
    expect(out).toEqual({
      kind: 'revealed',
      methods: expect.objectContaining({ email: 'careers@fixture.example' }),
    });
    expect(f.posts).toEqual([{ url: POST_URL, body: buildRevealPostBody('99990001') }]);
  });

  it('partner: no POST at all', async () => {
    const f = fakeFetch(F('partner.html'), F('partner.html'));
    expect(await revealApplyMethods(f, POST_URL, '99990001')).toEqual({ kind: 'partner' });
    expect(f.posts).toHaveLength(0);
  });

  it('throttling: POST ok but panel absent → throttled', async () => {
    const f = fakeFetch(F('direct-get.html'), F('direct-get.html'));
    expect(await revealApplyMethods(f, POST_URL, '99990001')).toEqual({ kind: 'throttled' });
  });

  it('non-2xx GET → unavailable, POST never called', async () => {
    const f = fakeFetch(F('direct-get.html'), F('direct-panel-email.html'), 503);
    expect(await revealApplyMethods(f, POST_URL, '99990001')).toEqual({ kind: 'unavailable' });
    expect(f.posts).toHaveLength(0);
  });

  it('unknown markup → unavailable', async () => {
    const f = fakeFetch(F('expired.html'), F('expired.html'));
    expect(await revealApplyMethods(f, POST_URL, '99990001')).toEqual({ kind: 'unavailable' });
  });

  it('network failure on GET → unavailable', async () => {
    const f: RevealFetch = {
      get: () => Promise.reject(new Error('ECONNREFUSED')),
      post: () => Promise.reject(new Error('unreachable')),
    };
    expect(await revealApplyMethods(f, POST_URL, '99990001')).toEqual({ kind: 'unavailable' });
  });
});

describe('httpRevealFetch egress composition (S25/B-010)', () => {
  it('не-https URL отвергается до создания транспорта', () => {
    expect(() => httpRevealFetch('http://www.jobbank.gc.ca/jobsearch/jobposting/1')).toThrow(/egress blocked/);
  });

  it('хост вне allowlist отвергается', () => {
    expect(() => httpRevealFetch('https://evil.example/jobsearch/jobposting/1')).toThrow(/egress blocked/);
  });

  it('jobbank https URL принимается (транспорт создаётся)', () => {
    expect(() =>
      httpRevealFetch('https://www.jobbank.gc.ca/jobsearch/jobposting/50415430'),
    ).not.toThrow();
  });
});
