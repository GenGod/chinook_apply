# S10: Metrics v2 — LLM-стоимость, воронка сквозной воронки, dispatch/quality

Статус: accepted (G1 — мандат PO «бери M4», S10 второй инкремент, 2026-10-01) · Версия: 1.0 · Milestone: **M4** (закрывает M4: «полная метрик-страница»)
Реестр: DESIGN §6.1 (S10: все виды из раздела 5; дашборд на реальных числах) · зависит от S8/S9 (dispatch_log), S4/S5 (llm_run, artifact).

## Проблема и цель

S13 отдаёт воронку кандидатов, здоровье источников и ingest-историю. Не покрыты DESIGN §5.1 (токены/стоимость/кэш по стадиям), §5.3 (полная воронка: scored → drafted → sent), §5.2 (качество: доля невалидных артефактов — прокси hallucination_rate; капча-стопы). Цель — дополнить `getMetrics` и страницу /metrics этими видами.

## Решение

- **R1. getMetrics расширяется** (обратно-совместимо: старые ключи сохраняются):
  - `llm`: totals + byStage из `llm_run` (calls, cacheHits, costUsd, prompt/completion tokens, avgLatency);
  - `funnel` += `scored` (job_match), `drafted` (валидные resume/cover артефакты по уникальным job), `dispatchedSent` (dispatch_log sent), `appliedTotal` (application applied, все каналы);
  - `dispatch`: sent/failed/skipped + byChannel;
  - `quality`: artifactsTotal/invalid/invalidShare, captchaStops.
- **R2. Страница /metrics**: новые секции LLM cost, Dispatch, Quality — CSS-бары/токены DS v1.1 (паттерн S13), без chart-зависимостей (STACK 1.5).
- **R3. API /api/metrics** — автоматически отдаёт расширенный JSON (тот же getMetrics).

## AC

1. Integration: сидированные llm_run/dispatch_log/artifact/job_match/application → точные агрегаты (по стадиям, кэш-хиты, cost rounding, фаннел-цепочка, quality-доля); пустая БД → нули/null без ошибок.
2. E2E: /metrics рендерит новые секции с числами; снапшот обновлён осознанно.
3. Обратно-совместимость: существующие S13-тесты (funnel/sources/history) зелёные без правок.

## Тест-план / DoD

Integration red→green (metrics.test.ts расширить); e2e metrics.spec расширить (DOM-ассерты новых секций); полный набор гейтов; отчёт specs/notes/S10-report.md; деплой.
