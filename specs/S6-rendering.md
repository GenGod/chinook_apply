# S6: Рендер артефактов — tailored resume / cover letter → DOCX + PDF

Статус: accepted (G1 — мандат PO «реализуй S6», 2026-09-28; решения зафиксированы для ревью на G6) · Версия: 1.0 · Milestone: **M2/M3-stitch**
Реестр: DESIGN §6.1 (S6 Rendering: JSON→DOCX/PDF, DoD — snapshot-тесты артефактов) · зависит от S5 (done: артефакты `resume`/`cover_letter` в БД, `assembleResume`, валидаторы).

## Проблема и цель

S5 отдаёт адаптированные документы как JSONB в БД (`resume` = `{diff, resume}`, `cover_letter` = `{letter}`). Отправить их работодателю нельзя: нужен файл. Цель S6 — детерминированный рендер **валидных** артефактов в **DOCX** (ATS-канон для резюме) и **PDF** (человекочитаемый формат, будущие email-вложения S8), со скачиванием из UI, версионно-аудируемым следом в `artifact` и snapshot-гейтами на структуру артефакта.

Рендер — **чистая детерминированная функция** (без LLM): одинаковый вход → одинаковые байты. Стоимость рендера — $0.

## Входные артефакты / зависимости

- S5: таблица `artifact` (kind ∈ resume|cover_letter, status valid|invalid, content JSONB, UNIQUE(job_id, kind, version)); `getArtifactContent`; UI-секция Documents (аккордеон, вариант A).
- `TailoredResume` (core): summary, keywords, skills (flat), experience[bullets, technology], education (raw master-записи).
- Identity: в контенте артефакта **нет** (G1 S5: identity не входит в промпты и в UI-превью). Профиль `data/profile/master_profile.json` (gitignored PII) имеет `identity {full_name, headline, email, location_constraints}`.
- DESIGN §3.2: `artifact ... kind(resume|cover_letter|render_pdf), version, content_path, llm_run_id`; §3.1 пайплайн: `generate → render → approve`.

## Решение (альтернативы из brainstorm, выбор + почему отвергнуты)

### R1. Библиотеки: `docx` 9.8.0 + `pdfkit` 0.20.2 — ✅
- **docx** (dolanmiu) — де-факто стандарт OOXML-генерации, pure JS, без нативных зависимостей; декларативное API (Paragraph/HeadingLevel/Bullet), шрифт — атрибут (Calibri, ATS-безопасный).
- **pdfkit** — классика, pure JS; решающий аргумент: `new PDFDocument({ compress: false })` пишет content-стримы **несжатыми** → текст PDF ассертируется из буфера напрямую (`(строка) Tj`) без тяжёлых экстракторов (pdfjs-dist ~40MB) и без хрупких byte-snapshots. Стандартные шрифты (Helvetica) — без файлов шрифтов; WinAnsi покрывает EN-типографику (— ’ “ ” •).
- (откл.) **@react-pdf/renderer 4.9** — declarative-стили хороши, но React-reconciler+yoga+fontkit тяжёлые, вывод сжат/подмножество шрифтов → контент-тесты требуют pdfjs-dist; метаданные с датами ломают детерминизм снапшотов.
- (откл.) **HTML → PDF через headless Chromium/Playwright** — браузер в web-образе ради одной страницы документов.
- (откл.) **DOCX → PDF конвертер (LibreOffice)** — тяжёлый системный dep, второй рендер-стек.
- (откл.) **рукописный OOXML/PDF** — unmaintainable.

### R2. Размещение: render-модель + оба энкодера в `packages/core` — ✅
DESIGN §3 относит рендер к core-сервисам Generation. Чистые функции (модель — data-mapping, энкодеры — RenderDoc→Buffer, без I/O) живут в core-сьюте (vitest уже настроен, 72 теста). S8 (email dispatch, воркер) получит рендеры бесплатно.
- (откл.) новый пакет `packages/render` — churn в arch-плагине и DESIGN-структуре ради двух файлов (YAGNI, ст. 9.1).
- (откл.) `apps/web/src/lib` (S5-прецедент web-owned) — воркеру потом дублировать; энкодеры чистые, им нечего делать в app-слое.
Новые зависимости — у `packages/core`: `docx`, `pdfkit` (runtime), `fflate` + `@types/pdfkit` (dev: zip-распаковка/типы). STACK.md обновляется (см. Changelog).

### R3. Триггер: ручной из UI, пара форматов одним действием — ✅
Кнопки **DOCX / PDF** в превью валидного артефакта → `POST /api/artifacts/:id/render` → рендерит **оба формата** одним действием (2 artifact-строки render_docx + render_pdf), затем скачивание через `GET /api/artifacts/:id/file`.
- (откл.) авто-рендер после каждой валидной генерации — мусорные рендеры на циклах regenerate и артефактах, которые никогда не уйдут; шум в списке версий.
- (откл.) только батч-скрипт — нет UI, противоречит «пакет в дашборде» (DESIGN 1.1).

### R4. Identity рендера: snapshot в контенте артефакта (additive к S5) — ✅
Документ для работодателя обязан иметь шапку (имя, headline, email, локация). `generateDocuments` с S6 сохраняет в контент `identity` (snapshot на момент генерации): resume → `{diff, resume, identity}`, cover → `{letter, identity}`. Рендер самодостаточен; **fallback для legacy-артефактов** (golden S5): `loadMasterProfile()` → собрать identity из файла; недоступно и то и другое → 503 `MasterIdentityUnavailableError`.
Плюсы: e2e/CI зелёные без gitignored-PII (seed кладёт синтетическую identity в контент); аудируемость (рендер старой версии держит identity того времени — конституция 8.2); identity по-прежнему не входит в промпты (G1 S5 не трогаем).
- (откл.) читать master_profile.json при каждом рендере — рендер зависит от мутабельного внешнего файла, e2e в CI падает (файл gitignored), а подмена файла меняет задним числом документы старых версий.
Identity-тип: `RenderIdentity { fullName, headline?, email?, location? }` — собирается из `identity.full_name/headline/email` + `location_constraints` («Alberta, Canada · Open to relocation across Canada»); availability/work_authorization на документ **не выносятся** (v1; отмечено PO в открытых вопросах).

### R5. Хранение файлов: локальный FS `data/artifacts/`, в БД — только ссылка — ✅
`content_path` — относительный путь от корня хранилища: `{jobId}/{sourceKind}-v{sourceVersion}.{ext}`. Корень: env `ARTIFACTS_DIR`, dev-default `../../data/artifacts` (конвенция WORKDIR apps/web → repo root, как master-профиль). Docker: volume `./data/artifacts:/app/data/artifacts` (rw). `data/` уже gitignored+dockerignored → PII вне git, в БД только ссылка (конституция 3.2). UI получает файлы только потоковым download.
- (откл.) байты в JSONB/bytea — разув БД, ломает контент_path из DESIGN-схемы.

### R6. Схема `artifact`: render-kind'ы + audit-цепочка — ✅
- `kind` CHECK расширяется: `+ 'render_docx' | 'render_pdf'`;
- `llm_run_id` → **NULLable** (у рендера нет LLM-вызова; FK нет — подтверждено схемой S5);
- + `source_artifact_id UUID NULL REFERENCES artifact(id)` — аудиторская цепочка «рендер ← источник» (ст. 8.2); у resume/cover_letter — NULL;
- render-строки: `status='valid'`, `validation='[]'`, `version=1` — **одна строка на (source_artifact, kind)**, upsert по UNIQUE(job_id,kind,version): рендер детерминирован от неизменяемого источника, версии-клоны ничего не добавляют (YAGNI). Файл перезаписывается по тому же пути.
Миграция — идемпотентные statement'ы в `SCHEMA_SQL` (ALTER ... IF EXISTS/IF NOT EXISTS паттерн) + Row-типы.

### R7. Render-модель: промежуточное представление (RenderDoc) — ✅
Чистые билдеры в core: `buildResumeRenderModel(identity, tailored, education)`, `buildCoverRenderModel(identity, letter)` → плоские структуры секций (header/section/paragraph/bullets/skills-group). Энкодеры — тонкое отображение RenderDoc → формат. Это слой snapshot-гейта (DoD DESIGN: «snapshot-тесты артефактов»): vitest toMatchSnapshot модели + контент-гейты обоих энкодеров. Skills рендерятся **сгруппированно** по категориям мастера (labels: Languages/Frontend/Backend/Data & Cloud/Quality/Platform & AI) с сохранением tailored-порядка внутри группы; `keywords` в документ не выводятся (они вплетены в summary/skills генерацией — секция «Keywords» для рекрутера нечитаема).

### R8. UI: минимальная дельта внутри существующей секции — ✅
superdesign-дельта: секция Documents (вариант A) дополняется, без нового экрана: в превью валидного артефакта — блок Download (кнопки DOCX/PDF), render-строки в списке версий (label `Resume · DOCX v1` / `Resume · PDF v1`) с кнопкой Download. Полный superdesign-пасс не проводится: экран существует, изменений — два контрола в существующей панели; выбор вариантов и вёрстка — по DS v1.1 токенам; PO утверждает дифф по снапшотам (G4).

## Контракт

### Типы (packages/core, `src/render-model.ts`)

```ts
export interface RenderIdentity { fullName: string; headline?: string; email?: string; location?: string }

export interface RenderResumeModel {
  identity: RenderIdentity;
  summary: string;
  skillGroups: Array<{ label: string; items: string[] }>;   // категория мастера → tailored-скиллы
  experience: Array<{ title: string; employer: string; period: string; technology: string[]; bullets: string[] }>;
  education: Array<{ line: string }>;                        // degree — institution, year
}
export interface RenderCoverModel { identity: RenderIdentity; paragraphs: string[] }

export function buildResumeRenderModel(identity: RenderIdentity, resume: TailoredResume, masterSkills?: Record<string, string[]>): RenderResumeModel
  // masterSkills опциональны: есть → группировка, нет → одна группа 'Skills'
export function buildCoverRenderModel(identity: RenderIdentity, letter: string): RenderCoverModel
  // letter → абзацы по \n+; пустые отбрасываются
export function renderIdentityFromMaster(raw: unknown): RenderIdentity | null  // из master_profile.json
export function renderIdentityFromContent(content: unknown): RenderIdentity | null // из артефакта
```

### Энкодеры (packages/core, `src/render-docx.ts` / `src/render-pdf.ts`)

```ts
export function encodeResumeDocx(model: RenderResumeModel): Promise<Buffer>
export function encodeCoverDocx(model: RenderCoverModel): Promise<Buffer>
export function encodeResumePdf(model: RenderResumeModel): Buffer   // PDFDocument({ compress:false })
export function encodeCoverPdf(model: RenderCoverModel): Buffer
```
Вёрстка v1: одна колонка, ATS-консервативно; DOCX — Calibri, PDF — Helvetica; header (имя крупно, headline, email · location), секции Summary/Skills/Experience/Education; experience: Title — Employer + period, technology-строка, bullets; cover: шапка + абзацы. Разрывы страниц — естественные (pdfkit auto page-break; docx — потоком).

### Репозиторий/сервис (packages/core + apps/web)

```ts
// core, artifacts.ts:
saveRenderArtifact(db, input: { jobId; sourceArtifactId; kind: 'render_docx'|'render_pdf';
  contentPath: string; sourceVersion: number }): Promise<ArtifactView>   // version=1, upsert
findRenderArtifact(db, sourceArtifactId, kind): Promise<ArtifactView | null>
// web, render-service.ts:
renderArtifact(db, artifactId: string, opts?: { artifactsDir?: string; master?: unknown }):
  Promise<{ artifacts: ArtifactView[]; files: Array<{ kind; path }> }>
  // source = getArtifactContent: kind resume|cover_letter + status valid, иначе RenderNotRenderableError(409)
  // identity = renderIdentityFromContent(content) ?? renderIdentityFromMaster(master ?? loadMasterProfile())
  //   → null: RenderIdentityUnavailableError(503)
  // рендерит ОБА формата, пишет файлы (mkdir -p), upsert 2 строк; идемпотентно
readRenderFile(db, artifactId, opts?): Promise<{ buffer: Buffer; contentType: string; filename: string } | null>
  // только kind render_*; 404 если нет строки/файла
```

### API (apps/web)

```
POST /api/artifacts/:id/render   → 200 { artifacts: ArtifactView[] }       // 2 render-строки
                                 → 404 (нет источника) | 409 (invalid/чужой kind) | 503 (identity)
GET  /api/artifacts/:id/file     → 200 file stream (Content-Type: application/vnd.openxmlformats-...wordprocessingml.document | application/pdf; Content-Disposition: attachment; filename="resume-v2.docx")
                                 → 404 (не render-артефакт / нет файла)
```

### UI (documents-section)

- Превью валидного артефакта: блок Download — кнопки `DOCX` / `PDF` (POST render → then GET file, `data-testid="download-docx|pdf"`); busy-состояние; ошибки — существующий errorBox.
- Список версий: render-строки (label `Resume · DOCX v1`) c кнопкой Download (`data-testid="download-row"`); render-строка НЕ открывает превью-аккордеон (бинарник) — клик по строке = скачивание.

## Acceptance criteria

1. Миграция идемпотентна: свежая БД и живая БД S5 обе получают render-kind'ы, nullable llm_run_id, source_artifact_id; вставка render-строки с source_artifact_id и llm_run_id=NULL работает; FK на source валиден.
2. `buildResumeRenderModel`: снапшот структуры (синтетические данные); сгруппированные скиллы по категориям мастера при переданном masterSkills и одна группа без него; tailored-порядок сохранён; education нормализуется из raw-записей; отсутствующие поля — опциональны, не роняют.
3. `buildCoverRenderModel`: letter → непустые абзацы; снапшот.
4. DOCX-энкодер: буфер = zip (PK-магия), внутри `word/document.xml` содержатся имя, фраза summary, буллет-маркер, работодатель; повторный вызов — детерминированный вывод.
5. PDF-энкодер: `%PDF-` магия; при compress:false текст (`(имя)`, `(фраза)`) читается из буфера; повторный вызов — детерминированный.
6. `renderArtifact`: valid resume/cover → 2 render-строки + 2 файла на диске; повторный вызов — те же строки (upsert, version=1), файл перезаписан; invalid-артефакт → RenderNotRenderableError; resume без identity (ни контент, ни master) → RenderIdentityUnavailableError.
7. API: POST render 200/404/409/503; GET file — 200 c правильными Content-Type/Disposition и байтами файла; 404 для не-render id.
8. E2E: seeded valid resume → кнопки DOCX/PDF в превью → скачивание отрабатывает (download event, файл не пуст); render-строки появляются в списке; e2e проходит в CI **без** master_profile.json (identity из сидированного контента).
9. PII-гейт: rendered файлы — только в gitignored `data/artifacts/`; в коммитах репо ни имён из identity, ни буллетов нет (grep по трекаемым файлам); снапшоты маскируют контент.
10. Вёрстка документов визуально проверена PO на реальном артефакте (golden T8) — «ок»/правки.

## Тест-план

- **Unit** (packages/core/test): render-model билдеры ×2 (снапшоты + кейсы R7), энкодеры ×2 (content-гейты, детерминизм), renderIdentityFrom* .
- **Integration** (tests/integration): миграция (AC1), saveRenderArtifact/findRenderArtifact upsert-семантика, renderArtifact (AC6), readRenderFile.
- **E2E** (tests/e2e): documents.spec расширение — download-флоу, render-строки (AC8); визуальный снапшот секции (дельта — новые контролы).
- **Golden** (scripts, apps/web): рендер всех валидных артефактов живой БД на реальном master-профиле; отчёт: файлы, размеры, единица «4 вакансии × 2 документа × 2 формата»; PO открывает файлы (AC10).

## Метрики

- LLM-стоимость: $0 (рендер без LLM) — в отчёте зафиксировать отсутствие новых llm_run.
- Рендер-факты: количество render-артефактов/файлов, средний размер DOCX/PDF — в S6-report.md.
- Качество: AC10 (визуальная приёмка PO) — единственная качественная метрика инкремента; hallucination-рисков нет (текст артефакта не меняется рендером — байт-в-байт из БД).

## DoD

- [ ] Все AC выполнены; unit/integration/e2e зелёные.
- [ ] lint / arch-lint / colors / kysely / typecheck — 0 нарушений.
- [ ] Docker-образ web пересобран, render+download работают на LAN:3000 (с volume `data/artifacts`).
- [ ] STACK.md changelog (docx, pdfkit, fflate, @types/pdfkit); DESIGN.md не меняется (схема §3.2 уже описывает content_path; факт render_docx — дописать в §3.2 комментарием при T1).
- [ ] Security-аудит инкремента — вывод в S6-report.md (Mimosa-хук + ручная верификация: запись файлов по uuid-путям, отсутствие path-traversal в file-роуте).
- [ ] Отчёт specs/notes/S6-report.md (LLM-расход: $0).
- [ ] Снапшоты до/после (git-lfs) обновлены осознанно (дельта UI).

## Открытые вопросы (решения по умолчанию — PO может переопределить на G6)

1. Шапка документа: v1 = имя, headline, email, «Alberta, Canada · Open to relocation across Canada». Availability («ET/PT core hours») и work_authorization на документ не выносятся. → правка точечная (render-model), если PO решит иначе.
2. Шрифты: DOCX — Calibri, PDF — Helvetica (ATS-консервативно; DS-пара Crimson Pro/Jakarta — только web, не документы).
3. Одна render-строка на (source, format) с перезаписью файла (без версий-клонов производных артефактов). Если PO захочет историю перерендеров —version+=1, замена upsert на append (маленькая правка T5).
