# S11-report — Мульти-резюме → суперпрофиль с provenance

Ветка `feat/S11-superprofile` (от `origin/main` = merge S23). Спека: [S11-superprofile.md](../S11-superprofile.md) (стейджинг v1/v1.1 в спеке).
G1: мандат PO «давай S11» (2026-10-01). **M5 v1** (ядро B-002 п.1–2; треки — v1.1, см. ОВ-1).

## Что сделано

| Ед. | Суть |
|---|---|
| T1 | `profile_source` (sha256 UNIQUE, format docx\|pdf\|txt, storage_path, text_chars) + `profile_fact` (kind × 5, payload JSONB, **excerpt**) + репозитории — integration 2/2 |
| T2 | `extractDocxText` (core, fflate; round-trip с собственным docx-энкодером 3/3) + `extractPdfText` (web, pdf-parse, best-effort) |
| T3 | `packages/llm/profile-facts.ts`: zod-схема (5 kind-ов) + промпт с ЖЁСТКОЙ формой вывода (kind/payload/excerpt, дословность) — unit 5/5 |
| T4 | Инжест-сервис: sha-дедуп → gitignored sources → LLM (flash) → **provenance-гейт** (excerpt ⊆ текст документа) → profile_fact — integration 4/4 |
| T5 | `core/superprofile.ts` — детерминированный merge (код, не LLM): дедуп-ключи, **conflict**-очередь для PO, identity/search_config дословно, version+1 — unit 4/4 |
| T6 | Approve-flow (env-мастер, бэкап, идемпотент) — integration 2/2; API state/sources/proposal/approve; **/profile** (дифф с выдержками, конфликты красным, Approve) — e2e 3/3 + снапшот |
| T7 | Golden (живой flash на реальном master_resume_source.docx): **62/62 через гейт**; 54 skill/4 experience/3 summary/1 education; **$0.0028**; предложение из 2 add_skill **НЕ применено** — ждёт PO в /profile |

## Ключевые гарантии (конституция 2.1–2.3)

1. **Ничего не выдумывается**: LLM только извлекает; гейт механически проверяет excerpt ⊆ текст документа.
2. **Merge применяет только человек**: propose read-only; approve — единственная точка записи (бэкап + version+1); identity автоматика не трогает.
3. **Конфликты не применяются** — очередь решений PO.
4. **PII**: исходники/факты — БД + gitignored dir; /profile рендерит метаданные и diff-выдержки (approve-интерфейс, ст. 1.3); e2e — fixture-мастер через env.

## AC — все ✅ (1–9 см. спеку; соответствие по задачам выше)

## Цифры

unit: core +7 (docx 3, superprofile 4), llm +5; integration **96** (+8); e2e **85** (+3); lint/arch/typecheck — 0. Docker web пересобран: /profile жив (1 источник, master v1).

## Инциденты/фиксы в ходе

- Форма вывода flash (`type/excerpt/text` вместо схемы) → явный OUTPUT SHAPE + пример JSON в промпте (урок: дискриминированная zod-схема требует буквального примера).
- Windows-имя файла с обратным слэшем (артефакт блокировки записи) пойман Turbopack-сборкой; устранён.
- e2e: гонка notice↔refresh в approve — переставлен порядок.
- Сид /profile sha-идемпотентен.

## Security

- Mimosa: 1 блокировка (path-traversal на env-путях) → пути в core/profile-paths (whitelist storage-имени, containment-гварды).
- Upload whitelist (docx/pdf/txt, ≤10 МБ), текст ≤18k в промпт; секреты без изменений.

## Открытые вопросы (G6)

1. **Треки/personas + ранжирование (v1.1)** — дефолт: отложить до оценки PO качества суперпрофиля.
2. **Golden-предложение (2 add_skill)** — тебе в /profile: выдержки → Approve или пропустить.
3. summary-факты не применяются автоматически (3 варианта в фактах — ручное решение).
4. NOC-расширение — не в v1 (отдельное решение PO с обоснованием по фактам).
