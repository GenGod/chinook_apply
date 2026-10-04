# S25 Implementation Plan — Job Bank apply-адаптер (раскрытие панели + маршрутизация)

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:executing-plans (или subagent-driven-development). Шаги с чекбоксами `- [ ]`.

**Goal:** Первый пер-сайт адаптер: HTTP-раскрытие панели «How to apply» прямых Job Bank-постингов (GET→POST с cookie-сессией), извлечение методов подачи (email/веб-ссылка/Direct Apply/скрининг-вопросы), кэш в `job.raw.applyMethods`, UI-блок на странице вакансии и подстановка email в dispatch.

**Architecture:** чистые функции + инъекция fetch в `packages/adapters/src/jobbank-apply.ts` (egress-guard в фабрике `httpRevealFetch`); оркестрация с кэшем/политикой в `apps/web/src/lib/jobbank-dispatch-service.ts`; API `POST /api/jobs/[id]/reveal-apply` + опциональный `to` в существующем `/dispatch` (auto-reveal); клиентская секция `apply-methods-section.tsx` на `/job/[id]` (только для source=jobbank).

**Tech Stack:** TS strict, vitest (unit: packages/adapters/test; integration: tests/integration с node:http-сервером и Postgres), Playwright e2e, Kysely, DS-токены.

**Spec:** `specs/S25-jobbank-apply-adapter.md` (accepted G1 — мандат PO «начни делать пер-сайт форм-адаптеры», 2026-10-03).

## Global Constraints

- Ст. 11: раскрытие — read-only (никаких submit'ов в Job Bank из S25); Direct Apply — вне скоупа (S26).
- Egress: прод-URL только через `assertSafeExternalUrl(url, EGRESS_JOBBANK_HOSTS)` (B-010); инъекция fetch — политика вызывающей стороны (тесты/локальный сервер).
- Раскрытие никогда не батчами: только по действию PO (кнопка/Send), TTL кэша 15 мин, троттлинг не ретраится.
- `job.raw.applyMethods` пишет ТОЛЬКО сервис; API не принимает методы из запроса.
- Скрининг-вопросы — display-only (ст. 2: ответы не генерируются).
- Цвета/шрифты — только DS-токены (S16/S17); греп-гейт хардкода.
- Kysely `.execute()`; никаких новых env-переменных; секреты не затрагиваются.

---

### Task 1: Фикстуры + classifyPosting + extractApplyMethods + buildRevealPostBody (adapters, pure)

**Files:**
- Create: `packages/adapters/test/fixtures/jobbank/apply/direct-get.html` (прямой постинг, GET-вид — кнопка, панели НЕТ)
- Create: `packages/adapters/test/fixtures/jobbank/apply/direct-panel-email.html` (POST-вид: панель с Direct Apply + email + вопросы + заметки)
- Create: `packages/adapters/test/fixtures/jobbank/apply/direct-panel-web.html` (панель с «Apply online» → внешняя ссылка)
- Create: `packages/adapters/test/fixtures/jobbank/apply/direct-panel-inperson.html` (панель: только in person/прочее → otherText)
- Create: `packages/adapters/test/fixtures/jobbank/apply/partner.html` (партнёрский: externalJobLink)
- Create: `packages/adapters/test/fixtures/jobbank/apply/expired.html` (нет ни кнопки, ни ссылки)
- Create: `packages/adapters/src/jobbank-apply.ts`
- Create: `packages/adapters/test/jobbank-apply.test.ts`
- Modify: `packages/adapters/src/index.ts`, `packages/adapters/package.json` (subpath `./jobbank-apply`)

**Interfaces (Produces):**
```ts
export type PostingKind = 'partner' | 'direct' | 'unknown';
export interface ApplyMethods {
  email: string | null; webUrl: string | null; directApply: boolean;
  screeningQuestions: string[]; notes: string[]; otherText: string | null;
}
export function classifyPosting(html: string): PostingKind;
export function extractApplyMethods(pageHtml: string): ApplyMethods | null; // null = панели нет
export function buildRevealPostBody(jobId: string): string;
```

- [ ] **Step 1: Фикстуры** — синтетические, маркерная разметка живых страниц (email'ы `*@fixture.example`). Скелет `direct-panel-email.html` (другие — вариации):

```html
<!doctype html><html><body>
<div id="applynow" class="job-posting-detail-apply">
  <section id="seekeractions" class="how-to-apply">
    <p><button type="button" data-jsjobid="99990001" id="applynowbutton" class="btn btn-primary">Show how to apply</button></p>
    <form id="seekeractivity" name="seekeractivity" method="post" action="/jobsearch/pers/jobposting.xhtml"><input type="hidden" id="seekeractivity:jobid" name="seekeractivity:jobid" value="99990001" /><input type="hidden" name="seekeractivity_SUBMIT" value="1" /><input type="hidden" name="jakarta.faces.ViewState" value="stateless" /></form>
  </section>
  <div id="howtoapply" class="howtoapply">
    <h3>How to apply</h3>
    <h4>By Direct Apply</h4>
    <section id="direct-apply-popup" class="mfp-hide modal-dialog"><div class="modal-body"><p>Sign in to apply directly on Job Bank.</p></div></section>
    <details class="mrgn-tp-md"><summary>Additional ways to apply</summary>
      <h4 id="htaemail">By email</h4>
      <p><a href="mailto:careers@fixture.example">careers@fixture.example</a></p>
      <h4>What you must include in your application:</h4>
      <ul><li>Answers to the following screening questions:
        <ul><li>Do you have a valid driver's licence?</li><li>Do you meet the language requirements (English or French)?</li></ul>
      </li></ul>
      <h4>What might be required by the employer later in the hiring process:</h4>
      <ul><li data-appinst="3">References attesting experience</li><li data-appinst="4">Letter of recommendation</li></ul>
    </details>
  </div>
</div>
</body></html>
```

`direct-get.html` — тот же файл без блока `id="howtoapply"` (панель не раскрыта). `partner.html`: внутри `#applynow` — `<a id="externalJobLink" href="https://partner.example/job/1">…</a>`, панели нет. `expired.html`: только текст и «Advertised until».

- [ ] **Step 2: RED** — `packages/adapters/test/jobbank-apply.test.ts`:

```ts
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { classifyPosting, extractApplyMethods, buildRevealPostBody } from '../src/jobbank-apply.js';

const F = (name: string) => readFileSync(join('test/fixtures/jobbank/apply', name), 'utf8');

describe('classifyPosting (S25 R1)', () => {
  it('partner: externalJobLink', () => expect(classifyPosting(F('partner.html'))).toBe('partner'));
  it('direct: applynowbutton', () => expect(classifyPosting(F('direct-get.html'))).toBe('direct'));
  it('expired/unknown', () => expect(classifyPosting(F('expired.html'))).toBe('unknown'));
  it('empty → unknown', () => expect(classifyPosting('')).toBe('unknown'));
});

describe('extractApplyMethods (S25 R2)', () => {
  it('GET-вид (панели нет) → null', () => expect(extractApplyMethods(F('direct-get.html'))).toBeNull());
  it('email + вопросы + заметки + directApply', () => {
    const m = extractApplyMethods(F('direct-panel-email.html'));
    expect(m).not.toBeNull();
    expect(m!.email).toBe('careers@fixture.example');
    expect(m!.directApply).toBe(true);
    expect(m!.screeningQuestions).toEqual([
      'Do you have a valid driver\'s licence?',
      'Do you meet the language requirements (English or French)?',
    ]);
    expect(m!.notes).toEqual(['References attesting experience', 'Letter of recommendation']);
    expect(m!.webUrl).toBeNull();
  });
  it('Apply online → webUrl (внешняя ссылка, не jobbank)', () => {
    const m = extractApplyMethods(F('direct-panel-web.html'));
    expect(m!.webUrl).toBe('https://employer.example/apply/123');
    expect(m!.email).toBeNull();
  });
  it('in person → otherText', () => {
    const m = extractApplyMethods(F('direct-panel-inperson.html'));
    expect(m!.otherText).toContain('In person');
    expect(m!.email).toBeNull();
  });
  it('HTML-entities в вопросах декодируются', () => {
    const m = extractApplyMethods(F('direct-panel-email.html').replace("driver's licence", 'driver&#39;s licence'));
    expect(m!.screeningQuestions[0]).toBe("Do you have a valid driver's licence?");
  });
});

describe('buildRevealPostBody (S25 R1)', () => {
  it('точное тело JSF-постбэка', () => {
    expect(buildRevealPostBody('99990001')).toBe(
      'seekeractivity%3Ajobid=99990001&seekeractivity_SUBMIT=1&jakarta.faces.ViewState=stateless',
    );
  });
});
```

- [ ] **Step 3: FAIL** — `pnpm vitest run packages/adapters/test/jobbank-apply.test.ts` (модуля нет).
- [ ] **Step 4: GREEN** — реализация `packages/adapters/src/jobbank-apply.ts`:

```ts
// S25: Job Bank apply-адаптер — классификация постинга и извлечение методов
// подачи из панели «How to apply» (раскрытой JSF-постбэком). Маркеры сняты с
// живых страниц 2026-10-03; PII в фикстурах обезличен.
import { stripHtml } from './posting-fetcher';

export type PostingKind = 'partner' | 'direct' | 'unknown';
export interface ApplyMethods {
  email: string | null;
  webUrl: string | null;
  directApply: boolean;
  screeningQuestions: string[];
  notes: string[];
  otherText: string | null;
}

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;

export function classifyPosting(html: string): PostingKind {
  if (/id="externalJobLink"/.test(html)) return 'partner';
  if (/id="applynowbutton"/.test(html)) return 'direct';
  return 'unknown';
}

export function buildRevealPostBody(jobId: string): string {
  const id = encodeURIComponent(jobId);
  return `seekeractivity%3Ajobid=${id}&seekeractivity_SUBMIT=1&jakarta.faces.ViewState=stateless`;
}

/** Панель целиком (или null): от id="howtoapply" до job-posting-detail-common. */
function panelOf(pageHtml: string): string | null {
  const start = pageHtml.indexOf('id="howtoapply"');
  if (start < 0) return null;
  const end = pageHtml.indexOf('job-posting-detail-common', start);
  return pageHtml.slice(start, end > start ? end : undefined);
}

/** Текст первого mailto/адреса в секции. */
function emailOf(sectionHtml: string): string | null {
  const mailto = /href="mailto:([^"'?]+)/i.exec(sectionHtml);
  if (mailto?.[1] && EMAIL_RE.test(mailto[1])) return mailto[1];
  const plain = EMAIL_RE.exec(sectionHtml);
  return plain?.[0] ?? null;
}

/** Первая внешняя http(s)-ссылка секции (не jobbank). */
function webUrlOf(sectionHtml: string): string | null {
  const re = /href="(https?:\/\/[^"]+)"/gi;
  for (let m = re.exec(sectionHtml); m; m = re.exec(sectionHtml)) {
    const url = m[1]!;
    if (!/jobbank\.gc\.ca/i.test(url)) return url;
  }
  return null;
}

/** li-тексты блока; li, содержащие вложенный <ul> (обёртки-боилерплейты), пропускаются. */
function listItems(sectionHtml: string): string[] {
  const items: string[] = [];
  const re = /<li[^>]*>([\s\S]*?)<\/li>/gi;
  for (let m = re.exec(sectionHtml); m; m = re.exec(sectionHtml)) {
    const inner = m[1]!;
    if (/<ul[\s>]/i.test(inner)) continue; // обёртка со вложенным списком
    const text = stripHtml(inner).trim();
    if (text !== '') items.push(text);
  }
  return items;
}

/** Секция h4-заголовка: от </h4> до следующего <h4 или конца панели. */
function sectionUnderHeading(panel: string, headingTest: (h: string) => boolean): string | null {
  const re = /<h4[^>]*>([\s\S]*?)<\/h4>/gi;
  const headings = [...panel.matchAll(re)];
  for (let i = 0; i < headings.length; i++) {
    const h = stripHtml(headings[i]![1]!).toLowerCase().trim();
    if (headingTest(h)) {
      const from = (headings[i]!.index ?? 0) + headings[i]![0].length;
      const to = i + 1 < headings.length ? headings[i + 1]!.index : panel.length;
      return panel.slice(from, to);
    }
  }
  return null;
}

const OTHER_HEADINGS = /^(in person|by phone|by mail|by fax|in person\b|apply in person)/;

export function extractApplyMethods(pageHtml: string): ApplyMethods | null {
  const panel = panelOf(pageHtml);
  if (!panel) return null;
  const emailSection = sectionUnderHeading(panel, (h) => h.startsWith('by email'));
  const webSection = sectionUnderHeading(panel, (h) => /apply online|by web|online at/.test(h));
  const mustInclude = sectionUnderHeading(panel, (h) => h.includes('must include'));
  const later = sectionUnderHeading(panel, (h) => h.includes('might be required') || h.includes('required by the employer later'));

  const others: string[] = [];
  const h4re = /<h4[^>]*>([\s\S]*?)<\/h4>/gi;
  for (const h of panel.matchAll(h4re)) {
    const text = stripHtml(h[1]!).trim();
    if (OTHER_HEADINGS.test(text.toLowerCase())) {
      const from = (h.index ?? 0) + h[0].length;
      const to = panel.indexOf('<h4', from);
      const body = stripHtml(panel.slice(from, to > from ? to : panel.length)).trim();
      others.push(`${text}${body ? `: ${body}` : ''}`);
    }
  }

  const methods: ApplyMethods = {
    email: emailSection ? emailOf(emailSection) : null,
    webUrl: webSection ? webUrlOf(webSection) : null,
    directApply: /id="direct-apply-popup"|class="[^"]*openDA/.test(panel),
    screeningQuestions: mustInclude ? listItems(mustInclude) : [],
    notes: later ? listItems(later) : [],
    otherText: others.length > 0 ? others.join('; ') : null,
  };
  return methods;
}
```

- [ ] **Step 5: PASS** — та же команда vitest, все зелёные (включая существующие тесты adapters).
- [ ] **Step 6:** `packages/adapters/package.json` — subpath по образцу `./posting-fetcher`:

```json
"./jobbank-apply": { "types": "./src/jobbank-apply.ts", "default": "./src/jobbank-apply.ts" },
"./jobbank-apply.js": { "types": "./src/jobbank-apply.ts", "default": "./src/jobbank-apply.ts" }
```
`packages/adapters/src/index.ts` — добавить: `export { classifyPosting, extractApplyMethods, buildRevealPostBody } from './jobbank-apply'; export type { ApplyMethods, PostingKind } from './jobbank-apply';`
- [ ] **Step 7: Commit** `S25 T1: jobbank apply panel — classify/extract/buildRevealPostBody (fixtures, red→green)`.

---

### Task 2: revealApplyMethods (оркестрация) + httpRevealFetch (cookie-jar + egress)

**Files:**
- Modify: `packages/adapters/src/jobbank-apply.ts`, `packages/adapters/test/jobbank-apply.test.ts`
- Test: `tests/integration/jobbank-apply.test.ts` (создать; полные сценарии — в Task 3, здесь — транспорт против node:http-сервера)

**Interfaces:**
```ts
export interface RevealResponse { status: number; body: string }
export interface RevealFetch {
  get(url: string): Promise<RevealResponse>;
  post(url: string, body: string): Promise<RevealResponse>;
}
export type RevealOutcome =
  | { kind: 'revealed'; methods: ApplyMethods }
  | { kind: 'throttled' | 'partner' | 'unavailable' };
export function httpRevealFetch(postingUrl: string, allowedHosts?: readonly string[]): RevealFetch; // guard + jar внутри
export async function revealApplyMethods(fetcher: RevealFetch, postingUrl: string, jobId: string): Promise<RevealOutcome>;
```

- [ ] **Step 1: RED (unit, fake fetcher)** — в `jobbank-apply.test.ts` добавить:

```ts
import { revealApplyMethods, buildRevealPostBody } from '../src/jobbank-apply.js';
import type { RevealFetch } from '../src/jobbank-apply.js';

const POST_URL = 'https://www.jobbank.gc.ca/jobsearch/jobposting/99990001';
function fakeFetch(getBody: string, postBody: string, status = 200): RevealFetch & { posts: Array<{ url: string; body: string }> } {
  const posts: Array<{ url: string; body: string }> = [];
  return {
    posts,
    async get() { return { status, body: getBody }; },
    async post(url, body) { posts.push({ url, body }); return { status, body: postBody }; },
  };
}

describe('revealApplyMethods (S25 R1/R4)', () => {
  it('direct: GET→POST→revealed, POST-тело и URL точные', async () => {
    const f = fakeFetch(F('direct-get.html'), F('direct-panel-email.html'));
    const out = await revealApplyMethods(f, POST_URL, '99990001');
    expect(out).toEqual({ kind: 'revealed', methods: expect.objectContaining({ email: 'careers@fixture.example' }) });
    expect(f.posts).toEqual([{ url: POST_URL, body: buildRevealPostBody('99990001') }]);
  });
  it('partner: без POST', async () => {
    const f = fakeFetch(F('partner.html'), F('partner.html'));
    const out = await revealApplyMethods(f, POST_URL, '99990001');
    expect(out).toEqual({ kind: 'partner' });
    expect(f.posts).toHaveLength(0);
  });
  it('троттлинг: POST ok, панели нет → throttled', async () => {
    const f = fakeFetch(F('direct-get.html'), F('direct-get.html'));
    expect(await revealApplyMethods(f, POST_URL, '99990001')).toEqual({ kind: 'throttled' });
  });
  it('не-2xx GET → unavailable (POST не вызывался)', async () => {
    const f = fakeFetch(F('direct-get.html'), F('direct-panel-email.html'), 503);
    expect(await revealApplyMethods(f, POST_URL, '99990001')).toEqual({ kind: 'unavailable' });
    expect(f.posts).toHaveLength(0);
  });
  it('unknown-разметка → unavailable', async () => {
    const f = fakeFetch(F('expired.html'), F('expired.html'));
    expect(await revealApplyMethods(f, POST_URL, '99990001')).toEqual({ kind: 'unavailable' });
  });
});
```

- [ ] **Step 2: FAIL → GREEN** — дописать в `jobbank-apply.ts`:

```ts
import { assertSafeExternalUrl, EGRESS_JOBBANK_HOSTS } from './egress';
import { crawlerUserAgent } from './user-agent';

export interface RevealResponse { status: number; body: string }
export interface RevealFetch {
  get(url: string): Promise<RevealResponse>;
  post(url: string, body: string): Promise<RevealResponse>;
}
export type RevealOutcome =
  | { kind: 'revealed'; methods: ApplyMethods }
  | { kind: 'throttled' | 'partner' | 'unavailable' };

const UA = { 'User-Agent': crawlerUserAgent(), Accept: 'text/html' };
const TIMEOUT_MS = 30_000;

/** Прод-транспорт: egress-guard B-010 + cookie-jar (JSESSIONID из GET → POST). */
export function httpRevealFetch(postingUrl: string, allowedHosts: readonly string[] = EGRESS_JOBBANK_HOSTS): RevealFetch {
  const base = assertSafeExternalUrl(postingUrl, allowedHosts).toString();
  let cookie = '';
  const request = async (method: 'GET' | 'POST', body?: string): Promise<RevealResponse> => {
    const response = await fetch(base, {
      method,
      headers: { ...UA, ...(body ? { 'Content-Type': 'application/x-www-form-urlencoded', cookie } : cookie ? { cookie } : {}) },
      body,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const setCookies = response.headers.getSetCookie?.() ?? [];
    if (setCookies.length > 0) cookie = setCookies.map((c) => c.split(';')[0]).join('; ');
    return { status: response.status, body: await response.text() };
  };
  return { get: () => request('GET'), post: (_url, body) => request('POST', body) };
}

export async function revealApplyMethods(fetcher: RevealFetch, postingUrl: string, jobId: string): Promise<RevealOutcome> {
  let page: RevealResponse;
  try { page = await fetcher.get(postingUrl); } catch { return { kind: 'unavailable' }; }
  if (page.status < 200 || page.status >= 300) return { kind: 'unavailable' };
  const kind = classifyPosting(page.body);
  if (kind === 'partner') return { kind: 'partner' };
  if (kind !== 'direct') return { kind: 'unavailable' };
  let posted: RevealResponse;
  try { posted = await fetcher.post(postingUrl, buildRevealPostBody(jobId)); } catch { return { kind: 'unavailable' }; }
  if (posted.status < 200 || posted.status >= 300) return { kind: 'unavailable' };
  const methods = extractApplyMethods(posted.body);
  return methods ? { kind: 'revealed', methods } : { kind: 'throttled' };
}
```

- [ ] **Step 3: integration-транспорт (RED→GREEN)** — `tests/integration/jobbank-apply.test.ts` (начало файла; node:http-сервер повторяет поведение Job Bank: GET ставит JSESSIONID, POST с cookie и телом → панель, без cookie → GET-вид):

```ts
import { createServer, type Server } from 'node:http';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { httpRevealFetch, revealApplyMethods } from '@chinook/adapters/jobbank-apply';

const FIX = (n: string) => readFileSync(join(__dirname, '../../packages/adapters/test/fixtures/jobbank/apply', n), 'utf8');
const JOB_ID = '99990001';
let server: Server; let base = ''; let postsSeen = 0;

beforeAll(async () => {
  server = createServer((req, res) => {
    const cookies = req.headers.cookie ?? '';
    if (req.method === 'GET') {
      res.setHeader('Set-Cookie', 'JSESSIONID=test-session; Path=/');
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(FIX('direct-get.html'));
      return;
    }
    postsSeen++;
    if (cookies.includes('JSESSIONID=test-session') && (req.headers.cookie ?? '') !== '' && postsSeen <= 2) {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(FIX('direct-panel-email.html'));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(FIX('direct-get.html')); // троттлинг-поведение
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}/jobsearch/jobposting/${JOB_ID}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

describe('httpRevealFetch + revealApplyMethods против локального сервера (S25 AC4)', () => {
  it('GET→POST с cookie → revealed', async () => {
    const out = await revealApplyMethods(httpRevealFetch(base, ['127.0.0.1']), base, JOB_ID);
    expect(out).toEqual({ kind: 'revealed', methods: expect.objectContaining({ email: 'careers@fixture.example' }) });
    expect(postsSeen).toBe(1);
  });
  it('троттлинг-сервер → throttled', async () => {
    const out = await revealApplyMethods(httpRevealFetch(base, ['127.0.0.1']), base, JOB_ID);
    expect(out.kind).toBe('throttled');
  });
  it('egress-guard: не-jobbank хост без явного allowlist → unavailable', async () => {
    const out = await revealApplyMethods(httpRevealFetch(base), base, JOB_ID);
    expect(out.kind).toBe('unavailable');
  });
});
```

(порядок тестов внутри describe значим: первый — «свежая сессия», второй — сервер уже «затроттил»; комментарий об этом обязателен).

- [ ] **Step 4: PASS** — `pnpm vitest run packages/adapters/test/jobbank-apply.test.ts tests/integration/jobbank-apply.test.ts`.
- [ ] **Step 5: Commit** `S25 T2: reveal orchestration + httpRevealFetch (cookie jar, egress guard)`.

---

### Task 3: Сервис revealJobApplyMethods (кэш/TTL/политика) + API-роуты

**Files:**
- Create: `apps/web/src/lib/jobbank-dispatch-service.ts`
- Create: `apps/web/app/api/jobs/[id]/reveal-apply/route.ts`
- Modify: `apps/web/app/api/jobs/[id]/dispatch/route.ts` (to — опциональный + auto-reveal)
- Test: `tests/integration/jobbank-apply.test.ts` (сервис-сценарии; БД из тест-конвенции tests/integration — как в dispatch.test.ts)

**Interfaces:**
```ts
export const REVEAL_TTL_MIN = 15;
export class RevealJobNotFoundError extends Error { readonly status = 404 }
export interface CachedApplyMethods { methods: ApplyMethods; revealedAt: Date }
export function parseCachedApplyMethods(raw: unknown): CachedApplyMethods | null; // shape-валидация
export interface RevealServiceOutcome { status: 'revealed'|'cached'|'throttled'|'partner'|'unavailable'; methods: ApplyMethods | null }
export async function revealJobApplyMethods(
  db: Kysely<Database>, jobId: string,
  opts?: { fetcher?: RevealFetch; now?: Date; ttlMin?: number },
): Promise<RevealServiceOutcome>;
// /dispatch: Body.to → optional; при отсутствии — reveal, email из методов, иначе 409
```

- [ ] **Step 1: RED** — в `tests/integration/jobbank-apply.test.ts` добавить describe (БД по паттерну `tests/integration/dispatch.test.ts`: схема через `ensureSchema`, вакансии через прямые insertInto с raw-фикстурами; сетка дата-кейсов):

```ts
import { Kysely } from 'kysely';
import { ensureSchema, type Database } from '@chinook/core';
import { getIntegrationDb } from './helpers/db'; // существующий хелпер интеграционных тестов (см. dispatch.test.ts импорты)
import { revealJobApplyMethods, parseCachedApplyMethods, REVEAL_TTL_MIN } from '../../apps/web/src/lib/jobbank-dispatch-service';
import type { RevealFetch } from '@chinook/adapters/jobbank-apply';
```

(точные импорты БД копировать из `tests/integration/dispatch.test.ts` — там уже решены схема/сид/очистка; вставить фикстурную вакансию:)

```ts
async function seedJobbankJob(db: Kysely<Database>, overrides: Record<string, unknown> = {}) {
  const id = crypto.randomUUID();
  await db.insertInto('job').values({
    id, title: 'welder-assembler', employer: 'Fixture employer', city: 'Fort McMurray',
    province: 'AB', remote: false, source: 'jobbank', source_job_id: JOB_ID,
    url: 'https://www.jobbank.gc.ca/jobsearch/jobposting/99990001',
    posted_at: new Date(), ingested_at: new Date(),
    rule_status: 'relevant', raw: { summary: { '#text': 'fixture' }, ...overrides },
  }).execute();
  return id;
}
```

Сценарии:
1. `parseCachedApplyMethods`: валидный raw → методы+дата; мусор/неполный shape → null (email-строка или null, screeningQuestions — массив строк и т.п.).
2. reveal Job Bank-вакансии с инъекцией fake-fetcher (direct-panel-email) → `status='revealed'`, `raw.applyMethods` записан (прочитать из БД: email + revealedAt = Date), повторный вызов с now=+5 мин → `'cached'`, fetcher НЕ вызывался (счётчик).
3. кэш старше TTL (`now = revealedAt + REVEAL_TTL_MIN + 1 мин`) → повторный reveal (fetcher вызван).
4. `source='adzuna'` → `'unavailable'`, fetcher не создан.
5. URL не-jobbank при НЕинъектированном fetcher → `'unavailable'` (egress-guard) — у вакансии url=`https://evil.example/x`.
6. Троттлинг (fake-fetcher возвращает GET-вид) → `status='throttled'`, raw НЕ перезаписан.

- [ ] **Step 2: FAIL → GREEN** — `apps/web/src/lib/jobbank-dispatch-service.ts`:

```ts
// S25: Job Bank apply-сервис — on-demand раскрытие панели подачи, кэш в
// job.raw.applyMethods, консервативная политика (ст. 11): только по действию
// PO, TTL-кэш, троттлинг не ретраится. Прямых submit'ов в Job Bank нет (S26).
import type { Kysely } from 'kysely';
import type { Database } from '@chinook/core';
import {
  httpRevealFetch, revealApplyMethods,
  type ApplyMethods, type RevealFetch, type RevealOutcome,
} from '@chinook/adapters/jobbank-apply';

export const REVEAL_TTL_MIN = 15;

export class RevealJobNotFoundError extends Error {
  readonly status = 404;
  constructor(message = 'job not found') { super(message); this.name = 'RevealJobNotFoundError'; }
}

export interface CachedApplyMethods { methods: ApplyMethods; revealedAt: Date }

const EMAIL_RE = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;

function asStringArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}

/** Форма-валидация кэша job.raw.applyMethods (дефолты для незнакомых полей). */
export function parseCachedApplyMethods(raw: unknown): CachedApplyMethods | null {
  const m = (raw as Record<string, unknown> | null)?.applyMethods as Record<string, unknown> | undefined;
  if (!m || typeof m !== 'object') return null;
  const revealedAtRaw = m.revealedAt;
  const revealedAt = typeof revealedAtRaw === 'string' ? new Date(revealedAtRaw) : null;
  if (!revealedAt || Number.isNaN(revealedAt.getTime())) return null;
  const email = typeof m.email === 'string' && EMAIL_RE.test(m.email) ? m.email : null;
  const webUrl = typeof m.webUrl === 'string' && /^https?:\/\//.test(m.webUrl) ? m.webUrl : null;
  return {
    revealedAt,
    methods: {
      email,
      webUrl,
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

export async function revealJobApplyMethods(
  db: Kysely<Database>,
  jobId: string,
  opts?: { fetcher?: RevealFetch; now?: Date; ttlMin?: number },
): Promise<RevealServiceOutcome> {
  const job = await db.selectFrom('job')
    .select(['id', 'source', 'url', 'raw'])
    .where('id', '=', jobId).executeTakeFirst();
  if (!job) throw new RevealJobNotFoundError();
  if (job.source !== 'jobbank' || !job.url) return { status: 'unavailable', methods: null };

  const raw = (job.raw ?? {}) as Record<string, unknown>;
  const cached = parseCachedApplyMethods(raw);
  const ttlMin = opts?.ttlMin ?? REVEAL_TTL_MIN;
  const now = opts?.now ?? new Date();
  if (cached && now.getTime() - cached.revealedAt.getTime() < ttlMin * 60_000) {
    return { status: 'cached', methods: cached.methods };
  }

  // Политика egress (B-010) живёт в httpRevealFetch; инъекция fetcher — для
  // тестов/локального сервера (политика вызывающей стороны — урок Mimosa).
  let outcome: RevealOutcome;
  try {
    outcome = await revealApplyMethods(opts?.fetcher ?? httpRevealFetch(job.url), job.url, String(job.source_job_id ?? ''));
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
```

(если `job.source_job_id` не строка в схеме — привести `String(…)` только когда не null; jobId posting-страницы для POST-тела берётся из `source_job_id` — у живых jobbank-вакансий это число постинга; null → fallback: вытащить `\d+` из job.url, иначе 'unknown' → POST вернёт throttled/unavailable, не краш.)

- [ ] **Step 3: API reveal-apply (RED→GREEN)** — `apps/web/app/api/jobs/[id]/reveal-apply/route.ts` по образцу dispatch-form:

```ts
// S25 T3: POST /api/jobs/[id]/reveal-apply — on-demand раскрытие панели подачи
// Job Bank (read-only: ничего не отправляет), кэш в raw. Методы из запроса
// НЕ принимаются — только выдача (форма-фейк поверхность закрыта).
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { ensureSchema, type Database, type Kysely } from '@chinook/core';
import { getDb } from '@/lib/db';
import { revealJobApplyMethods, RevealJobNotFoundError } from '@/lib/jobbank-dispatch-service';

export const dynamic = 'force-dynamic';

let schemaReady: Promise<unknown> | null = null;
function schemaReadyOnce(db: Kysely<Database>): Promise<unknown> {
  schemaReady ??= ensureSchema(db);
  return schemaReady;
}

export async function POST(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const uuid = z.uuid().safeParse(id);
  if (!uuid.success) return NextResponse.json({ error: 'invalid job id' }, { status: 400 });
  const db = getDb();
  await schemaReadyOnce(db);
  try {
    const result = await revealJobApplyMethods(db, uuid.data);
    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof RevealJobNotFoundError) return NextResponse.json({ error: 'not found' }, { status: 404 });
    console.error('[reveal-apply] failed:', error instanceof Error ? error.message : error);
    return NextResponse.json({ error: 'reveal failed' }, { status: 500 });
  }
}
```

- [ ] **Step 4: /dispatch auto-reveal (RED→GREEN)** — в `apps/web/app/api/jobs/[id]/dispatch/route.ts`:
  - `Body = z.object({ to: z.string().min(3).optional(), kinds: … })`.
  - Перед вызовом `sendApplicationEmail`: если `parsed.data.to` нет —

```ts
import { revealJobApplyMethods } from '@/lib/jobbank-dispatch-service';

let to = parsed.data.to?.trim();
if (!to) {
  const reveal = await revealJobApplyMethods(db, uuid.data);
  if (!reveal.methods?.email) {
    return NextResponse.json(
      { error: 'no recipient available — reveal apply methods first', reveal: { status: reveal.status } },
      { status: 409 },
    );
  }
  to = reveal.methods.email;
}
const result = await sendApplicationEmail(db, uuid.data, { to, kinds: parsed.data.kinds });
```
  - существующие тесты `tests/integration/dispatch.test.ts` не меняются (to передаётся явно).

- [ ] **Step 5: PASS** — `pnpm vitest run tests/integration/jobbank-apply.test.ts tests/integration/dispatch.test.ts`.
- [ ] **Step 6: Commit** `S25 T3: reveal service (cache/TTL/policy) + reveal-apply route + dispatch auto-reveal`.

---

### Task 4: UI — секция «Apply methods (Job Bank)» + префилл email

**Files:**
- Create: `apps/web/app/job/[id]/apply-methods-section.tsx`
- Modify: `apps/web/app/job/[id]/page.tsx` (парсинг кэша, префилл recipients, рендер секции)

**Interfaces:**
- Consumes: `parseCachedApplyMethods`, `CachedApplyMethods` (Task 3).
- Produces: `<ApplyMethodsSection jobId initial={CachedApplyMethods | null} />` (client); page добавляет `raw.applyMethods.email` в `recipients` после S23 applyEmail.

- [ ] **Step 1:** `apply-methods-section.tsx` (client, стиль — инлайн DS-токены по паттерну page.tsx):

```tsx
'use client';

// S25 T4 — Apply methods (Job Bank): on-demand раскрытие панели подачи
// (read-only — ничего не отправляется), кэш методов на вакансии.
// Кнопка Reveal = действие PO; троттлинг → подсказка ручного пути (ст. 11).
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import type { ApplyMethods } from '@chinook/adapters/jobbank-apply';

export function ApplyMethodsSection({
  jobId,
  initial,
}: {
  jobId: string;
  initial: { methods: ApplyMethods; revealedAt: string } | null;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [methods, setMethods] = useState<ApplyMethods | null>(initial?.methods ?? null);

  async function reveal() {
    setBusy(true);
    setStatus(null);
    try {
      const res = await fetch(`/api/jobs/${jobId}/reveal-apply`, { method: 'POST' });
      const data = (await res.json()) as { status?: string; methods?: ApplyMethods | null; error?: string };
      if (!res.ok) {
        setStatus(data.error ?? 'reveal failed');
      } else if ((data.status === 'revealed' || data.status === 'cached') && data.methods) {
        setMethods(data.methods);
        setStatus(data.status === 'cached' ? 'Showing saved methods.' : null);
        router.refresh(); // префилл email в dispatch-секциях
      } else if (data.status === 'throttled') {
        setStatus('Job Bank did not reveal the panel right now (rate limit). Open the posting and copy the details manually.');
      } else if (data.status === 'partner') {
        setStatus('Partner posting — application happens on the linked external site.');
      } else {
        setStatus('Apply methods are not available for this posting.');
      }
    } catch {
      setStatus('reveal failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <section data-testid="apply-methods" style={{ borderTop: '1px solid var(--border-subtle)', margin: '20px 0', paddingTop: 16 }}>
      <h3 style={{ fontSize: 'var(--text-emphasis)', margin: '0 0 12px' }}>Apply methods (Job Bank)</h3>
      {methods ? (
        <div style={{ color: 'var(--text-secondary)', fontSize: 'var(--text-body)' }}>
          {methods.email ? <p style={{ margin: '0 0 6px' }}>Email: <strong>{methods.email}</strong></p> : null}
          {methods.webUrl ? <p style={{ margin: '0 0 6px' }}>Apply online: <a href={methods.webUrl} target="_blank" rel="noopener noreferrer" style={{ color: 'var(--accent)' }}>{methods.webUrl.slice(0, 60)}{methods.webUrl.length > 60 ? '…' : ''}</a></p> : null}
          {methods.directApply ? <p style={{ margin: '0 0 6px' }}>Direct Apply available on Job Bank (account sign-in required — manual, automation planned separately).</p> : null}
          {methods.screeningQuestions.length > 0 ? (
            <div style={{ margin: '8px 0 6px' }}>
              <div style={{ color: 'var(--text-muted)', fontSize: 'var(--text-aux)' }}>Screening questions (answer them yourself in the application — never auto-answered):</div>
              <ul style={{ margin: '4px 0 0', paddingLeft: 20 }}>{methods.screeningQuestions.map((q, i) => <li key={i}>{q}</li>)}</ul>
            </div>
          ) : null}
          {methods.notes.length > 0 ? (
            <div style={{ margin: '8px 0 6px' }}>
              <div style={{ color: 'var(--text-muted)', fontSize: 'var(--text-aux)' }}>Required later in hiring:</div>
              <ul style={{ margin: '4px 0 0', paddingLeft: 20 }}>{methods.notes.map((n, i) => <li key={i}>{n}</li>)}</ul>
            </div>
          ) : null}
          {methods.otherText ? <p style={{ margin: '6px 0 0', color: 'var(--text-muted)' }}>{methods.otherText}</p> : null}
          <button onClick={reveal} disabled={busy} data-testid="apply-methods-refresh"
            style={{ marginTop: 10, background: 'none', border: '1px solid var(--border-subtle)', color: 'var(--text-secondary)', cursor: 'pointer', padding: '4px 10px' }}>
            {busy ? 'Checking…' : 'Re-check methods'}
          </button>
        </div>
      ) : (
        <div>
          <p style={{ color: 'var(--text-secondary)', fontSize: 'var(--text-body)', margin: '0 0 8px' }}>
            The «How to apply» panel is hidden on direct Job Bank postings. Reveal it to get the email / link (read-only, nothing is sent).
          </p>
          <button onClick={reveal} disabled={busy} data-testid="apply-methods-reveal"
            style={{ background: 'var(--accent)', border: 'none', color: '#0b1f33', fontWeight: 600, cursor: 'pointer', padding: '6px 14px' }}>
            {busy ? 'Revealing…' : 'Reveal apply methods'}
          </button>
        </div>
      )}
      {status ? <p data-testid="apply-methods-status" style={{ marginTop: 8, color: 'var(--status-warning)', fontSize: 'var(--text-aux)' }}>{status}</p> : null}
    </section>
  );
}
```

(цвет текста кнопки — токен из DS; если хардкод-гейт ругнётся на `#0b1f33`, заменить на `var(--accent-contrast)`/существующий токен палитры — сверить с S17-токенами перед коммитом.)

- [ ] **Step 2:** `page.tsx` — импорты + парсинг + рендер (только jobbank):

```tsx
import { ApplyMethodsSection } from './apply-methods-section';
import { parseCachedApplyMethods } from '@/lib/jobbank-dispatch-service';
```
в теле компонента после `const applyEmailRaw = …`:
```tsx
const cachedApply = parseCachedApplyMethods(job.raw);
if (cachedApply?.methods.email && !recipients.includes(cachedApply.methods.email)) {
  recipients.push(cachedApply.methods.email);
}
```
(`recipients` объявить `const`→let или push-ом по мутабельному массиву — он уже `Array`); рендер после `<EmailDispatchSection … />`:
```tsx
{job.source === 'jobbank' ? (
  <ApplyMethodsSection
    jobId={job.id}
    initial={cachedApply ? { methods: cachedApply.methods, revealedAt: cachedApply.revealedAt.toISOString() } : null}
  />
) : null}
```
- [ ] **Step 3: PASS** — `pnpm --filter web typecheck && pnpm vitest run tests/unit tests/integration` (без новых падений).
- [ ] **Step 4: Commit** `S25 T4: apply-methods UI section + email prefill from revealed methods`.

---

### Task 5: E2E + визуальный бейслайн + гейты + доки/отчёт

**Files:**
- Create: `tests/e2e/jobbank-apply.spec.ts`
- Create: `tests/e2e/__snapshots__/jobbank-apply.spec.ts-snap/…` (бейслайны после первого прогона)
- Modify: `STACK.md` (только если версия-строка меняется — новых пакетов нет: не менять), `specs/notes/S25-report.md` (создать), DESIGN.md §6.1 (строка S25 в реестр — по образцу S19–S24)

**Interfaces:** seed через существующий e2e-сид (см. `tests/e2e/dispatch.spec.ts` openSeededJob / fixture-seeding helper — при необходимости дописать raw-override для фикс. вакансии, как это делает трек-спека S24: `seed-e2e.ts` в apps/worker).

- [ ] **Step 1: Сид** — в e2e-фикстурную вакансию (первая relevant, source='jobbank') добавить `raw.applyMethods` с `revealedAt = new Date().toISOString()` (свежий кэш → API вернёт `cached`, сети не будет — egress-гейт не задет):

```ts
applyMethods: {
  email: 'apply@fixture-e2e.example',
  webUrl: null, directApply: true,
  screeningQuestions: ['Do you have a valid driver\'s licence?'],
  notes: ['References attesting experience'],
  otherText: null,
  revealedAt: new Date().toISOString(),
}
```
- [ ] **Step 2: RED e2e** — `tests/e2e/jobbank-apply.spec.ts`:

```ts
import { test, expect } from '@playwright/test';

// S25 — Apply methods (Job Bank) на странице вакансии: кэш раскрытых методов,
// префилл получателя, Re-check (cached), visual baseline. Сеть не трогаем:
// в сиде свежий applyMethods-кэш → reveal-эндпоинт отвечает 'cached'.

test('apply methods section shows revealed email and screening questions', async ({ page }) => {
  await page.goto('/?rule=relevant');
  await page.getByTestId('jobs-table').locator('tbody a[href^="/job/"]').first().click();
  await page.waitForURL(/\/job\/[0-9a-f-]{36}/);

  await expect(page.getByTestId('apply-methods')).toBeVisible();
  await expect(page.getByTestId('apply-methods')).toContainText('apply@fixture-e2e.example');
  await expect(page.getByTestId('apply-methods')).toContainText('Direct Apply');
  await expect(page.getByTestId('apply-methods')).toContainText('valid driver');

  // Префилл получателя из раскрытых методов (S23-приоритет сохраняется).
  await expect(page.getByTestId('dispatch-recipient')).toHaveValue('apply@fixture-e2e.example');
});

test('re-check hits the cache (no network) and keeps the section stable', async ({ page }) => {
  await page.goto('/?rule=relevant');
  await page.getByTestId('jobs-table').locator('tbody a[href^="/job/"]').first().click();
  await page.waitForURL(/\/job\/[0-9a-f-]{36}/);
  await page.getByTestId('apply-methods-refresh').click();
  await expect(page.getByTestId('apply-methods-status')).toContainText('saved methods');
  await expect(page.getByTestId('apply-methods')).toContainText('apply@fixture-e2e.example');
  await expect(page).toHaveScreenshot('s25-apply-methods.png', { threshold: 0.01 }); // B-011 порог
});
```

- [ ] **Step 3:** прогон e2e локально (веб + БД + Mailpit по существующей обвязке), бейслайны: `pnpm playwright test tests/e2e/jobbank-apply.spec.ts --update-snapshots`; затем два чистых прогона (стабильность, конвенция S9).
- [ ] **Step 4: Гейты** — `pnpm lint && pnpm arch-lint && pnpm typecheck && pnpm vitest run` (unit+integration), `pnpm playwright test` (e2e целиком — регресс). Все 0/зелёные.
- [ ] **Step 5: Доки** — DESIGN.md §6.1 строка `S25 Job Bank apply-адаптер | reveal панели подачи, методы → email/external/manual | фикстуры+integration+e2e`; отчёт `specs/notes/S25-report.md` (формат S24: задачи, AC-таблица, цифры, отклонения, security); BACKLOG changelog.
- [ ] **Step 6: Живой smoke (ручной, опционально)** — скриптом на живой AB-постинг (только reveal, без отправки), результат в отчёт.
- [ ] **Step 7: Commit** `S25 T5: e2e + visual baseline + docs/report`.

## Self-review

- Спека→план: R1 (T1/T2), R2 (T1), R3 (T3 кэш), R4 (T3 TTL/throttled), R5 (T4 префилл/ссылки/вопросы display-only), R6 (T3 /dispatch), R7 (фикстуры/интеграция/e2e). AC1–9 покрыты: AC1–3 (T1), AC4 (T2), AC5–6 (T3), AC7 (T3), AC8 (T5), AC9 (T5 Step 4).
- Плейсхолдеров нет; имена/типы сверены между тасками (`ApplyMethods`, `RevealFetch`, `revealJobApplyMethods`, `parseCachedApplyMethods`, `REVEAL_TTL_MIN`).
- S25-спека: тест-фикстуры в `packages/adapters/test/fixtures/jobbank/apply/` — консистентно с планом.
