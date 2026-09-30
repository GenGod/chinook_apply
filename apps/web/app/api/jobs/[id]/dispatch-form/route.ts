// S9 T3: POST /api/jobs/[id]/dispatch-form — browser form dispatch (art. 1.1:
// this call is the user's one-time approve; art. 11: browser automation only
// for this explicitly confirmed response, captcha stops the attempt).
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { ensureSchema, type Database, type Kysely } from '@chinook/core';
import { getDb } from '@/lib/db';
import {
  sendWebFormApplication,
  FormNotConfiguredError,
  FormCaptchaStoppedError,
  FormBrowserUnavailableError,
  FormSendError,
} from '@/lib/form-dispatch-service';

export const dynamic = 'force-dynamic';
// Browser automation is slow by nature — give the mock flow headroom.
export const maxDuration = 60;

let schemaReady: Promise<unknown> | null = null;
function schemaReadyOnce(db: Kysely<Database>): Promise<unknown> {
  schemaReady ??= ensureSchema(db);
  return schemaReady;
}

export async function POST(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const uuid = z.uuid().safeParse(id);
  if (!uuid.success) return NextResponse.json({ error: 'invalid job id' }, { status: 400 });

  const db = getDb();
  await schemaReadyOnce(db);
  try {
    const result = await sendWebFormApplication(db, uuid.data);
    return NextResponse.json({
      dispatch: { id: result.dispatchId },
      outcome: result.outcome,
      screenshots: result.screenshots,
    });
  } catch (error) {
    if (error instanceof FormNotConfiguredError) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    if (error instanceof FormCaptchaStoppedError) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    if (error instanceof FormBrowserUnavailableError) {
      return NextResponse.json({ error: error.message }, { status: 503 });
    }
    if (error instanceof FormSendError) {
      return NextResponse.json({ error: error.message }, { status: 502 });
    }
    console.error(
      '[dispatch-form] failed:',
      error instanceof Error ? `${error.name}: ${error.message}` : error,
    );
    return NextResponse.json({ error: 'form dispatch failed' }, { status: 500 });
  }
}
