# S23-report — Операционные улучшения

Ветка `feat/S23-ops` (от `origin/main` = merge S10). Спека: [S23-ops.md](../S23-ops.md).
G1: мандат PO «давай операционные улучшения» (2026-10-01).

## Что сделано

| R | Суть |
|---|---|
| R1 | **Фикс сломанного enrichment**: живая разметка Job Bank сменилась — ни один из трёх старых маркеров не матчился (0/27 enriched, проверено на живой странице). Новый первичный маркер `section.job-posting-content`, старые — fallback, `<body>`-fallback остался. Fixture-тесты на текущей разметке (red→green, 4/4). |
| R2 | **applyEmail** (best-effort, статика): `extractPosting` возвращает `{description, applyEmail}` (mailto:/plain из apply-блоков); enrich пишет `raw.applyEmail`; dispatch-префилл: applyEmail → кандидаты. **JSF-панель how-to-apply НЕ эмулируется** (ст. 4.2 — честность/хрупкость; ограничение зафиксировано). e2e: префилл из applyEmail. |
| R3 | **Авто-драфт**: `selectAutoDraftCandidates` (relevant, best score ≥ AUTO_DRAFT_SCORE=85, без application/валидного resume; лимит AUTO_DRAFT_JOBS_PER_DAY=10 по autodraft-флагу в content) + `runAutoDraft` (покандидатная изоляция ошибок; GEN_DAILY_LIMIT_USD внутри; GenerationLimitError останавливает батч). Встроен в тик scheduler'а после ingest (AUTO_DRAFT=0 — выкл). |
| R3b | **Архитектурный перенос**: generation-оркестрация из apps/web → `packages/llm/document-generation.ts` (+autodraft.ts). Причина: turbo-цикл core↔llm при размещении в core; в llm зависимости сходятся (llm→core ✓). Путь мастера — от `import.meta.url` (одинаково web/worker в dev и Docker). Web-шим сохраняет импорт-сайты. |
| R4 | **Stale-алерт**: `SourceHealth.stale` (нет успешного non-empty прогона за 3× интервала) + красный чип STALE в Sources; e2e DOM↔API. |
| Инфра | compose: scheduler получает `data/profile:ro` + AUTO_DRAFT*/GEN_DAILY_LIMIT_USD/ZAI_API_KEY env; env.example дополнен; STACK 2.7. |

## AC — все выполнены

| AC | Проверка |
|---|---|
| 1 extraction (новый маркер/applyEmail/нет-email/legacy) | ✅ unit 4/4 |
| 2 enrich пишет applyEmail+fullDescription, кэш | ✅ (код-путь покрыт unit+e2e префилла) |
| 3 dispatch префилл applyEmail приоритетнее | ✅ e2e |
| 4 перенос генерации: 12/12 generation + 87/87 integration | ✅ |
| 5 селектор/лимит/флаг + runAutoDraft batch-изоляция | ✅ integration 5/5 |
| 6 stale: свежий=false, всё старое=true; чип | ✅ integration + e2e |
| 7 гейты | ✅ lint/arch/typecheck/build/unit/integration/e2e 82/82 |

## Живой прогон (deployed scheduler)

- Смоук авто-драфта (порог 70, лимит 1 — осознанно ниже дефолта, в живой БД максимум свежих = 84 < 85):
  `{"considered":1,"drafted":1}` — resume **valid + autodraft-флаг**; cover **invalid: unknown_entity "At Akvelon"** — факт-чек поймал выдуманного работодателя на 2-й попытке (гейт работает как задумано); стоимость дня **$0.0283**.
- Смоук вскрыл и починил 2 деплой-бага (каждый — red→green): пустая строка `GEN_DAILY_LIMIT_USD=""` из compose валилась как invalid (теперь игнорируется), и отсутствие `ZAI_API_KEY` в env scheduler (401).

## Цифры

unit turbo 11 задач (199+4 extraction); integration **87** (+5 autodraft, +1 stale, +1 empty-env); e2e **82** (+1 префилл, +1 stale); lint/arch/typecheck — 0.

## Security

- Перенос не изменил PII-границы: мастер-файл по-прежнему gitignored/ro-маунт; промпты без identity (G1).
- JSF-панель не эмулируется (ст. 4.2) — ручной ввод получателя остаётся fallback; applyEmail только из статической страницы.
- auto-draft — внутреннее действие (ст. 1.1 про исходящие); отправка по-прежнему только ручной Approve (S8/S9).

## Открытые вопросы

1. AUTO_DRAFT_SCORE=85: в текущей живой БД свежих ≥85 нет (макс 84) — первый реальный автодрафт случится на новом инgest-пополнении; PO может опустить порог (env).
2. Крон-очистка dispatch_log/скриншотов не заведена (YAGNI; папки gitignored).
