// S8 T4: POST /api/jobs/[id]/dispatch — send the application package by email
// (dry-run envelope by default; art. 1.1: this call IS the user's explicit
// approve for ONE dispatch — no delegation).
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { ensureSchema, type Database, type Kysely } from '@chinook/core';
import { getDb } from '@/lib/db';
import {
  sendApplicationEmail,
  InvalidRecipientError,
  DispatchNotFoundError,
  DispatchNotReadyError,
  DispatchLimitError,
  DispatchSendError,
  DispatchIdentityUnavailableError,
  DispatchConfigError,
} from '@/lib/dispatch-service';
import { revealJobApplyMethods } from '@/lib/jobbank-dispatch-service';

export const dynamic = 'force-dynamic';

// The dispatch route owns the newest tables (dispatch_log): ensure the schema
// once per process — the live DB may predate this increment.
let schemaReady: Promise<unknown> | null = null;
function schemaReadyOnce(db: Kysely<Database>): Promise<unknown> {
  schemaReady ??= ensureSchema(db);
  return schemaReady;
}

const Body = z.object({
  // S25: to is optional for Job Bank jobs — the recipient is resolved from the
  // revealed apply panel (cached or fresh reveal). The Send click IS the
  // approve (art. 1.2) for the resolved address, same as for a typed one.
  to: z.string().min(3).optional(),
  kinds: z.array(z.enum(['render_docx', 'render_pdf'])).min(1),
});

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const uuid = z.uuid().safeParse(id);
  if (!uuid.success) return NextResponse.json({ error: 'invalid job id' }, { status: 400 });

  const parsed = Body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: 'invalid body' }, { status: 400 });

  const db = getDb();
  await schemaReadyOnce(db);

  let to = parsed.data.to?.trim();
  if (!to) {
    // Auto-reveal (S25 R6): recipient from the apply panel (cache-first).
    const reveal = await revealJobApplyMethods(db, uuid.data);
    if (!reveal.methods?.email) {
      return NextResponse.json(
        {
          error: 'no recipient available — reveal apply methods first',
          reveal: { status: reveal.status },
        },
        { status: 409 },
      );
    }
    to = reveal.methods.email;
  }

  try {
    const result = await sendApplicationEmail(db, uuid.data, { to, kinds: parsed.data.kinds });
    return NextResponse.json({ dispatch: { id: result.dispatchId }, envelopeTo: result.envelopeTo, mode: process.env.DISPATCH_MODE ?? 'dry-run' });
  } catch (error) {
    if (error instanceof InvalidRecipientError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    if (error instanceof DispatchNotFoundError) {
      return NextResponse.json({ error: 'not found' }, { status: 404 });
    }
    if (error instanceof DispatchNotReadyError) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    if (error instanceof DispatchLimitError) {
      return NextResponse.json({ error: error.message }, { status: 429 });
    }
    if (error instanceof DispatchSendError) {
      return NextResponse.json({ error: error.message }, { status: 502 });
    }
    if (error instanceof DispatchIdentityUnavailableError) {
      return NextResponse.json({ error: error.message }, { status: 503 });
    }
    if (error instanceof DispatchConfigError) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }
    // Server-side log only — no recipient/document content beyond ids.
    console.error(
      '[dispatch] failed:',
      error instanceof Error ? `${error.name}: ${error.message}` : error,
    );
    return NextResponse.json({ error: 'dispatch failed' }, { status: 500 });
  }
}
