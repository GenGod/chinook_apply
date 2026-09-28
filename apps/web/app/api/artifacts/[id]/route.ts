// S5 T7: GET /api/artifacts/[id] — full artifact (metadata + generated
// content + validation violations) by id; 404 for an unknown id.
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getArtifactContent } from '@chinook/core';
import { getDb } from '@/lib/db';

export const dynamic = 'force-dynamic';

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const uuid = z.uuid().safeParse(id);
  if (!uuid.success) return NextResponse.json({ error: 'invalid artifact id' }, { status: 400 });

  const artifact = await getArtifactContent(getDb(), uuid.data);
  if (!artifact) return NextResponse.json({ error: 'not found' }, { status: 404 });
  return NextResponse.json({ artifact });
}
