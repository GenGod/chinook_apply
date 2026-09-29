# S8 Implementation Plan — email dispatch

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:executing-plans. Checkbox steps.

**Goal:** Отправка пакета отклика письмом из UI: nodemailer + Mailpit (dev/CI), dry-run по умолчанию (envelope → dispatch-sink@localhost), лимит 10/день, аудит dispatch_log + application(applied/auto).

**Architecture:** чистые билдеры в core (extractEmailCandidates, buildDispatchEmail, saveDispatchLog, countSentToday, latestRenderArtifactByKind); транспорт-оркестрация в apps/web/src/lib/dispatch-service.ts (nodemailer, инъекция createTransport); API route; UI-секция email-dispatch.

**Tech Stack:** nodemailer ^10, axllent/mailpit v1.31.3 (compose + CI), Kysely, zod, Playwright. devDeps: нет новых.

**Spec:** `specs/S8-email-dispatch.md` (accepted G1 — мандат PO, 2026-09-29).

## Global Constraints

- dry-run по умолчанию: envelope RCPT → dispatch-sink@localhost, заголовок To: сохраняет реального получателя.
- SMTP_PASS только в .env; в dispatch_log нет тела письма; в логи — id/ошибки.
- Минимум 1 вложение; вложения — только последние render-артефакты этого job.
- Kysely — только с .execute(); цвета UI — токены; миграция — идемпотентная в SCHEMA_SQL.

---

### Task 1: dispatch_log миграция + Row + репозиторий

**Files:** Modify `packages/core/src/db.ts` (DispatchLogRow, Database.dispatch_log, SCHEMA_SQL), `packages/core/src/artifacts.ts` (saveDispatchLog, countSentToday, latestRenderArtifactByKind), `src/index.ts`; Test `tests/integration/dispatch.test.ts`

SQL:
```sql
CREATE TABLE IF NOT EXISTS dispatch_log (
  id BIGSERIAL PRIMARY KEY,
  job_id UUID NOT NULL REFERENCES job(id) ON DELETE CASCADE,
  application_id BIGINT REFERENCES application(id),
  channel TEXT NOT NULL DEFAULT 'email',
  outcome TEXT NOT NULL CHECK (outcome IN ('sent','failed')),
  to_address TEXT NOT NULL,
  subject TEXT NOT NULL,
  attachments JSONB NOT NULL DEFAULT '[]',
  smtp_message_id TEXT,
  error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS dispatch_log_created_idx ON dispatch_log (created_at);
```

- [ ] **Step 1: RED** — integration: таблица принимает строку; saveDispatchLog возвращает id и округляет поля; countSentToday считает только sent за сегодня; latestRenderArtifactByKind возвращает последнюю версию по kind (append-версии S21).
- [ ] **Step 2: FAIL → Step 3: GREEN → Step 4: PASS**; commit `S8 T1: dispatch_log schema + repository`.

### Task 2: core/dispatch.ts — извлечение + билдер

**Files:** Create `packages/core/src/dispatch.ts`, test `packages/core/test/dispatch.test.ts`, export в index.ts

- extractEmailCandidates: regex `mailto:` (capture), затем bare `[\w.+-]+@[\w-]+\.[\w.-]+`; dedupe preserve order; non-string raw → [].
- buildDispatchEmail(job, identity, coverText|null): subject `Application for ${title} — ${fullName}`; coverText → абзацы, join \n\n; null → шаблон: `Dear Hiring Manager,\n\nI am applying for the ${title} role at ${employer}. My resume is attached.\n\nBest regards,\n${fullName}`; identity null → throw DispatchIdentityError (core-level).
- [ ] **Step 1: RED** (кандидаты: mailto первым; dedupe; пусто; subject/тело оба случая; identity-missing throw) → **Step 3: GREEN** → **Step 4: PASS**; commit `S8 T2: email candidates extraction + deterministic email builder`.

### Task 3: dispatch-service (transport, dry-run envelope, лимит, application)

**Files:** Create `apps/web/src/lib/dispatch-service.ts`; Test `tests/integration/dispatch.test.ts` (расширить); deps: `pnpm --filter @chinook/web add nodemailer@^10 + @types/nodemailer (dev)`

sendApplicationEmail(db, jobId, { to, kinds }, opts { mode='env'|'dry-run'|'live', createTransport?, loadMaster?, limit? }):
1. `to` валиден (regex) иначе DispatchConfigError-400 класс InvalidRecipientError(400);
2. job fetch (404 DispatchNotFoundError);
3. limit: opts.limit ?? env DISPATCH_DAILY_LIMIT ?? 10; countSentToday >= limit → DispatchLimitError(429);
4. identity: renderIdentityFromContent(latest resume/cover content) ?? renderIdentityFromMaster(loadMaster ?? loadMasterIdentity()) — иначе 503;
5. вложения: для каждого kind — latestRenderArtifactByKind; отсутствующие skip; 0 → DispatchNotReadyError(409); bytes из readRenderFile;
6. body: buildDispatchEmail(job, identity, coverText из latest valid cover artifact content);
7. transport = opts.createTransport ?? nodemailer.createTransport({ host, port, secure, auth? }); verify не нужен;
8. sendMail: from SMTP_FROM, to (header), subject, text, attachments [{filename, content: Buffer, contentType по расширению}]; **dry-run: envelope { from, to: ['dispatch-sink@localhost'] }**; live: envelope не указывать;
9. успех: saveDispatchLog(sent, smtpMessageId=messageId, applicationId) + если текущая application не applied → setApplicationStatus(db, jobId, { status: 'applied', channel: 'auto' }) (из @chinook/core; обернуть try — TransitionError не должен валить отправку, логируем);
10. провал sendMail: saveDispatchLog(failed, error) + DispatchSendError(502).
env-конфиг: readSmtpConfig() — SMTP_HOST/PORT/SECURE/USER/PASS/FROM/MODE/DISPATCH_DAILY_LIMIT; live без USER/PASS/FROM → DispatchConfigError(500).

- [ ] **Step 1: RED** — integration c fake transport (захватывает mailOptions) + Mailpit e2e-проверка в Task 6: dry-run envelope; failure-path: createTransport, возвращающий объект с sendMail→reject → failed-лог + 502.
- [ ] **Step 2: FAIL → Step 3: GREEN → Step 4: PASS**; commit `S8 T3: dispatch service (dry-run envelope, limit, audit, application)`.

### Task 4: API route

**Files:** Create `apps/web/app/api/jobs/[id]/dispatch/route.ts`; body zod `{ to: z.email(), kinds: z.array(z.enum(['render_docx','render_pdf'])).min(1) }`; ошибки → статусы; Test: integration smoke (400/404) + e2e.

- [ ] **Step 1-3:** реализация по паттерну render/route.ts; **Step 4:** commit `S8 T4: dispatch API route`.

### Task 5: UI — Email dispatch секция

**Files:** Create `apps/web/app/job/[id]/email-dispatch-section.tsx` + `email-dispatch.module.css`; Modify `apps/web/app/job/[id]/page.tsx` (секция после Documents, props: jobId, renders: ArtifactView[] — фильтр latest по kind, candidates: string[] — из job.raw серверно через extractEmailCandidates); compose mailpit + env.example.

Поведение: input recipient (префилл candidates[0]), чекбоксы доступных рендеров (label `Resume DOCX v3`), кнопка `Send by email` (busy/disabled), errorBox (400/404/409/429/502/503 — текст API), success-чип `Sent ✓ (dispatch #id, mode)`. testid: dispatch, dispatch-recipient, dispatch-attach-<kind>, dispatch-send, dispatch-success, dispatch-error.

- [ ] **Step 1-3:** компонент по DS-токенам (паттерн documents.module.css); **Step 4:** typecheck; commit `S8 T5: email dispatch UI section`.

### Task 6: E2E + CI + финальные гейты

**Files:** Test `tests/e2e/dispatch.spec.ts`; Modify `.github/workflows/ci.yml` (mailpit service), `docker-compose.yml` (mailpit + web env), `.env.example`

e2e: seed job (без рендеров — секция показывает «render first» disabled); seedArtifactsOnJob + renderArtifact нельзя в e2e (нет master) → render-фикстуры: POST render недоступен без identity → сидировать render-строки через seedArtifactsOnJob (kind render_docx/pdf, content_path на несуществующие файлы?) — НЕТ: вложения читаются readRenderFile → файлы нужны. Решение: e2e seed пишет ДВЕ мини-файла в ARTIFACTS_DIR через node:fs в глобальном setup-скрипте сид-хелпера (seed-e2e.ts воркера — расширить: после seedArtifactsOnJob написать файлы resume-v1.docx/pdf по путям из фикстур) + соответствующие content_path. Тогда e2e: секция видна, чекбоксы с именами, Send → 200 → письмо в Mailpit (`http://localhost:8025/api/v1/messages` — проверка to/subject/attachments), dry-run envelope sink, лимит-текст 429 не тестируем в e2e (integration).
CI: services.mailpit (v1.31.3, ports 1025) + env SMTP_HOST/PORT integration-шагу.
- [ ] **Step 1: RED e2e → Step 2: GREEN** → полный e2e; commit `S8 T6: e2e + mailpit infra (compose, CI)`.

### Task 7: Отчёт + деплой + STACK

- [ ] STACK 2.5 (nodemailer ^10 runtime web, mailpit v1.31.3 infra); env.example; `docker compose build web && up -d`; live-чек: письмо в Mailpit UI; S8-report.md (AC-таблица, security: PASS в .env, dry-run safety, логи без контента); commit `S8 T7: report + docs + deploy`.

## Self-Review

AC1→T2; AC2→T2; AC3→T1; AC4→T3(+T6 e2e); AC5→T3; AC6→T3/T4; AC7→T5/T6; AC8→все. Типы: DispatchLimitError и др. — единые имена T3/T4/T5; ArtifactFixture из S21 — используется в seed-e2e. Пустот нет.
