// S6 T7: POST /api/artifacts/[id]/render — deterministic DOCX+PDF rendering of
// one valid generated artifact (S5). No LLM involved; two render artifact rows
// are upserted per (source, format) and the files land in data/artifacts.
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { renderArtifact, RenderSourceNotFoundError, RenderNotRenderableError, RenderIdentityUnavailableError } from '@/lib/render-service';
import { getDb } from '@/lib/db';

export const dynamic = 'force-dynamic';

export async function POST(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const uuid = z.uuid().safeParse(id);
  if (!uuid.success) return NextResponse.json({ error: 'invalid artifact id' }, { status: 400 });

  const db = getDb();
  try {
    const { artifacts } = await renderArtifact(db, uuid.data);
    return NextResponse.json({ artifacts });
  } catch (error) {
    if (error instanceof RenderSourceNotFoundError) {
      return NextResponse.json({ error: 'not found' }, { status: 404 });
    }
    if (error instanceof RenderNotRenderableError) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    if (error instanceof RenderIdentityUnavailableError) {
      return NextResponse.json({ error: error.message }, { status: 503 });
    }
    // Server-side log only — document content never reaches logs (art. 3.2).
    console.error(
      '[render] failed:',
      error instanceof Error ? `${error.name}: ${error.message}` : error,
    );
    return NextResponse.json({ error: 'render failed' }, { status: 500 });
  }
}
