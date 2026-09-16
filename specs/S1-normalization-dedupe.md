# S1: Normalization & dedupe — контракты вакансий, адаптеры, персистентность

Статус: **draft** (ждёт G1 approve PO) · Версия: 1.0 · Milestone: **M1**
Источник: DESIGN.md §3.1 (Ingestion), §6.1; зависит от S0 (done).

## Проблема и цель

Вакансии из гетерогенных источников (Job Bank, Adzuna, позже alis/RSS/TG/email)
приходят в разных форматах и с дублями (одна вакансия пере-публикуется,
кросспостится, варьирует заголовок). Цель S1: единый контракт `Job`,
нормализация, канонический хэш и дедупликация (точная + fuzzy), персистентность
в Postgres, CLI-команда инжеста. По завершении M1-цель: «вакансии текут в базу».

## Входные артефакты / зависимости

- S0-каркас (workspace, гейты, CI) — готово.
- Профиль поиска: `data/profile/master_profile.json` → search_config (NOC 21231/21234,
  Alberta) — используется начиная с S2, в S1 только сохраняем source-поля.
- Внешние API: Job Bank (открытый REST), Adzuna (APP_ID + APP_KEY — **см. открытые вопросы**).

## Решение (альтернативы из brainstorm, выбор + отказ)

### R1. Персистентность: Postgres + Kysely — сейчас
- **(a) Postgres (docker-compose) + Kysely** — ✅: M1 обещает «вакансии в базе», S1a (список
  вакансий) без БД невозможен; Kysely уже в скилл-стеке резюме, типобезопасен без ORM-магии.
- (b) Отложить БД (in-memory + JSON) — заставит S1a читать файлы, дублирование I/O-слоя;
  рефактор позже дороже.
- (c) Drizzle/Prisma — Prisma тяжёл (engine), Drizzle допустим, но Kysely ближе к SQL
  и уже знаком по резюме. Отклонено без ущерба.
- ⚠ Новая позиция стека (postgres 17, kysely) — вносится в STACK.md 1.2 при реализации,
  G1-аппрув спеки считается approve расширения стека (PROCESS.md §8.1).

### R2. HTTP-клиент: нативный fetch
- **(a) `fetch` Node 26** — ✅: ноль зависимостей, таймауты через AbortController.
- (b) got/axios — новая зависимость без_unique выгоды. Отклонено (YAGNI).

### R3. Оркестрация инжеста: CLI-команда, без очередей
- **(a) `pnpm --filter @chinook/worker ingest`** — ✅: одноразовый прогон адаптеров →
  нормализация → дедуп → upsert. Повторяемость через внешний планировщик не нужна до
  S5 (BullMQ появляется, когда воркеров станет несколько — DESIGN §3.1).
- (b) BullMQ сразу — инфраструктура Redis ради крона одного адаптера; отложено.
- docker-compose в S1 содержит только postgres.

### R4. Дедупликация: канонический хэш + fuzzy (bigram dice)
- **(a) Точный хэш sha256(versioned-нормализованного кортежа) + fuzzy: dice-коэффициент
  биграмм на (title+employer) при равенстве нормализованной локации, порог 0.92** — ✅:
  без внешних библиотек, объяснимая метрика, детерминированная.
- (b) Levenshtein-либа — зависимость; (c) только точный хэш — пропускает перефразированные
  дубли (главный кейс). Отклонены.

### R5. Схема canonical_hash — версионированная
`canonical_v1 = sha256("v1|" + normTitle + "|" + normEmployer + "|" + normLocation + "|" + sourceId?)`
Префикс версии позволит мигрировать формулу без боли (старые записи остаются валидными).
Вопрос-sourceId включён: тот же работодатель постит в двух источниках — это один Job
(мерж источников) или два (разные url)? **Решение: БЕЗ sourceId** — кросс-источниковые
дубли схлопываем, url сохраняем списком `urls[]`.

### R6. Фикстуры адаптеров
Реальные ответы API, санитизированные (без PII рекрутеров), лежат в
`tests/fixtures/adapters/{jobbank,adzuna}/*.json`; тесты гоняют нормализацию и дедуп
по ним. Обновление фикстур — ручная процедура, задокументированная в README tests.

## Контракт

### packages/contracts (zod)
```ts
JobSourceId = 'jobbank' | 'adzuna' | 'indeed' | 'alis' | 'rss' | 'telegram' | 'email'
Job = {
  id: uuid; canonicalHash: string;          // canonical_v1:...
  title: string; employer: string;
  location: { city: string; province: 'AB' | string; remote: boolean };
  url: string; urls: string[];              // кросс-источниковый мерж
  source: JobSourceId; sourceJobId: string | null;
  postedAt: ISO8601 | null; salaryMin/Max/Currency: number | null | 'CAD';
  nocCode: string | null; raw: unknown;      // исходный payload (JSONB)
  ingestedAt: ISO8601;
}
Adapter = { id: JobSourceId; fetch(since?: ISO8601): Promise<RawJob[]> }
```
Нормализация: NFC-unicode, lowercase, ascii-fold, схлопывание пробелов/пунктуации
заголовка; локация → город из словаря Alberta + флаг remote.

### packages/core
`normalize(raw, source): Job` · `canonicalHash(job): string` ·
`dedupe(jobs): { unique: Job[]; merged: number; fuzzyPairs: FuzzyPair[] }`

### apps/worker
`src/ingest.ts` — CLI: адаптеры → core → репозиторий (upsert by canonicalHash,
мерж urls[]). Таблица `job` из DESIGN §3.2 (job + migration SQL в репо).

### docker-compose.yml (новый в корне)
postgres:17-alpine, порт 5432, volume, healthcheck; пароль/юзер из .env
(в репо — .env.example). redis НЕ добавляем (R3).

## Acceptance criteria

1. `Job`/`Adapter` контракты в packages/contracts, zod-схемы экспортированы.
2. Адаптеры jobbank + adzuna имплементированы; на фикстурах дают Jobs,
   проходящие zod-валидацию.
3. `canonicalHash` детерминирован (property-тест: повторный вызов = тот же хэш);
   версия `v1` в префиксе.
4. Дедуп: фикстурный набор с (а) точным дублем, (б) fuzzy-дублем (перефразированный
   заголовок), (в) уникальными → схлопываются только (а) и (б); urls смержены.
5. Postgres в docker-compose поднимается; миграция создаёт `job`;
   ingest-CLI складывает фикстурные данные (режим `--fixtures`) в БД,
   повторный прогон не создаёт дубли (upsert).
6. `pnpm pipeline:check` зелёный; arch-lint чист (адаптеры не импортируют core/llm).
7. STACK.md 1.2: postgres/kysely зафиксированы.
8. Живой прогон `pnpm ingest` против реальных API — зафиксирован в отчёте
   (число вакансий, доля дубликатов, дедуп-ratio).

## Тест-план

- **Unit (packages/core, TDD):** нормализация (таблица кейсов: unicode, пунктуация,
  регистр), canonicalHash (детерминизм + чувствительность к компонентам),
  dedupe (точный/fuzzy/уникальные, мерж urls, порог 0.92 на границе).
- **Property (fast-check):** hash(normalize(x)) стабилен при повторе; перестановка
  полей меняет хэш.
- **Integration (tests/):** адаптеры на фикстурах; ingest-CLI на фикстурах против
  postgres (docker, в CI — service-контейнер).
- **E2E:** не затрагивается (страница не меняется) — прогон подтверждает отсутствие
  visual-диффа (PROCESS §4 E7).

## Метрики

- Дедуп-ratio по источникам (уникальные/total) — в отчёт S1 и в event_log.
- Время ingest-прогона (baseline для будущего крона).
- Токены: N/A (S1 без LLM; см. S0-report §Метрики).

## DoD (копируется в отчёт)

- [ ] AC 1–8 зелёные; красные→зелёные коммиты по TDD
- [ ] Фикстуры санитизированы (без PII)
- [ ] docker-compose + .env.example в репо; секретов в git нет
- [ ] Отчёт specs/notes/S1-report.md (тесты цифрами, дедуп-ratio, security, отклонения)
- [ ] STACK.md 1.2 + changelog
- [ ] CI зелёный (включая integration с postgres-сервисом)

## Открытые вопросы (к PO, вместе с G1)

1. **Adzuna credentials:** нужны `ADZUNA_APP_ID` / `ADZUNA_APP_KEY`
   (бесплатный тариф, регистрация adzuna.com). Завести и положить в `.env`
   (в git не попадут). Без них адаптер не заработает в live-режиме (фикстуры — смогут).
2. Job Bank API работает без ключа — оставляю как основной live-источник S1, ок?
3. docker-desktop на машине есть? Postgres-контейнер — основа dev-среды с S1.
4. Порог fuzzy 0.92 — стартовая эвристика, будет калиброваться на реальных данных
   в S1-отчёте (показываю примеры пограничных пар). Ок как default?
