import { describe, it, expect } from 'vitest';
import { validateFormConfig, detectCaptcha, buildFormValues } from '../src/form-dispatch.js';

describe('validateFormConfig', () => {
  const ok = {
    url: 'https://fixture.example/apply',
    selectors: { name: '[data-form="name"]', submit: 'button[type=submit]' },
    successText: 'Thank you',
  };

  it('accepts a valid config with http(s) url and safe selectors', () => {
    expect(validateFormConfig(ok)).toEqual(ok);
    expect(validateFormConfig({ url: 'http://localhost:3999/mock-form' })).toEqual({
      url: 'http://localhost:3999/mock-form',
      selectors: {},
    });
  });

  it('rejects non-http urls, malformed and garbage input', () => {
    expect(validateFormConfig({ url: 'ftp://x' })).toBeNull();
    expect(validateFormConfig({ url: 'javascript:alert(1)' })).toBeNull();
    expect(validateFormConfig({ url: 'not a url' })).toBeNull();
    expect(validateFormConfig({ url: 'https://x.example', selectors: { name: '<script>' } })).toBeNull();
    expect(validateFormConfig({ url: 'https://x.example', selectors: { name: 'javascript:void(0)' } })).toBeNull();
    expect(validateFormConfig('string')).toBeNull();
    expect(validateFormConfig(null)).toBeNull();
    expect(validateFormConfig({})).toBeNull();
  });
});

describe('detectCaptcha', () => {
  it('catches known captcha markers', () => {
    for (const marker of ['g-recaptcha', 'hcaptcha.com', 'cf-challenge', 'data-captcha', 'challenges.cloudflare.com/turnstile']) {
      expect(detectCaptcha(`<div class="${marker}"></div>`)).toBeTruthy();
    }
  });

  it('returns null for a clean page', () => {
    expect(detectCaptcha('<form><input name="name"></form>')).toBeNull();
  });
});

describe('buildFormValues', () => {
  it('uses identity and cover text when available', () => {
    const values = buildFormValues(
      { fullName: 'Alex Fixture', email: 'alex.fixture@example.com' },
      'Dear Hiring Manager,\n\nI am applying for the Senior Developer role at Fixture Corp.',
      { title: 'Senior Developer', employer: 'Fixture Corp' },
    );
    expect(values.name).toBe('Alex Fixture');
    expect(values.email).toBe('alex.fixture@example.com');
    expect(values.message).toContain('Dear Hiring Manager,');
    expect(values.message).toContain('Senior Developer');
  });

  it('falls back to the deterministic note without a cover letter', () => {
    const values = buildFormValues(
      { fullName: 'Alex Fixture', email: 'alex.fixture@example.com' },
      null,
      { title: 'Developer', employer: 'Corp' },
    );
    expect(values.message).toContain('I am applying for the Developer role at Corp.');
  });
});
