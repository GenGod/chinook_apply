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
  jobId: string;
  kind: string;
  version: number;
  status: string;
  content: unknown;
  violations: string[];
  /** Render artifacts only: relative path of the rendered file. */
  contentPath: string | null;
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

/** S22: a concurrent saver can race on the same (job_id, kind) version slot. */
const SAVE_ATTEMPTS = 3;

async function insertNextArtifactVersion(
  db: Kysely<Database>,
  input: {
    jobId: string;
    kind: 'resume' | 'cover_letter';
    status: 'valid' | 'invalid';
    content: unknown;
    validation: ValidationReport;
    llmRunId: number;
  },
  id: string,
  attemptsLeft: number,
): Promise<ArtifactView> {
  const rows = await db.transaction().execute(async (trx) => {
    const maxRow = await trx
      .selectFrom('artifact')
      .select((eb) => eb.fn.max<number | null>('version').as('max_version'))
      .where('job_id', '=', input.jobId)
      .where('kind', '=', input.kind)
      .executeTakeFirstOrThrow();
    const version = (maxRow.max_version ?? 0) + 1;
    // on-conflict-do-nothing turns a lost version race into an empty result —
    // the caller retries with a freshly computed version, no raw error leaks.
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
      .onConflict((oc) => oc.columns(['job_id', 'kind', 'version']).doNothing())
      .returningAll()
      .execute();
  });
  if (rows.length > 0) return toView(rows[0]!);
  if (attemptsLeft <= 1) {
    throw new Error(`artifact version race: concurrent saves exhausted ${SAVE_ATTEMPTS} attempts`);
  }
  return insertNextArtifactVersion(db, input, id, attemptsLeft - 1);
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
  return insertNextArtifactVersion(db, input, randomUUID(), SAVE_ATTEMPTS);
}

/** All artifact versions of a job, newest first (created DESC, version DESC tie-break), metadata only. */
export async function listArtifacts(db: Kysely<Database>, jobId: string): Promise<ArtifactView[]> {
  const rows = await db
    .selectFrom('artifact')
    .select(['id', 'job_id', 'kind', 'version', 'status', 'validation', 'source_artifact_id', 'created_at'])
    .where('job_id', '=', jobId)
    .orderBy('created_at', 'desc')
    .orderBy('version', 'desc')
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
    .select(['id', 'job_id', 'kind', 'version', 'status', 'content', 'validation', 'source_artifact_id', 'content_path', 'created_at'])
    .where('id', '=', artifactId)
    .executeTakeFirst();
  if (!row) return null;
  return {
    jobId: row.job_id,
    kind: row.kind,
    version: row.version,
    status: row.status,
    content: row.content,
    violations: violationDetails(row.validation),
    contentPath: row.content_path,
  };
}

// --- S6: render artifacts (derived, deterministic) ---

export type RenderFormat = 'docx' | 'pdf';

/**
 * S21: stores one render version of (source artifact, format). The caller
 * derives the version via nextRenderVersion — every render action appends a
 * new version (history), nothing is overwritten. content_path is relative to
 * the artifacts root. UNIQUE(job_id, kind, version) guards duplicates.
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
    version: number;
  },
): Promise<ArtifactView> {
  const row = await db
    .insertInto('artifact')
    .values({
      id: randomUUID(),
      job_id: input.jobId,
      kind: `render_${input.format}` as `render_${RenderFormat}`,
      version: input.version,
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
    })
    .returningAll()
    .executeTakeFirstOrThrow();
  return toView(row);
}

/** Next free render version for (job, kind) = max(existing)+1 (S21 append history). */
export async function nextRenderVersion(
  db: Kysely<Database>,
  jobId: string,
  kind: 'render_docx' | 'render_pdf',
): Promise<number> {
  const row = await db
    .selectFrom('artifact')
    .select((eb) => eb.fn.max<number | null>('version').as('max_version'))
    .where('job_id', '=', jobId)
    .where('kind', '=', kind)
    .executeTakeFirstOrThrow();
  return (row.max_version ?? 0) + 1;
}

/** The LATEST render of (source, format), or null when not rendered yet. */
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
    .orderBy('version', 'desc')
    .executeTakeFirst();
  return row ? toView(row) : null;
}

// --- S8: dispatch audit (email sends) ---

export interface DispatchAttachment {
  kind: 'render_docx' | 'render_pdf';
  artifactId: string;
  filename: string;
  bytes: number;
}

/**
 * Writes one dispatch-audit row (Constitution 8.2: any sent response is
 * reconstructible from records). Metadata only — the email body never lands
 * here. Returns the generated dispatch id.
 */
export async function saveDispatchLog(
  db: Kysely<Database>,
  input: {
    jobId: string;
    applicationId: number | null;
    outcome: 'sent' | 'failed';
    toAddress: string;
    subject: string;
    attachments: DispatchAttachment[];
    smtpMessageId: string | null;
    error: string | null;
  },
): Promise<{ id: number }> {
  const row = await db
    .insertInto('dispatch_log')
    .values({
      job_id: input.jobId,
      application_id: input.applicationId,
      channel: 'email',
      outcome: input.outcome,
      to_address: input.toAddress,
      subject: input.subject,
      attachments: JSON.stringify(input.attachments),
      smtp_message_id: input.smtpMessageId,
      error: input.error,
    })
    .returningAll()
    .executeTakeFirstOrThrow();
  return { id: Number(row.id) };
}

/** Dispatches successfully sent today (channel email) — the art. 4.3 daily cap input. */
export async function countSentToday(db: Kysely<Database>): Promise<number> {
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const row = await db
    .selectFrom('dispatch_log')
    .where('outcome', '=', 'sent')
    .where('channel', '=', 'email')
    .where('created_at', '>=', todayStart)
    .select((eb) => eb.fn.count<number>('id').as('count'))
    .executeTakeFirst();
  return Number(row?.count ?? 0);
}

/** The LATEST render artifact of a job for one render kind (S21 append versions). */
export async function latestRenderArtifactByKind(
  db: Kysely<Database>,
  jobId: string,
  kind: 'render_docx' | 'render_pdf',
): Promise<ArtifactView | null> {
  const row = await db
    .selectFrom('artifact')
    .select(['id', 'job_id', 'kind', 'version', 'status', 'validation', 'source_artifact_id', 'created_at'])
    .where('job_id', '=', jobId)
    .where('kind', '=', kind)
    .orderBy('version', 'desc')
    .executeTakeFirst();
  return row ? toView(row) : null;
}
