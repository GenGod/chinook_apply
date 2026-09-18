# S15: Контейнеризация планировщика — сбор идёт сам при поднятом Docker

Статус: done (CI success, ожидает G6) · Версия: 1.0 · Milestone: **M1.5** (не-AI трек)
Источник: BACKLOG **B-005** · зависит от S12 (scheduler), S1 (compose/postgres).

## Проблема и цель

Планировщик (S12) — локальный процесс в терминале: закрыл терминал/перезагрузил
машину — сбор встал до ручного перезапуска. Цель: compose-сервис `scheduler`,
который поднимается вместе с postgres при `docker compose up -d` и переживает
рестарты машины (`restart: unless-stopped`). Плюс docker-build гейт в CI, чтобы
Dockerfile не гнил молча.

## Входные артефакты / зависимости

- S12: `apps/worker/src/scheduler.ts` (schedule/status/once; graceful SIGTERM).
- docker-compose.yml (postgres), Docker Desktop на машине PO (есть).

## Решение (альтернативы из brainstorm, выбор + отказ)

### R1. Образ: одношаговый Dockerfile с полным workspace-инсталлом
- **(a) `FROM node:26-alpine` + corepack/pnpm + `pnpm install --frozen-lockfile`
  (полный) + копия исходников + CMD `tsx src/scheduler.ts`** — ✅: проект мал,
  образ ~300 МБ приемлем для локального single-user; один источник правды
  (тот же lockfile, что и в CI); никакого отдельного build-стейджа, который
  разъедется с реальностью.
- (b) Multi-stage + `pnpm deploy --prod` — минус ~150 МБ ради локальной машины PO;
  усложнение (tsx — devDep, пришлось бы переносить в dependencies и тащить весь
  TS в рантайм всё равно). Отложено до облачного деплоя.
- tsx переносится из devDependencies в **dependencies** worker'а — он и есть
  рантайм планировщика; фиксация в STACK 1.6.

### R2. Compose-сервис `scheduler`
- `depends_on: postgres (condition: service_healthy)`; `restart: unless-stopped`;
- env: `DATABASE_URL=postgres://chinook:chinook_dev@postgres:5432/chinook`
  (**service-name сеть**, не localhost!), `ADZUNA_APP_ID/KEY` — проброс из `.env`
  через `${VAR}` (compose подставляет хостовые env/.env — секреты остаются вне
  образа и вне git);
- `SCHED_JOBBANK_MIN/SCHED_ADZUNA_MIN` — опционально с дефолтами образа.

### R3. CI-гейт: docker build
- Отдельный шаг `docker build` после pipeline (гейт «образ собирается»);
  рантайм-смоук в CI не гоняем (postgres там — service-контейнер вне docker-сети
  job'а; полный compose-smoke — локальная проверка в отчёте).

### R4. Разделение источников env
Внутри контейнера НЕ работает корневой `.env`-лоадер (он читает путь хоста);
креды приходят только через environment compose. Секреты в образ не попадают
(проверка: `docker run --rm image env | grep -c ADZUNA` → 0 — в отчёт).

## Контракт

```dockerfile
# apps/worker/Dockerfile (build context = корень репо)
FROM node:26-alpine
WORKDIR /app
RUN corepack enable
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY packages/contracts/package.json packages/contracts/
... (все workspace-манифесты)
RUN pnpm install --frozen-lockfile
COPY . .
CMD ["pnpm", "--filter", "@chinook/worker", "exec", "tsx", "src/scheduler.ts"]
```
+ `.dockerignore` (node_modules, .next, .git, data, tests/test-results, .env).
+ compose: сервис `scheduler` по R2; healthcheck не нужен (restart-политика +
логи `docker compose logs -f scheduler`).

## Acceptance criteria

1. `docker compose up -d --build` поднимает postgres+scheduler; контейнер жив
   (Up, рестартует при падении — проверка kill+restart в отчёте).
2. Планировщик в контейнере подключается к postgres по внутренней сети и пишет
   ingest_run (первый тик в логах; `schedule:status` на хосте показывает свежие
   last-run — та же БД через проброшенный 5433).
3. `docker stop` → graceful (лог «signal SIGTERM: finishing…», exit 0).
4. В образе нет секретов (env-проверка из R4) и нет `data/` (PII вне образа).
5. CI: docker build зелёный (гейт R3).
6. Все прежние гейты зелёные; arch-lint чист.

## Тест-план

- **CI:** docker build (гейт).
- **Локально (в отчёт, чек-лист AC1–4):** up --build, логи первого тика,
  ingest_run-строки, kill-рестарт, docker stop exit-код, env-аудит образа.
- Unit/integration: без изменений (код планировщика не меняется).

## Метрики
Время docker build (кэшированный/холодный) — baseline в отчёт.

## DoD (копируется в отчёт)

- [ ] AC 1–6; STACK 1.6 (node:26-alpine, tsx→dependencies, docker-подход)
- [ ] Отчёт S15-report.md; CI зелёный; B-005 → done

## Открытые вопросы (к PO, вместе с G1)

1. Пин базового образа `node:26-alpine` (мажор, без digest-пина) — ок для локального
   этапа? (digest-пин — при облачном деплое)
2. `restart: unless-stopped` — ок? (альтернатива `always` — стартует и после
   `docker stop` при перезагрузке демона; рекомендую unless-stopped — уважает
   ручной stop)
3. CI-шаг docker build добавляет ~1–2 мин к прогону — ок?
