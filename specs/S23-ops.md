# S23: Операционные улучшения — enrichment-фикс, apply-контакты, авто-драфт, алерты источников

Статус: accepted (G1 — мандат PO «давай операционные улучшения», 2026-10-01) · Версия: 1.0 · Milestone: ops
Реестр: эксплуатационные боли из отчётов S8/S10 +living-данных · зависит от S4 (posting-fetcher), S5 (генерация), S12 (scheduler), S13 (metrics).

## Проблема и цель

1. **Enrichment описаний сломан**: живая разметка Job Bank сменилась — ни один из трёх маркеров `fetchPostingDescription` не матчится (проверено на живой странице: 0/27 вакансий с fullDescription). Качество промптов S5 деградирует до коротких feed-снимок.
2. **Получатель вводится руками**: в raw нет email; «How to apply» у Job Bank — JSF-AJAX панель (статически недоступна). Часть страниц отдаёт apply-инфо статически — её надо сохранять.
3. **Документы генерируются только по клику** — топ-вакансии дня ждут ручного «Generate» (S5 R3 откладывал авто до approve-флоу; S8/S9 его закрыли).
4. **Нет алерта «источник пуст»** (DESIGN §7: «алерты источник пуст N часов») — виден только вручную по Sources.

## Решения

### R1. Фикс extraction posting-fetcher — ✅
Новый первичный маркер `section.job-posting-content` (живая разметка, проверено), затем старые (оставлены как fallback), fallback по `<body>` остаётся. Fixture-тест на сохранённом фрагменте живой страницы (синтетический мини-HTML — без PII).

### R2. applyEmail из статической страницы — ✅ (best-effort, без JSF)
`fetchPostingDescription` → возвращает `{ description, applyEmail }`: email из блоков `job-posting-detail-apply` (mailto:/текст) если присутствуют статически. `enrich-description` пишет `raw.applyEmail` + `fullDescription`. UI dispatch: префилл = applyEmail → extractEmailCandidates. JSF-панель НЕ эмулируем (ст. 4.2 честность + хрупкость; ручной ввод остаётся fallback) — фиксируется ограничением.

### R3. Авто-драфт топ-вакансий в scheduler — ✅
- Перенос `generateDocuments`(+master-лоадеры, ошибки) из apps/web в **packages/core** (арх-правила позволяют: core→llm ✓); путь мастера — от `import.meta.url` (одинаково в dev/докер для web и worker); web-роуты/сервисы импортируют из core. Compose: scheduler получает `./data/profile:ro` маунт.
- `selectAutoDraftCandidates(db, {scoreMin, limitToday})`: relevant, best score ≥ `AUTO_DRAFT_SCORE` (env, default 85), без application-строки, без валидного resume-артефакта; лимит `AUTO_DRAFT_JOBS_PER_DAY` (default 10) по счёту артефактов за сегодня с `content->>'autodraft'='true'`.
- `runAutoDraft(db, llm)`: для кандидатов — enrichment описания если нет (R1), generateDocuments(['resume','cover_letter'], {autodraft:true} → флаг в content), ошибки — лог и продолжение; GEN_DAILY_LIMIT_USD уже внутри generateDocuments. Выключатель `AUTO_DRAFT=0`.
- Конституция: генерация — внутреннее действие (ст. 1.1 регулирует исходящее), отправка остаётся только ручным Approve.

### R4. Алерт stale-источника — ✅
`SourceHealth.stale: boolean` — нет успешного прогона (error IS NULL) с unique_jobs>0 моложе `intervalMin*3`; UI-чип «stale» красным в Sources (токены DS).

## AC

1. Fixture-тесты: новый маркер извлекает описание; applyEmail ловится из apply-блока (mailto + plain), отсутствует → null — unit.
2. enrich-description пишет applyEmail+fullDescription; повторный просмотр — из кэша — integration.
3. dispatch UI префилл: applyEmail приоритетнее кандидатов — e2e (сид с applyEmail).
4. Перенос генерации в core: все существующие generation-тесты зелёные через `@chinook/core` (импорт-обновление), web-роуты работают — integration/e2e регрессия.
5. `selectAutoDraftCandidates`: порог/отсутствие-артефактов/лимит-дня — integration; `runAutoDraft` с mock-LLM: 2 кандидата → артефакты с autodraft-флагом, 3-й сверх лимита не генерится — integration.
6. `SourceHealth.stale`: свежий источник false; все прогоны старые/ошибочные → true — integration; UI-чип — e2e.
7. Гейты + CI зелёные (linux/win32 бейслайны при необходимости).

## DoD

AC1–7; STACK 2.7 (без новых пакетов — перенос кода); compose-маунт профиля в scheduler; отчёт S23-report; деплой + живой прогон auto-draft (dry, ≤ $0.10).

## Открытые вопросы (дефолты)

1. AUTO_DRAFT_SCORE=85 / JOBS_PER_DAY=10 — env-ручки, PO может ужесточить.
2. JSF-панель how-to-apply не эмулируется (ст. 4.2) — ограничение зафиксировано.
3. Авто-драфт не трогает excluded/review и вакансии с application-строкой.
