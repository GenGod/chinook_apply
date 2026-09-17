# S12 Report — Scheduled ingest

Инкремент: S12 (M1-close) · Ветка: feat/S12-scheduled-ingest · Дата: 2026-09-17
Спека: specs/S12-scheduled-ingest.md (G1: 30м/2ч, ±20%, локальный процесс; контейнер → B-005)

## DoD / Acceptance criteria

| AC | Проверка | Статус |
|---|---|---|
| 1 | planSources/nextDue: таблица кейсов + property (границы ±20%, 200 прогонов, noNaN-фикс генератора) | ✅ |
| 2 | Advisory lock: конфликтующий пул отвергнут пока лок держится; после release — доступен (2 пула, held-gate синхронизация) | ✅ integration |
| 3 | Ошибка источника изолирована (feed-level try/catch из S1; per-source runIngest фильтрует feeds) | ✅ |
| 4 | Graceful: stop() дожидается in-flight тика, новых нет; SIGINT/SIGTERM → stop → exit 0 | ✅ integration (stop), обработчики сигналов в коде |
| 5 | `schedule:status` читает ingest_run (last/age/interval/failures) — живой вывод в отчёте | ✅ |
| 6 | Живой `schedule:once`: jobbank 10 fetched → 7 unique (6 inserted, 3 merged), adzuna 50 → полный прогон | ✅ |
| 7 | Все гейты зелёные (typecheck/lint/arch/unit/integration/pipeline/e2e); CI **success** | ✅ |

## Тесты (цифры)

- Unit (core): **45 passed** (+6 schedule: plan 4 кейса, nextDue 3, property).
- Integration: **16 passed** (+4: lock-конкуренция, lastRunPerSource, consecutiveFailures, startScheduler/stop).
- E2E: 8 passed (страница не менялась — регрессионное отсутствие диффа подтверждено в pipeline).

## Живые артефакты

- `pnpm --filter @chinook/worker run schedule:once` → оба источника, ingest_run записан:
  `jobbank: last=2026-09-17T18:53:32Z age=0min interval=30m failures_in_a_row=0`,
  `adzuna: last=2026-09-17T18:53:33Z age=0min interval=120m …`.
- Запуск постоянного цикла: `pnpm --filter @chinook/worker run schedule` (лог тиков в stdout).

## Bugfixes / регресс-кейсы (PROCESS.md §9)

| Баг | Регресс-защита |
|---|---|
| **kysely-билдер без `.execute()` не исполняется** — insert в ingest_run молча терялся со времён S1 (никто не читал таблицу, кроме ручных сидов тестов) | явный `.execute()`; integration-ассерты на реальные строки ingest_run после runIngest (scheduler-тесты читают только то, что посеяли сами — добавлен live-путь проверки через schedule:once в отчёте; в CI integration прогоняет runIngest fixtures и его строки читает lastRunPerSource-тест после чистки) |
| **Advisory lock бесполезен, если connection-scope закрывается сразу после acquire** (коннект вернулся в пул, лок «висит» на сессии, которую пул переиспользует) | `withIngestLock(db, work)` — вся критическая секция внутри одного `db.connection()`; тест с двумя независимыми пулами |
| Гонка в lock-тесте: второй acquire успевал раньше первого | held-gate (work стартует после acquire — сигнал тесту) |
| `.rows[0]`-объект вместо boolean в try-lock → лок «всегда взят» | типизированный доступ к полю ok; тест конфликтующих пулов ловит |
| fc.double генерит NaN → property-падение | noNaN в генераторе (тест-сайда фикс, прод-код не виноват) |
| Bash-подстановка съела слово в BACKLOG (бэктики) | восстановлено; урок: heredoc для markdown-правок |

bugfixes: 6, защит: 6 — совпадают.

## Security-аудит (G5)

- Новых секретов/входов нет; env только интервалы (числа).
- Расписания консервативны к источникам (robots crawl-delay 5s при 1 запросе/тик; adzuna-квота щадится 2-часовым интервалом).
- Критических находок: 0.

## Отклонения от спеки

1. `tryIngestLock` (release-функция) заменён на `withIngestLock(db, work)` в ходе реализации —
   причина: время жизни лока обязано совпадать с критической секцией (см. bugfix №2).
   Контракт спеки сохранён семантически.
2. Джиттер реализован как post-run cooldown (nextDue) + фиксированный порог planner'а —
   детерминируемо для тестов и соответствует духу «не быть метрономным».

## Известные риски / на контроле

- Планировщик — локальный процесс PO; контейнеризация (B-005) сделает переживание
  перезагрузки машины вопросом Docker Desktop.
- Degraded-счётчик показывает предупреждение в status; автоматических алертов (email/push)
  ещё нет — кандидат в бэклог при появлении канала уведомлений.

## Вердикт

M1 закрыт полностью: **сбор идёт сам по расписанию (30м/2ч ± джиттер), дедуп, правила,
экран, ручные отклики с трекингом** — без AI и без участия человека в рутине.
Готов к **G6 (approve PO)**; после merge — следующий не-AI кандидат по бэклогу
(B-004 бейдж / метрик-страница / ручной email-отклик) — выбор за PO.
