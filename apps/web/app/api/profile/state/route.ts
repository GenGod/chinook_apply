// S11: GET /api/profile/state — sources with fact counts + master version
// (metadata only; document contents and master file body never leave the server).
import { NextResponse } from 'next/server';
import { ensureSchema, listProfileSources, type Database, type Kysely } from '@chinook/core';
import { getDb } from '@/lib/db';
import { readMasterRaw } from '@/lib/superprofile-service';

export const dynamic = 'force-dynamic';

let schemaReady: Promise<unknown> | null = null;
function schemaReadyOnce(db: Kysely<Database>): Promise<unknown> {
  schemaReady ??= ensureSchema(db);
  return schemaReady;
}

export async function GET() {
  const db = getDb();
  await schemaReadyOnce(db);
  const [sources, master] = await Promise.all([listProfileSources(db), readMasterRaw()]);
  const version = (master as { version?: unknown } | null)?.version;
  return NextResponse.json({
    sources: sources.map((s) => ({
      id: s.id,
      fileName: s.fileName,
      format: s.format,
      sha256: s.sha256.slice(0, 8),
      textChars: s.textChars,
      factCount: s.factCount,
      createdAt: s.createdAt,
    })),
    masterVersion: typeof version === 'number' ? version : null,
  });
}
