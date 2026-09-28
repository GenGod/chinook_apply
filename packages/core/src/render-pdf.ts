// S6: PDF encoder — RenderResumeModel / RenderCoverModel → PDF buffer via
// pdfkit. Layout v1: single-column, ATS-conservative, Helvetica core fonts.
//
// Deterministic + content-testable: the document is created with
// `compress: false` (content streams stay plain text — tests read strings
// straight from the buffer) and fixed metadata dates (never the wall clock).
import PDFDocument from 'pdfkit';
import type {
  RenderCoverModel,
  RenderIdentity,
  RenderResumeModel,
} from './render-model';

const FIXED_DATE = new Date(Date.UTC(2026, 0, 1));
const MARGIN = 54;
const TEXT = 10;
const MUTED = '#555555';

function createDocument(): PDFKit.PDFDocument {
  return new PDFDocument({
    size: 'A4',
    margins: { top: MARGIN, bottom: MARGIN, left: MARGIN, right: MARGIN },
    compress: false,
    info: { CreationDate: FIXED_DATE, ModDate: FIXED_DATE },
  });
}

/** Collects the emitted PDF bytes: 'data' events are async by stream contract. */
function renderToBuffer(doc: PDFKit.PDFDocument): Promise<Buffer> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    doc.on('data', (chunk: Buffer) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.end();
  });
}

function header(doc: PDFKit.PDFDocument, identity: RenderIdentity): void {
  doc.font('Helvetica-Bold').fontSize(20).fillColor('#000000').text(identity.fullName, { align: 'center' });
  doc.moveDown(0.2);
  if (identity.headline) {
    doc.font('Helvetica').fontSize(10.5).fillColor(MUTED).text(identity.headline, { align: 'center' });
  }
  const contact = [identity.email, identity.location].filter((s): s is string => Boolean(s)).join(' · ');
  if (contact) {
    doc.fontSize(9).text(contact, { align: 'center' });
  }
  doc.moveDown(0.8).fillColor('#000000').fontSize(TEXT);
}

function sectionHeading(doc: PDFKit.PDFDocument, text: string): void {
  doc.moveDown(0.6);
  doc.font('Helvetica-Bold').fontSize(12).fillColor('#000000').text(text);
  doc.moveDown(0.2).font('Helvetica').fontSize(TEXT);
}

function resumeBody(doc: PDFKit.PDFDocument, model: RenderResumeModel): void {
  header(doc, model.identity);
  if (model.summary !== '') {
    sectionHeading(doc, 'Summary');
    doc.text(model.summary);
  }
  if (model.skillGroups.length > 0) {
    sectionHeading(doc, 'Skills');
    for (const group of model.skillGroups) {
      doc.font('Helvetica-Bold').text(`${group.label}: `, { continued: true });
      doc.font('Helvetica').text(group.items.join(', '));
    }
  }
  if (model.experience.length > 0) {
    sectionHeading(doc, 'Experience');
    for (const exp of model.experience) {
      doc.moveDown(0.3);
      doc.font('Helvetica-Bold').fillColor('#000000').text(`${exp.title} — ${exp.employer}`, { continued: true });
      doc.font('Helvetica').fillColor(MUTED).text(`  |  ${exp.period}`);
      doc.fillColor('#000000');
      if (exp.technology.length > 0) {
        doc.fontSize(8.5).fillColor(MUTED).text(exp.technology.join(' · ')).fillColor('#000000').fontSize(TEXT);
      }
      for (const b of exp.bullets) {
        doc.text(b, { indent: 14, listType: 'bullet', bulletRadius: 1.2, bulletIndent: 4 });
      }
    }
  }
  if (model.education.length > 0) {
    sectionHeading(doc, 'Education');
    for (const e of model.education) doc.text(e.line);
  }
}

function coverBody(doc: PDFKit.PDFDocument, model: RenderCoverModel): void {
  header(doc, model.identity);
  for (const p of model.paragraphs) {
    doc.text(p, { lineGap: 2 });
    doc.moveDown(0.5);
  }
}

export function encodeResumePdf(model: RenderResumeModel): Promise<Buffer> {
  const doc = createDocument();
  resumeBody(doc, model);
  return renderToBuffer(doc);
}

export function encodeCoverPdf(model: RenderCoverModel): Promise<Buffer> {
  const doc = createDocument();
  coverBody(doc, model);
  return renderToBuffer(doc);
}
