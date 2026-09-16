# S1a: Jobs Explorer — список вакансий с откликом по прямой ссылке

Статус: accepted (G1 2026-09-16: вариант A подтверждён; kanban — в бэклог) · Версия: 1.0 · Milestone: **M1**
Источник: BACKLOG.md **B-001** (accepted, PO 2026-09-16) · зависит от S1 (done).

## Проблема и цель

Вакансии уже собираются в Postgres (S1), но их не видно и нельзя быстро откликнуться
руками, пока строится автоматизация. Цель: read-only экран со списком вакансий,
фильтрами и **прямой ссылкой «Apply externally»** на оригинал; отметка ручного
отклика попадает в БД, чтобы воронка-метрики не теряла ручные отклики.

## Входные артефакты / зависимости

- S1: таблица `job` с данными (55 вакансий live), контракты `Job` (zod).
- S0: визуальный гейт (снапшоты, LFS), e2e-инфраструктура.

## Решение (альтернативы из brainstorm, выбор + отказ)

### R1. Доступ web-приложения к данным: репозиторий переносится в packages/core
- **(a) Перенести db-слой (kysely: схема/репозиторий) из apps/worker в packages/core**
  — ✅: arch-rules разрешают app→core; worker продолжает импортировать core;
  домен + персистентность в одном месте, никакого дублирования клиентов.
- (b) web вызывает worker по HTTP — worker не имеет сервера; ради одного экрана
  поднимать RPC-слой — overkill (ст. 9).
- (c) Тонкий pg-клиент прямо в apps/web — дублирование схемы/типов между
  приложениями, рассинхрон миграций неизбежен. Отклонено.
- Следствие: `apps/worker/src/db.ts` → `packages/core/src/db/`; core получает
  deps kysely+pg (STACK 1.3); arch-правила не меняются (core→только contracts ✓).

### R2. Отметка ручного отклика: таблица `application` сразу
- **(a) Создать `application` (job_id, status, channel, created_at) и писать
  `status='applied_manual', channel='external_link'`** — ✅: соответствует
  DESIGN §3.2 (таблица application существовала в модели с самого начала),
  воронка получает данные, S7 потом читает её для Inbox.
- (b) Колонка `applied_manually_at` на job — теряет историю/канал, конфликтует
  с моделью application. Отклонено.
- event_log (полный append-only аудит) остаётся за S7 — фиксируется как
  осознанная отсрочка (в S1a пишем только application).

### R3. Дизайн экрана: плотная таблица с акцентной ссылкой (вариант A)
Brainstorm дал три варианта (PO выбирает на G1):
- **A (рекомендован): Data-table** — плотная таблица, колонки: вакансия-ссылка,
  работодатель, локация, источник (badge), зарплата, дата; действия справа:
  «Apply ↗» и «✓ Applied». Максимум данных на экран, минимум скролла,Scalable
  до score-колонки S4. Тёмная тема (продолжение scaffold-бренда Chinook,
  фон #0d1b2a).
- B: Card-list — крупные карточки, воздух, красиво для демо, но в 2-3 раза
  меньше плотность информации; для «просмотреть 50 вакансий и выбрать» хуже.
- C: Kanban по статусам — преждевременный: статусов отклика ещё нет (S7).
Выбор A — data-table, single-column layout, sticky-фильтрбар сверху.

### R4. Фильтры и сортировка (минимум для пользы)
Фильтры: источник (all/jobbank/adzuna), давность (7/30/все дни), зарплата от (CAD/год);
сортировка: posted_at DESC (default) / salary DESC. Всё — query-параметры,
серверная фильтрация (данных мало, но паттерн сразу правильный).

### R5. Стек экрана
Next.js App Router server component для списка + маленький client component
для действий (Apply-кнопка состояние, фильтры → URL). Никакого отдельного
CSS-фреймворка: CSS Modules + дизайн-токены (S7 решит глобально с superdesign).

## Контракт

### API (apps/web/app/api)
- `GET /api/jobs?source=&days=&salaryMin=&sort=posted|salary&limit=50`
  → `{ jobs: Job[]; total: number }` (Job из contracts; urls[0] = primary).
- `PATCH /api/jobs/:id/applied-manually` → создаёт/идемпотентно возвращает
  `{ applicationId, status: 'applied_manual' }`.

### core/repository (новое в packages/core/src/db)
- `listJobs(db, filters): Promise<Job[]>` (map row→Job);
- `markAppliedManually(db, jobId): Promise<ApplicationRow>`;
- миграция `application` (CREATE TABLE IF NOT EXISTS в SCHEMA_SQL v2).

### UI (apps/web/app/page.tsx — заменяет scaffold)
Экран «Jobs» (вариант A): фильтрбар → таблица → строка: title (ссылка
`target=_blank rel="noopener noreferrer"`), employer, location, source-badge,
salary (год CAD, «—» если null), posted (YYYY-MM-DD), [Apply ↗][✓ Applied].
Empty-state: «Нет вакансий под фильтры — запусти ingest».

## Acceptance criteria

1. `GET /api/jobs` отдаёт вакансии из БД с фильтрами source/days/salaryMin и
   сортировкой; пустые фильтры = все; лимит 50.
2. `PATCH /api/jobs/:id/applied-manually` идемпотентен: второй вызов не создаёт
   дубль в `application`.
3. Таблица рендерит все поля; ссылка открывается в новой вкладке с noopener;
   после «✓ Applied» кнопка переходит в состояние applied (persist после reload).
4. Фильтры и сортировка работают через URL (обновление — навигацией).
5. Visual: новый baseline экрана Jobs закоммичен в LFS; дифф «до(scaffold)→после»
   осознан (первая итерация — baseline заменяется), инверсия-доказательство
   гейта повторяется (правка верстки → падение).
6. arch-lint чист после переноса db в core; turbo-задачи зелёные.
7. `pnpm pipeline:check` зелёный; CI зелёный (postgres-service уже в workflow).

## Тест-план

- **Unit (core):** listJobs-фильтры (fixture-строки), markAppliedManually
  идемпотентность — против postgres (integration-конфиг tests).
- **Integration (tests/):** API-хендлеры через next-подобный вызов? — нет:
  хендлеры тонкие, покрываются e2e; integration = repository-слой.
- **E2E (playwright):** страницу с посеянной БД (fixtures-seed перед прогоном):
  рендер N строк, фильтр по source сужает список, Apply-клик помечает строку
  (persist после reload), ссылка имеет правильные атрибуты.
  Снапшот до/после + инверсия.
- e2e-гейт против реального UI: БД для e2e = локальный postgres с seed-скриптом
  (`pnpm --filter @chinook/worker run ingest --fixtures`), в CI уже есть
  postgres-service — e2e-стадия CI дополняется seed-шагом.

## Метрики

- Время загрузки /api/jobs (dev-сервер, 55 строк) — baseline в отчёт.
- Доля applied_manual (первая продуктовая метрика воронки!) — считается запросом
  в отчёте S1a.

## DoD (копируется в отчёт)

- [ ] AC 1–7 зелёные; RED→GREEN коммиты
- [ ] Перенос db в core без нарушения arch-границ
- [ ] Новый visual baseline + инверсия-доказательство
- [ ] STACK.md 1.3 (css-подход не добавляет зависимостей; фиксация переноса)
- [ ] Отчёт specs/notes/S1a-report.md (тесты цифрами, метрики, security)
- [ ] CI зелёный

## Открытые вопросы (к PO, вместе с G1)

1. **Дизайн-вариант A (таблица, тёмная тема)** — подтверждаем? (B-карточки и
   C-канбан отклонены по причинам выше.)
2. Фильтр «давность» кнопками 7/30/все — ок как стартовый набор?
3. Зарплату показываем годовой CAD (hourly уже пересчитаны ×2080) — с суффиксом
   «/yr», ок?
