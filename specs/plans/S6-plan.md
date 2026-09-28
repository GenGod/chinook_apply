# S6 Implementation Plan — artifact rendering (DOCX + PDF)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Детерминированный рендер валидных артефактов S5 (tailored resume / cover letter) в DOCX и PDF с хранением файлов в gitignored `data/artifacts/`, download-флоу из UI и snapshot/content-гейтами.

**Architecture:** Чистая render-модель (RenderDoc) + два энкодера в `packages/core` (docx 9.8.0, pdfkit 0.20.2, `compress:false`); identity берётся из snapshot'а в контенте артефакта (additive к S5) с fallback на master-файл; render-артефакты — kind'ы `render_docx`/`render_pdf`, по одной upsert-строке на (source, format), `content_path` — колонка (DESIGN §3.2), `source_artifact_id` — аудиторская цепочка; ручной триггер из UI (POST render → GET file).

**Tech Stack:** pnpm monorepo, Kysely + Postgres, zod, vitest, Playwright, docx, pdfkit, fflate (dev: zip-распаковка тестов).

**Spec:** `specs/S6-rendering.md` (accepted G1 2026-09-28 — мандат PO «реализуй S6»).

## Global Constraints

- PII: рендеренные файлы — только в gitignored `data/artifacts/`; в тестах/коммитах — синтетические identity/буллеты; real master в тесты не грузится (конституция 3.2, AC9).
- Рендер — без LLM: не создаёт `llm_run`, стоимость $0; текст документа байт-в-байт из контента артефакта (никаких переформулировок).
- Каждый багфикс — красный тест. Kysely-билдеры — только с `.execute()` (гейт check-kysely). UI-цвета — только токены (гейт check-colors).
- Миграции — идемпотентные statement'ы в `SCHEMA_SQL` (packages/core/src/db.ts): финальная форма в `CREATE TABLE` + ALTER'ы для живых БД.
- PDF — `new PDFDocument({ compress: false, useObjectStreams: false, info: {...фикс. даты} })` → текст читаем из буфера (`(строка) Tj`); маркеры-ассерты ≤ 30 символов (не порвутся при wrap).
- env/пути: `ARTIFACTS_DIR` (default `../../data/artifacts`, cwd = apps/web — та же конвенция, что `DEFAULT_MASTER_PATH`); путь файла = `{jobId}/{source-kind-dash}-v{sourceVersion}.{ext}`, content_path — относительный; readRenderFile валидирует `resolved.startsWith(resolvedDir)` (path-traversal защита).

---

### Task 1: Миграция render-kind'ов + Row-типы + ArtifactView.sourceArtifactId

**Files:**
- Modify: `packages/core/src/db.ts` (ArtifactRow ~стр. 68, SCHEMA_SQL ~стр. 201)
- Modify: `packages/core/src/artifacts.ts` (ArtifactView, toView, listArtifacts, getArtifactContent)
- Test: `tests/integration/render-artifacts.test.ts` (создать)

**Interfaces (produces):**
- `ArtifactRow`: `llm_run_id: number | null; source_artifact_id: string | null; content_path: string | null` (остальное как было).
- `ArtifactView` += `sourceArtifactId: string | null`.
- SQL (идемпотентно, в SCHEMA_SQL после CREATE artifact):
```sql
ALTER TABLE artifact DROP CONSTRAINT IF EXISTS artifact_kind_check;
ALTER TABLE artifact ADD CONSTRAINT artifact_kind_check
  CHECK (kind IN ('resume', 'cover_letter', 'render_docx', 'render_pdf'));
ALTER TABLE artifact ALTER COLUMN llm_run_id DROP NOT NULL;
ALTER TABLE artifact ADD COLUMN IF NOT EXISTS source_artifact_id UUID REFERENCES artifact(id);
ALTER TABLE artifact ADD COLUMN IF NOT EXISTS content_path TEXT;
```
  CREATE TABLE artifact — финальная форма: 4 kind'а, `llm_run_id BIGINT`, `content_path TEXT`, `source_artifact_id UUID REFERENCES artifact(id)`.

- [ ] **Step 1: RED — тест миграции и вставки render-строки** (`tests/integration/render-artifacts.test.ts`):

```ts
import { describe, it, expect, beforeAll } from 'vitest';
import { createDb, ensureSchema, saveArtifact, type Database } from '@chinook/core';
import type { Kysely } from 'kysely';

const db: Kysely<Database> = createDb(
  process.env.DATABASE_URL ?? 'postgres://chinook:chinook_dev@localhost:5433/chinook_test',
);
beforeAll(async () => { await ensureSchema(db); });

describe('artifact schema (S6 migration)', () => {
  it('accepts a render row with llm_run_id NULL and a source FK', async () => {
    const { randomUUID } = await import('node:crypto');
    const src = await saveArtifact(db, {
      jobId: randomUUID(), kind: 'resume', status: 'valid',
      content: { letter: 'x' }, validation: { valid: true, violations: [] }, llmRunId: 1,
    }); // job_id — несуществующий uuid: FK job отсутствует → используем реальную job
    // ↑ если FK job(id) роняет — взять first job id из job (см. Step 1a ниже)
    const id = randomUUID();
    await db.insertInto('artifact').values({
      id, job_id: src.jobId, kind: 'render_docx', version: 1, status: 'valid',
      content: JSON.stringify({}), validation: JSON.stringify({ valid: true, violations: [] }),
      llm_run_id: null, source_artifact_id: src.id, content_path: `${src.jobId}/resume-v1.docx`,
    }).execute();
    const row = await db.selectFrom('artifact').selectAll().where('id', '=', id).executeTakeFirstOrThrow();
    expect(row.llm_run_id).toBeNull();
    expect(row.source_artifact_id).toBe(src.id);
    expect(row.content_path).toBe(`${src.jobId}/resume-v1.docx`);
  });
  it('rejects an unknown kind', async () => {
    const { randomUUID } = await import('node:crypto');
    const job = (await db.selectFrom('job').select('id').limit(1).executeTakeFirst());
    if (!job) return;
    await expect(db.insertInto('artifact').values({
      id: randomUUID(), job_id: job.id, kind: 'render_xlsx' as never, version: 1, status: 'valid',
      content: JSON.stringify({}), validation: JSON.stringify({ valid: true, violations: [] }), llm_run_id: null,
    }).execute()).rejects.toThrow();
  });
});
```
  Step 1a: `saveArtifact` требует существующий job_id (FK) — в тесте сначала `select id from job limit 1`; если БД пустая — `expect` только миграционных полей через прямую вставку с произвольным uuid... НЕТ: FK job(id) всё равно валидируется. Корректно: пропускать тест если нет job (`if (!job) return;`), job есть всегда (seed S1). Итоговый тест берёт `jobId = job.id`.

- [ ] **Step 2: Run** `cd tests && npx vitest run integration/render-artifacts.test.ts` — FAIL (колонки нет / CHECK не пускает / NOT NULL на llm_run_id).
- [ ] **Step 3: GREEN** — SQL выше в SCHEMA_SQL + финальная форма CREATE TABLE + Row-типы + `sourceArtifactId` в ArtifactView/toView/listArtifacts-select (`expect(row.source_artifact_id)` в list-тесте дописать в artifact-repo.test.ts при правке). commit `S6 T1: artifact render migration + row types`.

---

### Task 2: render-модель (core) — билдеры + identity-парсеры

**Files:**
- Create: `packages/core/src/render-model.ts`
- Test: `packages/core/test/render-model.test.ts`
- Modify: `packages/core/src/index.ts` (export)

**Interfaces (produces):** как в спеке (RenderIdentity, RenderResumeModel, RenderCoverModel, buildResumeRenderModel(identity, resume, masterSkills?), buildCoverRenderModel(identity, letter), renderIdentityFromMaster(raw), renderIdentityFromContent(content)).
- Группировка скиллов: `SKILL_LABELS: Record<string,string> = { languages: 'Languages', frontend: 'Frontend', backend: 'Backend', data_and_cloud: 'Data & Cloud', quality: 'Quality & Testing', platform_and_ai: 'Platform & AI' }`; порядок категорий — ключи masterSkills; внутри категории — порядок tailored.skills; остаток (не найден в категориях) → группа 'Other' в конце. Без masterSkills — одна группа `[{ label: 'Skills', items: skills }]`.
- experience: `period = start && end ? \`${start} — ${end}\` : (start || end)`; technology/bullets — копии; education: `line` из полей degree/institution/school/year (`degree — institution · year`, пропуская отсутствующие).
- renderIdentityFromMaster: identity.full_name обязателен; headline/email; location из location_constraints: `target_province` + `', Canada'`; если `relocation` — ` · ${relocation}`.
- renderIdentityFromContent: `(content as {identity?}).identity` структурно: fullName строка → RenderIdentity (поля опциональны); иначе null.

- [ ] **Step 1: RED** — тесты: (a) снапшот `buildResumeRenderModel` с синтетическим TailoredResume+masterSkills (toMatchInlineSnapshot заполнить при первом прогоне, потом зафиксировать); (b) группировка: категории мастера, tailored-порядок, остаток → 'Other'; (c) без masterSkills — одна группа; (d) education line; (e) buildCoverRenderModel: абзацы из letter (\n\n), пустые отброшены; (f) renderIdentityFromMaster: полный raw → поля, location-сборка; нет full_name → null; (g) renderIdentityFromContent: {identity:{fullName:'A'}} → объект; {} → null.
- [ ] **Step 2: Run** `cd packages/core && npx vitest run test/render-model.test.ts` — FAIL (модуля нет).
- [ ] **Step 3: GREEN** — реализация. **Step 4: PASS**, export в index.ts. commit `S6 T2: render model builders + identity parsers`.

---

### Task 3: DOCX-энкодер (core)

**Files:**
- Modify: `packages/core/package.json` (+ `docx: ^9.8.0` deps, `fflate: ^2.0.0` devDeps) → `pnpm install`
- Create: `packages/core/src/render-docx.ts`
- Test: `packages/core/test/render-docx.test.ts`
- Modify: `packages/core/src/index.ts`

**Interfaces (produces):** `encodeResumeDocx(model: RenderResumeModel): Promise<Buffer>`, `encodeCoverDocx(model: RenderCoverModel): Promise<Buffer>`.
- docx v9: `import { Document, Packer, Paragraph, TextRun, HeadingLevel, AlignmentType } from 'docx'`; шрифт Calibri через styles default (`styles: { default: { document: { run: { font: 'Calibri' } } } }`).
- Структура: имя (title, size 32 half-points → size: 32), headline, контактная строка (email · location); секции HeadingLevel.HEADING_1 (Summary/Skills/Experience/Education); skills — по группам: bold label + `: items.join(', ')`; experience — `title — employer` + период, technology-строка, bullets — `bullet: { level: 0 }`; cover — шапка + абзацы.

- [ ] **Step 1: RED**:

```ts
import { describe, it, expect } from 'vitest';
import { unzipSync } from 'fflate';
import { encodeResumeDocx, encodeCoverDocx } from '../src/render-docx.js';
import { buildResumeRenderModel, buildCoverRenderModel, type RenderIdentity } from '../src/render-model.js';

const identity: RenderIdentity = { fullName: 'Alex Fixture', headline: 'Senior Developer', email: 'alex@example.com', location: 'Alberta, Canada' };
const model = buildResumeRenderModel(identity, {
  summary: 'Platform engineer with 10 years of experience.',
  keywords: [], skills: ['TypeScript', 'PostgreSQL'],
  experience: [{ employer: 'Fixture Corp', title: 'Senior Developer', start: '2020', end: 'present', technology: ['TypeScript'], bullets: ['Owned the platform serving 40k users.'] }],
  education: [{ degree: 'B.Sc. Computer Science', school: 'Fixture University', year: '2014' }],
}, { frontend: ['TypeScript'], backend: ['PostgreSQL'] });

function docXml(buf: Buffer): string {
  const files = unzipSync(new Uint8Array(buf));
  return new TextDecoder().decode(files['word/document.xml']!);
}

describe('encodeResumeDocx', () => {
  it('is a zip containing the identity, summary and bullet text', async () => {
    const buf = await encodeResumeDocx(model);
    expect(buf.subarray(0, 2).toString('latin1')).toBe('PK');
    const xml = docXml(buf);
    expect(xml).toContain('Alex Fixture');
    expect(xml).toContain('Platform engineer with 10 years of experience.');
    expect(xml).toContain('Owned the platform serving 40k users.');
    expect(xml).toContain('Fixture Corp');
  });
  it('is deterministic', async () => {
    expect(await encodeResumeDocx(model)).toEqual(await encodeResumeDocx(model));
  });
});
describe('encodeCoverDocx', () => { /* шапка 'Alex Fixture' + абзац 'Dear Hiring Manager' + детерминизм */ });
```
- [ ] **Step 2: Run** — FAIL. **Step 3: GREEN.** **Step 4: PASS**; commit `S6 T3: docx encoder`.

---

### Task 4: PDF-энкодер (core)

**Files:**
- Modify: `packages/core/package.json` (+ `pdfkit: ^0.20.2` deps, `@types/pdfkit` devDeps) → `pnpm install`
- Create: `packages/core/src/render-pdf.ts`
- Test: `packages/core/test/render-pdf.test.ts`
- Modify: `packages/core/src/index.ts`, `apps/web/next.config.ts` (`serverExternalPackages: ['pdfkit']` — CJS c динамическими require, не бандлить)

**Interfaces (produces):** `encodeResumePdf(model): Buffer`, `encodeCoverPdf(model): Buffer`.
- `import PDFDocument from 'pdfkit'` (CJS default interop); `new PDFDocument({ compress: false, useObjectStreams: false, size: 'A4', margins: { top: 54, bottom: 54, left: 54, right: 54 }, info: { CreationDate: new Date(Date.UTC(2026, 0, 1)), ModDate: new Date(Date.UTC(2026, 0, 1)) } })`.
- Сборка в Buffer: `const chunks: Buffer[] = []; doc.on('data', (c: Buffer) => chunks.push(c)); const done = new Promise<Buffer>(res => doc.on('end', () => res(Buffer.concat(chunks)))); ... doc.end(); return done;`
- Шрифты: 'Helvetica' / 'Helvetica-Bold' (стандартные, WinAnsi покрывает EN-типографику). Layout: имя 20pt bold; headline 10pt; контакт 9pt; секционные заголовки 11pt bold с moveDown; текст 10pt, bullets — `doc.text(b, { indent: 14, bulletRadius: 1.5 })` (pdfkit-буллеты) или '• ' префикс с hanging indent — выбрать работающий вариант при реализации, зафиксировать в тесте текстом.

- [ ] **Step 1: RED**:

```ts
import { describe, it, expect } from 'vitest';
import { encodeResumePdf, encodeCoverPdf } from '../src/render-pdf.js';
// модель — из render-model.test.ts fixtures (скопировать конструктор, данные те же)

function pdfText(buf: Buffer): string { return buf.toString('latin1'); } // compress:false → строки читаемы

describe('encodeResumePdf', () => {
  it('has PDF magic and contains identity/summary/bullet text', () => {
    const buf = encodeResumePdf(model);
    expect(buf.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    const text = pdfText(buf);
    expect(text).toContain('(Alex Fixture)');            // короткие маркеры — не рвутся wrap'ом
    expect(text).toContain('(Owned the platform');       // начало буллета
    expect(text).toContain('(Fixture Corp)');
  });
  it('is deterministic', () => {
    expect(encodeResumePdf(model)).toEqual(encodeResumePdf(model));
  });
  it('paginates: 6 experience entries produce >= 2 pages', () => {
    const long = buildResumeRenderModel(identity, { ...tailored, experience: Array.from({ length: 6 }, (_, i) => ({ employer: `Corp ${i}`, title: 'Dev', start: '2020', end: 'present', technology: [], bullets: ['Did things.'] })) });
    const buf = encodeResumePdf(long);
    expect(pdfText(buf)).toMatch(/\/Count 2/); // /Type /Pages /Count N — толькко эмпирически: маркер '/Count 2'
  });
});
```
  Контингенция: если строка рвётся экранированием скобок/переносом — маркеры короче (слово). Если детерминизм падает на trailer `/ID` или датах — зафиксировать находку, ослабить до «same length + same markers» с комментом (факт — в отчёт).
- [ ] **Step 2: Run** — FAIL. **Step 3: GREEN.** **Step 4: PASS**; commit `S6 T4: pdf encoder (compress:false content gate)`.

---

### Task 5: Репозиторий render-артефактов (core)

**Files:**
- Modify: `packages/core/src/artifacts.ts`
- Test: `tests/integration/render-artifacts.test.ts` (расширить)

**Interfaces (produces):**
- `saveRenderArtifact(db, input: { jobId: string; sourceArtifactId: string; sourceKind: 'resume'|'cover_letter'; sourceVersion: number; format: 'docx'|'pdf'; contentPath: string }): Promise<ArtifactView>`
  kind = `render_${format}`; version = 1; upsert `.onConflict(oc => oc.columns(['job_id','kind','version']).doUpdateSet({...}))`; content = `{ format, sourceVersion, sourceKind }`; content_path = input.contentPath; llm_run_id = null.
- `findRenderArtifact(db, sourceArtifactId: string, format: 'docx'|'pdf'): Promise<ArtifactView | null>`

- [ ] **Step 1: RED**: сохранение → view c kind render_docx, version 1, sourceArtifactId; повторное сохранение (тот же source+format) → id/версия не растут, content_path обновился; findRenderArtifact находит/не находит.
- [ ] **Step 2: FAIL → Step 3: GREEN → Step 4: PASS**; commit `S6 T5: render artifact repository (upsert per source+format)`.

---

### Task 6: render-сервис (apps/web) — оркестрация + файлы

**Files:**
- Create: `apps/web/src/lib/render-service.ts`
- Modify: `apps/web/src/lib/generation-service.ts` (identity snapshot в контент + export loadMasterIdentity)
- Test: `tests/integration/render-artifacts.test.ts` (расширить)

**Interfaces:**
- `export class RenderNotRenderableError extends Error { readonly status = 409 }` — source нет / invalid / render-kind.
- `export class RenderIdentityUnavailableError extends Error { readonly status = 503 }`.
- `export async function renderArtifact(db, artifactId: string, opts?: { artifactsDir?: string; master?: unknown }): Promise<{ artifacts: ArtifactView[] }>`
  Пайплайн: `getArtifactContent` → kind resume: `content.resume` (TailoredResume-шейп), cover: `content.letter`; статус не valid или render-kind → RenderNotRenderableError. identity: `renderIdentityFromContent(content) ?? renderIdentityFromMaster(opts?.master ?? loadMasterIdentity())`; null → RenderIdentityUnavailableError. Модель: `buildResumeRenderModel(identity, resume, masterSkillsFrom(opts))` (masterSkills из master-файла/opts.master.skills если есть; из content — нет) / `buildCoverRenderModel`. Файлы: `dir = opts?.artifactsDir ?? process.env.ARTIFACTS_DIR ?? '../../data/artifacts'`; для обоих форматов: `contentPath = \`${jobId}/${sourceKindDash}-v${sourceVersion}.${ext}\`` (sourceKindDash: resume | cover-letter), `writeFile(join(resolve(dir), ...path))` c `mkdir(recursive)`, `encodeResumeDocx/Pdf`, `saveRenderArtifact`. job_id для saveRenderArtifact — из ArtifactContent (добавить jobId в getArtifactContent return — там уже select id, job_id... getArtifactContent не возвращает jobId — добавить `jobId` в return + select).
- `export async function readRenderFile(db, artifactId: string, opts?: { artifactsDir?: string }): Promise<{ buffer: Buffer; contentType: string; filename: string } | null>` — строка kind render_* иначе null; `content_path` → `join(rootDir, p)`; guard `resolved.startsWith(resolve(rootDir) + sep)`; readFile; contentType/filename из kind/content_path.
- generation-service: `loadMasterIdentity(): RenderIdentity | null` — readFileSync(DEFAULT_MASTER_PATH) → renderIdentityFromMaster; generateDocuments сохраняет identity в контент: resume `{diff, resume, identity}`, cover `{letter, identity}` (identity = renderIdentityFromMaster(raw master normalized? raw!) — loadMasterProfile теряет identity → читать raw заново через loadMasterIdentity() и хранить; если null — поле identity не пишется (рендер уйдёт в 503 — осознанно: без master-файла генерация и так невозможна, т.к. master null → 500). Точнее: `const renderIdentity = loadMasterIdentity();` и если non-null — писать в контент.

- [ ] **Step 1: RED** (integration, `artifactsDir: tmpdir()`: valid resume seeded с identity в контенте → 2 render-строки + 2 файла (PK / %PDF- магия); повторный renderArtifact → те же 2 id (upsert), файлы перезаписаны; valid cover без identity в контенте + opts.master raw-объект с identity → рендер ок; без того и другого → RenderIdentityUnavailableError; invalid → RenderNotRenderableError; readRenderFile: buffer совпадает с файлом, contentType по kind, чужой content_path (`../x.docx` в content_path) → null (guard); readRenderFile не-render id → null).
- [ ] **Step 2: FAIL → Step 3: GREEN → Step 4: PASS**; commit `S6 T6: render service (identity snapshot, file storage, traversal guard)`.

---

### Task 7: API routes (apps/web)

**Files:**
- Create: `apps/web/app/api/artifacts/[id]/render/route.ts`
- Create: `apps/web/app/api/artifacts/[id]/file/route.ts`
- Test: `tests/integration/render-artifacts.test.ts` (smoke: GET file 404 на не-render id — route-логика через service уже покрыта)

- [ ] render route (POST): паттерн artifacts/[id]/route.ts — uuid zod; `renderArtifact(db, id)`; ошибки → 404 (не найден), 409 RenderNotRenderableError, 503 RenderIdentityUnavailableError, 500 прочее (console.error без контента).
- [ ] file route (GET): uuid; `readRenderFile` → null: 404; иначе `new Response(new Uint8Array(buffer), { headers: { 'content-type': contentType, 'content-disposition': \`attachment; filename="${filename}"\` } })` (filename — basename из uuid-путей, без PII).
- [ ] Run integration PASS; commit `S6 T7: render + file download API routes`.

---

### Task 8: UI Documents — Download-флоу + e2e

**Files:**
- Modify: `apps/web/app/job/[id]/documents-section.tsx`
- Modify: `apps/web/app/job/[id]/documents.module.css`
- Modify: `packages/core/src/seed.ts` (синтетическая identity в контент сидированных артефактов)
- Test: `tests/e2e/documents.spec.ts` (расширить)

**Поведение:**
- `KIND_LABEL` + render-метки: `labelFor(a: ArtifactView)`: render_docx/pdf → `\`${sourceLabel} · ${DOCX|PDF}\`` (sourceLabel по a.sourceArtifactId в списке, fallback 'Document'); render-строка: клик = скачивание (не аккордеон), в rowMeta — `Rendered <дата>`.
- Превью валидного артефакта: блок Download (`styles.downloadRow`): кнопки `DOCX` / `PDF` (`data-testid="download-docx|pdf"`, класс styles.btn): onClick → busy → POST `/api/artifacts/${open.id}/render` → обновить список → anchor-click на `/api/artifacts/${row.id}/file` (по kind). Ошибки → существующий errorBox.
- seed.ts: syntheticResumeContent += `identity: { fullName: 'Alex Fixture', headline: 'Senior Developer', email: 'alex.fixture@example.com', location: 'Alberta, Canada' }`; syntheticCoverContent += та же identity.

- [ ] **Step 1: RED e2e** (documents.spec.ts добавить):
```ts
test('valid artifact exposes DOCX/PDF downloads and render rows appear', async ({ page }) => {
  await openSeededJob(page);
  await page.getByTestId('artifact-row').filter({ hasText: 'Resume' }).click();
  await expect(page.getByTestId('download-docx')).toBeEnabled();
  const download = page.waitForEvent('download');
  await page.getByTestId('download-docx').click();
  const dl = await download;
  expect((await dl.path()) ?? '').not.toBe('');
  // render rows appear in the list
  const rows = page.getByTestId('documents').getByTestId('artifact-row');
  await expect(rows.filter({ hasText: 'Resume · DOCX' })).toHaveCount(1);
  await expect(rows.filter({ hasText: 'Resume · PDF' })).toHaveCount(1);
});
test('render row click downloads the file', async ({ page }) => { /* seeded render row → click → download event */ });
```
  (второй тест: первый тест уже создал render-строки в БД e2e? БД персистентна между спеками? seed пересоздаётся на каждый прогон `seed:e2e` — render-строки не сидируются → сидировать их в seed.ts напрямую нельзя (файлы писать нельзя) → в тесте 1 клик создаёт их; тест 2 зависит от теста 1 (workers=1, порядок файловый) — либо тест 2 выполняет клик по DOCX-кнопке сам и потом кликает по render-строке. ОК: тест 2 сам создаёт рендер кликом по кнопке, затем кликает render-строку → download.)
- [ ] **Step 2: Run e2e** — FAIL. **Step 3: GREEN** (компонент+css+seed). **Step 4: e2e полный PASS**; снапшот documents-секции осознанно обновить (`pnpm e2e:update-snapshots` — только documents-тесты: `--update-snapshots` на spec-файл), дифф = новые контролы. commit `S6 T8: Documents download flow + e2e`.

---

### Task 9: Golden render + отчёт + гейты + деплой

**Files:**
- Create: `apps/web/src/scripts/render-documents.ts` (+ `"render:documents": "tsx --env-file-if-exists=../../.env src/scripts/render-documents.ts"`)
- Create: `specs/notes/S6-report.md`; Modify: `STACK.md`, `DESIGN.md` (§3.2 kind-строка)

- [ ] Скрипт: по живой БД — все валидные resume/cover артефакты без render-строк (или все — upsert идемпотентен) → renderArtifact; вывод: количество, размеры файлов, суммарно; **контент не печатать** (PII).
- [ ] Прогон на живой БД (мастер-профиль PO): 4 golden-вакансии × 2 документа × 2 формата = 16 render-артефактов; PO открывает файлы (AC10).
- [ ] Гейты: `pnpm lint && pnpm arch-lint && pnpm typecheck && pnpm test` + core-тесты (`cd packages/core && npx vitest run`) + integration (`cd tests && npx vitest run integration`) + e2e.
- [ ] STACK.md changelog 2.3: docx 9.8.0, pdfkit 0.20.2, fflate dev, @types/pdfkit (PO-мандат «реализуй S6», DESIGN §3.1). DESIGN.md §3.2: kind(resume|cover_letter|render_docx|render_pdf), content_path, source_artifact_id.
- [ ] Docker: `docker compose build web && docker compose up -d web` (volume `./data/artifacts:/app/data/artifacts` добавить в docker-compose.yml + env ARTIFACTS_DIR не нужен — dev-default совпадает).
- [ ] S6-report.md: DoD, цифры, security (Mimosa-хук + ручная верификация: traversal-guard, PII-гейт grep), $0 LLM.
- [ ] commit `S6 T9: golden render + report + docs`; push → G6.

## Self-Review

- **Spec coverage:** R1→T3/T4; R2→T2-T4; R3→T7/T8; R4→T2(identity-парсеры)/T6(loadMasterIdentity+snapshot)/T8(seed); R5→T6/T9; R6→T1/T5; R7→T2/T3/T4; R8→T8; контракт API→T7; AC1→T1; AC2-3→T2; AC4→T3; AC5→T4; AC6→T6; AC7→T7; AC8→T8; AC9→T9+гейты; AC10→T9. Пустот нет.
- **Placeholders:** «выбрать работающий вариант буллетов» в T4 — локальная вилка с фиксацией в тесте (тип pdfkit-буллетов проверяется живым прогоном; оба варианта приведены). Контингенции T4 описаны.
- **Type consistency:** RenderIdentity/RenderResumeModel/RenderCoverModel (T2) → T3/T4/T6/T8; saveRenderArtifact/findRenderArtifact (T5) → T6; ArtifactView.sourceArtifactId (T1) → T5/T8; getArtifactContent+jobId (T6) → T6/T7; kind-строки render_docx/render_pdf едины.
