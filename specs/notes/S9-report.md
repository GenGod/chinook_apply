# S9-report — Form dispatch (Playwright-заполнение веб-форм)

Ветка `feat/S9-form-dispatch` (от `origin/main` = merge S8). Спека: [S9-form-dispatch.md](../S9-form-dispatch.md) · План: [S9-plan.md](../plans/S9-plan.md).
G1: мандат PO «бери M4» (2026-10-01), S9 первым по PROCESS §3. DoD DESIGN выполнен: **весь флоу против локальной mock-формы**.

## Что сделано

| Задача | Суть |
|---|---|
| T1 | core/form-dispatch.ts: validateFormConfig (http(s) URL, whitelist-символы селекторов, запрет javascript:/HTML), detectCaptcha (recaptcha/hcaptcha/turnstile/cf-challenge/data-captcha), buildFormValues (identity+cover или детерминированная заметка); countSentToday → **все каналы** (ст. 4.3 суммарный лимит); dispatch_log: outcome +skipped, +screenshot_paths JSONB (+ идемпотентные ALTER для живых БД) (red→green, 6/6) |
| T2 | form-dispatch-service: playwright chromium (инъекция launchBrowser; executablePath из env для alpine), goto → **капча-стоп ДО заполнения** (аудит skipped → 409, art. 11.3), fill name/email/message + setInputFiles(resume PDF) → скриншоты before/filled/submitted (art. 11.2) → submit → successText; аудит sent/failed; application(applied/auto); mock-константы + роут /mock-form (FIXTURE) (red→green, 4/4 против локального http-сервера с реальным chromium) |
| T3 | POST /api/jobs/[id]/dispatch-form (409/502/503/500); UI-блок Web form dispatch — виден ТОЛЬКО при job.raw.formConfig (v1: фикстуры/будущие адаптеры) |
| T4 | e2e 2/2 (реальный chromium в e2e-прогоне: заполнение через веб-приложение + проверка 3 скриншотов в artifacts-e2e; капча-фикстура рендерит маркер); Dockerfile: apk chromium + CHROMIUM_EXECUTABLE_PATH; STACK 2.6; живой smoke в контейнере |

## Ключевые свойства (конституция ст. 11)

1. **Капча → немедленный стоп**: детектор до заполнения; submit не вызывается (в интеграционном тесте сервер счётчиком POST'ов подтверждает: 0); аудит outcome='skipped' с причиной; fallback — ручная отправка.
2. **Скриншоты before/filled/submitted** — в gitignored artifacts-dir, пути в dispatch_log.screenshot_paths (DESIGN §3.2).
3. **Цель — только из job.raw.formConfig** (не из клиентского запроса): API не принимает url — фишинг-поверхность закрыта архитектурно.
4. **Одноразовый Approve**: видимый блок (url + поля) + Send = одна отправка (ст. 1.2/1.3).
5. v1 без пер-сайт адаптеров: универсальный филлер отклонён brainstorm'ом (хрупкость + риск мисфайлов).

## AC

| AC | Статус |
|---|---|
| 1 validateFormConfig (ок/ftp/javascript/мусор) | ✅ unit |
| 2 detectCaptcha (5 маркеров/чистая) | ✅ unit |
| 3 buildFormValues (identity+cover/заметка) | ✅ unit |
| 4 Integration (chromium+mock: sent+3 скриншота+application; captcha=skipped+0 submit; 503 browser; 409 нет конфига) | ✅ 4/4 |
| 5 countSentToday кросс-канально | ✅ integration |
| 6 E2E (секция+Send+скриншоты; капча-фикстура) | ✅ 2/2 |
| 7 Скриншоты вне git; метаданные в dispatch_log | ✅ |

**Живой smoke (контейнер, alpine + системный chromium)**: POST dispatch-form на золотую вакансию → `outcome=sent`, `screenshot_paths` ×3; тестовый formConfig снят с вакансии после смоука.

## Цифры

unit 199 (+6); integration 78 (+4); e2e 79 (+2, ×2 стабильных прогона после бейслайна); lint/arch-lint/typecheck — 0. Docker web пересобран с системным chromium (apk) — см. ниже. LLM: $0.

## Отклонения/находки

- **Alpine + playwright**: `npx playwright install --with-deps chromium` падает (apt-get отсутствует, alpine не поддерживается) → системный chromium через `apk add chromium` + `CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium-browser` (поддержка executablePath добавлена в сервис). Живой smoke подтвердил работоспособность связки.
- Бейслайн s5-documents обновлён осознанно (новая секция Web form на странице вакансии с formConfig; для вакансий без конфига секция скрыта — диффа у большинства вакансий нет).
- 1 непроизведённый интеграционный флейк на промежуточном прогоне (не воспроизведён в 6 последующих прогонах; при появлении в CI — разбор по vitest-отчёту).

## Security

- Mimosa: 1 блокировка (path-traversal на env-дефолте с '../' в seed) — устранена архитектурно: директория фикстур передаётся ВЫЗЫВАЮЩЕЙ стороной абсолютным путём, core её не вычисляет; 2 блокировки Bash-записей — переписано через Write/Edit по требованию хука.
- formConfig из raw валидируется (протокол, селекторы) — URL навигации не может быть внешним относительно данных вакансии, а в v1 конфиги создаются только сидом/PO.

## Открытые вопросы (G6)

1. Пер-сайт адаптеры форм — после набора PO живых примеров (v1 — mock only).
2. Синхронный API-вызов достаточно для mock (<10 c); для реальных форм — фоновый воркер (след. спека).
3. S10 (metrics v2) — второй инкремент M4, следующий.
