# S1a Report — Jobs Explorer

Инкремент: S1a (M1) · Ветка: feat/S1a-jobs-explorer · Дата: 2026-09-16
Спека: specs/S1a-jobs-explorer.md (G1: вариант A подтверждён, kanban → BACKLOG B-003)

## DoD / Acceptance criteria

| AC | Проверка | Статус |
|---|---|---|
| 1 | `GET /api/jobs` + listJobs: source/days/salaryMin (strict: null-зарплаты отсекаются), sort posted/salary, limit≤200 | ✅ |
| 2 | `markAppliedManually` идемпотентен (UNIQUE(job_id,status,channel) + ON CONFLICT DO NOTHING; интеграционный тест двойным вызовом) | ✅ |
| 3 | Таблица рендерит поля; title-ссылка `target=_blank rel="noopener noreferrer"` (e2e); Applied сохраняется после reload (e2e) | ✅ |
| 4 | Фильтры/сортировка через URL (server-side, e2e: source=adzuna сужает список) | ✅ |
| 5 | Visual: новый baseline s1a-jobs.png (LFS); до(scaffold)/после(jobs) — осознанная замена (s0-тест удалён вместе со scaffold-страницей); инверсия: кнопка #2f81f7→#ff5500 → exit 1 (3660 px, ratio 0.01), откат → exit 0 | ✅ |
| 6 | arch-lint чист после переноса db в core; все turbo-задачи зелёные | ✅ |
| 7 | `pnpm pipeline:check` зелёный; CI — см. ниже | ✅ |

## Тесты (цифры)

- Unit: 39 passed (S1: 35 + worker env-loader 4 — без изменений).
- Integration: **9 passed** (repository 6 новых: сортировка default/salary, фильтры
  source/salary/days, applied-идемпотентность, limit; ingest 3).
- E2E: **7 passed** (рендер, ссылка-атрибуты, фильтр, applied-persist, **PATCH API-контракт**, empty-state, visual) — финальный прогон на чистой БД (volume пересоздан).
- RED→GREEN: repository-сьют закоммичен красным (6 падений на отсутствии модуля).

## Метрики

- Первая продуктовая метрика воронки: `applied_manual` пишется и читается (e2e-persist).
- Dev-загрузка / и страницы: рендер 55 вакансий < 100 мс локально (визуально, точные
  числа — в S10-метрики).

## Bugfixes / регресс-кейсы (PROCESS.md §9)

| Баг | Регресс-защита |
|---|---|
| **API-роуты в `src/app` молча игнорировались** (страницы в `app/`; Next выбирает один корень) → PATCH получал HTML-404. Локально маскировалось готовым applied-состоянием БД | роуты перенесены в `app/api`; новый e2e-тест бьёт в PATCH напрямую и проверяет JSON-контракт (ловит и пустые 404-страницы) |
| Подписи кнопок совпадали в обоих состояниях («✓ Applied» как action и как state) — маскировало сбой в yaml-диагностике | разведены: действие «Mark applied», состояние «✓ Applied»; тест по role+name |
| Turbopack не резолвит NodeNext `.js`-суффиксы в TS-импортах | проект переведён на moduleResolution=bundler (tsconfig.base), фиксация в STACK 1.3 |
| CSS Modules: глобальные селекторы (table/th/td) — «not pure» | все селекторы скоупы под .table (фиксация паттерна) |
| Salary-фильтр пропускал null-зарплаты → empty-state недостижим | strict-семантика фильтра + e2e-тест empty-state |
| e2e ловил STALE .next (next start без rebuild после правок) | chain e2e/update-snapshots всегда `pnpm run build` первым; локальные прогоны — через корневые скрипты |
| appliedManually: number(id) сравнивался с true | интеграционный тест ловит (false-positive устранил) |
| Integration-файлы гоняли одну БД параллельно | fileParallelism:false + детерминированная сортировка (tie-break canonical_hash) |

bugfixes: 8, regression cases: 8 — совпадают. Оба CI-only бага пойманы свежим CI-прогоном
(логично: локальная БД «помнила» прошлые состояния) — кейс за машинные гейты: e2e на чистой среде.

## Security-аудит (G5)

- Секретов в git нет; DATABASE_URL в CI — публичные dev-креды service-контейнера.
- PATCH-роут: uuid-валидация входа (zod), 400/404; SQL — параметризованный kysely.
- SSRF/инъекций нет: внешние URL рендерятся как ссылки (noopener/noreferrer),
  не запрашиваются сервером.
- Критических находок: 0.

## Отклонения от спеки

1. Visual-гейт для data-таблицы реализован как **masked layout gate** (текстовые
   зоны замаскированы; корректность данных — DOM-ассертами). Причина —
   кросс-платформенная растеризация шрифтов (S0-урок); в S7 (дизайн-система)
   подход пересматривается вместе с superdesign-проходом.

## Известные риски / на контроле

- Job Bank Atom-фид: до ~10 записей за опрос (см. S1-report).
- Фильтр «давность» по posted_at; у части adzuna-записей postedAt может быть null —
  показываются при любом фильтре дат (null не отсекается days-фильтром — осознанное
  «не прятать неизвестное»).

## Вердикт

Все AC закрыты; экран Jobs жив на http://localhost:3000 (dev: `pnpm --filter @chinook/web run dev`).
Готов к **G6 (approve PO)**; после — merge в main, следующий инкремент M1: **S2
(Rule matcher — фильтры NOC 21231/21234 и Alberta из master_profile)**.
