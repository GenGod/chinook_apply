# Chinook — Alberta Job Search Automation Service (Design Document)

**Продукт/бренд:** **Chinook** · GitHub-репозиторий: **`chinook_apply`** (приватный; локальная папка `canada_job_search` — переименование опционально)
**Версия:** 0.1 (черновик архитектуры)
**Дата:** 2026-09-16
**Статус:** к согласованию

---

## 1. Цель и рамки

### 1.1 Цель
Персональный веб-сервис, который:
1. Регулярно собирает вакансии из нескольких источников по Alberta, Canada (под Express Entry / Alberta Opportunity Stream).
2. Ранжирует их по соответствию твоему профилю (match score).
3. Генерирует адаптированное резюме (EN) и cover letter (EN) под каждую вакансию через LLM (Z.ai GLM).
4. Показывает пакет в дашборде; после твоего явного Approve — автоматически отправляет отклик (браузерная автоматизация или API/email).
5. Ведёт полный цикл метрик: расход токенов и стоимость по этапам, качество генерации, конверсии воронки, UI-снимки.

### 1.2 In scope (этап 1)
- Строго один пользователь, один профиль резюме (master resume).
- Источники: Job Bank API, Adzuna API, Indeed API (если доступен), alis.gov.ab.ca, кастомные RSS/Telegram/email-каналы.
- Semi-auto отклики: генерация → Approve в UI → авто-отправка.
- Английский язык документов.

### 1.3 Out of scope (этап 1)
- Мультипользовательность, авторизация ролей.
- Отправка на источники без стабильного пути автоматизации (например, капча) — fallback на «скачать пакет и отправить вручную».
- ~~Глубокий анализ резюме~~ — перенесено в roadmap по решению PO 2026-09-16: спека S11 / M5 (BACKLOG B-002, мульти-резюме → суперпрофиль).

---

## 2. Решения (записаны по итогам вопросов)

| Решение | Выбор | Следствие |
|---|---|---|
| Источники | Job Bank + Adzuna/Indeed API, alis, кастомные RSS/TG/email | Гибридный layer адаптеров; scraping LinkedIn/Indeed не делаем |
| Отклики | Semi-auto: draft → Approve → auto-send | Playwright-воркер + очередь отправки; человек в контуре |
| LLM | Z.ai GLM (текущий провайдер) | Единый клиент-обёртка с учётом токенов/стоимости |
| Стек | Next.js (full-stack) | Один репозиторий: app router + API routes + server actions |
| Язык | EN | Промпты и документы на английском |
| Деплой | Локально, Docker Compose | Postgres + Redis + app + playwright-worker в одном compose |

---

## 3. Архитектура

```
┌─────────────────────────────────────────────────────────────┐
│ Next.js app (app router)                                    │
│  ├─ UI: Dashboard / Inbox / Application detail / Metrics    │
│  └─ API routes: REST для очередей, approve, retry           │
├─────────────────────────────────────────────────────────────┤
│ Core services (domain layer, вне UI)                        │
│  ├─ Ingestion: adapters (jobbank, adzuna, indeed, alis,     │
│  │              rss, telegram, email) → normalized Job      │
│  ├─ Matching: rule-фильтры (NOC, location, salary) +       │
│  │            LLM match-score с кэшем                       │
│  ├─ Generation: resume tailoring + cover letter (GLM)       │
│  ├─ Dispatch: Playwright-воркер авто-отправки + email       │
│  └─ Observability: token/cost ledger, event log, snapshots  │
├─────────────────────────────────────────────────────────────┤
│ Infra: Postgres (данные) · Redis + BullMQ (очереди) ·       │
│        Playwright (браузер) · MinIO/local FS (артефакты)    │
└─────────────────────────────────────────────────────────────┘
```

### 3.1 Компоненты

**Ingestion (сбор)**
- Каждый источник — адаптер с единым контрактом: `fetch(since) → RawJob[]`.
- Нормализация в единый `Job` (title, employer, location, NOC code если есть, salary, url, source, raw_payload JSONB).
- Дедупликация: canonical hash по (normalized title + employer + location) + fuzzy-порог для вариаций.
- Расписание: cron-задачи BullMQ (Job Bank каждые 30 мин, RSS — 15 мин, alis — раз в час; rate-limit per adapter, backoff).

**Matching (скоринг)**
- Уровень 1 — правила: провинция=AB, релевантные NOC-коды из твоего профиля, вилка зарплаты, ключевые слова исключения.
- Уровень 2 — LLM: промпт с master-profile + вакансией → JSON `{score: 0–100, reasons[], risks[], noc_guess}`. Температура 0. Результат кэшируется по job hash.
- Порог auto-draft (например, score ≥ 70) — вакансия автоматически уходит в генерацию; ниже — лежит в Inbox для ручного решения.

**Generation (адаптация)**
- Master resume хранится структурированно (JSON: experience[], skills, education, summary) — не как текст. Это ключ к будущему «глубокому анализу резюме»: структура = возможность скоринга и gap-анализа позже.
- Пайплайн на вакансию:
  1. Tailored resume JSON (GLM, диффы относительно master: перестановка буллетов, переакцент скиллов, ключевые слова из вакансии). **Запрещено** придумывать опыт — в промпте жёсткий constraint + валидатор (см. 6.2).
  2. Cover letter (GLM, тон: Canadian business style, ≤ 300 слов).
  3. Рендер: JSON → DOCX/PDF (docx skill подход / react-pdf).
- Каждый артефакт версионируется: `application_id + step + version`.

**Dispatch (отправка)**
- Статусная машина: `draft → pending_approval → approved → queued → sent / failed / skipped`.
- Каналы отправки по источнику:
  - Email-apply (большинство Job Bank / alis) — SMTP с приложенным пакетом. Самый надёжный канал, делать первым.
  - Web-form — Playwright-воркер: fill + attach + submit + screenshot до/после.
  - LinkedIn Easy Apply — **не в этапе 1** (риск бана); вакансии LinkedIn вообще не собираем.
- Анти-риски: глобальный лимит отправок в день (по умолчанию 10), jitter-задержки, обязательный человеческий Approve, полный скриншот-след каждого отправленного отклика.

### 3.2 Модель данных (Postgres, ключевые таблицы)

```sql
profile          -- master resume JSON (структурированный), настройки поиска
profile_source   -- S11: загруженный документ-резюме (path, формат, hash)
profile_fact     -- S11: атомарный факт с provenance (source_id, excerpt)
job              -- normalized vacancy; UNIQUE(canonical_hash); source, raw JSONB
job_match        -- score, reasons, risks, noc_guess, llm_run_id
application      -- job_id, status, approved_at, submitted_at, channel
artifact         -- application_id, kind(resume|cover_letter|render_pdf),
                   -- version, content_path, llm_run_id
llm_run          -- provider, model, prompt_tokens, completion_tokens,
                   -- cost_usd, latency_ms, stage, input_hash (для кэша)
dispatch_log     -- attempt, channel, outcome, error, screenshot_paths[]
event_log        -- append-only аудит всех действий (SDD-traceability)
ui_snapshot      -- pipeline-скриншоты тестов + production-следы отправок
```

---

## 4. AI-пайплайн и контроль генерации

### 4.1 Единый LLM-шлюз
Один модуль-обёртка над Z.ai GLM с двумя ролями моделей (см. PROCESS.md §2):
- логирует каждый вызов в `llm_run` (токены, стоимость, латентность, stage, **model role**);
- кэш по `hash(model + prompt + params)` — повторные скоринги/генерации бесплатны;
- retry с backoff, circuit breaker;
- structured output (JSON schema) для скоринга; валидация ответа zod-схемой, невалид → один повтор → degrade.

Маппинг stage → модель (quality-critical на основной модели, массовое — на flash):

| Runtime stage | Модель | Обоснование |
|---|---|---|
| match_llm (скоринг) | GLM-5.3-flash | массовая, дешёвая операция, структурированный вывод |
| generate_resume | GLM-5.3 | качество критично, ошибки видят работодатели |
| generate_cover | GLM-5.3 | качество критично |
| Валидация/diff-объяснения | GLM-5.3-flash | вспомогательное |

Dev-процесс (спеки, планы, ревью — архитектор GLM-5.3; код и тесты — имплементатор GLM-5.3-flash) описан в PROCESS.md §2.

### 4.2 Валидаторы правды (anti-hallucination)
После генерации tailored resume:
1. **Fact check**: каждый опыт/буллет из результата должен маппиться на запись master resume (fuzzy match по employer+dates+содержанию). Немаппируемое — ошибка генерации, регенерация.
2. **Date consistency**: периоды не расходятся с master.
3. **Keyword sanity**: ключевые слова из вакансии добавляются только в существующие формулировки, не создают новых фактов.
Валидаторы — чистые функции с unit-тестами; провал фиксируется в метриках как `hallucination_rate`.

### 4.3 Этапы пайплайна (каждый — измерим)
`ingest → dedupe → match_rules → match_llm → generate_resume → generate_cover → render → approve → dispatch → track_reply`

---

## 5. Метрики и методы контроля результата

### 5.1 Стоимость и токены
- На каждый `llm_run`: prompt/completion tokens, cost, latency — по stage и по application.
- Дашборд-виджет: токены и $ за день/неделю, разбивка по stage, топ-вакансии по стоимости, cache hit rate.

### 5.2 Качество генерации
- `hallucination_rate` — доля артефактов, проваливших fact-check (цель: 0).
- Твоя явная оценка в UI: каждый draft получает thumbs up/down + правки перед Approve. Правки диффом сохраняются — это готовый датасет для тонкой настройки промптов.
- Cover letter: word count, повторяемость (self-similarity между письмами — детектор «шаблонности»).

### 5.3 Продуктовая воронка
`jobs_ingested → passed_rules → score≥70 → drafted → approved → sent → replied → interview`
— конверсии между соседними этапами, по источникам. Отвечает на вопрос «какой источник реально работает».

### 5.4 Здоровье системы
- Успешность адаптеров (ошибки, 429, пустые выдачи), глубина дедупликации, очередь: длина/латентность/failed, uptime воркеров.
- Event log как единый источник для всех метрик (Grafana необязательна на этапе 1 — SQL-вьюхи поверх `event_log` + страница Metrics в Next.js).

### 5.5 UI-снимки
- **E2E (Playwright)**: каждый ключевой экран дашборда снимается в пайплайне CI; визуальная регрессия (pixelmatch/Playwright snapshots) — падение билда при диффе.
- **Production-след**: Playwright-воркер при каждой отправке сохраняет скриншоты «форма заполнена» и «подтверждение отправлено» — прикреплены к `dispatch_log`, видны в UI у каждого отклика.

---

## 6. SDD-процесс разработки

### 6.1 Порядок (spec → tests → impl, инкрементами)
| Спека | Что покрывает | DoD |
|---|---|---|
| S0 Tooling bootstrap | репо-каркас, tsconfig/eslint strict, **eslint-plugin-arch** (границы пакетов; при отсутствии готового — свой), git-lfs + `.gitattributes` для снапшотов, `STACK.md` с зафиксированным стеком, скелет CI | arch-lint ловит тестовые нарушения границ; LFS работает; CI-скелет зелёный |
| S1 Normalization & dedupe | контракты Job, canonical hash | unit-тесты на fixture-выдачах всех источников |
| S1a Jobs Explorer (из BACKLOG B-001) | read-only список вакансий + «Apply externally» по прямой ссылке + отметка applied_manually (в event_log/воронку) | e2e: фильтры, внешняя ссылка, отметка ручного отклика; снапшоты до/после |
| S2 Rule matcher | фильтры профиля | table-driven тесты |
| S3 LLM gateway | токены/кэш/retry/валидация schema | контрактные тесты + mock-провайдер |
| S4 Match scoring | JSON-вывод, пороги | golden-set из 30 вакансий с разметкой score (твоей) — точность меряем |
| S5 Resume tailoring | промпт + fact-check валидаторы | unit-тесты валидаторов + golden master resume |
| S6 Rendering | JSON→DOCX/PDF | snapshot-тесты артефактов |
| S7 Dashboard UI | Inbox, детали, approve-флоу | Playwright E2E + визуальные снапшоты |
| S8 Email dispatch | SMTP + вложения + лимиты | интеграционный тест на тестовый ящик |
| S9 Form dispatch (Playwright) | заполнение форм | тест против локальной mock-формы |
| S10 Metrics | все виды из раздела 5 | дашборд показывает реальные числа на staging-данных |
| S12 Scheduled ingest (post AI-park) | long-running планировщик: source-расписания + jitter, pg advisory lock, graceful shutdown, schedule:status/once | unit план-логики; integration: lock-конкуренция, shutdown; живой once-прогон |
| S11 Multi-resume superprofile (из BACKLOG B-002) | ingest N резюме → факты с provenance → слияние в суперпрофиль (approve PO), резюме-треки, ранжирование вакансий по трекам, расширение NOC | факт прослеживается до исходного документа (юнит-тесты provenance); дифф профиля одобряется PO; golden-set скоринга расширен под треки |

### 6.2 Контракты раньше кода
- Все спеки — markdown-файлы в `specs/`, каждая с acceptance criteria и списком метрик.
- CI (GitHub Actions, локальный act): lint → unit → integration → E2E + визуальные снапшоты → отчёт о расходе токенов на golden-set (регрессия стоимости тоже алертится).

### 6.3 Ритм
- Инкремент = одна спека. Ветвление feature/*, merge только зелёный пайплайн.
- Каждому инкременту — короткий changelog и обновление метрик-страницы (self-hosted transparency).

---

## 7. Безопасность и риски

| Риск | Митигация |
|---|---|
| Бан аккаунтов при автоматизации | Нет LinkedIn; email-канал основной; Playwright только для явных web-форм; дневные лимиты + jitter |
| ToS источников | Только официальные API + публичные RSS; robots.txt уважаем; идентификация UA |
| Секреты (SMTP, API keys, Z.ai) | `.env` вне git; docker secrets; ключи только в gateway-модулях |
| Галлюцинации в резюме | fact-check валидаторы (4.2), жёсткие промпт-констрейнты, ручной Approve |
| Хрупкость адаптеров | контракты + fixture-тесты + алерты «источник пуст N часов» |
| PII в резюме в логах | артефакты и payload'ы — в отдельном хранилище, в event_log только ссылки |

---

## 8. Структура репозитория (план)

```
canada_job_search/
  apps/web/            # Next.js: UI + API routes
  apps/worker/         # BullMQ воркеры: ingest, generation, dispatch
  packages/core/       # domain: Job, Matching, Generation, Validators
  packages/llm/        # Z.ai GLM gateway (токены, кэш, model routing)
  packages/adapters/   # source adapters
  packages/contracts/  # zod-схемы, shared типы
  packages/eslint-plugin-arch/  # arch-lint: границы пакетов (S0)
  specs/               # S0..S10 spec docs + plans/ + notes/
  tests/               # fixtures, golden-set, e2e
                     # tests/__snapshots__/ — UI-снапшоты до/после (git-lfs)
  STACK.md            # зафиксированный стек (меняется только с approve PO)
  docker-compose.yml   # postgres, redis, web, worker, playwright
```

## 9. Roadmap

**Парковка AI-контура (PO 2026-09-17):** S3 (LLM-шлюз) и зависимые от него S4 (LLM-скоринг), S5 (генерация), S6 (рендер), S11 (суперпрофиль) отложены до отдельного решения PO. M1 считается закрытым на S1+S1a+S2 (сбор→дедуп→правила→экран). Приоритет смещается на не-AI ценность: автоматизация сбора и ручной цикл отклика.
1. **M0 (S0):** tooling bootstrap — репо-каркас, arch-lint, git-lfs, заморозка стека в STACK.md, CI-скелет.
2. **M1 (S1–S3 + S1a):** сбор из Job Bank + Adzuna, дедуп, ранний экран Jobs Explorer с откликом по прямой ссылке, LLM-шлюз с учётом стоимости — «вакансии текут в базу, их видно и можно откликаться руками, метрики токенов работают».
3. **M2 (S4–S6):** скоринг + генерация резюме/письма с валидаторами — «пакет документов создаётся, качество измеримо».
4. **M3 (S7–S8):** дашборд + Approve + email-отправка — «сквозной semi-auto цикл живёт».
5. **M4 (S9–S10):** web-form отправка, полная метрик-страница, визуальная регрессия в CI.
6. **M5 (S11):** мульти-резюме → суперпрофиль с provenance, резюме-треки, ранжирование вакансий по трекам, расширенная NOC-taxonomy (по решению PO) — «система предлагает максимум подходящих позиций из всего опыта».

---

## 10. Открытые вопросы — статус (обновлено 2026-09-16)

1. ~~Master resume~~ — **получен и обработан**: исходник в `data/profile/master_resume_source.docx`, структурированный профиль в `data/profile/master_profile.json` (v1). Этот JSON — единственный источник правды для матчинга и генерации.
2. SMTP для откликов — **не создан**. Требуется отдельный ящик + пароль приложения; завести до M3 (спека S8). До тех пор dispatch работает в dry-run.
3. ~~Целевые NOC~~ — **21231 (Software developer), 21234 (Web developer)**; зашиты в `search_config` профиля.
4. ~~Indeed API~~ — согласовано: на старте Job Bank + Adzuna, Indeed — опционально позже при появлении partner-доступа.
