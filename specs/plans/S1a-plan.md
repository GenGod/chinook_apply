# S1a Plan — Jobs Explorer

Спека: specs/S1a-jobs-explorer.md (accepted, G1 2026-09-16; kanban → BACKLOG)
Порядок: рефактор-перенос → RED репозиторий → GREEN → API → UI → e2e/visual → отчёт.

1. BACKLOG B-003 (kanban, later) + статус спеки accepted; ветка feat/S1a-jobs-explorer.
2. Перенос db-слоя worker→core (packages/core/src/db): createDb/ensureSchema/SCHEMA_SQL v2
   (+application), repository (listJobs/markAppliedManually/countJobs/upsertJobs);
   worker/test импорты обновить; гейты зелёные (чистый рефактор).
3. RED: tests/integration/repository.test.ts (фильтры/сортировка/идемпотентность).
4. GREEN: реализация repository + миграция application.
5. API: GET /api/jobs, PATCH /api/jobs/[id]/applied-manually (thin, e2e-covered).
6. UI: страница Jobs (server) + JobsTable/Filters (client), CSS Modules, тёмная тема.
   createDbFromEnv() в core: DATABASE_URL || dev-default (локальный compose).
7. E2E: seed-fixtures в корневом скрипте e2e; spec: строки/фильтр/apply-persist/attrs;
   новый baseline + инверсия; CI: DATABASE_URL на Pipeline-стадии.
8. STACK 1.3 (без новых deps — перенос зафиксирован), отчёт, пуш, CI.
