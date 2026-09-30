// S8 T3: dispatch orchestration — send the application package (rendered
// attachments + cover-letter body) by email, with audit (dispatch_log) and the
// art. 4.3 daily cap.
//
// Safety by construction (spec R2): DISPATCH_MODE=dry-run (the default)
// REWRITES the SMTP envelope recipient to dispatch-sink@localhost — the letter
// physically cannot reach an employer even with live SMTP credentials
// configured. The visible To: header keeps the real recipient for review.
// Live mode sends to the real envelope and requires full SMTP config.
//
// Transport is injectable (opts.createTransport) so unit/integration tests run
// without network; real deployments use nodemailer against Mailpit (dev) or
// Gmail relay (live).
import process from 'node:process';
import type { Kysely } from 'kysely';
import {
  buildDispatchEmail,
  countSentToday,
  latestRenderArtifactByKind,
  saveDispatchLog,
  renderIdentityFromContent,
  normalizeLetter,
  setApplicationStatus,
  type Database,
  type DispatchAttachment,
  type RenderIdentity,
} from '@chinook/core';
import { loadMasterIdentity } from './generation-service';
import { readRenderFile } from './render-service';
import { resolveArtifactsDir } from './render-storage';

export type DispatchMode = 'dry-run' | 'live';
export type RenderKind = 'render_docx' | 'render_pdf';

/** HTTP 400 — the recipient is not a valid email address. */
export class InvalidRecipientError extends Error {
  readonly status = 400;
  constructor(message: string) {
    super(message);
    this.name = 'InvalidRecipientError';
  }
}

/** HTTP 404 — job unknown. */
export class DispatchNotFoundError extends Error {
  readonly status = 404;
  constructor(message: string) {
    super(message);
    this.name = 'DispatchNotFoundError';
  }
}

/** HTTP 409 — nothing to attach: no render artifacts for the job yet. */
export class DispatchNotReadyError extends Error {
  readonly status = 409;
  constructor(message: string) {
    super(message);
    this.name = 'DispatchNotReadyError';
  }
}

/** HTTP 429 — art. 4.3 daily cap reached. */
export class DispatchLimitError extends Error {
  readonly status = 429;
  constructor(message: string) {
    super(message);
    this.name = 'DispatchLimitError';
  }
}

/** HTTP 502 — SMTP transport failed; the failed dispatch is audited. */
export class DispatchSendError extends Error {
  readonly status = 502;
  constructor(message: string) {
    super(message);
    this.name = 'DispatchSendError';
  }
}

/** HTTP 503 — no identity available for the letter header/body. */
export class DispatchIdentityUnavailableError extends Error {
  readonly status = 503;
  constructor(message: string) {
    super(message);
    this.name = 'DispatchIdentityUnavailableError';
  }
}

/** HTTP 500 — SMTP configuration incomplete for the requested mode. */
export class DispatchConfigError extends Error {
  readonly status = 500;
  constructor(message: string) {
    super(message);
    this.name = 'DispatchConfigError';
  }
}

const EMAIL_RE = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;
const DEFAULT_DAILY_LIMIT = 10;

interface SmtpConfig {
  host: string;
  port: number;
  secure: boolean;
  user: string | null;
  pass: string | null;
  from: string;
  mode: DispatchMode;
  limit: number;
}

/** Validates the merged env+opts config at send time (opts can fill env gaps). */
function validateSmtpConfig(config: SmtpConfig): SmtpConfig {
  if (config.from === '') {
    throw new DispatchConfigError('SMTP_FROM is required (e.g. "Name <address@example.com>")');
  }
  if (config.mode === 'live' && (config.user === null || config.pass === null)) {
    throw new DispatchConfigError('live dispatch requires SMTP_USER and SMTP_PASS');
  }
  return config;
}

interface TransportMail {
  from: string;
  to: string;
  subject: string;
  text: string;
  attachments: Array<{ filename: string; content: Buffer; contentType: string }>;
  envelope?: { from: string; to: string[] };
}

export interface TransportLike {
  sendMail(mail: TransportMail): Promise<{ messageId: string }>;
}

type CreateTransportFn = (config: SmtpConfig) => TransportLike | Promise<TransportLike>;

function readSmtpConfig(): SmtpConfig {
  const mode = (process.env.DISPATCH_MODE ?? 'dry-run') as DispatchMode;
  const limitRaw = process.env.DISPATCH_DAILY_LIMIT;
  const limit = limitRaw !== undefined ? Number(limitRaw) : DEFAULT_DAILY_LIMIT;
  if (!Number.isFinite(limit) || limit <= 0) {
    throw new DispatchConfigError(`DISPATCH_DAILY_LIMIT must be a positive number, got "${limitRaw ?? ''}"`);
  }
  return {
    host: process.env.SMTP_HOST ?? 'localhost',
    port: Number(process.env.SMTP_PORT ?? 587),
    secure: (process.env.SMTP_SECURE ?? 'false') === 'true',
    user: process.env.SMTP_USER ?? null,
    pass: process.env.SMTP_PASS ?? null,
    from: process.env.SMTP_FROM ?? '',
    mode,
    limit,
  };
}

const CONTENT_TYPE_BY_KIND: Record<RenderKind, string> = {
  render_docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  render_pdf: 'application/pdf',
};

/**
 * Sends the application email for one job:
 *   1. recipient/job/limit/identity/attachments checks (400/404/429/503/409);
 *   2. deterministic subject + body (cover letter text or short note);
 *   3. nodemailer send — dry-run rewrites the ENVELOPE to dispatch-sink@localhost;
 *   4. success: dispatch_log(sent) + application(applied/auto) unless already applied;
 *      failure: dispatch_log(failed) + 502.
 */
export async function sendApplicationEmail(
  db: Kysely<Database>,
  jobId: string,
  input: { to: string; kinds: RenderKind[] },
  opts?: {
    mode?: DispatchMode;
    limit?: number;
    createTransport?: CreateTransportFn;
    loadMaster?: () => RenderIdentity | null;
    smtp?: Partial<SmtpConfig>;
  },
): Promise<{ dispatchId: number; messageId: string | null; envelopeTo: string; applicationId: number | null }> {
  const to = input.to.trim();
  if (!EMAIL_RE.test(to)) throw new InvalidRecipientError(`invalid recipient address: "${to}"`);
  if (input.kinds.length === 0) throw new DispatchNotReadyError('no attachment kinds requested');

  const job = await db
    .selectFrom('job')
    .select(['id', 'title', 'employer'])
    .where('id', '=', jobId)
    .executeTakeFirst();
  if (!job) throw new DispatchNotFoundError(`job ${jobId} not found`);

  const config = validateSmtpConfig({ ...readSmtpConfig(), ...(opts?.smtp ?? {}) });
  const mode = opts?.mode ?? config.mode;
  const limit = opts?.limit ?? config.limit;
  const sentToday = await countSentToday(db);
  if (sentToday >= limit) {
    throw new DispatchLimitError(
      `daily dispatch limit reached: ${sentToday} sent today, cap is ${limit}`,
    );
  }

  // Attachments: latest render per requested kind, bytes from storage.
  const attachments: DispatchAttachment[] = [];
  const mailAttachments: Array<{ filename: string; content: Buffer; contentType: string }> = [];
  for (const kind of input.kinds) {
    const view = await latestRenderArtifactByKind(db, jobId, kind);
    if (!view) continue;
    const file = await readRenderFile(db, view.id);
    if (!file) continue;
    attachments.push({
      kind,
      artifactId: view.id,
      filename: file.filename,
      bytes: file.buffer.length,
    });
    mailAttachments.push({ filename: file.filename, content: file.buffer, contentType: CONTENT_TYPE_BY_KIND[kind] });
  }
  if (attachments.length === 0) {
    throw new DispatchNotReadyError('render the documents first — nothing to attach (Documents section)');
  }

  // Identity for the letter (after the 409 nothing-to-attach check): the
  // SOURCE resume artifact's content snapshot first, master file second.
  const sourceResume = await db
    .selectFrom('artifact')
    .where('job_id', '=', jobId)
    .where('kind', '=', 'resume')
    .where('status', '=', 'valid')
    .orderBy('created_at', 'desc')
    .orderBy('version', 'desc')
    .select('content')
    .executeTakeFirst();
  const identityFromContent = sourceResume ? renderIdentityFromContent(sourceResume.content) : null;
  const identity: RenderIdentity | null =
    identityFromContent ?? (opts?.loadMaster ? opts.loadMaster() : loadMasterIdentity());
  if (!identity) {
    throw new DispatchIdentityUnavailableError(
      'no candidate identity available (identity comes from the artifact snapshot or the master profile)',
    );
  }

  // Body: the latest valid cover letter text, or the deterministic note.
  const coverSource = await db
    .selectFrom('artifact')
    .where('job_id', '=', jobId)
    .where('kind', '=', 'cover_letter')
    .where('status', '=', 'valid')
    .selectAll()
    .orderBy('created_at', 'desc')
    .orderBy('version', 'desc')
    .executeTakeFirst();
  const coverText = coverSource ? normalizeLetter(coverSource.content) : null;
  const email = buildDispatchEmail({ title: job.title, employer: job.employer }, identity, coverText);

  const createTransport: CreateTransportFn =
    opts?.createTransport ??
    (async (smtpConfig) => {
      const nodemailer = (await import('nodemailer')).default;
      return nodemailer.createTransport({
        host: smtpConfig.host,
        port: smtpConfig.port,
        secure: smtpConfig.secure,
        auth: smtpConfig.user && smtpConfig.pass ? { user: smtpConfig.user, pass: smtpConfig.pass } : undefined,
      }) as unknown as TransportLike;
    });
  const transport = await createTransport(config);

  // Safety by construction: dry-run sends to the sink envelope; the visible
  // To: header always shows the real recipient for review (Constitution 1.3).
  const envelopeTo = mode === 'dry-run' ? 'dispatch-sink@localhost' : to;

  let messageId: string | null;
  try {
    const result = await transport.sendMail({
      from: config.from,
      to,
      subject: email.subject,
      text: email.text,
      attachments: mailAttachments,
      // Explicit envelope in BOTH modes — deterministic audit trail; dry-run
      // routes to the sink, live routes to the real recipient.
      envelope: { from: config.from, to: [envelopeTo] },
    });
    messageId = result.messageId ?? null;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const logged = await saveDispatchLog(db, {
      jobId,
      applicationId: null,
      outcome: 'failed',
      toAddress: to,
      subject: email.subject,
      attachments,
      smtpMessageId: null,
      error: message.slice(0, 500),
    });
    void logged;
    throw new DispatchSendError(`smtp send failed: ${message.slice(0, 200)}`);
  }

  // Audit first, then board state. If the job is already applied (any channel)
  // the board stays untouched — it is already in an Applied column.
  let applicationId: number | null;
  const current = await db
    .selectFrom('application')
    .select(['id', 'status', 'channel'])
    .where('job_id', '=', jobId)
    .executeTakeFirst();
  if (current?.status === 'applied') {
    applicationId = current.id;
  } else {
    try {
      const row = await setApplicationStatus(db, jobId, { status: 'applied', channel: 'auto' });
      applicationId = row.id;
    } catch {
      applicationId = null; // board transition refused — dispatch itself succeeded
    }
  }

  const dispatch = await saveDispatchLog(db, {
    jobId,
    applicationId,
    outcome: 'sent',
    toAddress: to,
    subject: email.subject,
    attachments,
    smtpMessageId: messageId,
    error: null,
  });

  return { dispatchId: dispatch.id, messageId, envelopeTo, applicationId };
}

// resolveArtifactsDir is re-exported for tests that stage fixture files.
export { resolveArtifactsDir };
