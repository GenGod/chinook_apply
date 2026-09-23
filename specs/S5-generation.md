# S5: Генерация адаптированных документов — tailored resume + cover letter

Статус: approved (G1) · G2 pending · Версия: 1.0 · Milestone: **M3**
Реестр: DESIGN §6.1 (S5) · зависит от S3 (done — шлюз), S4 (done — score для акцентов и приоритезации).

## Проблема и цель

Скоринг (S4) выделяет вакансии, но отклик всё ещё требует ручной подгонки резюме
и письма. Цель S5: генерация **адаптированного резюме** (дифф относительно master
profile) и **cover letter** (канадский деловой тон) под конкретную вакансию через
glm-5.3, с доказуемой фактичностью (валидаторы) и просмотром в UI. Ручной
триггер; рендер в docx/PDF — S6; approve/dispatch — дальше по DESIGN-пайплайну.

Ключевой принцип (DESIGN §4.2, конституция 7.1): **LLM не может придумать
опыт**. Резюме собирается кодом из master + диффа; rephrase-буллеты проходят
проверку сохранности сущностей; провал валидации = регенерация, не «готово».

## Входные артефакты / зависимости

- S3: шлюз (`role: 'main'` = glm-5.3 для генерации — «качество критично», DESIGN §4.1);
  кэш по input-hash; cost-логирование в `llm_run`.
- S4: `job_match.score/reasons` — контекст для акцентов промпта; полное описание
  вакансии (`raw.fullDescription`, enrichment S4-addendum).
- Профиль: `data/profile/master_profile.json` — структурированный
  (identity, summary, skills, experience[4] с bullets+technology, education).
- DESIGN §3.2: таблица `artifact` (application_id, kind, version, content_path).

## Решение (альтернативы из brainstorm, выбор + отказ)

### R1. Форма выхода LLM: гибридный дифф со строгой проверкой сущностей
- **(a) Дифф: select/reorder + опциональный rephrase с сохранением сущностей.**
  Схема: `ResumeDiff {summary, skills_order[], bullets[{experience_id,
  bullet_index, rephrase?}], keywords[]}`. Финальный документ собирает КОД
  (`assembleResume`), LLM не пишет резюме целиком. Валидатор: в rephrase
  множество сущностей (числа, годы, даты, имена работодателей) обязано РАВНЯТЬСЯ
  множеству оригинала; в summary — подмножество сущностей master. — ✅:
  ATS-формулировки под словарь вакансии при доказуемой фактичности.
- (b) Чистый select/reorder без rephrase — валидация тривиальна, но нет
  главного ATS-рычага (буллет «TS ecosystem» не матчит «TypeScript»).
- (c) Полный документ от LLM — вся поверхность = поверхность галлюцинаций,
  fuzzy-факт-чек хрупок. Отклонено.

### R2. Хранение артефактов: JSONB в `artifact`, файлы — только рендерам (S6)
- `artifact (id, application_id FK, kind, version, status, content JSONB,
  validation JSONB, llm_run_id FK, created_at)`. PII живёт только здесь
  (конституция 3.2: БД не в git, в логах только id). `content_path` появится
  в S6 для kind=render_docx/render_pdf.
- Генерация для вакансии без application-строки создаёт её со status='new'
  (карточка остаётся в New; артефакты получают якорь DESIGN-схемы).

### R3. Триггер: ручной (кнопка), авто — позже
- Кнопки на странице вакансии. Auto-draft score>90 + дневной лимит — бэклог
  к S6/S7 (решение PO от 2026-09-23: ручной до approve-флоу).

### R4. Fact-check: блокирующий + авто-регенерация (≤2 попытки), потом флаг
- Попытка 2 получает в промпт список нарушений. Обе провалены → артефакт
  сохраняется status='invalid' + violations в UI; Regenerate вручную = vN+1.
- Cover letter: ≤300 слов — hard fail; сущности (работодатели/годы) — из
  master или вакансии; запрещённые паттерны (зарплатные ожидания, негатив
  о прошлых работодателях).

### R5. Стоимость: main-модель, дневной лимит
- glm-5.3: ~$0.004–0.01 за пару документов (оценка по ценам S3; уточняется
  golden-прогоном). `GEN_DAILY_LIMIT_USD` (default $1) — проверка перед
  генерацией, паттерн скоринг-батча.

## Контракт

### Схемы (packages/llm, zod)

```ts
RESUME_PROMPT_VERSION = 'v1'
ResumeDiffSchema = {
  summary: string            // переписанный под вакансию, факты только из master
  skills_order: string[]     // имена скиллов master (все обязаны существовать)
  bullets: Array<{ experience_id: string; bullet_index: number; rephrase?: string }>
  keywords: string[]         // термины вакансии, вплетённые в summary/skills
}
COVER_PROMPT_VERSION = 'v1'
CoverSchema = { letter: string }   // ≤300 слов
```

### Валидаторы (packages/core)

```ts
validateResumeDiff(master: MasterProfile, diff: ResumeDiff): ValidationReport
  // violations: unknown_experience | unknown_bullet | unknown_skill |
  //             entity_mismatch(rephrase) | summary_entity_not_in_master
validateCoverLetter(letter: string, master, job): ValidationReport
  // violations: word_limit | unknown_entity | forbidden_pattern
assembleResume(master: MasterProfile, diff: ResumeDiff): TailoredResume
  // детерминированная сборка; бросает исключение на несуществующих ссылках
ValidationReport = { valid: boolean; violations: Violation[] }
```

Сущность (entity): число, год/дата, название работодателя из master.
Извлечение — детерминированное (regex-набор чисел/дат + список работодателей
master), без LLM.

### API (apps/web)

```
POST /api/jobs/:id/generate        body: { kinds: ('resume'|'cover_letter')[] }
  → 200 { artifacts: ArtifactView[] }   // созданные версии
  → 402 если дневной лимит исчерпан
  → 409 если вакансия excluded
GET  /api/jobs/:id/artifacts       → список версий (kind, version, status, created)
GET  /api/artifacts/:id            → content + validation (PII: только тут)
ArtifactView = { id, kind, version, status, created, violations?: string[] }
```

### Пайплайн генерации (apps/web route / lib)

```
ensure application row (status='new' если нет) →
для каждого kind (до 2 попыток):
  buildPrompt(master, job, violations?) → llm.call(role:'main', schema) →
  validate → valid: assemble (для resume) + save artifact(status='valid')
           → invalid(попытка 1): повтор с violations в промпте
           → invalid(попытка 2): save artifact(status='invalid', validation)
```

### UI (страница вакансии, секция Documents)

- Кнопки: Generate resume · Generate cover letter · Generate both.
  Исчерпанный дневной лимит или excluded-статус — видимое сообщение
  об ошибке после клика (реактивно; отдельный статус-эндпоинт не вводим).
- Список версий: kind · vN · status (valid=зелёный/invalid=красный) · дата.
- Просмотр: resume — секциями (Summary / Skills / Experience / Education),
  cover — абзацами. invalid — красный флаг + список violations + Regenerate.
- Контент артефактов в Playwright-снапшотах **маскируется** (PII, ст. 3.2).
- Дизайн: superdesign-варианты → frontend-design → снапшоты до/после (мандат).

## Acceptance criteria

1. `buildResumePrompt` / `buildCoverPrompt` — юнит-тесты (структура, версия,
   violations-injection для попытки 2, кэш-различимость вакансий).
2. `validateResumeDiff`: каждый класс violation покрыт тестом; rephrase
   с изменённым числом/годом/работодателем — invalid; rephrase с теми же
   сущностями — valid.
3. `assembleResume` — собирает документ из диффа; неизвестная ссылка — исключение.
4. `validateCoverLetter`: >300 слов — invalid; работодатель не из master/job —
   invalid; зарплатный паттерн — invalid.
5. POST /generate: integration-тесты с мок-LLM (valid; invalid→retry→valid;
   double-fail→status invalid); дневной лимит → 402.
6. E2E: генерация (мок-LLM) → артефакт в списке; invalid → флаг и violations
   видны; Regenerate → новая версия. Снапшот секции с маскированным контентом.
7. Golden-прогон: 3–5 живых вакансий (score 74–84 из v5), оба документа,
   факт-чек 100% valid (после ≤2 попыток); отчёт по стоимости в notes.
8. PII-гейт: grep-тест — контент артефактов не встречается в логах/тест-фикстурах
   коммитов (файлы фикстур golden — только violations/метрики, не контент).

## Тест-план

- **Unit** (packages/core): валидаторы ×2, assemble, извлечение сущностей.
- **Unit** (packages/llm): промпт-билдеры, схемы.
- **Integration** (tests/integration): API с мок-LLM; версии; лимит.
- **E2E** (tests/e2e): секция Documents, генерация, invalid-флоу, снапшоты.
- **Golden** (scripts): живые вызовы, отчёт cost/факт-чек в S5-report.md.

## Метрики

- `llm_run` (stage=generate_resume|generate_cover): токены/cost/латентность.
- Отчёт: средняя стоимость пары документов, доля регенераций, доля invalid
  после 2 попыток — в `specs/notes/S5-report.md`.

## DoD

- [ ] Все AC выполнены; юнит/интеграция/e2e зелёные.
- [ ] lint / arch-lint / colors / kysely / typecheck — 0 нарушений.
- [ ] Docker-образы web пересобраны, секция работает на LAN:3000.
- [ ] Security-аудит инкремента (Mimosa-хук + ручная верификация; claude-security
      workflow — если будет доступен) — вывод в S5-report.md.
- [ ] Отчёт по токенам на golden-наборе (правило 7 AGENTS.md).
- [ ] Снапшоты до/после (git-lfs), PII маскирован.

## Открытые вопросы — решены PO (G1, 2026-09-23)

1. Тон cover letter: **формальный Canadian business** (v1); калибровка по golden.
2. Просмотр tailored resume: **без identity** — только профессиональные секции
   (Summary/Skills/Experience/Education); окончательная вёрстка — рендер S6.
