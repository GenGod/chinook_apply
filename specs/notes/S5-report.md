# S5-report — Tailored documents (generation)

Ветка `feat/S5-generation`, HEAD на момент отчёта: `d81addd` (+ T9-коммит).
Спека: [S5-generation.md](../S5-generation.md). План: [S5-plan.md](../plans/S5-plan.md).
Журнал выполнения: [.superpowers/sdd/S5-plan/progress.md](../../.superpowers/sdd/S5-plan/progress.md) — консолидирован
свежей сессией 2026-09-28 (хвост прошлой сессии содержал противоречивые записи;
все утверждения ниже перепроверены по git и живой БД).

## Что сделано

| Задача | Коммиты | Суть |
|---|---|---|
| T1 | `234706c` | миграция `artifact` + Row-типы (red→green) |
| T2 | `4e459fd` | извлечение сущностей + валидатор resume-диффа (red→green) |
| T3 | `0d5b936`, `df3977c` | `assembleResume` + валидатор cover letter; фикс RED-аргументации и сужение salary-паттерна (red→green) |
| T4 | `9ea4766` | промпты `buildResumePrompt`/`buildCoverPrompt` + zod-схемы (red→green) |
| T5 | `1aa6f35` | artifact-репозиторий (save/list/get, инкремент версий) |
| T6 | `e4bd35e` | оркестрация `generateDocuments`: 2 попытки, дневная капа, unknown-ref, GenerationLimitError/JobNotEligibleError |
| security | `a73b36b` | статический путь мастер-профиля (устранение path-traversal поверхности по находке Mimosa-хука) |
| T7 | `48a1819` | API-роуты generate/artifacts/content |
| T8 | `d81addd` | UI-секция Documents (superdesign вариант A → вёрстка), e2e |
| T9 | этот коммит | golden-скрипт `apps/web/src/scripts/generate-documents.ts` (live glm-5.3, метрики в консоль — без контента), `generate:documents` + tsx, compose-маунт `./data/profile:/app/data/profile:ro`, деплой, отчёт |

Отклонение от плана (задокументировано в журнале): golden-скрипт живёт в `apps/web`,
а не в `apps/worker`, — `generateDocuments` web-owned, воркер не может импортировать из приложения.
Проверено typecheck + arch-lint.

## DoD — Acceptance criteria

| AC | Проверка | Статус |
|---|---|---|
| 1 | Промпт-билдеры: структура, версия, violations-injection (попытка 2), кэш-различимость | ✅ unit `packages/llm/test/generation.test.ts` |
| 2 | `validateResumeDiff`: каждый класс violation покрыт; число/год/работодатель в rephrase → invalid; те же сущности → valid | ✅ 21 тест в `packages/core/test/generation-validators.test.ts` |
| 3 | `assembleResume` из диффа; неизвестная ссылка — исключение | ✅ тот же файл |
| 4 | `validateCoverLetter`: >300 слов / чужой работодатель / зарплатный паттерн → invalid | ✅ тот же файл |
| 5 | POST /generate, мок-LLM: valid; invalid→retry→valid; double-fail→invalid; лимит → 402 | ✅ `tests/integration/generation-service.test.ts` (9 тестов) |
| 6 | E2E: генерация → артефакт в списке; invalid → флаг+violations; Regenerate → новая версия; 402/409 error-path | ✅ e2e 70/70, вкл. `documents.spec.ts` |
| 7 | Golden-прогон: живые вакансии, оба документа, 100% valid после ≤2 попыток; cost-отчёт | ✅ 4/4 valid, $0.0152 за прогон (ниже) |
| 8 | PII-гейт: контент артефактов не встречается в закоммиченных файлах | ✅ (ниже, с одной находкой вне диффа S5) |

DoD-пункты: гейты 0 нарушений ✅; docker-образ web пересобран, секция работает на LAN:3000 ✅
(curl-проверки + артефакты видны через API); security-аудит ✅ (ниже); токен-отчёт ✅ (ниже);
снапшоты — UI в T9 не менялся, e2e-снапшоты (git-lfs) прошли без диффа ✅.

## Цифры тестов

| Сьют | Файлы | Тесты |
|---|---|---|
| unit turbo-гейт (`pnpm test`): adapters 24, llm 49, plugin-arch 10, worker 4, tests 5 | 11 | 92 |
| unit `packages/core` (vitest, вне turbo — у пакета нет test-скрипта, см. отложенное) | 9 | 72 |
| integration `tests/integration` (БД `chinook_test`, изолирована) | 9 | 46 |
| e2e Playwright (порт 3999, БД `chinook_e2e`) | — | 70 |
| **Итого** | | **280, 0 упавших** |

Гейты: `pnpm lint` (eslint + colors + kysely) 0; `pnpm arch-lint` 0; `pnpm typecheck` 8/8 пакетов.

## Golden run (T9, живой glm-5.3)

Свежая сессия 2026-09-28, скрипт `pnpm --filter @chinook/web generate:documents`.
Набор: топ-4 v5-relevant — Neo Financial **90**, 80, 78, 74 (замысел плана «band + Neo» — Neo=90 выше диапазона, остальные в 74–80).

| Работа прогона | Значение |
|---|---|
| Вакансий | 4/4, оба документа каждой |
| Результат факт-чека | 8/8 артефактов valid, 0 invalid, 0 нарушений |
| LLM-вызовы | 11 (9 cache-hit $0, 2 живых) |
| Стоимость прогона | **$0.015247** (бюджет плана ≤ $0.05) |
| Артефакты | записаны в живую БД, версии дописаны (append-only); в UI/API видны |

Честная оговорка по стоимости: повреждённая сессия 2026-09-23/28 успела до остановки
выполнить де-факто генерацию — в БД 21 живой вызов на $0.2173 (08:32–09:16 UTC) и её артефакты.
Её выводы были недостоверны, поэтому T9 перезапущен свежей сессией (см. выше). Суммарный расход
дня по generate-стадиям — **$0.2325** при дневной капе $1.00 (GEN_DAILY_LIMIT_USD не задан).

Метрики стадии generate за 2026-09-28 (оба прогона, из `llm_run`):

| Стадия | Вызовы (кэш/живые) | Cost | avg latency | prompt tok | completion tok |
|---|---|---|---|---|---|
| generate_resume | 12 (5/7) | $0.1257 | 151.8s | 17 844 | 71 896 |
| generate_cover | 20 (9/11) | $0.1068 | 40.4s | 20 593 | 57 467 |

Удельная экономика (живые вызовы): ~$0.0097/артефакт, ~$0.019/пара документов.
Доля регенераций: пары с >1 версией есть (append-only по дизайну); invalid-артефактов в БД — 0/24.
Кэш гейтвея даёт $0 на повторной генерации той же вакансии — подтверждено живьём (9/11 вызовов прогона).

## Security-аудит

- **Mimosa L2 stop-hook** (mid-T8): `artifacts.ts:80` sql-injection — FALSE POSITIVE (Kysely-параметризация,
  ни одного raw-SQL фрагмента, проверено grep по репо). `generation-service.ts:109` path-traversal — REAL:
  устранён в `a73b36b` полным удалением динамических фрагментов (статический литерал `../../data/profile/master_profile.json`,
  параметр explicitPath удалён — callers не использовали). `core/profile.ts` — тот же env-паттерн, pre-existing/вне диффа.
- **Mimosa pre-commit hook (T9-коммит `ad74329`)** — верифицировано вручную:
  `gateway.ts:123/125/207/227` «sql-injection» — FALSE POSITIVE (в этих строках нет SQL — вызовы Kysely-репозитория
  `findCache/incrementCacheHits/saveCache`; тот же класс эвристики, что зафиксирован ruling'ом mid-T8);
  `golden-set.ts:13` — аналогично; `ingest.ts:64` «SSRF» — FALSE POSITIVE на практике: fetch идёт на фиксированные
  хосты адаптеров (api.adzuna.com / jobbank), поисковый query не управляет назначением запроса (pre-existing S1/S12).
  Raw-SQL в репо ограничен `core/metrics.ts` (статические литералы без интерполяций) и `core/db.ts:281`
  (параметризованный `sql`-шаблон Kysely) — поверхности инъекции нет. Хук сам помечает покрытие неполным.
- **PII-гейт AC8** (свежая сессия): фрагмент реального буллета из БД → `git grep` по трекаемым файлам — **0 попаданий**;
  полное имя и фамилия из `identity.full_name` — **0 попаданий** (совпадение «имени» на первом прогоне оказалось
  словом «Senior» из заголовка — ложное срабатывание регэкспа, исправлено извлечением из `identity.full_name`).
  Контент артефактов живёт только в БД; в консоль скрипта — только метрики и kind'ы violations.
- **Находка вне диффа S5 (для решения PO):** личный email захардкожен в User-Agent трёх файлов адаптеров
  (`adzuna-enrich.ts:9`, `jobbank.ts:8`, `posting-fetcher.ts:5` — `Chinook/0.1 (personal job-search automation; contact: …)`).
  Внесён осознанно в S1 (`be6bfdb`) как контакт краулера (вежливая практика для jobbank/adzuna), уже публичен на `origin/main`.
  Рекомендация: заменить на env-переменную (`ADZUNA_CONTACT_EMAIL`) или noreply-адрес отдельным инкрементом;
  из истории GitHub строку не стереть без переписывания истории.
- Секреты: ключи только в `.env` (gitignored), `ZAI_API_KEY` в llm_run/артефакты не попадает; compose-маунт профиля read-only.

## Отложенные мелочи (из ревью задач, не блокируют G6)

- у `packages/core` нет `test`-скрипта → его 72 теста и integration-сюкит (46) не входят в turbo-гейт `pnpm test`
  (запускаются явно; предложение: добавить скрипты в T-очередь инструментов);
- `listArtifacts` без tie-break по версии при равном `created_at`; concurrent-save → сырая 23505;
  missing-master проверяется после 409/402 (misconfig → 500); toggleRow без sequencing запросов;
  async-обработчики UI глотают сетевые ошибки; dailyLimitUsd не валидируется сверху;
  seedArtifacts — фикстуры вместо параметризуемого хелпера.
- Spearman-валидация ранжирования — вне S5 (наследие S4, после PO-разметки).

## Следующий шаг

Финальное ревью ветки → push по «го» PO → G6.
