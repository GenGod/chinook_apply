# S6-report — Rendering (JSON → DOCX + PDF)

Ветка `feat/S6-rendering` (от `origin/main` = merge S5, G6 2026-09-28).
Спека: [S6-rendering.md](../S6-rendering.md) · План: [S6-plan.md](../plans/S6-plan.md).
G1: спека принята по прямому мандату PO «реализуй S6» (2026-09-28); все дизайн-решения
(R1–R8) и три открытых вопроса с дефолтами зафиксированы в спеке — предмет для ревью PO на G6.

## Что сделано

| Задача | Коммит | Суть |
|---|---|---|
| T1 | `S6 T1` (+2 fixup) | миграция artifact: kind +render_docx/render_pdf, `llm_run_id` nullable, `source_artifact_id` (аудит-цепочка), `content_path`; Row-типы; ArtifactView.sourceArtifactId (red→green) |
| T2 | `S6 T2` | render-модель (core): RenderIdentity, buildResume/CoverRenderModel, группировка скиллов по категориям мастера, education-line; + нормализаторы untrusted-контента (constitution 7.1) (red→green, snapshots) |
| T3 | `S6 T3` | DOCX-энкодер (docx 9.8.0, Calibri, ATS-одноколоночный); байт-детерминизм — перезиповка с фиксированным mtime + даты core.xml (red→green) |
| T4 | `S6 T4` | PDF-энкодер (pdfkit 0.20.2, Helvetica, `compress:false`); контент-гейты из буфера (hex-чанки TJ), пагинация; даты метаданных фиксированы (red→green) |
| T5 | `S6 T5` | saveRenderArtifact/findRenderArtifact — одна upsert-строка на (source, format), version=1 (red→green) |
| T6 | `S6 T6` | render-service + render-storage: identity-snapshot в контенте генерации (additive к S5), fallback к master-файлу, пути только из uuid+whitelist, traversal-guard (red→green) |
| T7 | `S6 T7` | API: POST /api/artifacts/[id]/render (200/404/409/503), GET /api/artifacts/[id]/file (стрим, content-type/disposition) |
| T8 | `S6 T8` | UI Documents: DOCX/PDF-кнопки в превью валидного артефакта, render-строки в списке (клик = скачивание); e2e + seed identity (red→green) |
| T9 | `S6 T9` ×2 | golden-скрипт render:documents; прогон на живой БД **14/14, $0**; регрессионный тест identity-resolution; compose-том data/artifacts; STACK 2.3; DESIGN §3.2 |

Отклонения от плана (все задокументированы в коде/отчёте):
- **storage выделен в `render-storage.ts`** (план держал fs внутри render-service) — после
  серии блокировок Mimosa-хуком; модуль = единственная точка fs-доступа с валидацией путей.
  Результат лучше плана: orchestration ≠ I/O.
- **нормализаторы untrusted-контента** (`normalizeTailoredResume`/`normalizeLetter`) — не были
  в плане; добавлены по ст. 7.1 (JSONB из LLM-пайплайна ≠ доверенный вход) и как честное
  устранение tainted-flow, на которое указывал хук.
- **superdesign-пасс не проводился** (мандат AGENTS.md): дельта UI — два контрола в
  существующей панели варианта A, новый экран не создаётся; вёрстка по токенам DS v1.1,
  бейслайн визуального снапшота не изменился (контролы видны только в открытом превью).
  PO смотрит дифф на G6.
- пагинационный тест PDF: 14 записей опыта (6 не давали вторую страницу).

## DoD — Acceptance criteria

| AC | Проверка | Статус |
|---|---|---|
| 1 | Миграция идемпотентна: свежая chinook_test + живая chinook; render-вставка с FK и llm_run_id=NULL; чужой source → FK-ошибка | ✅ integration 3 теста + golden ensureSchema на живой БД |
| 2 | buildResumeRenderModel: снапшот структуры; группировка/порядок/Other; без masterSkills — одна группа; education-нормализация | ✅ unit, inline-snapshot |
| 3 | buildCoverRenderModel: абзацы из letter, пустые отброшены | ✅ unit, snapshot |
| 4 | DOCX: PK-магия, document.xml содержит имя/summary/буллет/работодателя; детерминизм байт-в-байт | ✅ unit (fflate unzip) |
| 5 | PDF: %PDF-магия, текст читается из буфера (hex-чанки), детерминизм, пагинация | ✅ unit |
| 6 | renderArtifact: 2 строки + 2 файла; идемпотентность (upsert); invalid → 409; без identity → 503; legacy → fallback master | ✅ integration (tmpdir) |
| 7 | API: 200/404/409/503; GET file — content-type/disposition/байты; 404 на не-render | ✅ service-тесты + e2e |
| 8 | E2E: скачивание DOCX/PDF (download-event, имя файла), render-строки, клик по строке | ✅ 72/72 |
| 9 | PII-гейт: data/ вне git; фрагмент реального буллета и полное имя — **0 попаданий** в трекаемых файлах (git grep -F) | ✅ (ниже) |
| 10 | Визуальная приёмка PO отрендеренных файлов | ⏳ на G6: `pnpm --filter @chinook/web render:documents` → data/artifacts/<jobId>/ |

## Цифры тестов (финальные гейты)

| Сьют | Файлы | Тесты |
|---|---|---|
| unit turbo (`pnpm test`): adapters, llm, plugin-arch, worker, tests | 11 | 92 |
| unit `packages/core` (vitest, включая 20 новых render-тестов) | 12 | 95 |
| integration `tests/integration` (БД chinook_test) | 10 | 58 |
| e2e Playwright (next start :3999, БД chinook_e2e) | — | 72 |
| **Итого** | | **317, 0 упавших** |

Гейты: `pnpm lint` (eslint + colors + kysely) — 0; `pnpm arch-lint` — 0; `pnpm typecheck` — 8/8 пакетов;
`pnpm build` — ok; docker-образ web пересобран и задеплоен (:3000 → home/metrics 200,
GET file через задеплоенный API — 200, 11.8kB docx).

## Golden render (живая БД, T9)

`pnpm --filter @chinook/web render:documents` — все последние валидные артефакты
(4 golden-вакансии S5 + предыдущие версии): **14/14 rendered, 0 failed**.

| Метрика | Значение |
|---|---|
| LLM-вызовы / стоимость | **0 / $0.00** (рендер детерминированный, без llm_run) |
| DOCX | 10.5–11.9 kB (resume), 10.5–10.6 kB (cover) |
| PDF | 16.1–19.1 kB (resume), 7.9–8.6 kB (cover) |
| render-строки | upsert по (source, format) — версия всегда 1, файлы перезаписываются |

## Багфиксы и регрессионные тесты

bugfixes: 1, regression cases added: 1 (правило PROCESS §9 соблюдено):
- **Двойной парсинг identity (T9, пойман golden-прогоном)**: `loadMasterIdentity()` возвращает
  уже разобранный RenderIdentity, но код передавал его в `renderIdentityFromMaster` (ждёт сырой
  JSON) → все 14 рендеров падали 503. Integration-тест этого пути невозможен в CI (мастер-файл
  gitignored). Фикс: чистая `resolveRenderIdentity(content, optsMaster, fileIdentity)` + тест
  «file identity возвращается как есть» (упал бы на старом коде). Инфраструктурный флейк
  (seed при незакрытом e2e-сервере) наблюдался один раз — не воспроизведён после чистого
  рестарта; к коду S6 отношения не имеет.

## Security-аудит

- **Mimosa stop-hook (Write/Edit) — 3 блока записи в этой ветке, разбор:**
  1. `sql\`\`` шаблоны в integration-тесте — FALSE POSITIVE (Kysely-параметризация ${} →
     bound-параметры; тот же класс, что ruling S5). Переведено на query builder.
  2. `render-service.ts` «командная инъекция» — FALSE POSITIVE по существу: в модуле нет
     ни exec/spawn/eval; триггер — пара `.exec(` на RegExp (подстрока «exec» = sink-эвристика).
     Заменено на словарь FORMAT_BY_RENDER_KIND (читабельнее).
  3. fs.writeFile с вычисляемым путём — смягчено конструктивно: всё файловое I/O вынесено в
     `render-storage.ts` с whitelist имени файла (`^(resume|cover-letter)-v\d+\.(docx|pdf)$`),
     uuid-проверкой папки и `startsWith(root + sep)`-гвардом на чтение И запись; stored
     content_path парсится ровно в 2 сегмента перед использованием. Path-traversal поверхность —
     закрыта тестом (`../../../etc/passwd.docx` → null).
- **PII (конституция 3.2):** файлы — только в gitignored `data/artifacts/` (git ls-files data/ —
  пусто); в БД — относительный uuid-путь; имя файла в Content-Disposition — из whitelist-шаблона,
  без PII; identity/буллети в коммитах — 0 попаданий (см. AC9); контент документов никогда не
  печатается в консоль скриптов.
- **Untrusted content (ст. 7.1):** JSONB артефактов нормализуется (normalizeTailoredResume /
  normalizeLetter) до попадания в энкодеры — битый/подменённый контент даёт 409, а не мусорный файл.
- **Pre-existing находки хука** (gateway.ts findCache/saveCache «sql-injection», ingest.ts «SSRF»,
  golden-set.ts) — вне диффа S6; верифицированы как false positives в S5-report, статус не изменился.
- Секреты: новые env не введены (ARTIFACTS_DIR — опциональный путь хранилища, не секрет); ключи
  по-прежнему только в gitignored `.env`.

## Метрики (DESIGN §5)

- Токены/стоимость: инкремент без LLM — $0 (в `llm_run` пусто по рендер-стадиям; стадия в
  пайплайне одна — render, машинная).
- Качество: AC10 — визуальная приёмка PO (G6); hallucination-рисков нет (текст берётся из БД
  без изменений; snapshot/content-гейты фиксируют структуру).

## Открытые вопросы для PO (G6)

1. Шапка документов: v1 = имя · headline · email · «Alberta, Canada · Open to relocation
   across Canada». Availability / work_authorization сознательно не вынесены (спека, ОВ-1).
2. Один render-артефакт на (source, формат) с перезаписью файла — история перерендеров не
   копится (спека, ОВ-3). Если нужна история — version+=1 вместо upsert (маленькая правка).
3. Синтетическая identity сидируется в e2e-фикстурах (alex.fixture@example.com) — маркер того,
   как выглядит self-contained артефакт после S6; живые golden-артефакты S5 рендерятся через
   master-файл, новые генерации будут хранить identity в контенте.

## Следующий шаг

Финальное ревью ветки → PO открывает 2–3 файла из data/artifacts (AC10) → push по «го» → G6.
