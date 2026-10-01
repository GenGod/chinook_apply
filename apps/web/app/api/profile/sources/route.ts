// S11: POST /api/profile/sources — multipart upload of one resume document
// (docx|pdf|txt) → ingest: text extraction → LLM facts (flash) → provenance
// gate → profile_fact rows. Bytes land in the gitignored sources dir.
import { NextResponse } from 'next/server';
import { createLlm, createPgLlmDb } from '@chinook/llm';
import { getDb } from '@/lib/db';
import { ingestProfileDocument } from '@/lib/superprofile-service';

export const dynamic = 'force-dynamic';
export const maxDuration = 120;

const MAX_BYTES = 10 * 1024 * 1024;

export async function POST(request: Request) {
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return NextResponse.json({ error: 'multipart form expected' }, { status: 400 });
  }
  const file = form.get('file');
  if (!(file instanceof File)) {
    return NextResponse.json({ error: 'file field required' }, { status: 400 });
  }
  const format = file.name.toLowerCase().endsWith('.docx')
    ? 'docx'
    : file.name.toLowerCase().endsWith('.pdf')
      ? 'pdf'
      : file.name.toLowerCase().endsWith('.txt')
        ? 'txt'
        : null;
  if (!format) {
    return NextResponse.json({ error: 'supported formats: docx, pdf, txt' }, { status: 400 });
  }
  if (file.size > MAX_BYTES) {
    return NextResponse.json({ error: 'file too large (max 10 MB)' }, { status: 400 });
  }

  const bytes = Buffer.from(await file.arrayBuffer());
  try {
    const result = await ingestProfileDocument(getDb(), createLlm({ db: createPgLlmDb(getDb()) }), {
      fileName: file.name,
      format,
      bytes,
    });
    return NextResponse.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'ingest failed';
    return NextResponse.json({ error: message }, { status: 422 });
  }
}
