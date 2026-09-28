// S6: DOCX encoder — RenderResumeModel / RenderCoverModel → .docx buffer via
// the docx library (OOXML). Layout v1: single-column, ATS-conservative,
// Calibri. Deterministic: the docx library stamps core.xml with `new Date()`,
// so the package is re-zipped with a fixed timestamp (determinism gate).
import {
  AlignmentType,
  Document,
  HeadingLevel,
  Packer,
  Paragraph,
  TextRun,
} from 'docx';
import { strToU8, unzipSync, zipSync } from 'fflate';
import type {
  RenderCoverModel,
  RenderIdentity,
  RenderResumeModel,
} from './render-model';

// Fixed package metadata — never the wall clock (byte-deterministic renders).
const FIXED_ISO = '2026-01-01T00:00:00.000Z';
const FIXED_DATE = new Date(Date.UTC(2026, 0, 1));

function normalizeDocx(buf: Buffer): Buffer {
  const files = unzipSync(new Uint8Array(buf));
  const core = files['docProps/core.xml'];
  if (core) {
    const xml = new TextDecoder().decode(core)
      .replace(/<dcterms:created[^>]*>.*?<\/dcterms:created>/, `<dcterms:created xsi:type="dcterms:W3CDTF">${FIXED_ISO}</dcterms:created>`)
      .replace(/<dcterms:modified[^>]*>.*?<\/dcterms:modified>/, `<dcterms:modified xsi:type="dcterms:W3CDTF">${FIXED_ISO}</dcterms:modified>`);
    files['docProps/core.xml'] = strToU8(xml);
  }
  return Buffer.from(zipSync(files, { mtime: FIXED_DATE }));
}

const PAGE_TITLE = 32; // half-points: 16pt name
const BODY_SIZE = 21; // half-points: 10.5pt body

const HEADING = { size: 26, bold: true } as const; // 13pt section headers

function contactLine(identity: RenderIdentity): string | null {
  const parts = [identity.email, identity.location].filter((s): s is string => Boolean(s));
  return parts.length > 0 ? parts.join(' · ') : null;
}

function headerParagraphs(identity: RenderIdentity): Paragraph[] {
  const out: Paragraph[] = [
    new Paragraph({
      alignment: AlignmentType.CENTER,
      children: [new TextRun({ text: identity.fullName, bold: true, size: PAGE_TITLE })],
    }),
  ];
  if (identity.headline) {
    out.push(
      new Paragraph({
        alignment: AlignmentType.CENTER,
        children: [new TextRun({ text: identity.headline, size: BODY_SIZE, color: '555555' })],
      }),
    );
  }
  const contact = contactLine(identity);
  if (contact) {
    out.push(
      new Paragraph({
        alignment: AlignmentType.CENTER,
        spacing: { after: 200 },
        children: [new TextRun({ text: contact, size: 18, color: '555555' })],
      }),
    );
  }
  return out;
}

function sectionHeading(text: string): Paragraph {
  return new Paragraph({
    heading: HeadingLevel.HEADING_1,
    spacing: { before: 240, after: 120 },
    children: [new TextRun({ text, bold: true, size: HEADING.size, color: '000000' })],
  });
}

function body(text: string): Paragraph {
  return new Paragraph({ spacing: { after: 120 }, children: [new TextRun({ text, size: BODY_SIZE })] });
}

function bullet(text: string): Paragraph {
  return new Paragraph({
    bullet: { level: 0 },
    spacing: { after: 60 },
    children: [new TextRun({ text, size: BODY_SIZE })],
  });
}

function skillParagraphs(model: RenderResumeModel): Paragraph[] {
  const out: Paragraph[] = [];
  for (const group of model.skillGroups) {
    out.push(
      new Paragraph({
        spacing: { after: 60 },
        children: [
          new TextRun({ text: `${group.label}: `, bold: true, size: BODY_SIZE }),
          new TextRun({ text: group.items.join(', '), size: BODY_SIZE }),
        ],
      }),
    );
  }
  return out;
}

function experienceParagraphs(model: RenderResumeModel): Paragraph[] {
  const out: Paragraph[] = [];
  for (const exp of model.experience) {
    out.push(
      new Paragraph({
        spacing: { before: 120, after: 20 },
        children: [
          new TextRun({ text: exp.title, bold: true, size: BODY_SIZE }),
          new TextRun({ text: ` — ${exp.employer}`, size: BODY_SIZE }),
          new TextRun({ text: `  |  ${exp.period}`, size: BODY_SIZE, color: '555555' }),
        ],
      }),
    );
    if (exp.technology.length > 0) {
      out.push(
        new Paragraph({
          spacing: { after: 40 },
          children: [new TextRun({ text: exp.technology.join(' · '), italics: true, size: 18, color: '555555' })],
        }),
      );
    }
    for (const b of exp.bullets) out.push(bullet(b));
  }
  return out;
}

export function resumeDocxDocument(model: RenderResumeModel): Document {
  const children: Paragraph[] = [...headerParagraphs(model.identity)];
  if (model.summary !== '') {
    children.push(sectionHeading('Summary'), body(model.summary));
  }
  if (model.skillGroups.length > 0) {
    children.push(sectionHeading('Skills'), ...skillParagraphs(model));
  }
  if (model.experience.length > 0) {
    children.push(sectionHeading('Experience'), ...experienceParagraphs(model));
  }
  if (model.education.length > 0) {
    children.push(sectionHeading('Education'), ...model.education.map((e) => body(e.line)));
  }
  return new Document({
    styles: { default: { document: { run: { font: 'Calibri' } } } },
    sections: [{ properties: {}, children }],
  });
}

export function coverDocxDocument(model: RenderCoverModel): Document {
  const children: Paragraph[] = headerParagraphs(model.identity);
  for (const p of model.paragraphs) {
    children.push(
      new Paragraph({
        spacing: { after: 160 },
        children: [new TextRun({ text: p, size: BODY_SIZE })],
      }),
    );
  }
  return new Document({
    styles: { default: { document: { run: { font: 'Calibri' } } } },
    sections: [{ properties: {}, children }],
  });
}

export function encodeResumeDocx(model: RenderResumeModel): Promise<Buffer> {
  return Packer.toBuffer(resumeDocxDocument(model)).then(normalizeDocx) as Promise<Buffer>;
}

export function encodeCoverDocx(model: RenderCoverModel): Promise<Buffer> {
  return Packer.toBuffer(coverDocxDocument(model)).then(normalizeDocx) as Promise<Buffer>;
}
