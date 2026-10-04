// S25 T3: POST /api/jobs/[id]/reveal-apply — on-demand раскрытие панели подачи
// Job Bank (read-only: ничего не отправляет), кэш в raw. Методы из запроса
// НЕ принимаются — только выдача (поверхность подмены цели закрыта).
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { ensureSchema, type Database, type Kysely } from '@chinook/core';
import { getDb } from '@/lib/db';
import { revealJobApplyMethods, RevealJobNotFoundError, RevealBrowserUnavailableError } from '@/lib/jobbank-dispatch-service';

export const dynamic = 'force-dynamic';

// The route owns job-raw writes: ensure the schema once per process — the
// live DB may predate this increment.
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
    const result = await revealJobApplyMethods(db, uuid.data);
    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof RevealJobNotFoundError) {
      return NextResponse.json({ error: 'not found' }, { status: 404 });
    }
    if (error instanceof RevealBrowserUnavailableError) {
      return NextResponse.json({ error: error.message }, { status: 503 });
    }
    console.error('[reveal-apply] failed:', error instanceof Error ? error.message : error);
    return NextResponse.json({ error: 'reveal failed' }, { status: 500 });
  }
}
