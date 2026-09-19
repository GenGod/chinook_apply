import { describe, it, expect } from 'vitest';
import { assertSafeExternalUrl, EGRESS_JOBBANK_HOSTS, EGRESS_ADZUNA_HOSTS } from '../src/egress.js';
import { jobbankAdapter } from '../src/jobbank.js';
import { adzunaAdapter } from '../src/adzuna.js';

describe('assertSafeExternalUrl (egress guard)', () => {
  it('passes an https URL whose host is allowlisted', () => {
    const url = assertSafeExternalUrl('https://www.jobbank.gc.ca/feed?searchstring=dev', [
      'www.jobbank.gc.ca',
    ]);
    expect(url.hostname).toBe('www.jobbank.gc.ca');
  });

  it('rejects non-https protocol even for an allowlisted host', () => {
    expect(() =>
      assertSafeExternalUrl('http://www.jobbank.gc.ca/feed', ['www.jobbank.gc.ca']),
    ).toThrow(/egress blocked.*non-https/);
  });

  it('rejects an https URL whose host is not allowlisted', () => {
    expect(() => assertSafeExternalUrl('https://evil.example/x', ['www.jobbank.gc.ca'])).toThrow(
      /egress blocked.*evil\.example/,
    );
  });

  it('rejects strings that are not URLs at all', () => {
    expect(() => assertSafeExternalUrl('not a url', ['www.jobbank.gc.ca'])).toThrow(
      /egress blocked/,
    );
  });
});

describe('jobbank feedUrl stays inside the egress allowlist', () => {
  const hostileQueries = [
    'software developer',
    '../@evil.com',
    'dev #fragment-injection',
    'a b c ?x=1//evil.example',
    '\tdev\n',
  ];

  it('builds a guarded https URL on the jobbank host for every query', () => {
    for (const query of hostileQueries) {
      const raw = jobbankAdapter.feedUrl(query);
      const url = assertSafeExternalUrl(raw, EGRESS_JOBBANK_HOSTS);
      expect(url.protocol).toBe('https:');
      expect(url.hostname).toBe('www.jobbank.gc.ca');
    }
  });

  it('throws instead of returning a URL off the allowlisted host', () => {
    // If JOBBANK_FEED_URL ever drifts off the allowlist (http, typo, other host),
    // feedUrl must refuse to hand that URL to fetch.
    expect(() => assertSafeExternalUrl(jobbankAdapter.feedUrl('dev'), ['other.host.example'])).toThrow(
      /egress blocked/,
    );
  });
});

describe('adzuna searchUrl stays inside the egress allowlist', () => {
  const hostileParams = [
    { appId: 'id@evil.com', appKey: 'k/@evil.com', what: '../@evil.com', where: 'Calgary #x' },
    { appId: 'a b', appKey: 'c d', what: 'x?y=1//evil.example', where: '\tRemote\n' },
  ];

  it('builds a guarded https URL on the adzuna host for hostile params', () => {
    for (const params of hostileParams) {
      const raw = adzunaAdapter.searchUrl({ ...params, page: 1 });
      const url = assertSafeExternalUrl(raw, EGRESS_ADZUNA_HOSTS);
      expect(url.protocol).toBe('https:');
      expect(url.hostname).toBe('api.adzuna.com');
    }
  });
});
