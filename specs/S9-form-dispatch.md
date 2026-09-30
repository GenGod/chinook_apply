# S9: Form dispatch — Playwright-заполнение веб-форм отклика

Статус: accepted (G1 — мандат PO «бери M4», S9 первым по PROCESS §3, 2026-10-01) · Версия: 1.0 · Milestone: **M4**
Реестр: DESIGN §6.1 (S9: заполнение форм; DoD — тест против локальной mock-формы) · зависит от S8 (dispatch_log, лимит, Approve-паттерн) · Конституция ст. 11 (автоматизация браузера).

## Проблема и цель

Email-канал (S8) покрывает вакансии с email-контактом; часть публикаций требует отправки через веб-форму. Цель S9 — **механизм** браузерной отправки: Playwright открывает форму, заполняет её данными пакета, прикладывает резюме, снимает скриншоты до/после (ст. 11.2), останавливается при капче (ст. 11.3), пишет аудит. DoD спеки — весь флоу против **локальной mock-формы**; пер-сайт адаптеры реальных порталов — будущие спеки.

## Входные артефакты / зависимости

- S8: dispatch_log (аудит), лимит дня, Approve-паттерн, UI-паттерн секции.
- render-артефакты (вложение резюме в форму — file input).
- Playwright 1.63 на хосте/CI (chromium уже ставится); web-образ — без браузера.

## Решение (brainstorm, выбор + отказ)

### R1. Граница v1: механизм + mock, без пер-сайт адаптеров — ✅
DESIGN DoD задаёт рамку: «тест против локальной mock-формы». Заполнение произвольных сайтов без конфига — хрупко и вне S9. Форм-конфиг хранится в `job.raw.formConfig` (JSONB: url + selectors + successText) — в живых данных его нет → UI-блок появляется только у вакансий с конфигом (в v1 — только e2e/mock), у остальных секция скрыта. Расширение на реальные порталы = будущие спеки (пер-сайт адаптеры).
- (откл.) универсальный «умный» филлер по эвристикам — хрупко, риск мисфайлов в чужие формы (ст. 11).

### R2. Форм-конфиг и значения — ✅
`FormConfig { url, selectors: { name?, email?, message?, file?, submit? }, successText? }` с дефолтами под mock-конвенцию `[data-form="…"]`. Значения полей: name/email из RenderIdentity, message = cover-текст (или детерминированная заметка — как S8), file = последний render_pdf (bytes из хранилища). Чистые функции в core: `validateFormConfig` (url http(s), selectors — безопасные CSS-селекторы), `detectCaptcha(html)` (маркеры recaptcha/hcaptcha/cf-challenge/turnstile), `buildFormValues`.

### R3. Капча-стоп (ст. 11.3) — ✅
Перед заполнением: page.content() → detectCaptcha → при обнаружении: **немедленная остановка**, submit НЕ выполняется, dispatch_log outcome='skipped' с причиной — fallback на ручную отправку. Повторные попытки обхода запрещены (в коде их нет).
- (откл.) интеграция solver'ов — навсегда запрещено конституцией.

### R4. Скриншоты (ст. 11.2) — ✅
Три снимка в artifacts-dir (`form/{jobId8}-{timestamp}-before|filled|submitted.png`), пути — в `dispatch_log.screenshot_paths` (новая JSONB-колонка; DESIGN §3.2 её и описывает). Скриншоты — в gitignored хранилище.

### R5. Транспорт: playwright в web-контейнере, graceful degradation — ✅
`playwright@1.63.0` (та же версия, что @playwright/test — общий кэш браузеров) в deps apps/web; Dockerfile web: `RUN npx playwright install --with-deps chromium` (CI уже так делает). Запуск браузера не удался (нет бинарника/депсов) → `FormBrowserUnavailableError` 503 с понятным сообщением — ручной fallback, данные не теряются.
- (откл.) отдельный playwright-контейнер/очередь BullMQ — Redis в стеке нет, v1 — синхронный вызов из API (mock быстрый); асинхронность — при реальных адаптерах.

### R6. Аудит/лимит/Approve — ✅
dispatch_log channel='form' (outcome sent|failed|skipped, to_address = form url). `countSentToday` расширяется на ВСЕ каналы (ст. 4.3 лимитит суммарную авто-отправку; e2e/integration-тесты S8 обновляются). Approve — тот же одноразовый паттерн (ст. 1.2); форма показывает url и поля перед отправкой (ст. 1.3).

### R7. Mock-форма — ✅
HTML-константа в `apps/web/src/lib/mock-form.ts` (маркирована FIXTURE), отдаётся роутом `/mock-form`; та же константа раздаётся локальным http-сервером в integration-тестах (без Next). Форма: name, email, message, file (resume), submit → success-маркер. Вторая страница-вариант с капча-маркером — для теста ст. 11.3.

## Контракт

```ts
// core/form-dispatch.ts (чистые):
validateFormConfig(raw: unknown): FormConfig | null
detectCaptcha(html: string): string | null            // маркер или null
buildFormValues(identity, coverText|null): { name; email; message }
// db: ALTER dispatch_log ADD COLUMN IF NOT EXISTS screenshot_paths JSONB NOT NULL DEFAULT '[]'
// core/artifacts.ts: countSentToday — без фильтра канала (суммарный лимит)

// web/form-dispatch-service.ts:
sendWebFormApplication(db, jobId, opts?: { mode?; createTransport?→launchBrowser?; limit?; loadMaster? }):
  // formConfig из job.raw → validate → 409 если нет; браузер → goto → captcha-guard →
  // fill+file → screenshot → submit → successText → dispatch_log(sent, screenshots) +
  // application(applied/auto); captcha → skipped; ошибка → failed + 502
// API: POST /api/jobs/[id]/dispatch-form → 200 { dispatchId, screenshots, mode } | ошибки как S8 + 503 browser
```

## Acceptance criteria

1. validateFormConfig: валидный конфиг; не-URL/не-безопасные селекторы/мусор → null — unit.
2. detectCaptcha: recaptcha/hcaptcha/turnstile/cf-маркеры ловятся; чистая страница → null — unit.
3. buildFormValues: identity/cover/заметка — unit.
4. Integration (chromium + локальный http-сервер с mock-HTML): успешное заполнение+submit → dispatch_log sent, 3 скриншота существуют, application(applied/auto); капча-страница → skipped, submit не вызван (сервер фиксирует запросы); браузер недоступен → 503.
5. countSentToday: учитывает channel='form' (суммарный лимит).
6. E2E: вакансия с formConfig (сид) → секция Web form → Send → success; /mock-form получает submit (серверная фиксация не нужна — successText на странице); скриншоты в artifacts-e2e.
7. Секреты/PII: скриншоты в gitignored dir; dispatch_log хранит пути/метаданные.

## Тест-план

Unit (core): T-R2 функции. Integration (chromium + локальный сервер): AC4/AC5. E2E: AC6 (seed formConfig; chromium в webServer-хосте). Docker: build-гейт с браузером (локально).

## Метрики

dispatch_log — канал form в воронке (S10). Стоимость $0. Отчёт: отправки/капча-стопы.

## DoD

- [ ] AC1–7; гейты 0; e2e зелёные; Docker web с chromium пересобран; S8-тесты лимита обновлены.
- [ ] STACK 2.6 (playwright 1.63 runtime web); отчёт specs/notes/S9-report.md.

## Открытые вопросы (дефолты G6)

1. v1 — только mock-конфиг; пер-сайт адаптеры — после того, как PO наберёт живых примеров форм.
2. Синхронный API-вызов (mock < 10 c); для медленных реальных форм — будущая асинхронность.
