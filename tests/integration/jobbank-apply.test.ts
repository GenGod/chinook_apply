import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, type Server } from 'node:http';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  createDb,
  ensureSchema,
  type Database,
} from '@chinook/core';
import type { Kysely } from 'kysely';
import {
  cookieJarRevealFetch,
  revealApplyMethods,
  buildRevealPostBody,
  type RevealFetch,
} from '@chinook/adapters/jobbank-apply';
import {
  revealJobApplyMethods,
  parseCachedApplyMethods,
  REVEAL_TTL_MIN,
  RevealJobNotFoundError,
  RevealBrowserUnavailableError,
  type RevealPageLike,
} from '../../apps/web/src/lib/jobbank-dispatch-service';

/**
 * S25 T2/T3 (red→green): Job Bank apply-панель — транспорт (cookie-сессия,
 * egress-guard) и сервис (кэш raw.applyMethods, TTL, политика). Локальный
 * http-сервер воспроизводит поведение Job Bank: GET ставит JSESSIONID, POST
 * с cookie возвращает страницу с раскрытой панелью; после N раскрытий —
 * троттлинг (панель не раскрывается). Фикстуры синтетические — без PII.
 */
const db: Kysely<Database> = createDb(
  process.env.DATABASE_URL ?? 'postgres://chinook:chinook_dev@localhost:5433/chinook_test',
);

const FIX = (n: string) =>
  readFileSync(join(import.meta.dirname, '../../packages/adapters/test/fixtures/jobbank/apply', n), 'utf8');

const JOB_ID = '99990001';
const PANEL_PAGE = FIX('direct-panel-email.html');
const GET_PAGE = FIX('direct-get.html');

let server: Server;
let base = '';
let postCount = 0;
let throttleAfter = 1; // первый POST раскрывает панель, второй+ — троттлинг

beforeAll(async () => {
  server = createServer((req, res) => {
    const cookies = req.headers.cookie ?? '';
    if (req.method === 'GET') {
      res.setHeader('Set-Cookie', 'JSESSIONID=test-session; Path=/');
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(GET_PAGE);
      return;
    }
    postCount++;
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(postCount <= throttleAfter && cookies.includes('JSESSIONID=test-session') ? PANEL_PAGE : GET_PAGE);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  base = `http://127.0.0.1:${port}/jobsearch/jobposting/${JOB_ID}`;
  await ensureSchema(db);
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('cookieJarRevealFetch + revealApplyMethods против локального сервера (S25 AC4)', () => {
  it('GET→POST с cookie → revealed (тело и URL постбэка точные)', async () => {
    postCount = 0;
    throttleAfter = 1;
    const fetcher = cookieJarRevealFetch(base);
    const out = await revealApplyMethods(fetcher, base, JOB_ID);
    expect(out).toEqual({
      kind: 'revealed',
      methods: expect.objectContaining({ email: 'careers@fixture.example' }),
    });
    expect(postCount).toBe(1);
  });

  it('троттлинг-сервер (панель не раскрывается) → throttled', async () => {
    postCount = 0;
    throttleAfter = 0;
    const fetcher = cookieJarRevealFetch(base);
    expect(await revealApplyMethods(fetcher, base, JOB_ID)).toEqual({ kind: 'throttled' });
  });

  // Egress-guard httpRevealFetch (https + allowlist) покрыт юнит-тестами
  // assertSafeExternalUrl и jobbank-apply.test.ts; сервисный уровень —
  // evil-URL тест в revealJobApplyMethods describe ниже.

  it('POST-тело соответствует живой форме seekeractivity', () => {
    expect(buildRevealPostBody(JOB_ID)).toContain(`seekeractivity%3Ajobid=${JOB_ID}`);
    expect(buildRevealPostBody(JOB_ID)).toContain('jakarta.faces.ViewState=stateless');
  });
});

describe('parseCachedApplyMethods (S25 AC5)', () => {
  it('валидный raw → методы + дата', () => {
    const cached = parseCachedApplyMethods({
      applyMethods: {
        email: 'apply@fixture.example', webUrl: null, directApply: true,
        screeningQuestions: ['Q1?'], notes: ['N1'], otherText: null,
        revealedAt: '2026-10-03T12:00:00.000Z',
      },
    });
    expect(cached).not.toBeNull();
    expect(cached!.methods.email).toBe('apply@fixture.example');
    expect(cached!.methods.screeningQuestions).toEqual(['Q1?']);
    expect(cached!.revealedAt.toISOString()).toBe('2026-10-03T12:00:00.000Z');
  });

  it('мусор/неполный shape → null (email-невалид → null-поле, bad revealedAt → null)', () => {
    expect(parseCachedApplyMethods(null)).toBeNull();
    expect(parseCachedApplyMethods({})).toBeNull();
    expect(parseCachedApplyMethods({ applyMethods: { email: 'x' } })).toBeNull();
    expect(parseCachedApplyMethods({ applyMethods: { revealedAt: 'not-a-date' } })).toBeNull();
    const partial = parseCachedApplyMethods({
      applyMethods: { email: 'bad-address', webUrl: 42, revealedAt: '2026-10-03T12:00:00.000Z' },
    });
    expect(partial!.methods.email).toBeNull();
    expect(partial!.methods.webUrl).toBeNull();
  });
});

describe('revealJobApplyMethods (S25 AC5/AC6)', () => {
  const jobIds: string[] = [];

  async function seedJobbankJob(overrides: Record<string, unknown> = {}, source = 'jobbank'): Promise<string> {
    const id = randomUUID();
    await db
      .insertInto('job')
      .values({
        id,
        canonical_hash: `s25-${id}`,
        title: 'S25 reveal test job',
        employer: 'Fixture Corp',
        city: 'fort mcmurray',
        province: 'AB',
        remote: false,
        url: 'https://www.jobbank.gc.ca/jobsearch/jobposting/99990001',
        urls: [],
        source,
        source_job_id: JOB_ID,
        posted_at: new Date(),
        salary_currency: 'CAD',
        ingested_at: new Date(),
        raw: { summary: { '#text': 'fixture' }, ...overrides },
      })
      .execute();
    jobIds.push(id);
    return id;
  }

  function countingFetcher(body: string): RevealFetch & { calls: number } {
    return {
      calls: 0,
      async get() {
        this.calls++;
        return { status: 200, body: GET_PAGE };
      },
      async post() {
        this.calls++;
        return { status: 200, body };
      },
    };
  }

  afterAll(async () => {
    for (const id of jobIds) {
      await db.deleteFrom('job').where('id', '=', id).execute();
    }
  });

  it('revealed: методы записаны в raw.applyMethods с revealedAt; повтор ≤ TTL → cached без сети', async () => {
    const fetcher = countingFetcher(PANEL_PAGE);
    const id = await seedJobbankJob();

    const first = await revealJobApplyMethods(db, id, { fetcher, now: new Date('2026-10-03T12:00:00Z') });
    expect(first.status).toBe('revealed');
    expect(first.methods?.email).toBe('careers@fixture.example');

    const stored = await db.selectFrom('job').select('raw').where('id', '=', id).executeTakeFirst();
    const raw = stored!.raw as Record<string, unknown>;
    expect((raw.applyMethods as Record<string, unknown>).email).toBe('careers@fixture.example');
    expect((raw.applyMethods as Record<string, unknown>).revealedAt).toBe('2026-10-03T12:00:00.000Z');

    const second = await revealJobApplyMethods(db, id, { fetcher, now: new Date('2026-10-03T12:05:00Z') });
    expect(second.status).toBe('cached');
    expect(second.methods?.email).toBe('careers@fixture.example');
    expect(fetcher.calls).toBe(2); // GET+POST только в первый раз
  });

  it('кэш старше TTL → повторный reveal (сеть снова вызывается)', async () => {
    const fetcher = countingFetcher(PANEL_PAGE);
    const id = await seedJobbankJob();

    await revealJobApplyMethods(db, id, { fetcher, now: new Date('2026-10-03T12:00:00Z') });
    const later = await revealJobApplyMethods(db, id, {
      fetcher,
      now: new Date(`2026-10-03T12:00:00Z`),
      ttlMin: 0, // TTL исчерпан мгновенно
    });
    expect(later.status).toBe('revealed');
    expect(fetcher.calls).toBe(4);
  });

  it('throttled: raw НЕ перезаписывается', async () => {
    const fetcher = countingFetcher(GET_PAGE);
    const id = await seedJobbankJob();
    const out = await revealJobApplyMethods(db, id, { fetcher });
    expect(out.status).toBe('throttled');
    const stored = await db.selectFrom('job').select('raw').where('id', '=', id).executeTakeFirst();
    expect((stored!.raw as Record<string, unknown>).applyMethods).toBeUndefined();
  });

  it('не-jobbank источник → unavailable, fetch не вызывается', async () => {
    const fetcher = countingFetcher(PANEL_PAGE);
    const id = await seedJobbankJob({}, 'adzuna');
    const out = await revealJobApplyMethods(db, id, { fetcher });
    expect(out.status).toBe('unavailable');
    expect(fetcher.calls).toBe(0);
  });

  it('url вне egress-allowlist (дефолтный fetcher) → unavailable', async () => {
    const id = randomUUID();
    await db
      .insertInto('job')
      .values({
        id,
        canonical_hash: `s25-evil-${id}`,
        title: 'evil url', employer: 'Fixture Corp', city: 'x', province: 'AB', remote: false,
        url: 'https://evil.example/jobsearch/jobposting/1', urls: [],
        source: 'jobbank', source_job_id: '1', posted_at: new Date(), salary_currency: 'CAD',
        ingested_at: new Date(), raw: {},
      })
      .execute();
    jobIds.push(id);
    const out = await revealJobApplyMethods(db, id);
    expect(out.status).toBe('unavailable');
  });

  it('unknown job → RevealJobNotFoundError', async () => {
    await expect(revealJobApplyMethods(db, randomUUID())).rejects.toBeInstanceOf(RevealJobNotFoundError);
  });

  it('TTL-константа = 15 минут (спека R4)', () => {
    expect(REVEAL_TTL_MIN).toBe(15);
  });
});

/**
 * S25 R8 (дополнение 2026-10-04): дефолтный reveal — браузерный (Playwright).
 * Live-диагностика: fetch-POST постбэка проходит клиентский фингерпринт-гейт
 * Job Bank (панель не рендерится), реальный клик в chromium — раскрывает.
 * Оркестрация тестируется через инъекцию fake-страницы (сеть не нужна):
 * goto → content → капча-чек (11.3) → classify → клик #applynowbutton →
 * wait #howtoapply → content → extractApplyMethods → persist.
 */
describe('revealJobApplyMethods — браузерная стратегия (S25 R8)', () => {
  const JB_URL = 'https://www.jobbank.gc.ca/jobsearch/jobposting/50410350';
  const jobIdsBrowser: string[] = [];

  interface FakePageCalls { gotos: string[]; clicks: string[]; waits: string[]; closed: number }

  function fakePage(captcha = false, panelAfterClick = true): {
    page: RevealPageLike; calls: FakePageCalls;
  } {
    const calls: FakePageCalls = { gotos: [], clicks: [], waits: [], closed: 0 };
    const page: RevealPageLike = {
      async goto(u) {
        calls.gotos.push(u);
        return null;
      },
      async content() {
        if (captcha) return FIX('direct-get.html').replace('<body>', '<body><div data-captcha="1">bot check</div>');
        if (calls.clicks.length > 0 && panelAfterClick) return PANEL_PAGE;
        return GET_PAGE;
      },
      async click(selector) {
        calls.clicks.push(selector);
      },
      async waitForSelector(selector) {
        calls.waits.push(selector);
        if (!(calls.clicks.length > 0 && panelAfterClick)) throw new Error('timeout waiting for #howtoapply');
        return null;
      },
      async close() {
        calls.closed++;
      },
    };
    return { page, calls };
  }

  async function seedJob(overrides: Record<string, unknown> = {}): Promise<string> {    const id = randomUUID();
    await db
      .insertInto('job')
      .values({
        id,
        canonical_hash: `s25r8-${id}`,
        title: 'S25 browser reveal job', employer: 'Fixture Corp', city: 'calgary',
        province: 'AB', remote: false, url: JB_URL, urls: [],
        source: 'jobbank', source_job_id: '50410350', posted_at: new Date(),
        salary_currency: 'CAD', ingested_at: new Date(),
        raw: { summary: { '#text': 'fixture' }, ...overrides },
      })
      .execute();
    jobIdsBrowser.push(id);
    return id;
  }

  afterAll(async () => {
    for (const id of jobIdsBrowser) {
      await db.deleteFrom('job').where('id', '=', id).execute();
    }
  });

  it('success: goto → капча-чек → клик → панель → методы → raw.persist, страница закрыта', async () => {
    const { page, calls } = fakePage();
    const id = await seedJob();

    const out = await revealJobApplyMethods(db, id, { launchPage: async () => page });

    expect(out.status).toBe('revealed');
    expect(out.methods?.email).toBe('careers@fixture.example');
    expect(calls.gotos).toEqual([JB_URL]);
    expect(calls.clicks).toEqual(['#applynowbutton']);
    expect(calls.waits).toEqual(['#howtoapply']);
    expect(calls.closed).toBe(1);

    const stored = await db.selectFrom('job').select('raw').where('id', '=', id).executeTakeFirst();
    const raw = stored!.raw as Record<string, unknown>;
    expect((raw.applyMethods as Record<string, unknown>).email).toBe('careers@fixture.example');
    expect(typeof (raw.applyMethods as Record<string, unknown>).revealedAt).toBe('string');
  });

  it('капча-маркер на странице → стоп ДО клика (ст. 11.3), status throttled + reason', async () => {
    const { page, calls } = fakePage(true);
    const id = await seedJob();

    const out = await revealJobApplyMethods(db, id, { launchPage: async () => page });

    expect(out.status).toBe('throttled');
    expect(out.reason).toContain('captcha');
    expect(calls.clicks).toHaveLength(0);
    const stored = await db.selectFrom('job').select('raw').where('id', '=', id).executeTakeFirst();
    expect((stored!.raw as Record<string, unknown>).applyMethods).toBeUndefined();
  });

  it('партнёрский постинг → partner без клика', async () => {
    const { page, calls } = fakePage();
    const id = await seedJob();
    // подменяем content на партнёрскую страницу
    (page as unknown as { content(): Promise<string> }).content = async () => FIX('partner.html');

    const out = await revealJobApplyMethods(db, id, { launchPage: async () => page });

    expect(out.status).toBe('partner');
    expect(calls.clicks).toHaveLength(0);
  });

  it('панель не раскрылась после клика → throttled', async () => {
    const { page, calls } = fakePage(false, false);
    const id = await seedJob();

    const out = await revealJobApplyMethods(db, id, { launchPage: async () => page });

    expect(out.status).toBe('throttled');
    expect(calls.clicks).toEqual(['#applynowbutton']);
  });

  it('не-jobbank URL без инъекций → guard ДО создания страницы (egress)', async () => {
    const id = randomUUID();
    await db
      .insertInto('job')
      .values({
        id,
        canonical_hash: `s25r8-evil-${id}`,
        title: 'evil', employer: 'x', city: 'x', province: 'AB', remote: false,
        url: 'https://evil.example/jobsearch/jobposting/1', urls: [],
        source: 'jobbank', source_job_id: '1', posted_at: new Date(),
        salary_currency: 'CAD', ingested_at: new Date(), raw: {},
      })
      .execute();
    jobIdsBrowser.push(id);

    let pagesCreated = 0;
    const out = await revealJobApplyMethods(db, id, {
      launchPage: async () => {
        pagesCreated++;
        return fakePage().page;
      },
    });

    expect(out.status).toBe('unavailable');
    expect(pagesCreated).toBe(0);
  });

  it('браузер недоступен → RevealBrowserUnavailableError (503)', async () => {
    const id = await seedJob();
    await expect(
      revealJobApplyMethods(db, id, {
        launchPage: async () => {
          throw new RevealBrowserUnavailableError('no chromium binary');
        },
      }),
    ).rejects.toBeInstanceOf(RevealBrowserUnavailableError);
  });
});
