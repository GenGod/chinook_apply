# S21: Конвенция папок рендеров + история рендеров в UI

Статус: accepted (G1 — мандат PO «давай папку-конвенцию с поддержкой просмотра истории в UI», 2026-09-28) · Версия: 1.0 · Milestone: follow-up S6 (AI-track stitch)
Реестр: прямой запрос PO по итогам G6 S6 · зависит от S6 (done).

## Проблема и цель

После S6 рендеры лежат в `data/artifacts/<job-uuid>/resume-v3.docx` — папка нечитаема (uuid), сопоставить файл с вакансией можно только через БД. Кроме того, повторный рендер **перезаписывает** файл и строку (upsert, ОВ-3 S6) — истории рендеров нет ни на диске, ни в UI.

Цель S21: (1) человекочитаемая конвенция папок — дата + работодатель + короткий id вакансии; (2) рендеры накапливают версии (append), и вся история видна и скачиваема в существующем списке версий UI.

## Входные артефакты / зависимости

- S6: `render-storage.ts` (safeJoin: uuid-папка + whitelist файла), `saveRenderArtifact` (upsert version=1), `renderArtifact` (пара docx+pdf за действие), `readRenderFile` (обе схемы путей из БД).
- UI: список версий уже рендерит render-строки («Resume · DOCX v1», meta «Rendered <дата>»), клик = скачивание.
- Живые данные: 38 файлов в uuid-папках, строки в `artifact.content_path`.

## Решение (альтернативы из brainstorm, выбор + почему отвергнуты)

### R1. Схема папок: `{UTC-дата}_{employer-slug}_{jobId8}/` — ✅
Новый рендер пишется в `data/artifacts/2026-09-28_neo-financial_a1b2c3d4/resume-v3.docx`.
- slug работодателя: lowercase, `[a-z0-9]` + дефисы, схлопнуты, обрезаны; пустой → `job`.
- jobId8 — первые 8 символов uuid: уникальность папки без нарушения PII-нейтральности имени.
- дата — UTC-дата момента рендера (одинакова для хоста и контейнера).
- (откл.) зеркальная «человекочитаемая» папка с symlink/junction на uuid-папки — два источника правды, хрупкость junction на Windows.
- (откл.) миграция существующих uuid-папок с перезаписью content_path — churn ради эстетики; legacy-пути остаются валидными для чтения, новые пишутся по новой схеме. Мягкая конвертация = просто перезапустить `render:documents` (создаст новые версии по новой схеме).

### R2. История: append-версии вместо upsert — ✅
Каждое действие рендера создаёт новую пару строк `render_docx`/`render_pdf` с version = max+1 по (job_id, kind) — как у генераций S5. Файл каждой версии остаётся на диске по своему пути, старые строки/файлы не трогаются. Это осознанная замена решения ОВ-3 спеки S6 («одна строка, перезапись») по прямому запросу PO.
- (откл.) отдельная history-таблица — дублирование; `artifact` уже версионная.
- Гонки: max+1 вне транзакции + UNIQUE(job_id,kind,version) — второй конкурент получает 23505; рендер — ручное одиночное действие, риск принят и задокументирован.

### R3. UI: история в существующем списке версий — ✅ (минимальная дельта)
Аккордеон-список уже показывает render-строки с версией и датой; с append он становится историей: v1, v2, v3… каждая скачивается кликом. Кнопки DOCX/PDF в превью создают новую версию и скачивают её. Новых контролов не добавляется; label/meta без изменений.
- Download-имя файла — basename из content_path (`resume-v3.docx`); папка даёт контекст вакансии, дублировать работодателя в имени файла не нужно.

### R4. Валидация путей (render-storage): две схемы — ✅
`safeJoin` принимает папку-uuid (legacy) ИЛИ `^\d{4}-\d{2}-\d{2}_[a-z0-9-]+_[0-9a-f]{8}$` (новая); whitelist имени файла без изменений; traversal-гварды прежние. renderArtifact получает работодателя одним select'ом из `job` по source.jobId.

## Контракт

```ts
// render-storage.ts
export function renderFolderName(now: Date, employer: string, jobId: string): string
  // "2026-09-28_neo-financial_a1b2c3d4"; employerSlug: /[^\w-]/→'-', collapse, trim('-'); fallback 'job'
// safeJoin: folder regex → UUID_RE | FOLDER_RE (новая схема)

// artifacts.ts
saveRenderArtifact(db, input: { jobId; sourceArtifactId; sourceKind; sourceVersion; format;
  contentPath; version: number }): Promise<ArtifactView>   // явная версия, без upsert
export async function nextRenderVersion(db, jobId, kind): Promise<number> // max+1
findRenderArtifact(db, sourceArtifactId, format)            // ТЕПЕРЬ: последняя версия (order by version desc)

// render-service.ts
renderArtifact(...)  // job.employer → renderFolderName → nextRenderVersion → saveRenderFile → saveRenderArtifact
// golden-скрипт: пропускает источники, у которых уже есть render-строка (findRenderArtifact) — идемпотентен
```

## Acceptance criteria

1. `renderFolderName`: slug-правила (регистр, пробелы/юмикоды → дефис, collapse, пусто → 'job'), формат `{date}_{slug}_{8hex}`, дата UTC — unit.
2. safeJoin принимает новую папку и legacy-uuid, отвергает прочее (`..`, произвольные строки) — unit/integration.
3. `nextRenderVersion`/`saveRenderArtifact`: два рендера одного источника → версии 1, 2; строки обе; UNIQUE держит гонку — integration.
4. `findRenderArtifact` возвращает последнюю версию — integration.
5. `renderArtifact`: файлы ложатся в `2026-09-28_<slug>_<8hex>/`, content_path новой схемы, читаются обратно; legacy-uuid-пути читаются (регресс S6) — integration.
6. E2E: два клика DOCX → в списке «Resume · DOCX v1» и «v2», оба скачиваются; кнопка PDF создаёт пару v2 — e2e.
7. Golden-скрипт повторно: существующие источники пропускаются (0 новых версий), новые — рендерятся — integration/smoke.
8. PII-гейт: в папке/имени файла — slug работодателя и hex вакансии, никаких полных name/email (grep-тест синтетики).

## Тест-план

Unit (core/web по месту): renderFolderName, slug-правила. Integration: R2/R3/R4/R5/R7 в `tests/integration/render-artifacts.test.ts`. E2E: `documents.spec.ts` — история рендеров (AC6). Снапшоты: бейслайн не меняется (новых контролов нет).

## Метрики

LLM $0 (без изменений). Новое: доля рендеров по новой схеме (после первого golden-прогона — 100% новых), количество версий на источник в отчёте.

## DoD

- [ ] AC1–8; гейты lint/arch-lint/typecheck/unit/integration/e2e зелёные.
- [ ] Golden-прогон render:documents на живой БД: новые версии по новой схеме, старые файлы на месте.
- [ ] STACK.md — без новых зависимостей (запись в changelog не требуется; схема папок — в S21-report).
- [ ] Отчёт specs/notes/S21-report.md; снапшоты UI без диффа (regression evidence).

## Открытые вопросы (дефолты, PO может поменять на G6)

1. Дата в папке — UTC (не локальная): консистентно хост/контейнер.
2. Существующие 38 файлов не мигрируют; при желании — один прогон render:documents создаст новые версии по новой схеме (старые останутся до ручной чистки).
3. Download-имя остаётся `resume-v3.docx` (контекст — папка и UI).
