# S21 Implementation Plan — render folder convention + render history

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans. Steps use checkbox syntax.

**Goal:** Человекочитаемые папки рендеров (`YYYY-MM-DD_<employer-slug>_<jobId8>/`) + append-версии рендеров с историей в существующем UI-списке.

**Architecture:** Новая схема пути строится в render-storage (валидация двух схем в safeJoin); версия рендера — max+1 по (job_id, kind) через nextRenderVersion, явная version в saveRenderArtifact (upsert убран); renderArtifact берёт employer из job и строит путь; golden-скрипт становится идемпотентным (skip существующих).

**Tech Stack:** без новых зависимостей.

**Spec:** `specs/S21-render-history.md` (accepted G1 — мандат PO, 2026-09-28).

## Global Constraints

- Legacy uuid-пути обязаны остаться читаемыми (регресс-тесты S6 не меняются в assertions пути).
- Валидация путей: папка = uuid ИЛИ `^\d{4}-\d{2}-\d{2}_[a-z0-9-]+_[0-9a-f]{8}$`; файл — прежний whitelist.
- PII: в пути только slug работодателя и 8-hex вакансии; никаких email/полных имён.
- Каждый багфикс — красный тест; Kysely — только с `.execute()`.

---

### Task 1: renderFolderName + FOLDER_RE в render-storage

**Files:** Modify `apps/web/src/lib/render-storage.ts`; Test `tests/integration/render-artifacts.test.ts`
**Interfaces (produces):** `renderFolderName(now: Date, employer: string, jobId: string): string`.

- [ ] **Step 1: RED** — тесты: `'Neo Financial'` + uuid → `2026-09-28_neo-financial_a1b2c3d4` (дата фиксированная); `'ACME  Corp! (EU)'` → `acme-corp-eu`; `''`/`'???'` → `job`; job8 = первые 8 hex uuid lowercase.
- [ ] **Step 2: FAIL → Step 3: GREEN**:

```ts
const FOLDER_RE = /^\d{4}-\d{2}-\d{2}_[a-z0-9-]+_[0-9a-f]{8}$/;
export function employerSlug(employer: string): string {
  const slug = employer.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return slug === '' ? 'job' : slug;
}
export function renderFolderName(now: Date, employer: string, jobId: string): string {
  const y = now.getUTCFullYear(); const m = String(now.getUTCMonth() + 1).padStart(2, '0'); const d = String(now.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}_${employerSlug(employer)}_${jobId.slice(0, 8)}`;
}
```
  safeJoin: `if (!(UUID_RE.test(jobFolder) || FOLDER_RE.test(jobFolder))) return null;`
- [ ] **Step 4: PASS**; commit `S21 T1: render folder convention (date_slug_id8) + dual-scheme validation`.

---

### Task 2: Репозиторий — nextRenderVersion, явная версия, findRenderArtifact → последняя

**Files:** Modify `packages/core/src/artifacts.ts`, `src/index.ts`; Test `tests/integration/render-artifacts.test.ts`
**Interfaces:** `nextRenderVersion(db, jobId, kind): Promise<number>`; `saveRenderArtifact(input: {..., version: number})` (без onConflict); `findRenderArtifact` → `orderBy('version','desc').executeTakeFirst()`.

- [ ] **Step 1: RED** — integration: saveRenderArtifact(version 1) → saveRenderArtifact(version 2) → обе строки, обе с content_path; nextRenderVersion → 3; findRenderArtifact → v2; insert version=1 повторно → rejects (UNIQUE).
- [ ] **Step 2: FAIL → Step 3: GREEN** (max-запрос как в saveArtifact; insert без onConflict, version из input).
- [ ] **Step 4: PASS**; commit `S21 T2: append render versions (nextRenderVersion, explicit version, latest findRenderArtifact)`.

---

### Task 3: renderArtifact — новая схема + история; golden skip

**Files:** Modify `apps/web/src/lib/render-service.ts`, `apps/web/src/scripts/render-documents.ts`; Test `tests/integration/render-artifacts.test.ts`
**Interfaces:** renderArtifact: job.employer select → folder = renderFolderName(new Date(), employer, jobId) → для каждого format: v = nextRenderVersion → file `kind-dash-v{v}.{ext}` → saveRenderFile → saveRenderArtifact({version: v}). Скрипт: перед рендером `findRenderArtifact(src.id, 'docx')` — если не null → skip.

- [ ] **Step 1: RED** — integration: renderArtifact дважды → 4 строки (docx v1,v2 + pdf v1,v2), content_path матчит `^\d{4}-\d{2}-\d{2}_alex-fixture-?*_[0-9a-f]{8}/resume-v2.docx$` (вторая пара — версия 2, путь другой папки допустим: дата та же, папка совпадает), оба файла существуют; readRenderFile обеих версий ок; legacy-тест uuid-пути из S6 остаётся зелёным (без изменений).
- [ ] **Step 2: FAIL → Step 3: GREEN.** Обратить внимание: имя папки в тесте — синтетический employer 'Fixture Corp' → `fixture-corp`.
- [ ] **Step 4:** golden-скрипт: skip-логика + smoke (второй прогон на тестовой БД с существующими рендерами → 0 rendered). commit `S21 T3: dated render folders + versioned render history; idempotent golden script`.

---

### Task 4: E2E история + гейты + golden + отчёт

**Files:** Test `tests/e2e/documents.spec.ts`; Create `specs/notes/S21-report.md`

- [ ] **Step 1: RED e2e** — расширить тест 'render row click downloads': после второго клика DOCX-кнопки в списке 2 render-строки DOCX (v1, v2), клик по v1 скачивает.
- [ ] **Step 2: GREEN** — UI менять не ожидается; если label/сортировка ломаются — минимальный фикс.
- [ ] **Step 3:** гейты: lint, arch-lint, typecheck, pnpm test, core vitest, integration, e2e (полный).
- [ ] **Step 4:** golden `pnpm --filter @chinook/web render:documents` на живой БД: новые версии по новой схеме; повторный прогон — 0 новых (skip). Проверить ls data/artifacts.
- [ ] **Step 5:** S21-report.md (AC-таблица, цифры, папки до/после). commit `S21 T4: e2e history + gates + golden + report`.

## Self-Review

- AC1→T1; AC2→T1; AC3→T2; AC4→T2; AC5→T3; AC6→T4; AC7→T3; AC8→T1 (slug-тесты). Типы: renderFolderName/nextRenderVersion/saveRenderArtifact.version/findRenderArtifact — согласованы T1→T3. Пустот нет.
