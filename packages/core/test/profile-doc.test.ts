import { describe, it, expect } from 'vitest';
import { unzipSync } from 'fflate';
import { Document, Packer, Paragraph, TextRun } from 'docx';
import { extractDocxText } from '../src/profile-doc.js';

// Round-trip: the S6 docx ENCODER produces the package, the S11 extractor
// reads it back — synthetic content only (no PII).

async function makeDocx(lines: string[]): Promise<Buffer> {
  const doc = new Document({
    sections: [
      {
        children: lines.map(
          (line) => new Paragraph({ children: [new TextRun({ text: line })] }),
        ),
      },
    ],
  });
  return Packer.toBuffer(doc) as Promise<Buffer>;
}

describe('extractDocxText (S11 T2)', () => {
  it('extracts paragraph text from a docx produced by our own encoder', async () => {
    const buf = await makeDocx([
      'Senior Developer with 10 years of experience.',
      'Fixture Corp — Developer (2020): Built platforms.',
      'Skills: TypeScript, PostgreSQL.',
    ]);
    const text = extractDocxText(buf);
    expect(text).toContain('Senior Developer with 10 years of experience.');
    expect(text).toContain('Fixture Corp — Developer (2020): Built platforms.');
    expect(text).toContain('TypeScript, PostgreSQL.');
  });

  it('returns empty string for non-docx bytes (no throw)', () => {
    expect(extractDocxText(Buffer.from('not a zip at all'))).toBe('');
    expect(extractDocxText(Buffer.alloc(0))).toBe('');
  });

  it('output has no raw XML leaking through', async () => {
    const buf = await makeDocx(['Clean line only.']);
    const text = extractDocxText(buf);
    expect(text).not.toContain('<w:');
    expect(text).not.toContain('</w:p>');
    const files = Object.keys(unzipSync(new Uint8Array(buf)));
    expect(files).toContain('word/document.xml'); // sanity: real package
  });
});
