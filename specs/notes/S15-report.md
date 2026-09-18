# S15 Report — Контейнеризация планировщика

Инкремент: S15 (M1.5, не-AI трек) · Ветка: feat/S15-scheduler-container · Дата: 2026-09-18
Спека: specs/S15-scheduler-container.md (G1: node:26-alpine, unless-stopped, docker-build в CI)

## DoD / Acceptance criteria

| AC | Проверка | Статус |
|---|---|---|
| 1 | `docker compose up -d --build` → postgres+scheduler Up; `docker kill` → контейнер поднят заново restart-политикой | ✅ живьём |
| 2 | Контейнерный тик пишет в общую БД: лог `[03:21] run: jobbank → ok: fetched=9 unique=6 buckets={excluded:6}`; хостовой `schedule:status` видит те же last-run | ✅ |
| 3 | `docker compose stop` → лог `signal SIGTERM: finishing…`, **ExitCode=0** (после фикса сигнальной цепочки — см. bugfix), `start` снова Up | ✅ |
| 4 | Аудит образа: `env \| grep -cE 'ADZUNA\|DATABASE_URL'` → **0**; `/app/data` — отсутствует; `/app/.env` — отсутствует | ✅ |
| 5 | CI: docker build гейт — первый прогон зелёный (run 3b9975c) | ✅ |
| 6 | Все гейты зелёные (typecheck/test/pipeline; integration 19/19; e2e 15/15); arch-lint чист | ✅ |

## Живые артефакты

- Образ `canada_job_search-scheduler` (node:26-alpine, pnpm@11.21.0 pinned).
- `docker compose logs -f scheduler` — тики каждые 60 c, инжест по расписанию 30м/2ч.
- Первый контейнерный инжест: 2026-09-18T03:21Z (jobbank 9→6, все excluded — фид
  отдаёт всю Канаду; AB-вакансии несёт Adzuna-источник, см. S2-report).

## Bugfixes / регресс-кейсы (PROCESS.md §9)

| Баг | Регресс-защита |
|---|---|
| **corepack выпилен из Node 26** — `corepack enable` в образе падал (127) | `npm i -g pnpm@11.21.0` с пином = packageManager (фиксация в STACK 1.6) |
| **pnpm не пробрасывает SIGTERM** → docker stop давал exit 143, graceful-код не выполнялся | CMD = прямой `node --import tsx src/scheduler.ts` (pnpm исключён из сигнальной цепочки; tini остаётся PID1 через compose `init: true`); проверка ExitCode=0 в чек-листе |
| **Живой контейнерный планировщик гонял локальные e2e** (тик вставлял jobbank-строки между seed и ассертами → bar-widths тест падал) | e2e изолирован в `chinook_e2e` (seed-скрипт + playwright webServer env), integration — в `chinook_test` (vitest setupFiles); прод-БД `chinook` теперь доступна только рантайму |
| seed-скрипт в scripts/ не резолвил deps (pg, ts-импорт) | перенесён в apps/worker (tsx + pg рядом), скрипты перекошены на worker |

| e2e-URL жёстко на 5433 → ECONNREFUSED в CI (service на 5432) | URL chinook_e2e/производные вычисляются из DATABASE_URL окружения (CI/локальность агностик) |

bugfixes: 5, защит: 5 — совпадают. Урок процесса: правки кода через node -e со строками-регексами дважды портят эскейпы — только Edit-инструментом.

## Security-аудит (G5)

- Секреты: только через compose environment (из хостового .env); в образе — ноль
  (аудит AC4); .dockerignore исключает `.env*` и `data/` (PII).
- Образ не пушится никуда (локальный билд + CI-сборка для гейта).
- Критических находок: 0.

## Отклонения от спеки

1. CMD идёт напрямую через node (вместо pnpm-цепочки) — причина в сигналах (bugfix 2);
   WORKDIR перемещён в apps/worker. Семантика спеки сохранена.
2. Добавлена изоляция e2e/integration БД (не была в спеке) — прямое следствие
   появления постоянно живого планировщика (гонка, поймана локально).

## Известные риски / на контроле

- В CI e2e/integration работают на service-БД `chinook` (планировщика в CI нет —
  гонка невозможна); локальные прогоны — на изолированных базах.
- Образ не пинится по digest (облачный деплой введёт).

## Вердикт

B-005 закрыт: сбор вакансий идёт сам при поднятом Docker Desktop, переживает
ребуты и SIGTERM корректно; e2e/integration больше не делят БД с прод-рантаймом.
Готов к **G6 (approve PO)**.
