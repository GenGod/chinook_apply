// S11: profile sources + atomic facts with provenance (B-002 p.1).
// A source is an ingested resume document; a fact is one structured piece
// (skill / experience / education / certification / summary) with a VERBATIM
// excerpt from the source text — the provenance anchor the merge and the
// PO diff rely on. PII lives only here and in the gitignored sources dir.
import { randomUUID } from 'node:crypto';
import type { Kysely } from 'kysely';
import type { Database } from './db';

export type ProfileFactKind = 'summary' | 'skill' | 'experience' | 'education' | 'certification';

export interface ProfileSourceView {
  id: string;
  fileName: string;
  format: string;
  storagePath: string;
  sha256: string;
  textChars: number;
  createdAt: string;
  factCount: number;
}

export interface ProfileFactRow {
  id: string;
  sourceId: string;
  kind: ProfileFactKind;
  payload: unknown;
  excerpt: string;
  createdAt: string;
}

export interface NewProfileFact {
  kind: ProfileFactKind;
  payload: unknown;
  excerpt: string;
}

/** Registers an ingested document; re-upload of the same sha256 returns the existing row. */
export async function saveProfileSource(
  db: Kysely<Database>,
  input: { fileName: string; format: 'docx' | 'pdf' | 'txt'; storagePath: string; sha256: string; textChars: number },
): Promise<ProfileSourceView> {
  const existing = await findProfileSourceByHash(db, input.sha256);
  if (existing) return existing;
  const row = await db
    .insertInto('profile_source')
    .values({
      id: randomUUID(),
      file_name: input.fileName,
      format: input.format,
      storage_path: input.storagePath,
      sha256: input.sha256,
      text_chars: input.textChars,
    })
    .onConflict((oc) => oc.column('sha256').doNothing())
    .returningAll()
    .executeTakeFirst();
  if (row) {
    return {
      id: row.id,
      fileName: row.file_name,
      format: row.format,
      storagePath: row.storage_path,
      sha256: row.sha256,
      textChars: row.text_chars,
      createdAt: row.created_at.toISOString(),
      factCount: 0,
    };
  }
  return (await findProfileSourceByHash(db, input.sha256))!;
}

export async function findProfileSourceByHash(
  db: Kysely<Database>,
  sha256: string,
): Promise<ProfileSourceView | null> {
  const row = await db
    .selectFrom('profile_source')
    .leftJoin('profile_fact', 'profile_fact.source_id', 'profile_source.id')
    .where('sha256', '=', sha256)
    .select((eb) => [
      'profile_source.id',
      'profile_source.file_name',
      'profile_source.format',
      'profile_source.storage_path',
      'profile_source.sha256',
      'profile_source.text_chars',
      'profile_source.created_at',
      eb.fn.count<number>('profile_fact.id').as('fact_count'),
    ])
    .groupBy([
      'profile_source.id',
      'profile_source.file_name',
      'profile_source.format',
      'profile_source.storage_path',
      'profile_source.sha256',
      'profile_source.text_chars',
      'profile_source.created_at',
    ])
    .executeTakeFirst();
  return row ? toSourceView(row) : null;
}

/** All ingested sources, newest first, with fact counts. */
export async function listProfileSources(db: Kysely<Database>): Promise<ProfileSourceView[]> {
  const rows = await db
    .selectFrom('profile_source')
    .leftJoin('profile_fact', 'profile_fact.source_id', 'profile_source.id')
    .select((eb) => [
      'profile_source.id',
      'profile_source.file_name',
      'profile_source.format',
      'profile_source.storage_path',
      'profile_source.sha256',
      'profile_source.text_chars',
      'profile_source.created_at',
      eb.fn.count<number>('profile_fact.id').as('fact_count'),
    ])
    .groupBy('profile_source.id')
    .orderBy('profile_source.created_at', 'desc')
    .execute();
  return rows.map(toSourceView);
}

/** Saves a validated fact batch for one source; returns the stored count. */
export async function saveProfileFacts(
  db: Kysely<Database>,
  sourceId: string,
  facts: NewProfileFact[],
): Promise<number> {
  if (facts.length === 0) return 0;
  const rows = await db
    .insertInto('profile_fact')
    .values(
      facts.map((f) => ({
        id: randomUUID(),
        source_id: sourceId,
        kind: f.kind,
        payload: JSON.stringify(f.payload),
        excerpt: f.excerpt,
      })),
    )
    .returningAll()
    .execute();
  return rows.length;
}

/** All facts of one source (payload parsed), oldest first for stable diffs. */
export async function listProfileFacts(db: Kysely<Database>, sourceId: string): Promise<ProfileFactRow[]> {
  const rows = await db
    .selectFrom('profile_fact')
    .select(['id', 'source_id', 'kind', 'payload', 'excerpt', 'created_at'])
    .where('source_id', '=', sourceId)
    .orderBy('created_at', 'asc')
    .limit(500)
    .execute();
  return (rows as Array<{ id: string; source_id: string; kind: string; payload: unknown; excerpt: string; created_at: Date }>).map((r) => ({
    id: r.id,
    sourceId: r.source_id,
    kind: r.kind as ProfileFactKind,
    payload: r.payload,
    excerpt: r.excerpt,
    createdAt: r.created_at.toISOString(),
  }));
}

/** Every fact across all sources (for the superprofile proposal). */
export async function listAllProfileFacts(db: Kysely<Database>): Promise<ProfileFactRow[]> {
  const rows = await db
    .selectFrom('profile_fact')
    .select(['id', 'source_id', 'kind', 'payload', 'excerpt', 'created_at'])
    .orderBy('created_at', 'asc')
    .limit(2000)
    .execute();
  return (rows as Array<{ id: string; source_id: string; kind: string; payload: unknown; excerpt: string; created_at: Date }>).map((r) => ({
    id: r.id,
    sourceId: r.source_id,
    kind: r.kind as ProfileFactKind,
    payload: r.payload,
    excerpt: r.excerpt,
    createdAt: r.created_at.toISOString(),
  }));
}

function toSourceView(row: {
  id: string;
  file_name: string;
  format: string;
  storage_path: string;
  sha256: string;
  text_chars: number;
  created_at: Date;
  fact_count: string | number;
}): ProfileSourceView {
  return {
    id: row.id,
    fileName: row.file_name,
    format: row.format,
    storagePath: row.storage_path,
    sha256: row.sha256,
    textChars: row.text_chars,
    createdAt: row.created_at.toISOString(),
    factCount: Number(row.fact_count ?? 0),
  };
}
