// S6 T7: GET /api/artifacts/[id]/file — streams a rendered DOCX/PDF for
// download (render artifacts only). The filename is derived from the validated
// content_path (uuid folder + whitelisted name) — no PII in the header.
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { readRenderFile } from '@/lib/render-service';
import { getDb } from '@/lib/db';

export const dynamic = 'force-dynamic';

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const uuid = z.uuid().safeParse(id);
  if (!uuid.success) return NextResponse.json({ error: 'invalid artifact id' }, { status: 400 });

  const file = await readRenderFile(getDb(), uuid.data);
  if (!file) return NextResponse.json({ error: 'not found' }, { status: 404 });

  return new Response(new Uint8Array(file.buffer), {
    headers: {
      'content-type': file.contentType,
      'content-disposition': `attachment; filename="${file.filename}"`,
      'content-length': String(file.buffer.length),
    },
  });
}
