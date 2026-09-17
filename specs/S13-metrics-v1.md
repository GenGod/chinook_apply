# S13: Metrics v1 — воронка и здоровье источников на одном экране

Статус: done (CI success, ожидает G6) · Версия: 1.0 · Milestone: **M1.5** (не-AI трек)
Реестр: добавляется в DESIGN §6.1 · ранний поднабор S10 (full-версия остаётся в M4).
Выбор направления: автономный (PO «продолжай»); SMTP для email-отклика ещё не создан —
этот инкремент не требует ничего от PO.

## Проблема и цель

Данные о потоке уже копятся (job/ingest_run/application), но смотреть их можно только
SQL-ом. Цель: страница `/metrics` — воронка (поток → корзины правил → ручные отклики),
здоровье источников (возраст/интервал/серия неудач, fetched/unique/merged последнего
прогона) и история инжестов. Всё из существующих таблиц, ноль новых зависимостей.

## Входные артефакты / зависимости

- Таблицы: `job` (rule_status), `ingest_run`, `application` (applied_manual).
- S1a-паттерны UI (server component, CSS Modules, тёмная тема, masked-visual-gate).

## Решение (альтернативы из brainstorm, выбор + отказ)

### R1. Источник агрегатов: функции-репозитории в core
- **(a) `packages/core/src/metrics.ts`: `getMetrics(db): MetricsSummary` — один запрос-набор,
  юнит/integration-тестируемый, используется и страницей, и API** — ✅.
- (b) SQL-вьюхи в миграции — логика уезжает в DDL, тестировать неудобно, версионировать
  сложнее. (c) Прямые запросы в компоненте страницы — нет переиспользования для API/S10.

### R2. Визуализация: CSS-бары без chart-библиотек
- **(a) Проценты/бары чистым CSS (div с width)%** — ✅: стек заморожен; для 3-5 чисел
  chart-либа избыточна; маск-дисциплина visual-гейта сохраняется.
- (b) recharts/chart.js — новые зависимости ради красоты двух баров; отложено до S10 full.

### R3. Состав метрик v1
- **Воронка:** total jobs → relevant / review / excluded (числа + % бары) → applied_manual
  (число + конверсия relevant→applied).
- **Источники:** по каждому — last run (ts, age), interval из дефолтов планировщика,
  failures_in_a_row, последний fetched/unique/merged (средние за последние 5 прогонов —
  устойчивее одиночного).
- **История:** последние 10 ingest_run (ts, source, fetched→unique, error short).
- Дедуп-ratio считается из history (1 − unique/fetched среднее).

### R4. Навигация
Ссылка «Metrics →» в header-строке Jobs-страницы и «← Jobs» на /metrics.
Header Jobs-страницы целиком замаскирован в visual-гейте → добавление ссылки
внутри маски не меняет baseline (бокс фиксирован), отдельный e2e-тест перехода.

### R5. API
`GET /api/metrics` → тот же `MetricsSummary` JSON (контракт для будущего S10/уведомлений).

## Контракт

```ts
// packages/core/src/metrics.ts
export interface SourceHealth {
  source: string; lastRunAt: string | null; intervalMin: number;
  failuresInRow: number; avgFetched: number; avgUnique: number; dedupRatio: number | null;
}
export interface MetricsSummary {
  funnel: { total: number; relevant: number; review: number; excluded: number; appliedManual: number };
  sources: SourceHealth[];
  history: Array<{ id: number; startedAt: string; source: string; fetched: number; uniqueJobs: number; error: string | null }>;
}
export async function getMetrics(db: Kysely<Database>): Promise<MetricsSummary>;
```
UI: `apps/web/app/metrics/page.tsx` + `metrics.module.css` (тёмная тема, fixed-box
дисциплина для масок: числа и подписи в фиксированных боксах, бары — width%).

## Acceptance criteria

1. `getMetrics` корректен на посеянной БД (integration: известные counts из fixtures
   + ручные application-строки → точные значения funnel).
2. `GET /api/metrics` отдаёт контракт (e2e: поля присутствуют, funnel.total > 0).
3. Страница /metrics рендерит воронку, здоровье и историю; числа совпадают с API
   (e2e сверяет DOM против /api/metrics).
4. Навигация Jobs ↔ Metrics работает (e2e-клики).
5. Visual: baseline /metrics закоммичен (маски чисел/текстов, fixed-box); инверсия
   (ширина бара → падение → откат). Baseline Jobs-страницы НЕ меняется (ссылка внутри
   маскированного header-бокса) — проверяется прогоном.
6. Все гейты зелёные, arch-lint чист, CI success.

## Тест-план

- **Integration (tests/integration/metrics.test.ts):** funnel counts, source health
  (avg по 5 прогонам, dedup-ratio), history limit 10 — на управляемом сидe.
- **E2E:** metrics-страница против fixtures-seed (детерминированные counts), сверка с
  API, навигация, visual + инверсия.
- Unit не требуется (агрегация = SQL в одной функции, покрыта integration).

## Метрики (inception)
Время загрузки /metrics на dev-сервере — baseline в отчёт.

## DoD (копируется в отчёт)

- [ ] AC 1–6; RED→GREEN коммиты
- [ ] STACK.md 1.5 (без новых зависимостей — фиксация CSS-бар подхода)
- [ ] Отчёт S13-report.md; CI зелёный
- [ ] BACKLOG: пометка, что S10-full наследует getMetrics

## Открытые вопросы (к PO, вместе с G1)

1. Среднее по последним 5 прогонам для health-цифр — ок? (одиночный последний прогон
   шумит: фид отдаёт разное число записей)
2. История — 10 последних строк, ок?
3. Дашборд без авто-refresh (обновление по F5) — ок для v1?
