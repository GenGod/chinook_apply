// S9 T2: browser form dispatch — Playwright fills the target form with the
// approved package (identity + cover text + resume PDF attachment), takes
// before/filled/submitted screenshots (Constitution 11.2), STOPS immediately
// on any captcha marker before filling (Constitution 11.3), and audits every
// attempt in dispatch_log (channel='form').
//
// The form target comes ONLY from job.raw.formConfig (never from a client
// request). The browser launcher is injectable for tests.
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Kysely } from 'kysely';
import {
  buildFormValues,
  detectCaptcha,
  latestRenderArtifactByKind,
  saveDispatchLog,
  validateFormConfig,
  normalizeLetter,
  renderIdentityFromContent,
  setApplicationStatus,
  countSentToday,
  type Database,
  type FormConfig,
  type RenderIdentity,
} from '@chinook/core';
import { loadMasterIdentity } from './generation-service';
import { readRenderFile } from './render-service';
import { resolveArtifactsDir } from './render-storage';

/** HTTP 409 — the job has no formConfig in raw (web-form dispatch not offered). */
export class FormNotConfiguredError extends Error {
  readonly status = 409;
  constructor(message: string) {
    super(message);
    this.name = 'FormNotConfiguredError';
  }
}

/** HTTP 409 — captcha detected before filling: attempt stopped (art. 11.3). */
export class FormCaptchaStoppedError extends Error {
  readonly status = 409;
  constructor(message: string) {
    super(message);
    this.name = 'FormCaptchaStoppedError';
  }
}

/** HTTP 503 — no browser available in this deployment. */
export class FormBrowserUnavailableError extends Error {
  readonly status = 503;
  constructor(message: string) {
    super(message);
    this.name = 'FormBrowserUnavailableError';
  }
}

/** HTTP 502 — the form flow failed after navigation; attempt is audited. */
export class FormSendError extends Error {
  readonly status = 502;
  constructor(message: string) {
    super(message);
    this.name = 'FormSendError';
  }
}

export interface BrowserPageLike {
  goto(url: string): Promise<unknown>;
  content(): Promise<string>;
  fill(selector: string, value: string): Promise<void>;
  setInputFiles(selector: string, files: Array<{ name: string; mimeType: string; buffer: Buffer }>): Promise<void>;
  click(selector: string): Promise<void>;
  waitForSelector(selector: string, options?: { timeout?: number }): Promise<unknown>;
  screenshot(options: { path: string }): Promise<void>;
  close(): Promise<void>;
}

export interface BrowserLike {
  newPage(): Promise<BrowserPageLike>;
  close(): Promise<void>;
}

export type LaunchBrowserFn = () => Promise<BrowserLike>;

async function defaultLaunchBrowser(): Promise<BrowserLike> {
  try {
    const { chromium } = await import('playwright');
    return (await chromium.launch()) as unknown as BrowserLike;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new FormBrowserUnavailableError(`browser unavailable: ${detail.slice(0, 160)}`);
  }
}

/** Mock-form default selectors (config selectors override these). */
const DEFAULT_SELECTORS: Required<Pick<FormConfig['selectors'], 'name' | 'email' | 'message' | 'file' | 'submit'>> = {
  name: '[data-form="name"]',
  email: '[data-form="email"]',
  message: '[data-form="message"]',
  file: '[data-form="file"]',
  submit: '[data-form="submit"]',
};

async function screenshot(page: BrowserPageLike, dir: string, name: string): Promise<string> {
  const relPath = join('form', name);
  await mkdir(join(dir, 'form'), { recursive: true });
  await page.screenshot({ path: join(dir, relPath) });
  return relPath;
}

/**
 * Fills the configured web form with the approved package and submits it.
 * Captcha on the page → the attempt is audited as 'skipped' and NOTHING is
 * filled or submitted (art. 11.3).
 */
export async function sendWebFormApplication(
  db: Kysely<Database>,
  jobId: string,
  opts?: {
    mode?: 'dry-run' | 'live';
    limit?: number;
    launchBrowser?: LaunchBrowserFn;
    loadMaster?: () => RenderIdentity | null;
    artifactsDir?: string;
  },
): Promise<{ dispatchId: number; outcome: 'sent' | 'skipped'; screenshots: string[]; applicationId: number | null }> {
  const job = await db
    .selectFrom('job')
    .select(['id', 'title', 'employer', 'raw'])
    .where('id', '=', jobId)
    .executeTakeFirst();
  if (!job) throw new FormNotConfiguredError(`job ${jobId} not found`);

  const config: FormConfig | null = validateFormConfig((job.raw as Record<string, unknown> | null)?.formConfig);
  if (!config) {
    throw new FormNotConfiguredError('web-form dispatch is not configured for this job');
  }

  const limit = opts?.limit ?? 10;
  const sentToday = await countSentToday(db);
  if (sentToday >= limit) {
    throw new FormNotConfiguredError(`daily dispatch limit reached: ${sentToday} sent today, cap is ${limit}`);
  }

  // Identity: the SOURCE resume artifact's content snapshot, master file second.
  const sourceResume = await db
    .selectFrom('artifact')
    .where('job_id', '=', jobId)
    .where('kind', '=', 'resume')
    .where('status', '=', 'valid')
    .orderBy('created_at', 'desc')
    .orderBy('version', 'desc')
    .select('content')
    .executeTakeFirst();
  const identityFromContent = sourceResume ? renderIdentityFromContentSafe(sourceResume.content) : null;
  const identity: RenderIdentity | null =
    identityFromContent ?? (opts?.loadMaster ? opts.loadMaster() : loadMasterIdentity());
  if (!identity) {
    throw new FormNotConfiguredError('no candidate identity available (render documents first)');
  }

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

  const pdfView = await latestRenderArtifactByKind(db, jobId, 'render_pdf');
  const pdfFile = pdfView ? await readRenderFile(db, pdfView.id, { artifactsDir: opts?.artifactsDir }) : null;
  if (!pdfFile) {
    throw new FormNotConfiguredError('render the resume (PDF) first — nothing to attach');
  }

  const values = buildFormValues(identity, coverText, { title: job.title, employer: job.employer });
  const dir = resolveArtifactsDir(opts?.artifactsDir);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const base = `${jobId.slice(0, 8)}-${stamp}`;
  const screenshots: string[] = [];
  let browser: BrowserLike;
  try {
    browser = await (opts?.launchBrowser ?? defaultLaunchBrowser)();
  } catch (error) {
    if (error instanceof FormBrowserUnavailableError) throw error;
    const detail = error instanceof Error ? error.message : String(error);
    throw new FormBrowserUnavailableError(`browser unavailable: ${detail.slice(0, 160)}`);
  }

  try {
    const page = await browser.newPage();
    try {
      await page.goto(config.url);
      screenshots.push(await screenshot(page, dir, `${base}-before.png`));

      // Art. 11.3: captcha → stop BEFORE any filling or submission.
      const captcha = detectCaptcha(await page.content());
      if (captcha !== null) {
        const logged = await saveDispatchLog(db, {
          jobId,
          applicationId: null,
          outcome: 'skipped',
          toAddress: config.url,
          subject: `Web form application for ${job.title}`,
          attachments: [],
          smtpMessageId: null,
          error: `captcha detected: ${captcha} — manual fallback (art. 11.3)`,
          channel: 'form',
          screenshotPaths: screenshots,
        });
        void logged;
        throw new FormCaptchaStoppedError(
          `captcha detected (${captcha}): attempt stopped before filling — send manually (art. 11.3)`,
        );
      }

      const selectors = { ...DEFAULT_SELECTORS, ...config.selectors };
      await page.fill(selectors.name, values.name);
      if (values.email !== '') await page.fill(selectors.email, values.email);
      await page.fill(selectors.message, values.message);
      await page.setInputFiles(selectors.file, [
        { name: pdfFile.filename, mimeType: 'application/pdf', buffer: pdfFile.buffer },
      ]);
      screenshots.push(await screenshot(page, dir, `${base}-filled.png`));

      await page.click(selectors.submit);
      await page.waitForSelector('text=' + (config.successText ?? 'Thank you'), { timeout: 10_000 });
      screenshots.push(await screenshot(page, dir, `${base}-submitted.png`));

      let applicationId: number | null = null;
      const current = await db
        .selectFrom('application')
        .select(['id', 'status'])
        .where('job_id', '=', jobId)
        .executeTakeFirst();
      if (current?.status === 'applied') {
        applicationId = current.id;
      } else {
        try {
          const row = await setApplicationStatus(db, jobId, { status: 'applied', channel: 'auto' });
          applicationId = row.id;
        } catch {
          applicationId = null;
        }
      }

      const logged = await saveDispatchLog(db, {
        jobId,
        applicationId,
        outcome: 'sent',
        toAddress: config.url,
        subject: `Web form application for ${job.title}`,
        attachments: [],
        smtpMessageId: null,
        error: null,
        channel: 'form',
        screenshotPaths: screenshots,
      });
      return { dispatchId: logged.id, outcome: 'sent', screenshots, applicationId };
    } catch (error) {
      if (error instanceof FormCaptchaStoppedError) throw error; // audited upstream
      const message = error instanceof Error ? error.message : String(error);
      const logged = await saveDispatchLog(db, {
        jobId,
        applicationId: null,
        outcome: 'failed',
        toAddress: config.url,
        subject: `Web form application for ${job.title}`,
        attachments: [],
        smtpMessageId: null,
        error: message.slice(0, 500),
        channel: 'form',
        screenshotPaths: screenshots,
      });
      void logged;
      throw new FormSendError(`form dispatch failed: ${message.slice(0, 200)}`);
    } finally {
      await page.close();
    }
  } finally {
    await browser.close();
  }
}

// Local helper: identity parse must never crash the flow.
function renderIdentityFromContentSafe(content: unknown): RenderIdentity | null {
  try {
    return renderIdentityFromContent(content);
  } catch {
    return null;
  }
}
