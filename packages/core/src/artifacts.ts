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
  /** Render artifacts only: the resume/cover artifact this row was rendered from. */
  sourceArtifactId: string | null;
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
  source_artifact_id: string | null;
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
    sourceArtifactId: row.source_artifact_id,
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
    .select(['id', 'job_id', 'kind', 'version', 'status', 'validation', 'source_artifact_id', 'created_at'])
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

// --- S6: render artifacts (derived, deterministic) ---

export type RenderFormat = 'docx' | 'pdf';

/**
 * Stores (or updates) the render artifact of one (source artifact, format).
 * Renders are derived and deterministic, so there is exactly one row per
 * (source, format) with version=1 — re-rendering upserts in place instead of
 * spawning version clones. content_path is relative to the artifacts root.
 */
export async function saveRenderArtifact(
  db: Kysely<Database>,
  input: {
    jobId: string;
    sourceArtifactId: string;
    sourceKind: 'resume' | 'cover_letter';
    sourceVersion: number;
    format: RenderFormat;
    contentPath: string;
  },
): Promise<ArtifactView> {
  const values = {
    id: randomUUID(),
    job_id: input.jobId,
    kind: `render_${input.format}` as `render_${RenderFormat}`,
    version: 1,
    status: 'valid' as const,
    content: JSON.stringify({
      format: input.format,
      sourceKind: input.sourceKind,
      sourceVersion: input.sourceVersion,
    }),
    validation: JSON.stringify({ valid: true, violations: [] }),
    llm_run_id: null,
    source_artifact_id: input.sourceArtifactId,
    content_path: input.contentPath,
  };
  const row = await db
    .insertInto('artifact')
    .values(values)
    .onConflict((oc) =>
      oc.columns(['job_id', 'kind', 'version']).doUpdateSet({
        content: values.content,
        validation: values.validation,
        source_artifact_id: values.source_artifact_id,
        content_path: values.content_path,
        created_at: new Date(),
      }),
    )
    .returningAll()
    .executeTakeFirstOrThrow();
  return toView(row);
}

/** The render artifact of one (source, format), or null when not rendered yet. */
export async function findRenderArtifact(
  db: Kysely<Database>,
  sourceArtifactId: string,
  format: RenderFormat,
): Promise<ArtifactView | null> {
  const row = await db
    .selectFrom('artifact')
    .select(['id', 'job_id', 'kind', 'version', 'status', 'validation', 'source_artifact_id', 'created_at'])
    .where('source_artifact_id', '=', sourceArtifactId)
    .where('kind', '=', `render_${format}`)
    .executeTakeFirst();
  return row ? toView(row) : null;
}
