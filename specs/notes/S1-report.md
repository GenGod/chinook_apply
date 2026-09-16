# S1 Report — Normalization & dedupe

Инкремент: S1 (M1) · Ветка: feat/S1-normalization-dedupe · Дата: 2026-09-16
Спека: specs/S1-normalization-dedupe.md · План: specs/plans/S1-plan.md

## DoD / Acceptance criteria

| AC | Проверка | Статус |
|---|---|---|
| 1 | `Job`/`RawJob`/`Adapter` контракты в packages/contracts (zod 4); normalizeJob валидирует untrusted RawJob схемой | ✅ |
| 2 | Адаптеры jobbank (Atom-feed) + adzuna на живых фикстурах: парсят в RawJob[] | ✅ |
| 3 | canonicalHash детерминирован (property-тест, 200 runs), версионирован `canonical_v1:` | ✅ |
| 4 | Дедуп: точный дубль + fuzzy (перефразированный заголовок) схлопываются, urls мержатся; разные работодатели/локации — нет | ✅ |
| 5 | Postgres в docker-compose (порт **5433** — см. отклонения); ingest `--fixtures` → upsert; повторный прогон 0 вставок, дубликатов нет | ✅ |
| 6 | `pnpm pipeline:check` зелёный; arch-lint чист | ✅ |
| 7 | STACK.md 1.2: postgres 17, zod, kysely, pg, fast-xml-parser, fast-check, tsx | ✅ |
| 8 | Живой прогон: см. «Метрики» | ✅ |

## Тесты (цифры)

- Unit: **35 passed** (core 20: normalize/hash/dedupe+property; adapters 7; worker env-loader 4; pipeline 4) — 0 failed.
- Integration (fixtures→postgres): **3 passed** (первый прогон вставляет; второй не дублирует; canonical_hash уникален).
- E2E/visual: прогон в pipeline — диффа нет (backend-only итерация, PROCESS §4 E7 — регрессионное отсутствие изменений UI зафиксировано).
- RED→GREEN: core- и adapter-сьюты закоммичены красными (20+2 падения по отсутствию модулей) до реализации.

## Метрики живого прогона (2026-09-16, `pnpm --filter @chinook/worker run ingest`)

| Метрика | Значение |
|---|---|
| Fetched | 61 (jobbank 11 + adzuna 50) |
| Unique | 55 |
| Merged (дедуп) | 6 (**дедуп-ratio 9.8%**) |
| Fuzzy-pairs (порог 0.92) | 0 — все дубли точные (ожидуемо: фид и API отдают стабильные формулировки) |
| БД после прогона | 55 вакансий (28 inserted + 27 updated — upsert подтвердился) |
| Время прогона | 3.7 c |

Воронка по источникам живьём: jobbank 10–11 записей за опрос (лимит фида), adzuna 50 за страницу.

## Bugfixes / регресс-кейсы (PROCESS.md §9)

| Баг | Регресс-защита |
|---|---|
| **.env отравлен моим append без переноса строки**: `ADZUNA_APP_KEY=…DATABASE_URL=…` → ключ 98 символов → Adzuna 401 | `loadRootEnv` экспортирован, детектирует embedded `VAR=` в значении → skip+warning; 4 юнит-теста, включая точную форму инцидента |
| Порт 5432 на хосте занят нативным Postgres → auth-failed при подключении к «своему» контейнеру | compose переведён на 5433; фиксация в STACK.md 1.2 |
| tsx игнорирует node `--env-file` → DATABASE_URL не загружался | собственный ноль-зависимый env-лоадер в CLI (+тесты выше) |
| pnpm 11 `ERR_PNPM_IGNORED_BUILDS` (esbuild postinstall) блокировал install/exec | `allowBuilds: esbuild: true` в pnpm-workspace.yaml (версия-специфичная механика pnpm 11) |
| kysely: executeQuery(raw obj) / xmax-RETURNING не компилируются | ensureSchema через `sql.raw().execute(db)`; inserted/updated через предвыборку canonical_hash |

bugfixes: 5, regression cases: 5 — совпадают.

## Security-аудит (G5)

- Секретов в git нет: `.env` в .gitignore; в репо только `.env.example` с плейсхолдерами; фикстуры содержат только публичные данные вакансий (проверено; ключи в ответах Adzuna/Job Bank не присутствуют).
- UA запросов честный: `Chinook/0.1 (personal job-search automation; contact: …)`; Job Bank — публичный Atom-feed, robots.txt не запрещает (Crawl-delay 5s соблюдается — 1 запрос за прогон).
- Инъекции: SQL только через параметризованный kysely-билдер и `sql.raw` константы (DDL из кода, не из ввода).
- PII: не затрагивается (профиль в S1 не используется).
- Критических находок: 0.

## Отклонения от спеки

1. **Job Bank без официального API** (исследование): адаптер построен на публичном **Atom-feed** поиска — конституционно (ст. 4.1 «публичные RSS»), без скрейпинга. Ограничение: ~10 записей/опрос, без фильтра локации — фильтр Alberta ложится на S2 (rule-matcher), накопление — частыми опросами.
2. **Порт postgres 5433** вместо 5432 (хост-конфликт) — .env.example обновлён.
3. `tsx` добавлен как CLI-раннер (в спеке подразумевался, зафиксирован в STACK 1.2).

## Известные риски / на контроле

- Порог fuzzy 0.92: на живых данных fuzzy-pairs = 0; калибровка продолжится на объёме S1a/S2 (в отчёты пойдут примеры пограничных пар).
- Atom-фид отдаёт последние ~10 записей: пропуски между опросами возможны при активном потоке; митигация — периодичность опроса в S2+ (cron), позже HTML-поиск как расширение адаптера (robots разрешает).
- CI: integration-стадия требует postgres-service (добавлен в workflow); первый CI-прогон ветки — фактическая проверка.

## Вердикт

Все AC закрыты, живой прогон обоих источников успешен, дедуп и upsert подтверждены
и юнит-, и integration-, и live-данными. Готов к **G6 (approve PO)**; после — merge в main
и переход к S1a (Jobs Explorer — экран списка вакансий, BACKLOG B-001).
