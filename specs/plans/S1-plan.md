# S1 Plan — Normalization & dedupe

Спека: specs/S1-normalization-dedupe.md (accepted, G1 2026-09-16)
Роли: план — Архитектор; реализация — Имплементатор (TDD).

## Шаги (критерий проверки у каждого)

1. **Контракты (packages/contracts):** zod-схемы Job/RawJob/Adapter; типы.
   Deps: zod. Красный: schema-тесты (невалидный Job отклоняется, валидный проходит).
2. **Ядро (packages/core):** normalize / canonicalHash / dedupe (dice-bigram ≥0.92).
   TDD: таблица кейсов + property-тесты (fast-check) — красный → реализация → зелёный.
3. **Адаптеры (packages/adapters):** jobbank + adzuna; response-схемы zod; native fetch;
   Adzuna-креды из env (node --env-file). Фикстуры: живые ответы, санитизация.
   TDD: парсинг фикстур → Jobs, проходящие валидацию.
4. **Персистентность (apps/worker):** kysely + pg; таблицы job + ingest_run
   (CREATE TABLE IF NOT EXISTS — без миграционного фреймворка, YAGNI);
   upsert by canonical_hash с мержем urls[].
   CLI: `pnpm --filter @chinook/worker ingest [--fixtures]`.
5. **docker-compose.yml** (postgres:17-alpine, healthcheck) + `.env.example`.
6. **Integration-тесты (tests/):** ingest --fixtures против postgres (локально docker,
   в CI — service-контейнер); повторный прогон не плодит дубли.
7. **Живой прогон** Job Bank + Adzuna → метрики дедупа в отчёт.
8. **Обвязка:** STACK.md 1.2 (zod, kysely, pg, fast-check, tsx, postgres 17);
   отчёт S1-report.md; пуш ветки; зелёный CI.

## Риски/примечания
- Job Bank API — исследовать перед шагом 3 (наличие/форма/ToS/robots.txt);
  при отсутствии официального API — публичный JSON-эндпоинт поиска с уважением
  robots.txt (конституция ст. 4.1) либо сужение live-источника до Adzuna в S1
  с переносом Job Bank в S2 (решение Архитектора фиксируется в спеке/отчёте).
- Node 26 type stripping не используем — tsx как раннер CLI (стек-запись).
- Секреты только в .env; в фикстурах и логах ключи не появляются.
