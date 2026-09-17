# S12: Scheduled ingest — автоматический сбор по расписанию

Статус: **draft** (ждёт G1 approve PO) · Версия: 1.0 · Milestone: **M1-close** (post AI-park)
Реестр: добавляется в DESIGN §6.1 · зависит от S2 (done). Замещает отложенный «BullMQ в S5»
для текущей фазы (см. S1 R3).

## Проблема и цель

Сейчас инжест — ручная CLI-команда. Цель: long-running процесс-планировщик, который сам
опрашивает источники по расписанию с джиттером и защитой от наложения прогонов, пишет всё
в `ingest_run` (уже делает). M1 закрывается полностью: «вакансии текут в базу сами,
сужаются под профиль, видны на экране» — без участия человека.

## Входные артефакты / зависимости

- S2: `runIngest` (live-режим, правила, корзины), `ingest_run`.
- Postgres advisory locks (встроено, без нового софта).

## Решение (альтернативы из brainstorm, выбор + отказ)

### R1. Механизм планировщика: собственный цикл + pg advisory lock
- **(a) Long-running процесс (`apps/worker/src/scheduler.ts`): setInterval-цикл на
  тик 1 мин, внутри — расчёт «кому пора» по source-расписаниям с джиттером;
  `pg_try_advisory_lock` на время прогона** — ✅: ноль новых зависимостей при
  замороженном стеке; для one-user-системы достаточно; jitter и crawl-delay — первые
  классы.
- (b) BullMQ + Redis — оживление целой инфраструктуры ради одного крона;
  остаётся запаркованным до появления реальных очередей (эпоха S5, если AI вернётся).
- (c) node-cron — зависимость ради синтаксиса расписаний, которые нам нужны
  в виде «каждые N минут ± джиттер». Отклонено.

### R2. Расписания по источникам (env-переопределяемые)
- jobbank (Atom, 1 запрос/тик): каждые **30 мин**;
- adzuna: каждые **2 ч** (щадим бесплатную квоту ~500/сутки);
- джиттер ±20% на каждый интервал (не быть метрономным ботом);
- env: `SCHED_JOBBANK_MIN=30`, `SCHED_ADZUNA_MIN=120`.

### R3. Защита от наложения и повторного входа
- `pg_try_advisory_lock('chinook:ingest')`: тик, не взявший лок, пишет skip в лог
  и уходит; лок снимается в finally (и при аварийном дисконнекте — сессией pg).
- Один и тот же процесс не запускает два инжеста (in-flight флаг).

### R4. Отказоустойчивость источника
- Ошибка одного источника не роняет тик (в runIngest уже изолировано по feeds);
- счётчик последовательных неудач по источнику → в статус-вывод строка-предупреждение
  (`source degraded, N consecutive failures`);
- глобально невалидный тик (нет БД) — backoff процесса 5 мин + сообщение.

### R5. Наблюдаемость и управление
- Каждый тик: stdout-строка `[ts] source due/ok/skip/error (N jobs, buckets…)`.
- `pnpm --filter @chinook/worker schedule:status` — сводка: last run per source
  (из ingest_run), возраст, consecutive failures.
- `pnpm --filter @chinook/worker schedule:once --source=jobbank` — ручной прогон
  вне расписания (те же локи/логика).
- Graceful shutdown: SIGINT/SIGTERM — дозавершить текущий инжест (или прервать
  между источниками), снять лок, выйти 0.

### R6. Запуск: локальный процесс (контейнеризация — следующий шаг)
- Сейчас: `pnpm --filter @chinook/worker schedule` (терминал/фоновый процесс PO).
- Dockerfile + compose-сервис `scheduler` — **B-005** (backlog): потребует пайплайн
  docker-build; не смешиваем в один инкремент.

## Контракт

```ts
// packages/core/src/schedule.ts (чистая логика, тестируемая)
export interface SourceSchedule { source: JobSourceId; intervalMin: number; jitterRatio: number }
export function planSources(now: Date, schedules: SourceSchedule[],
                            lastRunPerSource: Record<string, Date>): SourceSchedule[]; // кому пора
export function nextDue(base: Date, s: SourceSchedule): Date;  // base + interval ± jitter

// apps/worker/src/scheduler.ts (I/O-обёртка)
export function startScheduler(opts: { db; intervalMs?; onTick? }): { stop(): Promise<void> }
// advisory lock: SELECT pg_try_advisory_lock(hashtext('chinook:ingest'))
```
Миграций нет (ingest_run достаточно; расширим later при S10).

## Acceptance criteria

1. `planSources`/`nextDue` — таблица кейсов: пора/не пора/джиттер в границах ±20%/
   первый запуск (нет истории) → пора.
2. Advisory lock: два конкурирующих тика — второй пишет skip и не дергает ingest
   (integration: параллельный запуск двух runOnce — ровно один выполнен).
3. Ошибка источника изолирована: feed с error не роняет тик (unit на моке runIngest).
4. Graceful shutdown: SIGTERM во время инжеста — процесс завершает текущий источник,
   снимает лок, exit 0 (integration по сигналу).
5. `schedule:status` корректно читает ingest_run (последние прогоны, возраст).
6. Живой прогон `schedule:once --source=jobbank` — вакансии в БД обновились,
   ingest_run записан (фиксация в отчёте).
7. Все гейты зелёные; arch-lint чист.

## Тест-план

- **Unit (core, TDD):** planSources/nextDue — детерминированные кейсы + property
  (джиттер в границах, monotonic next).
- **Integration (tests/):** advisory lock (конкуренция), shutdown-сигнал,
  schedule:status против реальной БД с посеянными ingest_run.
- **E2E/visual:** страница не меняется — прогон подтверждает отсутствие диффа.

## Метрики

- Возраст последнего успешного прогона по источникам после часа жизни планировщика.
- Тики/пропуски/ошибки за сессию — в отчёт.

## DoD (копируется в отчёт)

- [ ] AC 1–7; RED→GREEN коммиты
- [ ] Расписания env-переопределяемы, дефолты в STACK.md 1.4 (без новых зависимостей)
- [ ] Отчёт S12-report.md; CI зелёный
- [ ] B-005 (контейнеризация планировщика) заведён в backlog

## Открытые вопросы (к PO, вместе с G1)

1. Интервалы по умолчанию: jobbank 30 мин, adzuna 2 ч — ок? (Adzuna free-квоту
   бережём; при желании можно реже/чаще через env без правок кода.)
2. Джиттер ±20% — ок?
3. Пока без контейнеризации (локальный процесс; B-005 потом) — подтверждаем порядок?
