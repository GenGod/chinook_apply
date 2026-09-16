# S2: Rule matcher — правило-фильтр потока под профиль PO

Статус: accepted (G1 2026-09-16: junior→review, remote релевантен, UI-бейдж отложен) · Версия: 1.0 · Milestone: **M1**
Реестр: DESIGN.md §6.1 · зависит от S1/S1a (done).

## Проблема и цель

Инжест собирает всё подряд (в живом прогоне S1 — вакансии из Онтарио и Квебека,
потому что Atom-фид не фильтрует локацию). Цель S2: детерминированный
(без LLM — он в S4) правило-фильтр, применяемый при инжесте: каждая вакансия
получает `rule_status` + причины, а список умеет фильтроваться по нему.
Профиль-источник — `master_profile.json` (search_config: NOC 21231/21234,
Alberta, Senior/Lead).

## Входные артефакты / зависимости

- `data/profile/master_profile.json` → `search_config` (вне git, PII-контракт;
  путь конфигурируется `CHINOOK_PROFILE_PATH`, для тестов — синтетический
  анонимный `tests/fixtures/profile.synthetic.json`).
- S1: `normalizeJob` (province/city/remote уже нормализованы), ingest-CLI.
- S1a: `listJobs` (добавляем фильтр byRule).

## Решение (альтернативы из brainstorm, выбор + отказ)

### R1. Где живут правила: packages/core/rules.ts (чистые функции)
- **(a) Чистые функции `applyRules(job, profileSearch): RuleResult` в core** — ✅:
  table-driven тесты без I/O; вызываются из ingest после normalize.
- (b) В адаптерах — правила это домен, не источник. (c) В worker — тогда
  недоступны web/тестам без app-импорта. Отклонены.

### R2. Хранение результата: колонки на `job`
- **(a) `job.rule_status TEXT` ('relevant'|'review'|'excluded'),
  `job.rule_reasons JSONB`, `job.rule_scored_at`** — ✅: без join, история
  перезаписывается последним прогоном правил (правила эволюционируют).
- (b) Отдельная таблица rule_match — сущность избыточна: один результат на
  вакансию, не история (история = event_log, вне S2).
- (c) Таблица `job_match` из DESIGN §3.2 — она зарезервирована под LLM-скоринг
  S4 (score/reasons/risks/llm_run_id); правила туда не смешиваем.

### R3. Семантика статусов: три корзины вместо бинаря
- `relevant` — Alberta (или remote) **и** заголовок матчит семейства NOC-тайтлов;
- `review` — Alberta (или remote), но заголовок не матчит (или матчит
  «младшие» маркеры — intern/junior/co-op/student: не мусор, но не твой уровень);
- `excluded` — не Alberta и не remote.
Так ни одна вакансия не теряется молча (конституция ст. 1 дух: решения
видимы), а «review» — питательная среда для калибровки keyword-сетей.

### R4. Keyword-сети v1 (из NOC 21231/21234 title-семейств)
- include: developer, software, web, fullstack/full stack, frontend/front-end,
  backend/back-end, engineer (плюс контекстные: typescript, node, react —
  заголовки типа «React Developer» ловятся и без слова developer через react);
- junior-маркеры (→ review): intern, junior, co-op, student, trainee, entry-level.
Сети хранятся в правиле как данные (не хардкод в логике), калибруются по
фактическим заголовкам из БД (отчёт приведёт примеры).

### R5. Зарплатный порог: НЕ включаем в v1
Зарплата заполнена у меньшинства записей (фиды); фильтр по ней сейчас —
ложные excluded. Вернёмся, когда плотность данных вырастет (в S4 вместе с
score-порогом).

### R6. NOC-коды: заготовка, не фильтр
Источники не дают NOC — `job.nocCode` остаётся null; угадывание NOC — S4
(LLM `noc_guess`). Правила используют семейства тайтлов как прокси (R4).

## Контракт

```ts
// packages/core/src/rules.ts
export interface RuleResult { status: 'relevant'|'review'|'excluded'; reasons: string[] }
export function applyRules(job: Job, search: ProfileSearch): RuleResult;
// ProfileSearch = { targetProvince: 'AB'; seniority: string[]; nocTitles: string[] } (из profile)
// ingest: после normalizeJob → applyRules → job.rule_* в upsert
// listJobs(db, { ..., rule?: 'relevant'|'review'|'excluded' })
// API: GET /api/jobs?rule=relevant
```
Миграция: `ALTER TABLE job ADD COLUMN IF NOT EXISTS rule_status TEXT,
ADD COLUMN IF NOT EXISTS rule_reasons JSONB, ADD COLUMN IF NOT EXISTS
rule_scored_at TIMESTAMPTZ` (idempotent, в SCHEMA_SQL v3).

## Acceptance criteria

1. `applyRules` table-driven: AB+dev → relevant; QC → excluded (reason
   'province'); remote+react → relevant; AB+junior → review (reason
   'junior-marker'); AB+нет-матча → review (reason 'no-keyword-match').
2. Keyword-сети — данные; тест на границы (case, «Full-Stack» vs fullstack).
3. Ingest прогоняет правила и пишет rule_*; повторный прогон обновляет
   (правила эволюционируют — последнее выигрывает).
4. `listJobs({rule})` фильтрует; API `?rule=` работает (e2e: ?rule=relevant
   отдаёт подмножество).
5. Профиль грузится с диска (env-путь), тесты — на синтетическом фикстуре;
   PII не попадает ни в код, ни в тесты, ни в git.
6. Живой прогон: в отчёте — разбивка relevant/review/excluded и примеры
   заголовков по корзинам (калибровка сетей для следующей итерации).
7. Все гейты зелёные; arch-lint чист.

## Тест-план

- **Unit (core, TDD):** applyRules — полная таблица кейсов (AB/ON/QC/remote/
  NWT, junior-маркеры, include-сети, unicode-заголовки «Développeur» →
  normalizeTitle уже фолдит).
- **Integration:** ingest проставляет rule_* (fixtures); listJobs rule-фильтр;
  повторный ingest с изменённой сетью (синтетический профиль v2) меняет статус.
- **E2E:** `?rule=relevant` сужает таблицу; visual не затронут (baseline
  без изменений — страница та же, только query).

## Метрики

- Разбивка по корзинам после живого прогона ( relevant / review / excluded )
  — первая воронка-метрика качества потока.
- Доля review с junior-маркерами vs no-keyword — калибровка R4.

## DoD (копируется в отчёт)

- [ ] AC 1–7 зелёные; RED→GREEN коммиты
- [ ] Миграция v3 идемпотентна (прогон дважды — без ошибок)
- [ ] PII-контракт соблюдён (синтетический профиль в тестах)
- [ ] Отчёт S2-report.md: корзины живого прогона, примеры заголовков, план
      калибровки сетей
- [ ] CI зелёный

## Открытые вопросы (к PO, вместе с G1)

1. Junior/intern → **review** (не excluded) — подтверждаем? (Рекомендую review:
   иногда «Junior X» — фактический сеньор-тим с неправильным тайтлом, а
   решение всегда твоё.)
2. **Remote считать релевантным** независимо от провинции — подтверждаем?
   (Рекомендую да: ты open to relocation, а remote-from-anywhere частенько
   не указывает провинцию.)
3. Показывать rule-статус бейджем в Jobs Explorer сейчас (маленькая правка
   UI + новый baseline) или отложить в B-004 к S7-дизайну? Рекомендую отложить.
