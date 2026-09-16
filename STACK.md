# STACK.md — зафиксированный стек Chinook

**Политика (PROCESS.md §8.1):** стек выбран максимально современным на дату старта (2026-09-16)
и заморожен. Изменение любой позиции — только по необходимости (security-fix, EOL, критичная
фича) и строго после ручного одобрения PO, с записью в changelog ниже. Lockfile (`pnpm-lock.yaml`)
— источник правды для точных версий.

## Runtime

| Позиция | Версия | Примечание |
|---|---|---|
| Node.js | 26 (26.7.0 локально) | engines: >=26; Node 26 получает LTS-статус в октябре 2026 |
| pnpm | 11.21.0 | packageManager pin |
| Менеджер задач | Turborepo 2.10.13 | кэш задач typecheck/test/build |

## Язык и качество

| Позиция | Версия | Примечание |
|---|---|---|
| TypeScript | 6.0.3 | максимум, поддерживаемый typescript-eslint (<6.1); TS 7 (native port) — кандидат на будущий upgrade после поддержки инструментами (needs PO approve) |
| ESLint | 10.10.0 | flat config |
| typescript-eslint | 8.70.0 | парсер TS для линта |
| @chinook/eslint-plugin-arch | workspace | собственный arch-lint (PROCESS.md §7) |
| Vitest | 5.0.0 | unit + integration |
| @playwright/test | 1.63.0 | e2e + визуальные снапшоты (git-lfs) |
| husky | 9.1.7 | pre-push → pipeline:quick |

## Приложение (S0-каркас)

| Позиция | Версия | Примечание |
|---|---|---|
| Next.js | 16.3.5 | apps/web |
| React | 19.3.0 | |
| react-dom | 19.3.0 | |

## CI (GitHub Actions)

| Позиция | Версия | Примечание |
|---|---|---|
| actions/checkout | v7 | lfs: true |
| actions/setup-node | v7 | node 26, кэш pnpm |
| actions/upload-artifact | v7 | test-results (diffs) |
| pnpm/action-setup | v6 | читает packageManager |
| Runner | ubuntu-latest | git-lfs ставится шагом (в образе отсутствует) |

## Данные и персистентность (S1)

| Позиция | Версия | Примечание |
|---|---|---|
| PostgreSQL | 17-alpine (docker) | локально порт 5433 (5432 занят нативным сервисом PO); CI — service-контейнер |
| zod | 4.6.5 | контракты Job/RawJob |
| kysely | 0.29.5 | типобезопасный SQL без ORM-магии |
| pg | 8.23.0 | драйвер |
| fast-xml-parser | 5.11.1 | Atom-feed Job Bank |
| fast-check | 4.10.0 | property-тесты ядра (dev) |
| tsx | 4.23.13 | CLI-раннер worker (dev) |

## Changelog
- 1.2 (2026-09-16) — S1 (PO-approved со спекой): добавлены postgres 17-alpine,
  zod, kysely, pg, fast-xml-parser, fast-check, tsx; docker-compose (postgres only,
  порт 5433 из-за конфликта с нативным Postgres на хосте PO).
- 1.1 (2026-09-16) — PO-approved: экшены CI подняты на мажоры без Node-20 deprecation (setup-node v7, upload-artifact v7, action-setup v6, checkout v7); добавлена таблица CI в фиксацию стека.
- 1.0 (2026-09-16) — начальная фиксация по итогам S0. Отклонение зафиксировано: TypeScript
  ограничен 6.0.x из-за peer-диапазона typescript-eslint (>=4.8.4 <6.1.0); eslint-plugin-boundaries
  заменён собственным правилом (pnpm-строгая резолюция необъявленных импортов ломает
  resolution-based проверку границ).
