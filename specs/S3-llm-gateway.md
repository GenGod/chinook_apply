# S3: LLM-шлюз — единая точка вызова GLM с учетом стоимости, кэшем и устойчивостью

Статус: done (все 7 AC закрыты; живой smoke прошёл 2026-09-21 после пополнения баланса) · Версия: 1.0 · Milestone: **M1** (закрывающий)
Реестр: DESIGN.md §4.1/§4.3 · зависит от S2 (done). Потребитель — S4 (скоринг).

## Проблема и цель

Все будущие LLM-операции (S4 match-score, S5 генерация резюме/писем) обязаны идти
через один шлюз: логирование токенов/стоимости/латентности в `llm_run` (конституция
ст. 6.1 — «незалогированный вызов = дефект»), кэш по хэшу входа (ст. 7.3 — «одинаковые
входы не оплачиваются дважды»), retry с backoff и degrade при невалидном structured
output (ст. 7.1). Цель S3: шлюз готов и доказан тестами + живым smoke-вызовом,
метрики токенов видны — до появления первого потребителя.

## Входные артефакты / зависимости

- Провайдер: Z.ai GLM, OpenAI-compatible endpoint `POST /api/paas/v4/chat/completions`
  (сверить по документации на реализации — см. открытые вопросы).
- Креды: `ZAI_API_KEY` в `.env` (вне git). Модели: `LLM_MODEL_MAIN` / `LLM_MODEL_FLASH`
  (env, дефолты — см. вопросы).
- Postgres (S1) для `llm_run` и кэша.

## Решение (альтернативы из brainstorm, выбор + отказ)

### R1. Транспорт: нативный fetch против SDK
- **(a) Собственный тонкий клиент на fetch** — ✅: endpoint OpenAI-совместим, нужен
  один POST; ноль новых зависимостей; полный контроль таймаутов/ретраев; лёгкий мок.
- (b) `openai`-SDK с baseURL — тянет зависимости ради одного вызова; (c) z.ai SDK —
  ещё одна точка риска версий. Отклонены (YAGNI, стек-заморозка).

### R2. Кэш: таблица `llm_cache` в Postgres
- **(a) Таблица (key = sha256(model+prompt+params), value = ответ+usage)** — ✅:
  переживает рестарты, виден SQL-ом, чистка — одной командой.
- (b) In-memory Map — теряется между процессами worker/web; (c) Redis — новая
  инфраструктура ради кэша LLM (S5 решит, если появятся очереди). Отклонены.
- Кэш-хит НЕ пишет новую строку llm_run, но инкрементит `llm_cache.hits`
  (учёт «сэкономлено» — метрика из DESIGN §5.1).

### R3. Устойчивость: retry ×3 c экспонентой +полуоткрытым circuit breaker
- 429/5xx/сетевые → retry [1s, 4s, 16s] + jitter; 4xx (кроме 429) — сразу ошибкой.
- Circuit breaker: 5 последовательных сбоев → разомкнут 60с → half-open проба.
  Область — процесс (worker), не кластер. Достаточно для one-user-системы.

### R4. Structured output и валидация
- Запрос с `response_format: json_object` (где поддерживается) + системный промпт
  «ответь строго JSON»; ответ прогоняется через zod-схему, переданную вызовом.
  Невалид → 1 повтор с «предыдущий ответ не прошёл схему, верни корректный JSON» →
  повторная валидация → при провале `DegradeError` наверх (S4 решает, что делать).

### R5. Учет стоимости
- usage из ответа (prompt/completion_tokens) → cost по таблице цен из env:
  `LLM_PRICE_MAIN_IN/OUT`, `LLM_PRICE_FLASH_IN/OUT` ($ за 1M токенов).
  Дефолты зафиксируем в STACK.md по актуальному прайсу провайдера на дату старта
  (см. вопросы); цены — данные, не код.

### R6. Модели и роли
- `Role = 'main' | 'flash'` (PROCESS.md §2): main = генерация (quality-critical),
  flash = скоринг/массовое. Роль → модель через env. llm_run пишет и role, и model.

## Контракт

```ts
// packages/llm
export interface LlmCall<T> {
  role: 'main' | 'flash';
  stage: string;                       // 'match_llm' | 'generate_resume' | ...
  system: string; user: string;
  schema?: ZodType<T>;                 // structured output + валидация (R4)
  temperature?: number;                // default 0
  cache?: boolean;                     // default true
}
export interface LlmResult<T> {
  data: T;                             // провалидированный ответ
  cached: boolean;
  runId: number;                       // llm_run id (0 при кэш-хите)
  usage: { promptTokens: number; completionTokens: number; costUsd: number; latencyMs: number };
}
export function createLlm(opts: { db: Kysely<Database>; apiKey?: string }): Llm;
interface Llm { call<T>(input: LlmCall<T>): Promise<LlmResult<T>>;
                stats(): Promise<LlmStatsSummary> }   // по stage/role/model: calls, tokens, cost, cache-hit-rate
```
Миграция v4: `llm_run` (id, ts, role, model, stage, prompt_tokens, completion_tokens,
cost_usd NUMERIC, latency_ms, cache_hit BOOLEAN, ok BOOLEAN, error TEXT, input_hash)
+ `llm_cache` (key PK, response JSONB, usage JSONB, created_at) + индексы.

CLI: `pnpm --filter @chinook/llm ping` — живой smoke (1 вызов flash, вывод usage/cost)
и `pnpm --filter @chinook/llm stats` — сводка по llm_run.

## Acceptance criteria

1. Контрактные тесты на мок-провайдере: успех; 429→retry→успех (backoff наблюдаем);
   2 фейла → circuit разомкнут; невалидный JSON → повтор → валид; дважды невалид → DegradeError.
2. Кэш: одинаковый вход → второй вызов `cached: true`, 0 внешних запросов, hits растёт;
   изменение температуры → другой ключ.
3. `llm_run` пишется на каждый реальный вызов (успех и провал: ok/error); кэш-хит —
   отдельной строкой с cache_hit=true и нулевой стоимостью провайдера.
4. zod-схема прогоняется; для `schema`-вызовов тип вывода — T (compile-time).
5. Живой smoke: `ping` против реального API (за env-флагом, в CI не обязателен) —
   выводит usage и cost; в отчёте — фактические цифры первого вызова.
6. `stats()` корректно агрегирует (юнит-тест на фикстурных строках).
7. Все гейты зелёные; arch-lint: llm импортирует только contracts (+db через core? —
   см. вопрос архитектуры ниже).

## Тест-план

- **Unit (llm, TDD):** ретраи/circuit (fake fetch с запрограммированными сбоями), кэш-ключи,
  деградация, парсинг usage, расчёт cost по ценам.
- **Integration:** llm_run/llm_cache против postgres (запись/чтение, stats-агрегация);
  end-to-end шлюз+мок-fetch через реальную БД.
- **E2E/visual:** не затронуты (страница прежняя; прогон подтверждает отсутствие диффа).

## Метрики

- Первый живой вызов: токены, стоимость, латентность (flash ping) — в отчёт.
- cache-hit-rate на повторном ping (должен стать 1.0) — доказательство ст. 7.3.

## DoD (копируется в отчёт)

- [ ] AC 1–7 зелёные; RED→GREEN коммиты
- [ ] Миграция v4 идемпотентна
- [ ] STACK.md 1.4: модели и цены зафиксированы (или явно помечены «дефолт, сверить»)
- [ ] Секреты только в .env; ключ не появляется в логах/llm_run (тест на маскировку)
- [ ] Отчёт S3-report.md + CI зелёный

## Открытые вопросы (к PO, вместе с G1)

1. **Z.ai API key** — положи `ZAI_API_KEY=...` в `.env` (как делал с Adzuna).
2. **Идентификаторы моделей**: какие main/flash прописать дефолтами? Я возьму из
   текущей панели Z.ai (например, GLM-5.3 / GLM-5.3-flash, если доступны), но лучше
   подтверди точные id — впишу в env-дефолты и STACK.md.
3. **Цены** $/1M токенов (in/out для обеих моделей) — дай из панели, либо фиксирую
   дефолтом с пометкой «сверить» (влияет только на отчётность, не на работу).
4. Архитектурный нюанс: шлюзу нужна БД. Вариант — llm принимает уже созданный
   `db` извне (worker/S4 передаст), сам ничего не зная о подключении. Подтверждаешь?
   (Рекомендую да — llm остаётся чистым, зависимости не растут.)
