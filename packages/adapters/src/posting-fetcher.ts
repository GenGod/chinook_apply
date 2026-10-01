// Job Bank posting page fetcher — enriches truncated feed summaries with
// the full description from the actual posting page (S4 enrichment).
// S23: extraction fixed for the current markup (section.job-posting-content,
// captured 2026-10-01 — the old jobpostjobdescription/<article> markers are
// gone) and extended with a best-effort STATIC apply-email capture. The
// "How to apply" panel itself loads via a JSF postback and is NOT emulated
// (Constitution 4.2: no fragile automation of dynamic panels).
import { assertSafeExternalUrl, EGRESS_JOBBANK_HOSTS } from './egress';
import { crawlerUserAgent } from './user-agent';

export interface PostingExtract {
  description: string | null;
  /** Static apply-block email when the page exposes one (mailto: or plain text). */
  applyEmail: string | null;
}

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;
const EMAIL_G_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

/** Extracts description + static apply email from a Job Bank posting page HTML. */
export function extractPosting(html: string): PostingExtract {
  // Primary (current markup): the description section; apply blocks sit
  // inside it, so emails from them are collected before stripping.
  const contentMatch = html.match(/<section[^>]*class="[^"]*job-posting-content[^"]*"[^>]*>([\s\S]*?)<\/section>/i);
  if (contentMatch?.[1]) {
    const applyEmail = firstApplyEmail(contentMatch[1]);
    const description = stripHtml(contentMatch[1]).trim();
    if (description !== '') return { description, applyEmail };
  }

  // Legacy markers (kept as fallback for cached/alternate layouts).
  const markers = [
    /class="[^"]*jobpostjobdescription[^"]*"([\s\S]*?)<\/div>\s*<\/div>/i,
    /class="[^"]*job-description[^"]*"([\s\S]*?)<\/section>/i,
    /<article[^>]*>([\s\S]*?)<\/article>/i,
  ];
  for (const pattern of markers) {
    const match = html.match(pattern);
    if (match?.[1]) {
      const description = stripHtml(match[1]).trim();
      if (description !== '') return { description, applyEmail: firstApplyEmail(match[1]) };
    }
  }

  // Fallback: longest paragraph blocks of the body.
  const bodyMatch = html.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
  if (bodyMatch?.[1]) {
    const text = stripHtml(bodyMatch[1]);
    const paragraphs = text.split('\n').filter((p) => p.trim().length > 100);
    if (paragraphs.length > 0) {
      return { description: paragraphs.join('\n\n'), applyEmail: firstApplyEmail(bodyMatch[1]) };
    }
  }
  return { description: null, applyEmail: null };
}

/** First email found inside static apply blocks (mailto: links preferred). */
function firstApplyEmail(sectionHtml: string): string | null {
  const blocks = sectionHtml.match(/<div[^>]*class="[^"]*job-posting-detail-apply[^"]*"[^>]*>[\s\S]*?(?=<div[^>]*class="[^"]*(?:job-posting-detail|col-md)|$)/gi) ?? [sectionHtml];
  for (const block of blocks) {
    const mailto = block.match(/mailto:([^"'?>\s]+)/i);
    if (mailto?.[1] && EMAIL_RE.test(mailto[1])) return mailto[1];
    const plain = block.match(EMAIL_G_RE);
    if (plain && plain.length > 0) return plain[0]!;
  }
  return null;
}

/** Fetches a Job Bank posting page and extracts description + apply email. */
export async function fetchPostingDescription(postingUrl: string): Promise<PostingExtract> {
  const url = assertSafeExternalUrl(postingUrl, EGRESS_JOBBANK_HOSTS);
  const response = await fetch(url, {
    headers: { 'User-Agent': crawlerUserAgent(), Accept: 'text/html' },
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) return { description: null, applyEmail: null };
  const html = await response.text();
  return extractPosting(html);
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
