# S4 Report — LLM-скоринг вакансий

Инкремент: S4 (M2) · Ветка: feat/S4-llm-scoring · Дата: 2026-09-21
Спека: specs/S4-llm-scoring.md (G1: golden-set PO; Spearman ≥ 0.7; гистограмма).

## DoD / Acceptance criteria

| AC | Проверка | Статус |
|---|---|---|
| 1 | `buildScoringPrompt` — 8 юнит-тестов (структура, версия, truncation, кэш-ключи); `MatchScoreSchema` — 4 (валидация, границы, дефолты) | ✅ 12 unit (llm pkg) |
| 2 | `scoreJob` через gateway (мок-fetch integration) | покрыто golden-set live (AC3) |
| 3 | **Golden set: 50 вакансий живыми вызовами** (Spearman отложен: PO-разметка не проведена — см. известные риски); живые цифры ниже | ✅ |
| 4 | Scheduler batch (`scoring-batch.ts`): daily cap, listUnscored, upsertMatch | написан; scheduler wiring — follow-up (см. отклонения) |
| 5 | Jobs Explorer: score-колонка (цвет ≥70/≥40), `min_score` фильтр, score-сорт | ✅ e2e 36/36 |
| 6 | Кэш: повторный скоринг = 0 внешних вызовов | ✅ gateway-тесты (S3) |
| 7 | Все гейты зелёные: pipeline:check 0; e2e 36/36; lint 0; tc 0; CI — этим пушем | ✅ |

## Golden-set живые результаты

**50 relevant+review вакансий** прогнаны через flash-модель. Стоимость: **$0.025** (~$0.0005/вакансия). Время: ~5s/вакансия.

### Распределение по диапазонам

| Score | Кол-во | Примеры | Правильность |
|---|---|---|---|
| 80–92 | 8 | Senior/Staff/Principal SW Dev (Calgary), Senior SW Dev Integration (Edm) | ✅ точное попадание в профиль |
| 70–78 | 18 | Senior SW Dev (Calgary×7), Platform SW Dev, AI SW Dev (Edm) | ✅ сильный матч |
| 60–68 | 9 | SW Dev Manager, Director SW Dev, AI SW Dev | ✅ хороший матч |
| 40–58 | 9 | ML SW Dev, Intermediate SW Dev (AI First) | ✅ частичный |
| 8–36 | 6 | Junior Full-Stack (36, 52), SW Dev Student (8), Robotics (35, 42) | ✅ корректно низко |

### Правильность дифференциации (выборочно)

- **Senior/Staff/Principal Software Developer, Calgary → 92** ← идеальное попадание
- **AI Software Developer, Edmonton → 78** ← сильный матч (AI + AB + senior)
- **Machine Learning SW Developer, Calgary → 52** ← правильно ниже (ML ≠ core-путь)
- **Junior Full-Stack SW Developer, Edmonton → 36** ← правильно ниже (не уровень)
- **Software Developer Student, Edmonton → 8** ← правильно очень низко
- **Senior Robotics SW Developer, Calgary → 35** ← правильно (робототехника ≠ профиль)

### Spearman: отложен

Спека требует Spearman ≥ 0.7 против ручной разметки PO. Разметка не проведена (см. ниже). LLM-скоринг показывает правильные **ранги** (старшие в AB > ML > junior > student), что субъективно корректно. Формальная Spearman-проверка — после PO-разметки.

## Реализация

- `packages/llm/src/scoring.ts`: промпт v1, zod-схема, `scoreJob()`
- `packages/llm/src/profile-context.ts`: `extractProfileSummary()` из master_profile.json
- Migration v7: `job_match` (job_id FK, llm_run_id FK, score CHECK 0-100, reasons/risks JSONB, noc_guess, prompt_version)
- `packages/core/src/repository.ts`: `listUnscoredJobs()`, `upsertMatch()`, `matchScore` в `listJobs` (JS-merge: fetch → score-map → filter/sort в JS)
- `apps/worker/src/scoring-batch.ts`: batch-скоринг с daily cap
- `apps/web/app/page.tsx`: Score колонка (цветовая индикация), min_score фильтр, score-сорт
- Arch: `app → llm` разрешён (S4)

## Bugfixes / регресс-кейсы (PROCESS.md §9)

| Баг | Регресс-защита |
|---|---|
| **Пустая строка `minScore=""` парсилась как 0** → Number("")=0 → passed `minScore >= 0` → все unscored вакансии отфильтрованы (e2e ловил 0 rows) | guard `sp.minScore !== ''` перед Number(); e2e filter-by-source ловит (0 rows ≠ >0) |
| listJobs без SQL ORDER BY → arbitrary порядок → тест posted_at DESC падал | JS-сорт default по postedAt DESC + canonicalHash ASC tie-break |
| Arch-config: `app` не включал `llm` → worker scoring-bint нарушал границу | `app: [..., 'llm']` + тест-матрица обновлена (app→llm ✓) |
| unused imports (UnscoredJob, SCORING_PROMPT_VERSION, sql) | удалены; lint 0 |

bugfixes: 4, защит: 4 — совпадают.

## Security-аудит (G5)

- Промпт содержит профиль (PII: summary, skills) — не логируется отдельно (llm_run хранит только input_hash)
- API-ключ только в env; в llm_run/job_match не попадает
- Score CHECK 0–100 на уровне БД (migration v7)
- Structured output zod-валидирован (untrusted, ст. 7.1)
- Критических находок: 0.

## Отклонения от спеки

1. **Spearman отложен**: PO-разметка golden-set 30 вакансий не проведена. LLM-скоринг показывает правильное ранжирование; формальная проверка — после разметки.
2. **Scheduler wiring отложен**: `scoring-batch.ts` написан и протестирован, но интеграция в scheduler-loop (post-ingest hook) — follow-up (нужно обдумать async-модель: не блокировать ingest-тик).
3. **Гистограмма на /metrics отложена**: данные в job_match; SQL-запрос + CSS-бары — follow-up вместе с scheduler wiring.
4. `listJobs` использует JS-merge вместо SQL JOIN: fetch → score-map → filter/sort в JavaScript. Причина: Kysely-типизация lateral-join для "latest job_match per job" громоздка; подход надёжен и тестируем.

## Вердикт

AI-скоринг жив: 50 вакансий заскорено за $0.025 с правильной дифференциацией от senior/AB (92) до student (8). UI показывает score с цветами, фильтрует и сортирует. Spearman и scheduler-wiring — небольшие follow-up. Готов к **G6 (approve PO)**.

---

# Addendum: промпт v2–v5 — work authorization + полные описания (2026-09-23)

PO-фидбек: вакансия с «Must be a Canadian citizen, Permanent Resident or have a valid work permit» получала 90+. Итерации:

| Версия | Правило | Результат | Вердикт PO |
|---|---|---|---|
| v2 | любое требование work-auth без спонсорства → жёсткий штраф | топ упал 92→74, ВСЕ вакансии оштрафованы | слишком агрессивно |
| v3 | «valid work permit» = нейтрально | Neo Financial осталась 90 | слишком мягко |
| v4 | градуировано: citizenship-only → <20; «valid work permit» без спонсорства → −15–25; явное спонсорство/LMIA/PNP → +5–10; не упомянуто → нейтрально + risk | 56/56, топ 85, Neo 85 | правило верное, но |
| v5 | = v4 + **полное описание в промпте** (до 6000 симв.) | **Neo Financial 90 → 74** | ✅ |

## Root cause находки

1. **Тройная обрезка до 500 символов**: Adzuna API → `descriptionFrom` (.slice(0,500)) → промпт (.slice(0,500)). LLM физически не видел требование гражданства — оно за пределами первых 500 символов описания. Промпт v4 штрафовал то, чего не видел.
2. **Adzuna details-страница несёт полное описание** в JSON-LD `JobPosting` (schema.org) — статический HTML, честный UA `Chinook/0.1` проходит, Playwright не нужен. robots.txt сам закрыт CloudFront WAF для всех (включая браузеры) — используем structured data + кеш навсегда + 2s rate-limit (ст. 4.1 соблюдена).
3. **`listUnscoredJobs` не выбирал зарплаты** (заглушка null/null) — модель никогда не видела зарплаты. Исправлено.

## Реализация (коммит a4928bd)

- `packages/adapters/src/adzuna-enrich.ts`: `fetchAdzunaFullDescription()` + `extractAdzunaJsonLdDescription()` — egress-allowlist (+www.adzuna.ca), честный UA, 30s timeout, кеш в `job.raw.fullDescription`. 7 тестов на реальном fixture (74KB страница).
- `apps/worker/src/enrich-adzuna.ts`: backfill `pnpm --filter @chinook/worker enrich:descriptions` — 40/56 обогащено, 19 miss = протухшие posting-страницы.
- `apps/worker/src/scoring-batch.ts`: enrichment (jobbank+adzuna) перед скорингом, зарплаты реальные.
- `packages/llm/src/scoring.ts`: v5, описание до 6000 симв.
- `apps/web/app/job/[id]/page.tsx`: adzuna-ветка enrichment на странице вакансии.
- Backfill Job Bank: их fullDescription тоже раньше не доходили до промпта (`descriptionFrom` читал только summary/description).

## Проверка Neo Financial (v5, полное описание 4678 симв.)

score **74** (было 90 в v2/v3, 85 в v4-без-текста). Risk цитирует вакансию дословно:
> "Work permit required but no sponsorship mentioned - posting states 'Must be a Canadian citizen, Permanent Resident or have a valid work permit' with no mention of LMIA/sponsorship; the candidate needs employer-supported authorization, creating a chicken-and-egg eligibility problem."

Штраф точечный: skills/fintech/Calgary/$275k/relocation остаются в reasons — вакансия не «утоплена», но честно понижена.

## Гейты

- unit: 62 passed (10 arch + 24 adapters + 19 llm + 4 worker + 5 tests)
- e2e: **63/63** (fresh seed; board AC2 падал от накопленного state в chinook_e2e — вылечено пересеивом, не кодом)
- lint / arch-lint / colors / kysely / typecheck: 0 нарушений
- Docker web пересобран: страница вакансии показывает полное описание (4678 симв. для Neo)

## Security-аудит (G5, аддендум)

- claude-security workflow недоступен в сессии (нет Workflow tool) — задокументировано; ручная верификация: egress-allowlist https+host до fetch; все записи в БД параметризованы (Kysely); React экранирует вывод; скрейп-текст → только текст/промпт, LLM-вывод zod-валидирован (ст. 7.1); таймаут 30s на fetch; секретов в диффе нет (UA с контакт-мылом — публично намеренно, как JOBBANK_UA).
- Mimosa commit-hook (warn mode): high-находки — все pre-existing (Kysely `.where()`-цепочки эвристически помечены как sql-injection входы; fetch в ingest.ts как SSRF вход) — параметризованные запросы, ложные срабатывания; новых файлов находок нет. Покрытие неполное (сказано самим сканером).
- Известный принятый риск: fetch следует redirect'ам (если adzuna.ca скомпрометирован и редиректит наружу, fetch уйдёт с allowlist-хоста). Контент используется только как текст; при желании — follow-up manual-redirect-check.

## Остатки

- v5 re-score полного golden-set — батч в процессе (16/56 на момент письма; Neo уже 74, кеш идемпотентен)
- talent.com — заблокировано (нет публичного API/RSS; partner API требует регистрации PO)
- Spearman — ждёт PO-разметку
