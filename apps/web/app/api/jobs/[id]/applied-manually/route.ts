import { NextResponse } from 'next/server';
import { markAppliedManually } from '@chinook/core';
import { z } from 'zod';
import { getDb } from '@/lib/db';

export const dynamic = 'force-dynamic';

const Uuid = z.uuid();

export async function PATCH(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const parsed = Uuid.safeParse(id);
  if (!parsed.success) {
    return NextResponse.json({ error: 'invalid job id' }, { status: 400 });
  }
  try {
    const application = await markAppliedManually(getDb(), parsed.data);
    return NextResponse.json(application);
  } catch {
    return NextResponse.json({ error: 'job not found' }, { status: 404 });
  }
}
