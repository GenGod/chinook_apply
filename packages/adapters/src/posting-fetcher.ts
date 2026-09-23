// Job Bank posting page fetcher — enriches truncated feed summaries with
// the full description from the actual posting page (S4 enrichment).
import { assertSafeExternalUrl, EGRESS_JOBBANK_HOSTS } from './egress';

export const JOBBANK_UA = 'Chinook/0.1 (personal job-search automation; contact: gengodoriginal@gmail.com)';

/** Fetches a Job Bank posting page and extracts the full description text. */
export async function fetchPostingDescription(postingUrl: string): Promise<string | null> {
  const url = assertSafeExternalUrl(postingUrl, EGRESS_JOBBANK_HOSTS);
  const response = await fetch(url, {
    headers: { 'User-Agent': JOBBANK_UA, Accept: 'text/html' },
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) return null;
  const html = await response.text();

  // Job Bank posting pages have description in a <article> or section with
  // class containing 'jobpost' or 'job-description'. We try known markers,
  // then fall back to extracting from the main content area.
  const markers = [
    /class="[^"]*jobpostjobdescription[^"]*"([^]*?)<\/div>\s*<\/div>/i,
    /class="[^"]*job-description[^"]*"([^]*?)<\/section>/i,
    /<article[^>]*>([^]*?)<\/article>/i,
  ];
  for (const pattern of markers) {
    const match = html.match(pattern);
    if (match?.[1]) {
      return stripHtml(match[1]).trim() || null;
    }
  }

  // Fallback: extract everything between the page title and the footer
  const bodyMatch = html.match(/<body[^>]*>([^]*?)<\/body>/i);
  if (bodyMatch?.[1]) {
    const text = stripHtml(bodyMatch[1]);
    // Job Bank pages have nav/header/footer text; take the longest paragraph block
    const paragraphs = text.split('\n').filter((p) => p.trim().length > 100);
    if (paragraphs.length > 0) {
      return paragraphs.join('\n\n');
    }
  }
  return null;
}

/** Minimal HTML to text: removes script/style blocks, strips tags, decodes entities. */
export function stripHtml(html: string): string {
  // remove script and style content entirely (before stripping tags)
  let cleaned = html;
  const scriptStart = cleaned.indexOf('<script');
  while (scriptStart >= 0) {
    const scriptEnd = cleaned.indexOf('</script>', scriptStart);
    if (scriptEnd < 0) break;
    cleaned = cleaned.slice(0, scriptStart) + cleaned.slice(scriptEnd + 9);
  }
  const styleStart = cleaned.indexOf('<style');
  while (styleStart >= 0) {
    const styleEnd = cleaned.indexOf('</style>', styleStart);
    if (styleEnd < 0) break;
    cleaned = cleaned.slice(0, styleStart) + cleaned.slice(styleEnd + 8);
  }

  // strip remaining tags
  let text = '';
  let inTag = false;
  for (let i = 0; i < cleaned.length; i++) {
    const c = cleaned[i];
    if (c === '<') { inTag = true; text += ' '; continue; }
    if (c === '>') { inTag = false; continue; }
    if (!inTag) text += c;
  }

  // decode entities (first pass)
  const entities: Array<[string, string]> = [
    ['&amp;', '&'], ['&lt;', '<'], ['&gt;', '>'], ['&quot;', '"'], ['&#39;', "'"],
    ['&nbsp;', ' '], ['&#x27;', "'"], ['&#x2F;', '/'],
  ];
  for (const [ent, ch] of entities) {
    text = text.split(ent).join(ch);
  }

  // second pass: strip any tags revealed by entity decoding (e.g. &lt;p&gt; → <p>)
  let second = '';
  inTag = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '<') { inTag = true; second += ' '; continue; }
    if (c === '>') { inTag = false; continue; }
    if (!inTag) second += c;
  }
  text = second;

  // normalize whitespace
  const lines = text.split('\n').map((l) => l.trim());
  return lines.filter((l) => l !== '').join('\n');
}
