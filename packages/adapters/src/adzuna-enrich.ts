// Adzuna details-page enrichment — the API caps description at 500 chars, but
// the public details page (https://www.adzuna.ca/details/<id>) embeds a
// schema.org JobPosting JSON-LD block with the full description. One fetch per
// job, cached by the caller in job.raw.fullDescription; 2s politeness delay is
// the caller's responsibility (batch backfill).
import { assertSafeExternalUrl, EGRESS_ADZUNA_HOSTS } from './egress';
import { crawlerUserAgent } from './user-agent';
import { stripHtml } from './posting-fetcher';

const MIN_DESCRIPTION_LENGTH = 200;

/** Extracts <script type="application/ld+json"> block contents (indexOf scan, no regex). */
function jsonLdBlocks(html: string): string[] {
  const blocks: string[] = [];
  const marker = 'application/ld+json';
  let pos = 0;
  while (pos < html.length) {
    const scriptStart = html.indexOf('<script', pos);
    if (scriptStart < 0) break;
    const tagEnd = html.indexOf('>', scriptStart);
    if (tagEnd < 0) break;
    if (html.slice(scriptStart, tagEnd).includes(marker)) {
      const contentStart = tagEnd + 1;
      const contentEnd = html.indexOf('</script>', contentStart);
      if (contentEnd < 0) break;
      blocks.push(html.slice(contentStart, contentEnd));
      pos = contentEnd + 9;
    } else {
      pos = tagEnd + 1;
    }
  }
  return blocks;
}

/** Finds the JobPosting description across JSON-LD blocks (objects or arrays). */
function jobPostingDescription(parsed: unknown): string | null {
  if (parsed == null) return null;
  const candidates: unknown[] = Array.isArray(parsed) ? parsed : [parsed];
  for (const item of candidates) {
    if (item == null || typeof item !== 'object') continue;
    const obj = item as Record<string, unknown>;
    if (obj['@type'] === 'JobPosting' && typeof obj.description === 'string') {
      return obj.description;
    }
    // graph nesting (rare on Adzuna, cheap to support)
    if (Array.isArray(obj['@graph'])) {
      const nested = jobPostingDescription(obj['@graph']);
      if (nested !== null) return nested;
    }
  }
  return null;
}

/** Parses a details page and returns the full plain-text description, or null. */
export function extractAdzunaJsonLdDescription(html: string): string | null {
  for (const block of jsonLdBlocks(html)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(block);
    } catch {
      continue;
    }
    const raw = jobPostingDescription(parsed);
    if (typeof raw !== 'string') continue;
    const text = stripHtml(raw).trim();
    if (text.length >= MIN_DESCRIPTION_LENGTH) return text;
  }
  return null;
}

export type AdzunaFetcher = (url: URL, init: RequestInit) => Promise<Response>;

/** Fetches the Adzuna details page and returns the full description. */
export async function fetchAdzunaFullDescription(
  detailsUrl: string,
  opts: { fetchImpl?: AdzunaFetcher } = {},
): Promise<string | null> {
  const url = assertSafeExternalUrl(detailsUrl, EGRESS_ADZUNA_HOSTS);
  const doFetch = opts.fetchImpl ?? ((u: URL, init: RequestInit) => fetch(u, init));
  const response = await doFetch(url, {
    headers: { 'User-Agent': crawlerUserAgent(), Accept: 'text/html' },
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) return null;
  return extractAdzunaJsonLdDescription(await response.text());
}
