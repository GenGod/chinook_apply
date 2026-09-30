# S9 Implementation Plan — form dispatch (Playwright)

> **For agentic workers:** superpowers:executing-plans. Checkbox steps.

**Goal:** Механизм браузерной отправки отклика через веб-форму: Playwright + mock-форма, капча-стоп, скриншоты до/заполнено/отправлено, аудит dispatch_log (channel='form'), суммарный дневной лимит.

**Architecture:** чистые функции в core (validateFormConfig/detectCaptcha/buildFormValues), браузерная оркестрация в apps/web/src/lib/form-dispatch-service.ts (playwright chromium, инъекция launch для тестов), mock-HTML константа + роут /mock-form, API route, UI-блок при наличии job.raw.formConfig.

**Tech Stack:** playwright ^1.63 (web deps), chromium (host/CI уже есть; Dockerfile --with-deps), Kysely, zod.

**Spec:** `specs/S9-form-dispatch.md` (accepted G1 — мандат PO «бери M4», 2026-10-01).

## Global Constraints

- Ст. 11.3: капча → немедленный stop, submit не выполняется, fallback manual; никаких обходов.
- Ст. 11.2: скриншоты before/filled/submitted — в dispatch_log.screenshot_paths (gitignored dir).
- formConfig только из job.raw (не из запроса клиента — API не принимает url извне).
- Kysely .execute(); миграции идемпотентные; цвета UI — токены.

---

### Task 1: core/form-dispatch.ts + миграция screenshot_paths + countSentToday (все каналы)

**Files:** Create `packages/core/src/form-dispatch.ts`, test `packages/core/test/form-dispatch.test.ts`; Modify `packages/core/src/db.ts` (screenshot_paths ALTER), `artifacts.ts` (countSentToday без фильтра канала), `index.ts`; Test `tests/integration/dispatch.test.ts` (лимит-тест обновить: channel form тоже считается)

```ts
export interface FormConfig { url: string; selectors: { name?: string; email?: string; message?: string; file?: string; submit?: string }; successText?: string }
export function validateFormConfig(raw: unknown): FormConfig | null
// url: new URL(), протокол http/https; селекторы: строка 1..200 без '<'/javascript:
export function detectCaptcha(html: string): string | null
// /recaptcha|hcaptcha|turnstile|cf-challenge|data-captcha/i → маркер
export function buildFormValues(identity: { fullName: string; email?: string }, coverText: string | null, job: { title: string; employer: string }):
  { name: string; email: string; message: string }
```

- [ ] **Step 1: RED** — unit: конфиг ок; url ftp:// / selectors с '<' → null; мусор → null; капча-маркеры ×4 + чистая страница; values: identity+cover / заметка.
  Integration: countSentToday считает form-строку (saveDispatchLog channel='form' — параметр канала добавить в saveDispatchLog input: `channel?: string` default 'email').
- [ ] **Step 2: FAIL → Step 3: GREEN → Step 4: PASS**; commit `S9 T1: form config/captcha/values (core) + screenshot_paths + cross-channel limit`.

### Task 2: mock-форма + form-dispatch-service

**Files:** Create `apps/web/src/lib/mock-form.ts` (MOCK_FORM_HTML: `<form data-form>` name/email/message/file/submit + success div `#mock-success`; вариант CAPTCHA_FORM_HTML с div data-captcha), route `apps/web/app/mock-form/route.ts` (GET → html, ?captcha=1 → капча-вариант), Create `apps/web/src/lib/form-dispatch-service.ts`; Test `tests/integration/form-dispatch.test.ts`

fillApplicationForm(db, jobId, opts { launchBrowser?, mode?, limit?, loadMaster?, artifactsDir? }):
1. job.raw.formConfig → validateFormConfig → null ⇒ FormNotConfiguredError(409);
2. лимит countSentToday ≥ limit ⇒ 429; identity как S8 (503); вложение render_pdf (readRenderFile) — нет ⇒ 409;
3. browser = opts.launchBrowser?.() ?? (async () => { const { chromium } = await import('playwright'); return chromium.launch(); })(); try page = browser.newPage() catch ⇒ FormBrowserUnavailableError(503);
4. goto(config.url) → content → detectCaptcha ⇒ saveDispatchLog(skipped, error='captcha: <marker>', screenshot before) → 502 FormCaptchaError? — отдельный FormCaptchaStoppedError(502→ или 409? выбрать 409 conflict-статус… спека: skipped; HTTP 502 не подходит; использовать 409 с текстом captcha) — ЗАФИКСИРОВАТЬ: 409;
5. screenshots: before (goto) → fill name/email/message + setInputFiles(resume buffer) → screenshot filled → click submit → waitFor successText (timeout 10s) → screenshot submitted;
6. успех: saveDispatchLog(sent, screenshot_paths) + application(applied/auto — как S8); ошибка playwright ⇒ failed + FormSendError(502). Всегда browser.close() в finally.

- [ ] **Step 1: RED** — integration: локальный http-сервер (node:http) раздаёт MOCK_FORM_HTML на /form и CAPTCHA_FORM_HTML на /captcha; тест success-путь (лог sent + 3 png файла + application), captcha-путь (skipped + submit-запросов не было — сервер считает POST'ы), browser-launch failure (launchBrowser, бросающий ошибку ⇒ 503), нет formConfig ⇒ 409.
- [ ] **Step 2: FAIL → Step 3: GREEN → Step 4: PASS**; commit `S9 T2: form dispatch service + mock form (captcha stop, screenshots)`.

### Task 3: API route + UI блок

**Files:** Create `apps/web/app/api/jobs/[id]/dispatch-form/route.ts`, `apps/web/app/job/[id]/web-form-dispatch-section.tsx` (+css), Modify page.tsx (секция при `extractFormConfig(job.raw)`), zod-ответы как S8.

- [ ] **Step 1-3:** реализация (route: schemaReadyOnce + sendWebFormApplication; UI: url + поля + Send, testid web-form-*, скрыта без конфига); **Step 4:** typecheck; commit `S9 T3: dispatch-form API + UI section`.

### Task 4: e2e + Dockerfile + гейты + отчёт

**Files:** Modify `packages/core/src/seed.ts` (formConfig в raw первого relevant job), `tests/e2e/form-dispatch.spec.ts`, `apps/web/Dockerfile` (+ `RUN npx playwright install --with-deps chromium` после install), STACK 2.6, `specs/notes/S9-report.md`

e2e: seeded job с formConfig (url = http://localhost:3999/mock-form) → секция видна → Send → success; скриншоты в artifacts-e2e/form/. Затем полный e2e + обновление снапшота s5-documents (новая секция).

- [ ] **Step 1: RED e2e → Step 2: GREEN**; полный e2e ×2; **Step 3:** docker build web (chromium в образе); **Step 4:** STACK/env (без новых env); **Step 5:** отчёт; commit `S9 T4: e2e + docker browser + report`.

## Self-Review

AC1→T1; AC2→T1; AC3→T1; AC4→T2; AC5→T1; AC6→T4; AC7→T2/T4. Имена: FormConfig/detectCaptcha/buildFormValues/FormNotConfiguredError/FormCaptchaStoppedError/FormBrowserUnavailableError/FormSendError — сквозные. countSentToday — семантика расширена, S8-тест обновлён. Пустот нет.
