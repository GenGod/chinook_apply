// Chinook LLM gateway (S3): single entry point for every GLM call.
// Constitution art. 6.1 (no unlogged call), 7.3 (same input never paid twice),
// 7.1 (untrusted output until schema-validated).
import { createHash } from 'node:crypto';
import process from 'node:process';
import type { ZodType } from 'zod';

export type LlmRole = 'main' | 'flash';

export interface LlmCall<T = unknown> {
  role: LlmRole;
  stage: string;
  system: string;
  user: string;
  schema?: ZodType<T>;
  temperature?: number;
  cache?: boolean;
}

export interface LlmUsage {
  promptTokens: number;
  completionTokens: number;
  costUsd: number;
  latencyMs: number;
}

export interface LlmResult<T = unknown> {
  data: T;
  cached: boolean;
  runId: number; // 0 for cache hits
  usage: LlmUsage;
}

/** Narrow persistence seam — real Kysely adapts in llm-db.ts; unit tests fake it. */
export interface LlmDb {
  insertIntoRun(row: Record<string, unknown>): Promise<number>;
  findCache(key: string): Promise<{ response: unknown; usage: Pick<LlmUsage, 'promptTokens' | 'completionTokens' | 'costUsd'> } | null>;
  saveCache(key: string, value: { response: unknown; usage: Pick<LlmUsage, 'promptTokens' | 'completionTokens' | 'costUsd'> }): Promise<void>;
  incrementCacheHits(key: string): Promise<void>;
}

export class DegradeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DegradeError';
  }
}

const API_URL = 'https://api.z.ai/api/paas/v4/chat/completions';

const ROLE_MODEL: Record<LlmRole, string> = {
  main: process.env.LLM_MODEL_MAIN ?? 'glm-5.3',
  flash: process.env.LLM_MODEL_FLASH ?? 'glm-5.3-flash',
};

/** $/1M tokens — defaults marked "verify" in STACK.md; env overridable. */
const PRICE_TABLE: Record<LlmRole, { in: number; out: number }> = {
  main: {
    in: Number(process.env.LLM_PRICE_MAIN_IN ?? 1.0),
    out: Number(process.env.LLM_PRICE_MAIN_OUT ?? 1.5),
  },
  flash: {
    in: Number(process.env.LLM_PRICE_FLASH_IN ?? 0.2),
    out: Number(process.env.LLM_PRICE_FLASH_OUT ?? 0.3),
  },
};

export function computeCostUsd(role: LlmRole, promptTokens: number, completionTokens: number): number {
  const p = PRICE_TABLE[role]!;
  const usd = (promptTokens / 1_000_000) * p.in + (completionTokens / 1_000_000) * p.out;
  return Math.round(usd * 1_000_000) / 1_000_000;
}
export const COST_SCALE = 1_000_000;

export function computeCacheKey(input: { model: string; system: string; user: string; temperature: number }): string {
  return createHash('sha256').update(JSON.stringify(input)).digest('hex');
}

const RETRY_DELAYS_MS = [1_000, 4_000, 16_000];
const BREAKER_THRESHOLD = 5;
const BREAKER_COOLDOWN_MS = 60_000;

export interface Llm {
  call<T>(input: LlmCall<T>): Promise<LlmResult<T>>;
  breakerState(): { open: boolean; consecutiveFailures: number };
}

export function createLlm(opts: {
  db: LlmDb;
  apiKey?: string;
  fetchImpl?: typeof fetch;
  sleepImpl?: (ms: number) => Promise<void>;
  breakerThreshold?: number;
}): Llm {
  const apiKey = opts.apiKey ?? process.env.ZAI_API_KEY ?? '';
  const doFetch = opts.fetchImpl ?? fetch;
  const sleep = opts.sleepImpl ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const threshold = opts.breakerThreshold ?? BREAKER_THRESHOLD;

  let consecutiveFailures = 0;
  let openedAt: number | null = null;

  async function rawChat(messages: Array<{ role: string; content: string }>, model: string, temperature: number) {
    const response = await doFetch(API_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ model, messages, temperature }),
    });
    return response;
  }

  async function call<T>(input: LlmCall<T>): Promise<LlmResult<T>> {
    const { role, stage, system, user, schema } = input;
    const temperature = input.temperature ?? 0;
    const useCache = input.cache ?? true;
    const model = ROLE_MODEL[role];

    const key = computeCacheKey({ model, system, user, temperature });
    if (useCache) {
      const hit = await opts.db.findCache(key);
      if (hit) {
        await opts.db.incrementCacheHits(key);
        const runId = await opts.db.insertIntoRun({
          stage, role, model, prompt_tokens: 0, completion_tokens: 0,
          cost_usd: 0, latency_ms: 0, cache_hit: true, ok: true, error: null, input_hash: key,
        });
        return {
          data: schema ? schema.parse(hit.response) : (hit.response as T),
          cached: true,
          runId,
          usage: { promptTokens: 0, completionTokens: 0, costUsd: 0, latencyMs: 0 },
        };
      }
    }

    // circuit breaker check
    if (openedAt !== null) {
      if (Date.now() - openedAt < BREAKER_COOLDOWN_MS) {
        throw new Error('circuit breaker open: LLM unavailable (cooling down)');
      }
      openedAt = null; // half-open: let one probe through
    }

    const messages: Array<{ role: string; content: string }> = [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ];

    const started = Date.now();
    let lastError = '';
    let correctiveUsed = false;

    for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt += 1) {
      if (attempt > 0) await sleep(RETRY_DELAYS_MS[attempt - 1]!);
      let response: Response;
      try {
        response = await rawChat(messages, model, temperature);
      } catch (error) {
        lastError = String(error);
        continue; // network error → retry
      }
      if (response.status === 429 || response.status >= 500) {
        lastError = `HTTP ${response.status}`;
        continue; // retryable
      }
      if (!response.ok) {
        const message = `HTTP ${response.status}`;
        await recordFailure(stage, role, model, key, message, started);
        throw new Error(message); // 4xx non-429: fail fast
      }

      const body = (await response.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
        usage?: { prompt_tokens?: number; completion_tokens?: number };
      };
      const text = body.choices?.[0]?.message?.content ?? '';
      const promptTokens = body.usage?.prompt_tokens ?? 0;
      const completionTokens = body.usage?.completion_tokens ?? 0;

      // structured output validation (one corrective retry per call, not per attempt)
      if (schema) {
        let parsed: unknown;
        let parseFailed = false;
        try {
          parsed = schema.parse(safeJsonParse(text));
        } catch {
          parseFailed = true;
        }
        if (parseFailed) {
          if (!correctiveUsed) {
            correctiveUsed = true;
            messages.push({ role: 'assistant', content: text });
            messages.push({
              role: 'user',
              content: 'Your previous reply failed schema validation. Reply again with valid JSON only, matching the schema exactly.',
            });
            continue; // corrective retry: same backoff slot
          }
          await recordFailure(stage, role, model, key, 'schema validation failed twice', started);
          throw new DegradeError('schema validation failed after retry');
        }
        const runId = await recordSuccess(stage, role, model, key, started, promptTokens, completionTokens);
        if (useCache) {
          await opts.db.saveCache(key, {
            response: parsed,
            usage: { promptTokens, completionTokens, costUsd: computeCostUsd(role, promptTokens, completionTokens) },
          });
        }
        return {
          data: parsed as T,
          cached: false,
          runId,
          usage: {
            promptTokens, completionTokens,
            costUsd: computeCostUsd(role, promptTokens, completionTokens),
            latencyMs: Date.now() - started,
          },
        };
      }

      // free-text result
      const runId = await recordSuccess(stage, role, model, key, started, promptTokens, completionTokens);
      if (useCache) {
        await opts.db.saveCache(key, {
          response: text,
          usage: { promptTokens, completionTokens, costUsd: computeCostUsd(role, promptTokens, completionTokens) },
        });
      }
      return {
        data: text as T,
        cached: false,
        runId,
        usage: {
          promptTokens, completionTokens,
          costUsd: computeCostUsd(role, promptTokens, completionTokens),
          latencyMs: Date.now() - started,
        },
      };
    }

    await recordFailure(stage, role, model, key, lastError || 'retries exhausted', started);
    throw new Error(`LLM call failed after retries: ${lastError}`);
  }

  async function recordSuccess(stage: string, role: LlmRole, model: string, key: string, started: number, pt: number, ct: number) {
    consecutiveFailures = 0;
    return opts.db.insertIntoRun({
      stage, role, model,
      prompt_tokens: pt, completion_tokens: ct,
      cost_usd: computeCostUsd(role, pt, ct),
      latency_ms: Date.now() - started,
      cache_hit: false, ok: true, error: null, input_hash: key,
    });
  }

  async function recordFailure(stage: string, role: LlmRole, model: string, key: string, error: string, started: number) {
    consecutiveFailures += 1;
    if (consecutiveFailures >= threshold) openedAt = Date.now();
    await opts.db.insertIntoRun({
      stage, role, model,
      prompt_tokens: 0, completion_tokens: 0, cost_usd: 0,
      latency_ms: Date.now() - started,
      cache_hit: false, ok: false, error, input_hash: key,
    });
  }

  return {
    call,
    breakerState: () => ({ open: openedAt !== null, consecutiveFailures }),
  };
}

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
