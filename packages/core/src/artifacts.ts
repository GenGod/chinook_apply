import { randomUUID } from 'node:crypto';
import type { Kysely } from 'kysely';
import type { Database } from './db';
import type { Violation, ValidationReport } from './generation-validators';

/**
 * Artifact metadata as seen by lists/UI — no content field: PII (resume and
 * cover-letter bodies) leaves the repository only via getArtifactContent.
 */
export interface ArtifactView {
  id: string;
  jobId: string;
  kind: string;
  version: number;
  status: string;
  created: string;
  violations: string[];
}

/** Metadata plus the generated content, for artifact-id-scoped reads only. */
export interface ArtifactContent {
  kind: string;
  version: number;
  status: string;
  content: unknown;
  violations: string[];
}

interface ArtifactSelectRow {
  id: string;
  job_id: string;
  kind: string;
  version: number;
  status: string;
  validation: unknown;
  created_at: Date;
}

/** Violation detail strings from a stored ValidationReport JSONB ({valid, violations}). */
function violationDetails(validation: unknown): string[] {
  if (validation == null || typeof validation !== 'object') return [];
  const violations = (validation as { violations?: unknown }).violations;
  if (!Array.isArray(violations)) return [];
  return violations.map((v) =>
    v != null && typeof v === 'object' && typeof (v as Violation).detail === 'string'
      ? (v as Violation).detail
      : String(v),
  );
}

function toView(row: ArtifactSelectRow): ArtifactView {
  return {
    id: row.id,
    jobId: row.job_id,
    kind: row.kind,
    version: row.version,
    status: row.status,
    created: row.created_at.toISOString(),
    violations: violationDetails(row.validation),
  };
}

/**
 * Stores a generated artifact as the next version for (job_id, kind).
 * Version = max(version)+1 computed inside a transaction; the whole
 * ValidationReport ({valid, violations}) is persisted as JSONB in `validation`.
 */
export async function saveArtifact(
  db: Kysely<Database>,
  input: {
    jobId: string;
    kind: 'resume' | 'cover_letter';
    status: 'valid' | 'invalid';
    content: unknown;
    validation: ValidationReport;
    llmRunId: number;
  },
): Promise<ArtifactView> {
  const id = randomUUID();
  const row = await db.transaction().execute(async (trx) => {
    const maxRow = await trx
      .selectFrom('artifact')
      .select((eb) => eb.fn.max<number | null>('version').as('max_version'))
      .where('job_id', '=', input.jobId)
      .where('kind', '=', input.kind)
      .executeTakeFirstOrThrow();
    const version = (maxRow.max_version ?? 0) + 1;
    return trx
      .insertInto('artifact')
      .values({
        id,
        job_id: input.jobId,
        kind: input.kind,
        version,
        status: input.status,
        content: JSON.stringify(input.content),
        validation: JSON.stringify({
          valid: input.validation.valid,
          violations: input.validation.violations,
        }),
        llm_run_id: input.llmRunId,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
  });
  return toView(row);
}

/** All artifact versions of a job, newest first; metadata only (no content). */
export async function listArtifacts(db: Kysely<Database>, jobId: string): Promise<ArtifactView[]> {
  const rows = await db
    .selectFrom('artifact')
    .select(['id', 'job_id', 'kind', 'version', 'status', 'validation', 'created_at'])
    .where('job_id', '=', jobId)
    .orderBy('created_at', 'desc')
    .execute();
  return rows.map(toView);
}

/** Full artifact (metadata + generated content) by id, or null when unknown. */
export async function getArtifactContent(
  db: Kysely<Database>,
  artifactId: string,
): Promise<ArtifactContent | null> {
  const row = await db
    .selectFrom('artifact')
    .select(['id', 'job_id', 'kind', 'version', 'status', 'content', 'validation', 'created_at'])
    .where('id', '=', artifactId)
    .executeTakeFirst();
  if (!row) return null;
  return {
    kind: row.kind,
    version: row.version,
    status: row.status,
    content: row.content,
    violations: violationDetails(row.validation),
  };
}
