// S25: Job Bank apply-сервис — on-demand раскрытие панели подачи, кэш в
// job.raw.applyMethods, консервативная политика (ст. 11): только по действию
// PO (кнопка/Send), TTL-кэш, троттлинг не ретраится. Прямых submit'ов в
// Job Bank здесь нет (Direct Apply — S26, требует Plus-аккаунт).
import type { Kysely } from 'kysely';
import type { Database } from '@chinook/core';
import {
  httpRevealFetch,
  revealApplyMethods,
  type ApplyMethods,
  type RevealFetch,
  type RevealOutcome,
} from '@chinook/adapters/jobbank-apply';

/** Окно, в течение которого кэш раскрытия считается свежим (спека R4). */
export const REVEAL_TTL_MIN = 15;

export class RevealJobNotFoundError extends Error {
  readonly status = 404;
  constructor(message = 'job not found') {
    super(message);
    this.name = 'RevealJobNotFoundError';
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
}

/**
 * Идентификатор для тела постбэка: seekeractivity:jobid — число из URL
 * постинга (НЕ feed «Job number» из source_job_id: у живых постингов это
 * разные числа). Fallback — source_job_id.
 */
function revealJobId(url: string, sourceJobId: unknown): string {
  const fromUrl = /\/jobposting\/(\d+)/.exec(url)?.[1];
  if (fromUrl) return fromUrl;
  if (typeof sourceJobId === 'string' && sourceJobId !== '') return sourceJobId;
  return 'unknown';
}

export async function revealJobApplyMethods(
  db: Kysely<Database>,
  jobId: string,
  opts?: { fetcher?: RevealFetch; now?: Date; ttlMin?: number },
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

  // Политика egress (B-010) живёт в httpRevealFetch; инъекция fetcher — для
  // тестов/локального сервера (политика вызывающей стороны — урок Mimosa).
  let outcome: RevealOutcome;
  try {
    const fetcher = opts?.fetcher ?? httpRevealFetch(job.url);
    outcome = await revealApplyMethods(fetcher, job.url, revealJobId(job.url, job.source_job_id));
  } catch {
    return { status: 'unavailable', methods: null };
  }
  if (outcome.kind !== 'revealed') return { status: outcome.kind, methods: null };

  const enriched: Record<string, unknown> = {
    ...raw,
    applyMethods: { ...outcome.methods, revealedAt: now.toISOString() },
  };
  await db.updateTable('job').set({ raw: enriched }).where('id', '=', jobId).execute();
  return { status: 'revealed', methods: outcome.methods };
}
