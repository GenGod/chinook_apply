// S25: Job Bank apply-сервис — on-demand раскрытие панели подачи, кэш в
// job.raw.applyMethods, консервативная политика (ст. 11): только по действию
// PO (кнопка/Send), TTL-кэш, троттлинг не ретраится. Прямых submit'ов в
// Job Bank здесь нет (Direct Apply — S26, требует Plus-аккаунт).
//
// S25 R8 (2026-10-04): дефолтная стратегия — БРАУЗЕРНАЯ. Live-диагностика
// показала, что «голый» fetch-POST постбэка проходит клиентский
// фингерпринт-гейт Job Bank (панель не рендерится, 200 без rate-limit
// заголовков), а реальный клик в chromium раскрывает панель с того же IP.
// Раскрытие выполняется тем же действием, что и у пользователя (ст. 11):
// goto → капча-стоп (11.3) → клик #applynowbutton → wait #howtoapply →
// extract. Никакого спуфинга заголовков и каскадных ретраев.
import type { Kysely } from 'kysely';
import {
  detectCaptcha,
  type Database,
} from '@chinook/core';
import {
  classifyPosting,
  extractApplyMethods,
  revealApplyMethods,
  type ApplyMethods,
  type RevealFetch,
  type RevealOutcome,
} from '@chinook/adapters/jobbank-apply';

/** Окно, в течение которого кэш раскрытия считается свежим (спека R4). */
export const REVEAL_TTL_MIN = 15;

/** Таймаут ожидания панели после клика по кнопке (спека R8). */
export const REVEAL_CLICK_WAIT_MS = 15_000;

export class RevealJobNotFoundError extends Error {
  readonly status = 404;
  constructor(message = 'job not found') {
    super(message);
    this.name = 'RevealJobNotFoundError';
  }
}

/** Браузер недоступен в этом деплое (нет chromium/депсов) — как S9, 503. */
export class RevealBrowserUnavailableError extends Error {
  readonly status = 503;
  constructor(message: string) {
    super(message);
    this.name = 'RevealBrowserUnavailableError';
  }
}

export interface CachedApplyMethods {
  methods: ApplyMethods;
  revealedAt: Date;
}

const EMAIL_RE = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;

function asStringArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}

/** Форма-валидация кэша job.raw.applyMethods (недоверенные поля → дефолты). */
export function parseCachedApplyMethods(raw: unknown): CachedApplyMethods | null {
  const m = (raw as Record<string, unknown> | null)?.applyMethods as Record<string, unknown> | undefined;
  if (!m || typeof m !== 'object') return null;
  const revealedAt =
    typeof m.revealedAt === 'string' ? new Date(m.revealedAt) : null;
  if (!revealedAt || Number.isNaN(revealedAt.getTime())) return null;
  return {
    revealedAt,
    methods: {
      email: typeof m.email === 'string' && EMAIL_RE.test(m.email) ? m.email : null,
      webUrl: typeof m.webUrl === 'string' && /^https?:\/\//.test(m.webUrl) ? m.webUrl : null,
      directApply: m.directApply === true,
      screeningQuestions: asStringArray(m.screeningQuestions),
      notes: asStringArray(m.notes),
      otherText: typeof m.otherText === 'string' ? m.otherText : null,
    },
  };
}

export interface RevealServiceOutcome {
  status: 'revealed' | 'cached' | 'throttled' | 'partner' | 'unavailable';
  methods: ApplyMethods | null;
  /** Причина неуспеха для аудита/UI (captcha-стоп и т.п.). */
  reason?: string;
}

/** Минимальный интерфейс страницы для браузерного reveal (инъекция в тестах). */
export interface RevealPageLike {
  goto(url: string): Promise<unknown>;
  content(): Promise<string>;
  click(selector: string): Promise<void>;
  waitForSelector(selector: string, options?: { timeout?: number }): Promise<unknown>;
  close(): Promise<void>;
}

export type LaunchRevealPageFn = () => Promise<RevealPageLike>;

async function defaultLaunchRevealPage(): Promise<RevealPageLike> {
  try {
    const { chromium } = await import('playwright');
    const executablePath = process.env.CHROMIUM_EXECUTABLE_PATH;
    const browser = await chromium.launch(executablePath ? { executablePath } : {});
    const page = await browser.newPage();
    return {
      goto: (url) => page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45_000 }),
      content: () => page.content(),
      click: (selector) => page.click(selector),
      waitForSelector: (selector, options) => page.waitForSelector(selector, options),
      close: async () => {
        await page.close();
        await browser.close();
      },
    };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new RevealBrowserUnavailableError(`browser unavailable: ${detail.slice(0, 160)}`);
  }
}

/**
 * Идентификатор для тела постбэка: seekeractivity:jobid — число из URL
 * постинга (НЕ feed «Job number» из source_job_id: у живых постингов это
 * разные числа). Fallback — source_job_id.
 */
function revealJobId(url: string, sourceJobId: unknown): string {
  const fromUrl = url.match(/\/jobposting\/(\d+)/)?.[1];
  if (fromUrl) return fromUrl;
  if (typeof sourceJobId === 'string' && sourceJobId !== '') return sourceJobId;
  return 'unknown';
}

/** Браузерное раскрытие (R8): тот же экшн, что и у пользователя. */
async function revealViaBrowser(
  page: RevealPageLike,
  postingUrl: string,
): Promise<RevealOutcome & { reason?: string }> {
  await page.goto(postingUrl);
  const html = await page.content();

  // Ст. 11.3: анти-бот/капча → немедленный стоп ДО клика, без ретраев.
  const captcha = detectCaptcha(html);
  if (captcha !== null) {
    await page.close();
    return { kind: 'throttled', reason: `captcha detected: ${captcha} — manual fallback (art. 11.3)` };
  }

  const kind = classifyPosting(html);
  if (kind === 'partner') {
    await page.close();
    return { kind: 'partner' };
  }
  if (kind !== 'direct') {
    await page.close();
    return { kind: 'unavailable' };
  }

  await page.click('#applynowbutton');
  try {
    await page.waitForSelector('#howtoapply', { timeout: REVEAL_CLICK_WAIT_MS });
  } catch {
    await page.close();
    return { kind: 'throttled' };
  }
  const expanded = await page.content();
  await page.close();
  const methods = extractApplyMethods(expanded);
  return methods ? { kind: 'revealed', methods } : { kind: 'throttled' };
}

export async function revealJobApplyMethods(
  db: Kysely<Database>,
  jobId: string,
  opts?: { fetcher?: RevealFetch; launchPage?: LaunchRevealPageFn; now?: Date; ttlMin?: number },
): Promise<RevealServiceOutcome> {
  const job = await db
    .selectFrom('job')
    .select(['id', 'source', 'url', 'source_job_id', 'raw'])
    .where('id', '=', jobId)
    .executeTakeFirst();
  if (!job) throw new RevealJobNotFoundError();

  const raw = (job.raw ?? {}) as Record<string, unknown>;
  const cached = parseCachedApplyMethods(raw);
  const ttlMin = opts?.ttlMin ?? REVEAL_TTL_MIN;
  const now = opts?.now ?? new Date();
  // Fresh cache wins over the source check: the cache is written only by the
  // jobbank reveal service (data provenance), and answering it needs no network.
  if (cached && now.getTime() - cached.revealedAt.getTime() < ttlMin * 60_000) {
    return { status: 'cached', methods: cached.methods };
  }
  if (job.source !== 'jobbank' || !job.url) return { status: 'unavailable', methods: null };

  // Стратегия: инъекция fetcher — HTTP-постбэк (тесты/спец-деплои);
  // дефолт — браузерная (R8). Egress-guard обязателен до сети/браузера.
  let outcome: RevealOutcome & { reason?: string };
  try {
    if (opts?.fetcher) {
      outcome = await revealApplyMethods(opts.fetcher, job.url, revealJobId(job.url, job.source_job_id));
    } else {
      const target = new URL(job.url);
      if (target.protocol !== 'https:' || !/^(www\.)?jobbank\.gc\.ca$/i.test(target.hostname)) {
        return { status: 'unavailable', methods: null };
      }
      const page = await (opts?.launchPage ?? defaultLaunchRevealPage)();
      outcome = await revealViaBrowser(page, job.url);
    }
  } catch (error) {
    if (error instanceof RevealBrowserUnavailableError) throw error;
    return { status: 'unavailable', methods: null };
  }
  if (outcome.kind !== 'revealed') {
    return { status: outcome.kind, methods: null, reason: outcome.reason };
  }

  const enriched: Record<string, unknown> = {
    ...raw,
    applyMethods: { ...outcome.methods, revealedAt: now.toISOString() },
  };
  await db.updateTable('job').set({ raw: enriched }).where('id', '=', jobId).execute();
  return { status: 'revealed', methods: outcome.methods };
}
