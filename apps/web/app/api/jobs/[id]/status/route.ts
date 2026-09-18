import { NextResponse } from 'next/server';
import { z } from 'zod';
import { setApplicationStatus, TransitionError } from '@chinook/core';
import { getDb } from '@/lib/db';

export const dynamic = 'force-dynamic';

const Body = z.object({
  status: z.enum(['new', 'applying', 'applied', 'interview', 'rejected']),
  channel: z.enum(['manual', 'auto']).optional(),
});

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const uuid = z.uuid().safeParse(id);
  if (!uuid.success) return NextResponse.json({ error: 'invalid job id' }, { status: 400 });

  const parsed = Body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: 'invalid body' }, { status: 400 });

  try {
    const row = await setApplicationStatus(getDb(), uuid.data, parsed.data);
    return NextResponse.json(row);
  } catch (error) {
    if (error instanceof TransitionError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    return NextResponse.json({ error: 'job not found' }, { status: 404 });
  }
}
