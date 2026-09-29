# S8: Email dispatch — отправка пакета отклика по SMTP

Статус: accepted (G1 — мандат PO «го» на предложение S8 + SMTP-инструкции, 2026-09-29) · Версия: 1.0 · Milestone: **M3** (закрывает: «сквозной semi-auto цикл живёт»)
Реестр: DESIGN §6.1 (S8: SMTP + вложения + лимиты; интеграционный тест на тестовый ящик) · зависит от S6/S21 (render-артефакты = вложения), S7 (application/борда).

## Проблема и цель

Пакет отклика готов (S5 генерация → S6/S21 рендер DOCX/PDF), но уезжает вручную. Цель S8: отправка пакета письмом с вложениями из UI, с явным Approve (конституция ст. 1.1–1.3), полным аудитом (ст. 8.2), дневным лимитом (ст. 4.3) и безопасным dry-run по умолчанию.

## Входные артефакты / зависимости

- render-артефакты (kind render_docx/render_pdf, S21 append-версии) — вложения;
- `application` + борда: stored status 'applied' требует канал 'manual'|'auto'; колонка `applied_auto` существует и пуста — email-dispatch пишет туда (исходный замысел S7: системная отправка с Approve);
- SMTP: Mailpit (dev/test) / Gmail-релей (live) — инструкции PO от 2026-09-29;
- конституция: 1.1–1.3 (Approve + полный пакет), 3.1 (секреты в .env), 4.3 (лимит 10/день), 8.2 (восстановимость по записям).

## Решение (brainstorm, выбор + отказ)

### R1. Транспорт: nodemailer ^10, SMTP-only — ✅
(откл.) самописный SMTP на net/tls, GraphQL-API почтовых провайдеров — хрупко/лишнее. Dev/test — Mailpit (принимает всё, UI на :8025, не релеит наружу), live — Gmail-релей с паролем приложения (инструкции PO). Прямая доставка с домашнего IP отклонена на уровне архитектуры (SPF/DKIM/PTR невозможны — см. инструкции).

### R2. Режимы: DISPATCH_MODE = dry-run (default) | live — ✅ (safety by construction)
Dry-run: **SMTP-конверт переписывается** — RCPT TO = `dispatch-sink@localhost`, при этом видимый заголовок To: сохраняет реального получателя (для ревью в Mailpit). Даже при боевой SMTP-конфигурации письмо физически не может дойти до работодателя. Live: реальный конверт.
- (откл.) dry-run «вообще не слать» — теряем сквозную проверку вложений/формата через настоящий SMTP-путь.

### R3. Получатель: best-effort извлечение + ручное подтверждение — ✅
`extractEmailCandidates(raw)`: mailto: и адреса из fullDescription/summary/description, dedupe; в живой БД писем в raw нет (проверено) → UI-поле префиллится кандидатом либо пустое, **пользователь вводит/правляет вручную** — получатель виден в форме и является частью одобряемого пакета (ст. 1.3). zod-валидация формата на API.
- (откл.) скрейп «How to apply» со страницы Job Bank — отдельная задача enrichment, не S8.

### R4. Письмо — детерминированный билдер (core) — ✅
Subject: `Application for {title} — {fullName}`. Body: текст cover letter (последняя валидная версия) абзацами; без cover — короткая детерминированная заметка (шаблон с именем/вакансией, без выдуманных фактов). Вложения: последние render-артефакты запрошенных kinds (render_docx/render_pdf), **минимум 1**; имена файлов = basename(content_path). Чистые функции в `packages/core/src/dispatch.ts` — unit-тесты.

### R5. Статусы и аудит — ✅
Новая таблица `dispatch_log` (id, job_id FK, application_id NULL, channel 'email', outcome sent|failed, to_address, subject, attachments JSONB [{kind, artifactId, filename, bytes}], smtp_message_id, error, created_at). Успех → application (job_id, 'applied', 'auto') через `setApplicationStatus` борды: из new/applying — переход; если job уже applied (любой канал) — переход не трогаем (уже в Applied), только лог. Провал → dispatch_log failed + 502.
- (откл.) писать channel='email' в application — ломает борду (applied_manual/auto — G1 S7); 'auto' соответствует замыслу колонки.

### R6. Лимиты — ✅
`DISPATCH_DAILY_LIMIT` (default 10, env только ужесточается пользователем) — count(dispatch_log where outcome='sent' and created_at >= today); превышение → 429 с понятным сообщением. Jitter не применяется: отправки ручные (ст. 4.3 регламентирует авто-отправку; авто-диспетчер — будущая спека).

### R7. UI: секция Email dispatch на странице вакансии — ✅
Под Documents: поле получателя (префилл), чекбоксы вложений (доступные последние рендеры, все ON), строка «Body: cover letter (см. превью выше)» — полный пакет на одной странице (ст. 1.3), кнопка Send by email = единоразовый Approve (ст. 1.2). Состояния: busy, успех (чип + номер в dispatch_log), ошибки (лимит/не готово/SMTP) — существующий errorBox-паттерн. Токены DS v1.1.
- superdesign: мини-дельта (form-card в стиле существующих секций, варианты: форма в Documents vs отдельная секция — выбрана отдельная секция по структуре страницы); полный superdesign-пасс не проводится, PO утверждает по снапшотам (G6) — как в S21.

### R8. Инфраструктура — ✅
Compose: `mailpit` (axllent/mailpit:v1.31.3, SMTP :1025, UI :8025). CI: service-контейнер в ci.yml + env для integration-шага. env-контракт: `SMTP_HOST, SMTP_PORT (587), SMTP_SECURE (false), SMTP_USER, SMTP_PASS, SMTP_FROM, DISPATCH_MODE (dry-run), DISPATCH_DAILY_LIMIT (10)`. Транспорт инъекцируется в сервисе (`opts.createTransport`) — unit-тесты без сети.

## Контракт

```ts
// core/dispatch.ts (чистые):
extractEmailCandidates(raw: unknown): string[]          // mailto: первым, dedupe
buildDispatchEmail(job: {title; employer}, identity: RenderIdentity, coverText: string | null):
  { subject: string; text: string }
// core/artifacts.ts (рядом с репозиторием):
saveDispatchLog(db, input: { jobId; applicationId: number | null; outcome: 'sent'|'failed';
  toAddress; subject; attachments: Array<{kind; artifactId; filename; bytes}>;
  smtpMessageId: string | null; error: string | null }): Promise<{ id: number }>
countSentToday(db): Promise<number>
latestRenderArtifactByKind(db, jobId, kind): Promise<ArtifactView | null>

// web/dispatch-service.ts:
sendApplicationEmail(db, jobId, input: { to: string; kinds: Array<'render_docx'|'render_pdf'> },
  opts?: { mode?: 'dry-run'|'live'; createTransport?: ...; loadMaster?: ...; limit?: number }):
  Promise<{ dispatchId: number; messageId: string | null; envelopeTo: string; applicationId: number | null }>
// ошибки: DispatchNotFoundError(404), DispatchLimitError(429), DispatchNotReadyError(409 — нет рендеров),
//         DispatchIdentityUnavailableError(503), DispatchSendError(502), DispatchConfigError(500)

// API: POST /api/jobs/[id]/dispatch  body { to, kinds }  → 200 { dispatch, envelopeTo, mode }
//      400 invalid email/kinds · 404 · 409 · 429 · 502 · 503
```

## Acceptance criteria

1. `extractEmailCandidates`: mailto:/адреса/дedupe/пусто — unit.
2. `buildDispatchEmail`: subject с title+именем; cover-текст абзацами; без cover — шаблон-заметка; без identity — исключение — unit.
3. Миграция dispatch_log идемпотентна; вставка outcome/to/attachments работает — integration.
4. `sendApplicationEmail` против Mailpit: письмо получено (Mailpit API /api/v1/messages), вложения с правильными именами/размерами; заголовок To: = реальный получатель; **dry-run: envelope recipient = dispatch-sink@localhost**; live: envelope = получатель; dispatch_log sent + application (applied/auto) созданы; при уже-applied — переход не ломается — integration.
5. Лимит: предзаполненный count → 429 DispatchLimitError до SMTP — integration.
6. Нет рендеров → 409; невалидный email → 400 (API); SMTP недоступен → dispatch_log failed + 502 — integration.
7. E2E: секция с префиллом получателя, чекбоксы вложений, Send → успех, письмо видно в Mailpit UI-API; dry-run-конверт проверен; e2e против mailpit-контейнера.
8. PII/секреты: SMTP_PASS только в .env; dispatch_log не содержит тела письма (только метаданные); в логи — только id/ошибки без контента.

## Тест-план

Unit (core): dispatch.ts ×2. Integration (tests/integration, Mailpit из compose/CI): миграция, sendApplicationEmail (dry-run/live-конверт, вложения, логи, лимит, уже-applied, SMTP-down). E2E: dispatch-секция + Mailpit API. Снапшоты: дельта секции (осознанный update).

## Метрики

dispatch_log — источник воронки sent (DESIGN §5.3, страница Metrics — S10). Стоимость $0 (без LLM). Отчёт: кол-во dry/live отправок, лимит-поведение.

## DoD

- [ ] AC1–8; гейты 0 нарушений; pnpm test включает новые unit.
- [ ] Mailpit в compose + CI; env.example дополнен; STACK 2.5 (nodemailer ^10, mailpit v1.31.3).
- [ ] Docker web пересобран; на LAN:3000 dry-run отправка видна в Mailpit (:8025).
- [ ] Security-аудит в S8-report; отчёт specs/notes/S8-report.md.

## Открытые вопросы (дефолты для G6)

1. Body = cover-текст (не вложение) + вложение cover PDF — дублирование осознанное (стандарт практики); если PO хочет «только вложение» — чекбокс.
2. Успешная отправка ставит applied/auto — карточка уезжает в колонку Applied auto; ручной перевод обратно возможен (борда).
3. Jitter — только в будущей авто-диспетчере (ст. 4.3); ручные отправки без задержки.
