// S5 T7: GET /api/jobs/[id]/artifacts — artifact versions of one job,
// newest first, metadata only (content stays behind /api/artifacts/[id]).
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { listArtifacts } from '@chinook/core';
import { getDb } from '@/lib/db';

export const dynamic = 'force-dynamic';

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const uuid = z.uuid().safeParse(id);
  if (!uuid.success) return NextResponse.json({ error: 'invalid job id' }, { status: 400 });

  const artifacts = await listArtifacts(getDb(), uuid.data);
  return NextResponse.json({ artifacts });
}
