// S11: PDF text extraction for profile ingest (pdf-parse wraps pdf.js).
// Server-only module (dynamic import keeps it out of the client bundle);
// failures degrade to '' — the ingest flow rejects empty-text documents.
export async function extractPdfText(bytes: Buffer): Promise<string> {
  try {
    const mod = (await import('pdf-parse')) as unknown as {
      default: (buf: Buffer) => Promise<{ text: string }>;
    };
    const parsed = await mod.default(bytes);
    return parsed.text.replace(/\r/g, '').trim();
  } catch {
    return '';
  }
}
