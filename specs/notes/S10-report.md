# S10-report — Metrics v2 (LLM-стоимость, сквозная воронка, dispatch/quality)

Ветка `feat/S10-metrics-v2` (от `origin/main` = merge S9). Спека: [S10-metrics-v2.md](../S10-metrics-v2.md).
G1: мандат PO «бери M4» (2026-10-01). **M4 закрыт** (S9 + S10).

## Что сделано

| Единица | Суть |
|---|---|
| core/metrics-v2.ts | `funnelV2` (scored/drafted/dispatchedSent/appliedTotal — DESIGN §5.3), `llmAggregates` (calls/cacheHits/cost/tokens + byStage с avgLatency — §5.1), `dispatchAggregates` (sent/failed/skipped + byChannel), `qualityAggregates` (invalidShare — прокси hallucination_rate §5.2, captchaStops). Kysely query builders (типизировано; `fn.agg('count',[col]).distinct()` — count distinct в kysely 0.29) |
| getMetrics | расширен обратно-совместимо: старые ключи S13 нетронуты (его тесты зелёные без правок — AC3) |
| /metrics | новые секции **LLM cost**, **Dispatch**, **Quality** (+ scored→drafted в Quality) — CSS-карточки по DS-паттерну S13, без chart-зависимостей (STACK 1.5) |
| /api/metrics | автоматически отдаёт v2 (тот же getMetrics) |

## AC

| AC | Статус |
|---|---|
| 1 Агрегаты на контролируемом сидe (llm по стадиям/кэш/стоимость/latency; фаннел-цепочка; dispatch by channel; invalidShare=0.5; captchaStops) | ✅ integration 3 новых (red→green; llm-ассерты baseline-relative — fresh-ingest фикстуры пишут свои llm_run) |
| 2 /metrics рендерит новые секции; DOM↔API-консистентность; снапшот обновлён осознанно | ✅ e2e 10/10 |
| 3 Обратно-совместимость S13 | ✅ старые 3 теста зелёные без правок |

## Цифры

unit 199; integration 81 (+3); e2e 80 (+1); lint/arch/typecheck — 0. Бейслайн s13-metrics.png обновлён (осознанные новые секции).

**Живые данные (:3000/api/metrics)**: llm 78 calls / **$0.2522** / cache 33; воронка **46 scored → 7 drafted → 2 sent → 1 applied**; dispatch: email 1/1 sent/failed, form 1/0. Деплой пересобран.

## Отклонения/находки

- Mimosa блокировал sql``-шаблоны в новом файле (false positive — тот же ruling S13-кода) → v2-агрегаты написаны **Kysely query builders** (типизированнее sql``; `.js`-суффикс импортов убран — Turbopack+bundler resolution).
- `fn.distinct` нет в kysely 0.29 → `fn.agg('count', ['job_id']).distinct()`.
- Снапшот-гейт поймал новую секцию — бейслайн обновлён осознанно (G4-дисциплина).

## Security

Новых секретов/env нет; агрегаты только читают БД; PII в метриках отсутствуют (счётчики/стоимости — согласуется с конституцией 3.2/6.1).

## M4 итог (S9+S10)

Оба канала отправки живы (email dry-run-safe + form с капча-стопом), полная метрик-страница на реальных числах. Milestone **M4 закрыт**. Дальше по роадмапу: S11 (мульти-резюме, M5 — парковка PO) либо операционные улучшения по твоему выбору.
