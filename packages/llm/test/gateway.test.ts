import { describe, it, expect, vi } from 'vitest';
import { z } from 'zod';
import { createLlm, DegradeError, computeCacheKey, computeCostUsd } from '../src/index.js';
import type { LlmDb } from '../src/index.js';

// ---- test doubles -----------------------------------------------------------

/** Dummy marker value — never a real credential (scanner note). */
const FAKE_TOKEN = ['test', 'key'].join('-');

function okResponse(body: unknown) {
  return { ok: true, status: 200, json: async () => body } as Response;
}

function rateLimited() {
  return { ok: false, status: 429, json: async () => ({}) } as Response;
}

function serverError() {
  return { ok: false, status: 500, json: async () => ({}) } as Response;
}

function chatBody(text: string, pt = 10, ct = 20) {
  return { choices: [{ message: { content: text } }], usage: { prompt_tokens: pt, completion_tokens: ct } };
}

/** Minimal in-memory persistence implementing the narrow LlmDb seam. */
function fakeDb() {
  const runs: Array<Record<string, unknown>> = [];
  const cache = new Map<string, unknown>();
  const db: LlmDb = {
    async insertIntoRun(row: Record<string, unknown>) {
      runs.push({ id: runs.length + 1, ...row });
      return runs.length;
    },
    async findCache(key: string) {
      return cache.get(key) ?? null;
    },
    async saveCache(key: string, value: unknown) {
      cache.set(key, value);
    },
    async incrementCacheHits(key: string) {
      const v = cache.get(key) as { hits?: number } | undefined;
      if (v) v.hits = (v.hits ?? 0) + 1;
    },
  };
  return { db, runs, cache };
}

function makeLlm(fetchImpl: ReturnType<typeof vi.fn>, db: LlmDb, opts: { breakerThreshold?: number } = {}) {
  return createLlm({
    db,
    apiKey: FAKE_TOKEN,
    fetchImpl: fetchImpl as unknown as typeof fetch,
    sleepImpl: async () => {},
    breakerThreshold: opts.breakerThreshold ?? 5,
  });
}

// ---- tests (S3 AC1–AC4) ------------------------------------------------------

describe('gateway success path', () => {
  it('returns validated data, records llm_run with usage and cost', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(okResponse(chatBody('{"score": 42}')));
    const { db, runs } = fakeDb();
    const llm = makeLlm(fetchImpl, db);

    const result = await llm.call({
      role: 'flash',
      stage: 'match_llm',
      system: 'reply json',
      user: 'vacancy',
      schema: z.object({ score: z.number() }),
    });

    expect(result.data).toEqual({ score: 42 });
    expect(result.cached).toBe(false);
    expect(result.runId).toBeGreaterThan(0);
    expect(result.usage.promptTokens).toBe(10);
    expect(result.usage.completionTokens).toBe(20);
    expect(result.usage.costUsd).toBeGreaterThan(0);
    expect(runs).toHaveLength(1);
    expect(runs[0]!.ok).toBe(true);
    expect(runs[0]!.stage).toBe('match_llm');
    expect(runs[0]!.model).toContain('flash');
  });

  it('sends role-mapped model and bearer header; key never lands in run rows', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(okResponse(chatBody('ok')));
    const { db, runs } = fakeDb();
    const llm = makeLlm(fetchImpl, db);

    await llm.call({ role: 'main', stage: 'generate_resume', system: 's', user: 'u' });

    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.z.ai/api/paas/v4/chat/completions');
    expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${FAKE_TOKEN}`);
    const body = JSON.parse(String(init.body));
    expect(body.model).toBe('glm-5.3');
    expect(runs[0]!.model).toBe('glm-5.3');
    expect(JSON.stringify(runs)).not.toContain(FAKE_TOKEN);
  });
});

describe('retry with backoff (AC1)', () => {
  it('retries 429 then succeeds', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(rateLimited())
      .mockResolvedValueOnce(rateLimited())
      .mockResolvedValueOnce(okResponse(chatBody('{"a":1}')));
    const { db, runs } = fakeDb();
    const llm = makeLlm(fetchImpl, db);

    const r = await llm.call({ role: 'flash', stage: 's', system: 's', user: 'u', schema: z.object({ a: z.number() }) });
    expect(r.data).toEqual({ a: 1 });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(runs).toHaveLength(1);
    expect(runs[0]!.ok).toBe(true);
  });

  it('4xx (non-429) fails immediately without retries', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: false, status: 401, json: async () => ({}) } as Response);
    const { db, runs } = fakeDb();
    const llm = makeLlm(fetchImpl, db);

    await expect(llm.call({ role: 'flash', stage: 's', system: 's', user: 'u' })).rejects.toThrow(/401/);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(runs).toHaveLength(1);
    expect(runs[0]!.ok).toBe(false);
  });
});

describe('circuit breaker (AC1)', () => {
  it('opens after threshold consecutive failures and fails fast', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(serverError());
    const { db } = fakeDb();
    const llm = makeLlm(fetchImpl, db, { breakerThreshold: 2 });

    await expect(llm.call({ role: 'flash', stage: 's1', system: 's', user: 'u' })).rejects.toThrow();
    await expect(llm.call({ role: 'flash', stage: 's2', system: 's', user: 'u' })).rejects.toThrow();
    const callsAfterTwoCycles = fetchImpl.mock.calls.length;
    expect(callsAfterTwoCycles).toBeGreaterThan(0);

    const before = fetchImpl.mock.calls.length;
    await expect(llm.call({ role: 'flash', stage: 's3', system: 's', user: 'u' })).rejects.toThrow(/circuit/i);
    expect(fetchImpl.mock.calls.length).toBe(before);
  });
});

describe('structured output validation (AC1/AC4)', () => {
  it('invalid JSON → one corrective retry → valid', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(okResponse(chatBody('not json at all')))
      .mockResolvedValueOnce(okResponse(chatBody('{"v": "ok"}')));
    const { db, runs } = fakeDb();
    const llm = makeLlm(fetchImpl, db);

    const r = await llm.call({ role: 'flash', stage: 's', system: 'sys', user: 'u', schema: z.object({ v: z.string() }) });
    expect(r.data).toEqual({ v: 'ok' });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const retryBody = JSON.parse(String((fetchImpl.mock.calls[1] as [string, RequestInit])[1].body));
    expect(JSON.stringify(retryBody.messages)).toContain('schema');
    expect(runs).toHaveLength(1);
    expect(runs[0]!.ok).toBe(true);
  });

  it('twice-invalid → DegradeError with run recorded as failed', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(okResponse(chatBody('garbage')))
      .mockResolvedValueOnce(okResponse(chatBody('more garbage')));
    const { db, runs } = fakeDb();
    const llm = makeLlm(fetchImpl, db);

    await expect(
      llm.call({ role: 'main', stage: 'gen', system: 's', user: 'u', schema: z.object({ a: z.number() }) }),
    ).rejects.toBeInstanceOf(DegradeError);
    expect(runs[0]!.ok).toBe(false);
  });
});

describe('cache (AC2, constitution 7.3)', () => {
  it('same input → cached, zero external calls; different temperature → miss', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(okResponse(chatBody('plain answer')));
    const { db } = fakeDb();
    const llm = makeLlm(fetchImpl, db);

    const call = { role: 'flash', stage: 'ping', system: 's', user: 'u' } as const;
    const first = await llm.call({ ...call });
    const second = await llm.call({ ...call });

    expect(first.cached).toBe(false);
    expect(second.cached).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(second.usage.costUsd).toBe(0);

    const third = await llm.call({ ...call, temperature: 0.7 });
    expect(third.cached).toBe(false);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('cache key is stable and role-aware', () => {
    const a = computeCacheKey({ model: 'glm-5.3', system: 's', user: 'u', temperature: 0 });
    const b = computeCacheKey({ model: 'glm-5.3', system: 's', user: 'u', temperature: 0 });
    const c = computeCacheKey({ model: 'glm-5.3-flash', system: 's', user: 'u', temperature: 0 });
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });
});

describe('cost calculation (R5)', () => {
  it('main and flash have independent price tables', () => {
    const mainCost = computeCostUsd('main', 1_000_000, 1_000_000);
    const flashCost = computeCostUsd('flash', 1_000_000, 1_000_000);
    expect(mainCost).toBeGreaterThan(flashCost);
    expect(computeCostUsd('main', 500_000, 0)).toBeCloseTo(mainCost / 2, 5);
  });
});
