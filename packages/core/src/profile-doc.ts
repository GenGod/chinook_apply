// S11: DOCX text extraction for profile ingest — unzip word/document.xml
// (fflate, already a core dep from S6) + a minimal XML strip. Pure function,
// no filesystem access; failures degrade to '' (the ingest flow rejects
// empty-text documents upstream).
import { unzipSync } from 'fflate';

/** Extracts the visible text of a .docx package (paragraphs joined by \n). */
export function extractDocxText(bytes: Buffer): string {
  let xml: string;
  try {
    const files = unzipSync(new Uint8Array(bytes));
    const document = files['word/document.xml'];
    if (!document) return '';
    xml = new TextDecoder().decode(document);
  } catch {
    return '';
  }
  // Paragraph boundaries become newlines before stripping; everything else
  // inside <w:t> runs is kept verbatim (excerpts must match the source text).
  const withBreaks = xml
    .replace(/<\/w:p>/g, '\n')
    .replace(/<w:tab[^>]*\/>/g, '\t')
    .replace(/<w:br[^>]*\/>/g, '\n');
  const stripped = stripTags(withBreaks);
  return stripped
    .split('\n')
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter((line) => line !== '')
    .join('\n');
}

function stripTags(xml: string): string {
  let out = '';
  let inTag = false;
  for (let i = 0; i < xml.length; i += 1) {
    const c = xml[i];
    if (c === '<') {
      inTag = true;
      out += ' ';
      continue;
    }
    if (c === '>') {
      inTag = false;
      continue;
    }
    if (!inTag) out += c;
  }
  return out
    .split('&amp;')
    .join('&')
    .split('&lt;')
    .join('<')
    .split('&gt;')
    .join('>')
    .split('&quot;')
    .join('"')
    .split('&apos;')
    .join("'");
}
