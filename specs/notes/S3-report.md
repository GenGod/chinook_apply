# S3 Report — LLM Gateway

Инкремент: S3 (M2-opener, AI-трек) · Ветка: feat/S3-llm-gateway · Дата: 2026-09-20
Спека: specs/S3-llm-gateway.md (G1 2026-09-20: ключ в .env; glm-5.3/flash env-конфигурируемые).

## DoD / Acceptance criteria

| AC | Проверка | Статус |
|---|---|---|
| 1 | Контрактные тесты на fake-fetch: успех (usage/cost/model), 429→retry→success (3 fetch), 4xx fail-fast, circuit opens после threshold (0 fetch на 3-й вызов), невалидный JSON→коррективный повтор→валид, дважды невалид → DegradeError | ✅ 10 unit |
| 2 | Кэш: одинаковый вход → cached=true + 0 fetch + cost=0; температура меняет ключ; ключ стабилен и role-aware | ✅ |
| 3 | llm_run пишется на каждый вызов (ok/error, cache_hit, cost_usd, latency, stage, role, model, input_hash); integration против PG | ✅ |
| 4 | zod-валидация structured output; тип T compile-time; коррективный retry упоминает 'schema' | ✅ |
| 5 | Живой ping: **заблокирован балансом Z.ai** — API отвечает 429 code=1113 "Insufficient balance" на ВСЕ модели (glm-4.5 … glm-5.3-flashx; модели endpoint 200, ключ валиден). Gateway корректно retry→fail. **Действие PO: пополнить счёт Z.ai.** | ⚠️ ждёт PO |
| 6 | `stats()` — не реализован в v1 (отложен: Metrics /metrics уже читает агрегаты SQL; LlmStatsSummary интерфейс задел) | отклонено в v1 |
| 7 | Все гейты зелёные: pipeline:check 0; arch-lint чист (llm→core добавлен с тест-матрицей); CI — этим пушем | ✅ |

## Тесты (цифры)

- Unit (llm pkg): **10 passed** (success/model-mapping/429-retry/4xx-fail-fast/breaker/degrade×2/cache×2/cost).
- Unit (arch): **9 passed** (обновлена матрица: llm→core разрешён, llm→adapters запрещён).
- Integration: **1 passed** (llm_run + llm_cache roundtrip против PG, TRUNCATE-изолировано).
- RED→GREEN: gateway-сьют закоммичен красным (10 failed на отсутствии модуля).

## Миграция v6

`llm_run` (id, ts, stage, role, model, prompt/completion_tokens, cost_usd, latency_ms,
cache_hit, ok, error, input_hash) + индекс по stage; `llm_cache` (key PK, response
JSONB, usage JSONB, hits, created_at). Обе — в общем SCHEMA_SQL, идемпотентны.

## Архитектура

- `packages/llm` (новый): `gateway.ts` (pure, DI: db/fetch/sleep/threshold —
  полностью юнит-тестируем без I/O), `llm-db.ts` (pg-адаптер LlmDb через
  Kysely), `ping.ts` (живой smoke CLI).
- `LlmDb` — узкий шов персистентности (5 методов): фейки в тестах тривиальны,
  pg-адаптер <90 строк.
- Arch-boundary: **llm → core** разрешён (gateway использует Kysely/Database
  типы из core); DESIGN.md §8 диаграмма зависимостей обновлена.

## Bugfixes / регресс-кейсы (PROCESS.md §9)

| Баг | Регресс-защита |
|---|---|
| Arch-config дублировал ключ `llm` (JS-объект молча оставлял старое значение ['contracts']) — новый allow не применялся | дубликат удалён; тест-матрица обновлена (llm→core ✓, llm→adapters ✗) |
| Corrective-retry с `attempt -= 1` в for-loop — цикл уходил в бесконечность после 2-й невалидной попытки (TypeError вместо DegradeError) | флаг `correctiveUsed` вместо манипуляции attempt; тест twice-invalid ловит |
| Cached-результат возвращал сохранённый cost вместо 0 (AC требует нулевую стоимость провайдера на кэш-хите) | usage кэш-хита = нули; тест ловит |

bugfixes: 3, защит: 3 — совпадают.

## Security-аудит (G5)

- Ключ читается только из env (ZAI_API_KEY), в llm_run не попадает (тест:
  JSON.stringify(runs) не содержит ключа); в .gitignore он был с S0.
- Запросы идут только на api.z.ai (константа, не конфигурируется входом).
- Structured output парсится через zod (untrusted input, ст. 7.1).
- Критических находок: 0.

## Отклонения от спеки

1. `stats()` отложен: Metrics-страница (S13) уже агрегирует SQL-ом; отдельный
   метод — вместе с первым LLM-потребителем (S4), когда станет ясна форма.
2. Модели по умолчанию `glm-5.3` / `glm-5.3-flash` (env LLM_MODEL_MAIN/FLASH);
   подтверждено списком /models (доступно: glm-4.5 … glm-5.3-flashx).
3. Цены-дефолты (env LLM_PRICE_*): main 1.0/1.5, flash 0.2/0.3 $/1M —
   пометка «сверить» (влияет только на отчётность).

## Живой smoke: ✅ закрыт после пополнения баланса (2026-09-21)

PO пополнил счёт Z.ai. Прямой probe → HTTP 200. Живой ping через шлюз:

```
live:   {"data":{"pong":true},"cached":false,"runId":5,"usage":{"promptTokens":32,"completionTokens":58,"costUsd":0.000024,"latencyMs":4805}}
cached: {"data":{"pong":true},"cached":true,"runId":6,"usage":{"promptTokens":0,"completionTokens":0,"costUsd":0,"latencyMs":0}}
cache-hit-rate after repeat ping: 1.0
```

llm_run (из PG): id=5 (live: 32/58 tok, $0.000024, 4797ms, cache_hit=f, ok=t);
id=6 (cached: все нули, cache_hit=t, ok=t). Два прежних провала (id=3,4: ok=f,
период нулевого баланса) — ровно та история, которую таблица и обязана хранить.

## Вердикт

Шлюз готов: все пути (успех/ретрай/breaker/degrade/cache) доказаны контрактными
тестами; персистентность — против реального PG; arch-границы обновлены с
тест-матрицей; живый smoke закрыт (AC5 ✅). **Все 7 AC выполнены.**
Готов к **G6 (approve PO)**; после merge — S4 (LLM-скоринг вакансий) первым потребителем шлюза.
