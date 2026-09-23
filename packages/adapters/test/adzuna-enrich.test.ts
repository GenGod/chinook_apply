import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { extractAdzunaJsonLdDescription, fetchAdzunaFullDescription } from '../src/adzuna-enrich.js';

const detailsHtml = readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures/adzuna/details-neo.html'),
  'utf8',
);

describe('extractAdzunaJsonLdDescription', () => {
  it('extracts the full JobPosting description from a real details page', () => {
    const desc = extractAdzunaJsonLdDescription(detailsHtml);
    expect(desc).not.toBeNull();
    // full text, not the 500-char API excerpt
    expect(desc!.length).toBeGreaterThan(2000);
    // the work-authorization line the API truncation hides
    expect(desc!).toContain('Canadian citizen');
    // HTML stripped
    expect(desc!).not.toMatch(/<\w/);
  });

  it('returns null when no JobPosting JSON-LD exists', () => {
    expect(extractAdzunaJsonLdDescription('<html><body>no structured data</body></html>')).toBeNull();
  });

  it('returns null for a too-short description (junk guard)', () => {
    const html = '<script type="application/ld+json">{"@type":"JobPosting","description":"too short"}</script>';
    expect(extractAdzunaJsonLdDescription(html)).toBeNull();
  });

  it('skips non-JobPosting JSON-LD blocks (e.g. BreadcrumbList)', () => {
    const html = `<script type="application/ld+json">{"@type":"BreadcrumbList","itemListElement":[]}</script>
      <script type="application/ld+json">{"@type":"JobPosting","description":"<p>${'x'.repeat(300)}</p>"}</script>`;
    const desc = extractAdzunaJsonLdDescription(html);
    expect(desc).not.toBeNull();
    expect(desc!.length).toBeGreaterThanOrEqual(300);
  });
});

describe('fetchAdzunaFullDescription', () => {
  it('fetches the details page and returns the full description', async () => {
    let requestedUrl = '';
    const fetchImpl = async (url: URL, init: RequestInit): Promise<Response> => {
      requestedUrl = url.toString();
      void init;
      return new Response(detailsHtml, { status: 200 });
    };
    const desc = await fetchAdzunaFullDescription(
      'https://www.adzuna.ca/details/5745811241?utm_medium=api&utm_source=56c614cf',
      { fetchImpl },
    );
    expect(requestedUrl).toContain('adzuna.ca/details/5745811241');
    expect(desc).not.toBeNull();
    expect(desc).toContain('Canadian citizen');
  });

  it('throws on non-allowlisted host (egress guard)', async () => {
    await expect(
      fetchAdzunaFullDescription('https://evil.example.com/details/1', {
        fetchImpl: async () => new Response('', { status: 200 }),
      }),
    ).rejects.toThrow(/egress blocked/);
  });

  it('returns null on non-200 response', async () => {
    const desc = await fetchAdzunaFullDescription('https://www.adzuna.ca/details/999', {
      fetchImpl: async () => new Response('gone', { status: 404 }),
    });
    expect(desc).toBeNull();
  });
});
