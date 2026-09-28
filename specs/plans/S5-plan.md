# S5 Implementation Plan — tailored resume + cover letter generation

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Генерация адаптированного резюме (дифф+rephrase с сохранением сущностей) и cover letter под вакансию, с блокирующим fact-check, хранением версий и UI-секцией Documents.

**Architecture:** LLM (glm-5.3, role 'main') возвращает строгий дифф; код валидирует (детерминированные проверки сущностей), собирает финальное резюме и сохраняет артефакт с версией; ручной триггер из UI; до 2 попыток с инъекцией нарушений во вторую.

**Tech Stack:** pnpm monorepo, Next.js 16 App Router, Kysely + Postgres, zod, vitest, Playwright. Без новых зависимостей.

**Spec:** `specs/S5-generation.md` (approved G1, 2026-09-23).

## Erratum к спеке (утверждается PO вместе с планом)

Спека R2 говорила «artifact.application_id + ensure application row status=new».
Код-ревизия показала: колонка New борда = вакансии БЕЗ application-строки
(`getBoard`, board.ts:105-117 — NOT EXISTS), а возврат в New **удаляет** строку
→ FK cascade снёс бы артефакты. Корректно: **`artifact.job_id UUID FK → job(id)`**
(job-строки стабильны, артефакты переживают любые переходы канбана).
Единственное изменение контракта — якорь; всё остальное по спеке.

## Global Constraints

- Все LLM-вызовы — только через шлюз S3 (`llm.call`), stage
  `generate_resume`/`generate_cover`, role `main`. Прямых fetch к API — нет.
- PII (контент артефактов) — только в таблице `artifact`; в логах/промпт-хэшах/
  тест-фикстурах коммитов — никогда (конституция 3.2; AC8 спеки).
- Каждый багфикс — красный тест. Kysely-билдеры — только с `.execute()`
  (гейт check-kysely). Цвета — только из tokens.css (гейт check-colors).
- Миграции — идемпотентные `CREATE TABLE IF NOT EXISTS` в `SCHEMA_SQL`
  (packages/core/src/db.ts) + Row-тип + запись в `Database`.
- UI: цвета/токены из DS v1.1; снапшоты Playwright — маскировать контент
  артефактов.

---

### Task 1: Миграция — таблица artifact + Row-типы

**Files:**
- Modify: `packages/core/src/db.ts` (ArtifactRow ~строка 90, Database, SCHEMA_SQL)
- Test: `tests/integration/artifact-repo.test.ts`

**Interfaces (produces):**
- `ArtifactRow { id: Generated<string>; job_id: string; kind: string; version: number; status: string; content: unknown; validation: unknown; llm_run_id: number; created_at: Generated<Date> }`
- `Database.artifact: ArtifactRow`
- kind ∈ `'resume' | 'cover_letter'`; status ∈ `'valid' | 'invalid'`

- [ ] **Step 1: RED — интеграционный тест на создание схемы и таблицы**

```ts
// tests/integration/artifact-repo.test.ts
import { describe, it, expect, beforeAll } from 'vitest';
import { createDb, ensureSchema } from '@chinook/core';
import { sql } from 'kysely';

const db = createDb(process.env.DATABASE_URL!);

beforeAll(async () => { await ensureSchema(db); });

describe('artifact table', () => {
  it('exists after ensureSchema and accepts a row', async () => {
    const job = (await sql`select id from job limit 1`.execute(db)).rows[0] as { id: string } | undefined;
    if (!job) return; // empty db — schema check only
    await sql`delete from artifact where job_id = ${job.id}`.execute(db);
    await sql`insert into artifact (job_id, kind, version, status, content, validation, llm_run_id)
      values (${job.id}, 'resume', 1, 'valid', '{"summary":"x"}'::jsonb, '[]'::jsonb, 1)`.execute(db);
    const row = (await sql`select kind, version, status from artifact where job_id = ${job.id}`.execute(db)).rows[0] as any;
    expect(row.kind).toBe('resume');
    expect(row.version).toBe(1);
  });

  it('enforces unique (job_id, kind, version)', async () => {
    const job = (await sql`select id from job limit 1`.execute(db)).rows[0] as { id: string } | undefined;
    if (!job) return;
    await expect(sql`insert into artifact (job_id, kind, version, status, content, validation, llm_run_id)
      values (${job.id}, 'resume', 1, 'valid', '{}'::jsonb, '[]'::jsonb, 1)`.execute(db)
    ).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run** `npx vitest run --config vitest.integration.config.ts integration/artifact-repo.test.ts` (из tests/) — FAIL: relation "artifact" does not exist.
- [ ] **Step 3: GREEN — db.ts**: добавить в SCHEMA_SQL после job_match:

```sql
CREATE TABLE IF NOT EXISTS artifact (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id UUID NOT NULL REFERENCES job(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('resume', 'cover_letter')),
  version INT NOT NULL CHECK (version >= 1),
  status TEXT NOT NULL CHECK (status IN ('valid', 'invalid')),
  content JSONB NOT NULL,
  validation JSONB NOT NULL DEFAULT '[]',
  llm_run_id BIGINT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (job_id, kind, version)
);
CREATE INDEX IF NOT EXISTS artifact_job_idx ON artifact (job_id);
```

+ `ArtifactRow` (interfaces выше) + `artifact: ArtifactRow` в `Database`.
Нужен `crypto.randomUUID()`-совместимый дефолт — `gen_random_uuid()` есть в pg17.

- [ ] **Step 4: Run** — PASS. `git add -A && git commit -m "S5 T1: artifact table migration + types"`

---

### Task 2: Извлечение сущностей + validateResumeDiff

**Files:**
- Create: `packages/core/src/generation-validators.ts`
- Create: `packages/core/test/generation-validators.test.ts`
- Modify: `packages/core/src/index.ts` (export)

**Interfaces (produces):**
- `extractEntities(text: string, knownEmployers: string[]): string[]` —
  числа (`\d+(\.\d+)?`-токены) lowercase-нормализованные + имена работодателей
  (word-boundary, case-insensitive) из knownEmployers, встреченные в text.
- `Violation = { kind: 'unknown_experience' | 'unknown_bullet' | 'unknown_skill' | 'entity_mismatch' | 'summary_entity'; detail: string }`
- `ValidationReport = { valid: boolean; violations: Violation[] }`
- `MasterProfileLike = { summary: string; skills: Record<string, string[]>; experience: Array<{ id: string; employer: string; title: string; start: string; end: string; bullets: string[]; technology?: string[] }>; education: unknown[] }` (структурный минимум master_profile.json)
- `ResumeDiffLike = { summary: string; skills_order: string[]; bullets: Array<{ experience_id: string; bullet_index: number; rephrase?: string }>; keywords: string[] }`
- `validateResumeDiff(master: MasterProfileLike, diff: ResumeDiffLike): ValidationReport`

- [ ] **Step 1: RED — тесты всех классов нарушений** (полный файл; данные
  профиля — синтетические, НЕ реальные из master_profile.json — PII):

```ts
import { describe, it, expect } from 'vitest';
import { extractEntities, validateResumeDiff } from '../src/generation-validators.js';

const master = {
  summary: 'Engineer with 11 years experience',
  skills: { languages: ['TypeScript', 'C#'], frontend: ['React 19'] },
  experience: [
    { id: 'voki', employer: 'Voki Labs', title: 'Senior Engineer', start: '2020-03', end: 'present',
      bullets: ['Owned platform serving 40k users', 'Cut latency by 35%'], technology: ['React'] },
  ],
  education: [],
};

const validDiff = {
  summary: 'Engineer with 11 years experience building platforms',
  skills_order: ['TypeScript', 'React 19'],
  bullets: [{ experience_id: 'voki', bullet_index: 1, rephrase: 'Reduced latency by 35% across the platform' }],
  keywords: ['latency'],
};

describe('extractEntities', () => {
  it('collects numbers and known employers, normalized', () => {
    expect(extractEntities('Serving 40k users at Voki Labs since 2020', ['Voki Labs', 'Acme']))
      .toEqual(['40', '2020', 'voki labs']);
  });
  it('is case-insensitive on employers', () => {
    expect(extractEntities('worked at VOKI LABS', ['Voki Labs'])).toEqual(['voki labs']);
  });
});

describe('validateResumeDiff', () => {
  it('accepts a valid diff', () => {
    expect(validateResumeDiff(master, validDiff).valid).toBe(true);
  });
  it('unknown_experience when experience_id not in master', () => {
    const r = validateResumeDiff(master, { ...validDiff, bullets: [{ experience_id: 'nope', bullet_index: 0 }] });
    expect(r.violations.map(v => v.kind)).toContain('unknown_experience');
  });
  it('unknown_bullet on out-of-range index', () => {
    const r = validateResumeDiff(master, { ...validDiff, bullets: [{ experience_id: 'voki', bullet_index: 9 }] });
    expect(r.violations.map(v => v.kind)).toContain('unknown_bullet');
  });
  it('unknown_skill on skill not in master', () => {
    const r = validateResumeDiff(master, { ...validDiff, skills_order: ['Golang'] });
    expect(r.violations.map(v => v.kind)).toContain('unknown_skill');
  });
  it('entity_mismatch when rephrase changes a number', () => {
    const r = validateResumeDiff(master, { ...validDiff,
      bullets: [{ experience_id: 'voki', bullet_index: 1, rephrase: 'Cut latency by 45%' }] });
    expect(r.violations.map(v => v.kind)).toContain('entity_mismatch');
  });
  it('entity_mismatch when rephrase introduces new employer not in bullet', () => {
    const r = validateResumeDiff(master, { ...validDiff,
      bullets: [{ experience_id: 'voki', bullet_index: 1, rephrase: 'Cut latency by 35% at Acme Corp' }] });
    expect(r.violations.map(v => v.kind)).toContain('entity_mismatch');
  });
  it('summary_entity when summary invents a year', () => {
    const r = validateResumeDiff(master, { ...validDiff, summary: 'Engineer since 1999' });
    expect(r.violations.map(v => v.kind)).toContain('summary_entity');
  });
});
```

- [ ] **Step 2: Run** `cd packages/core && npx vitest run test/generation-validators.test.ts` — FAIL (модуля нет).
- [ ] **Step 3: GREEN — реализация**:

```ts
// packages/core/src/generation-validators.ts
export interface Violation { kind: string; detail: string }
export interface ValidationReport { valid: boolean; violations: Violation[] }

const NUMBER_TOKEN = /\d+(?:\.\d+)?/g;

export function extractEntities(text: string, knownEmployers: string[]): string[] {
  const out = new Set<string>();
  const m = text.match(NUMBER_TOKEN);
  if (m) for (const n of m) out.add(n);
  const lower = ' ' + text.toLowerCase().replace(/\s+/g, ' ') + ' ';
  for (const emp of knownEmployers) {
    if (emp.length < 3) continue;
    if (lower.includes(' ' + emp.toLowerCase() + ' ')) out.add(emp.toLowerCase());
  }
  return [...out];
}

function report(violations: Violation[]): ValidationReport {
  return { valid: violations.length === 0, violations };
}

export function validateResumeDiff(master: MasterProfileLike, diff: ResumeDiffLike): ValidationReport {
  const employers = master.experience.map(e => e.employer);
  const allSkills = new Set(Object.values(master.skills).flat());
  const masterEntityText = [master.summary, ...master.experience.flatMap(e => [e.employer, e.title, e.start, e.end, ...e.bullets, ...(e.technology ?? [])])].join(' ');
  const masterEntities = new Set(extractEntities(masterEntityText, employers));
  const violations: Violation[] = [];

  for (const b of diff.bullets) {
    const exp = master.experience.find(e => e.id === b.experience_id);
    if (!exp) { violations.push({ kind: 'unknown_experience', detail: b.experience_id }); continue; }
    const original = exp.bullets[b.bullet_index];
    if (original === undefined) { violations.push({ kind: 'unknown_bullet', detail: `${b.experience_id}[${b.bullet_index}]` }); continue; }
    if (b.rephrase !== undefined) {
      const a = extractEntities(original, employers).sort().join('|');
      const b2 = extractEntities(b.rephrase, employers).sort().join('|');
      if (a !== b2) violations.push({ kind: 'entity_mismatch', detail: `"${b.rephrase.slice(0, 80)}" vs "${original.slice(0, 80)}"` });
    }
  }
  for (const s of diff.skills_order) {
    if (!allSkills.has(s)) violations.push({ kind: 'unknown_skill', detail: s });
  }
  for (const e of extractEntities(diff.summary, employers)) {
    if (!masterEntities.has(e)) violations.push({ kind: 'summary_entity', detail: e });
  }
  return report(violations);
}
```

(`MasterProfileLike`/`ResumeDiffLike` — из Interfaces; типы объявить над функциями.)

- [ ] **Step 4: Run** — PASS. Экспорт в `packages/core/src/index.ts`:
  `export { extractEntities, validateResumeDiff } from './generation-validators';` (+типы).
- [ ] **Step 5:** `git commit -m "S5 T2: entity extraction + resume diff validator (red→green)"`

---

### Task 3: assembleResume + validateCoverLetter

**Files:**
- Modify: `packages/core/src/generation-validators.ts`, `packages/core/src/index.ts`
- Modify: `packages/core/test/generation-validators.test.ts`

**Interfaces (produces):**
- `assembleResume(master: MasterProfileLike, diff: ResumeDiffLike): TailoredResume` —
  `TailoredResume { summary: string; keywords: string[]; skills: string[]; experience: Array<{ employer: string; title: string; start: string; end: string; technology: string[]; bullets: string[] }>; education: unknown[] }`.
  Бросает `UnknownReferenceError` на несуществующие ссылки (защита после валидатора).
  Скиллы: сначала skills_order, затем остальные master-скиллы в исходном порядке.
  Буллеты: rephrase ?? оригинал, в порядке диффа, сгруппированы по experience.
- `validateCoverLetter(letter: string, master: MasterProfileLike, job: { title: string; employer: string; description: string }): ValidationReport`
  — violations: `word_limit` (>300 слов), `year_not_in_sources` (4-значный год
  не из master/job текстов), `forbidden_pattern` (зарплатные ожидания:
  /salary (expectation|requirement)|compensation package/i; негатив:
  /terrible|awful|horrible (boss|manager|employer|company)/i).

- [ ] **Step 1: RED — тесты**: assemble валидный дифф → структура (скиллы
  переупорядочены, rephrase подставлен, порядок буллетов из диффа);
  assemble с unknown ref → throw; validateCoverLetter: 301 слово → word_limit;
  год «2035» → year_not_in_sources; «My salary expectation is…» →
  forbidden_pattern; валидное письмо 120 слов → valid.
- [ ] **Step 2: Run** — FAIL. **Step 3: GREEN** (детерминированная сборка;
  подсчёт слов: `letter.trim().split(/\s+/).length`).
- [ ] **Step 4: Run** — PASS; экспорт `assembleResume`, `validateCoverLetter`,
  `UnknownReferenceError`, типов TailoredResume.
- [ ] **Step 5:** `git commit -m "S5 T3: assembleResume + cover letter validator"`

---

### Task 4: Промпт-билдеры и схемы (packages/llm)

**Files:**
- Create: `packages/llm/src/generation.ts`
- Create: `packages/llm/test/generation.test.ts`
- Modify: `packages/llm/src/index.ts` (если есть — проверить экспорт-паттерн)

**Interfaces (produces):**
- `RESUME_PROMPT_VERSION = 'v1'`; `COVER_PROMPT_VERSION = 'v1'`
- `ResumeDiffSchema = z.object({ summary: z.string().min(50).max(1200), skills_order: z.array(z.string()).min(3), bullets: z.array(z.object({ experience_id: z.string(), bullet_index: z.number().int().min(0), rephrase: z.string().min(20).optional() })).min(3), keywords: z.array(z.string()).max(15).default([]) })`
- `CoverSchema = z.object({ letter: z.string().min(200) })` (верхний лимит слов — валидатором, не схемой)
- `buildResumePrompt(master, job, opts?: { violations?: Violation[] }): { system, user }` —
  system: роль senior-техрайтера; ЖЁСТКИЕ правила: только select/reorder/rephrase;
  в rephrase обязаны сохраниться ВСЕ числа, годы и имена работодателей дословно;
  новые работодатели/роли/даты/числа запрещены; summary только из фактов master.
  user: профиль (секциями, bullets с индексами!), вакансия (title/employer/
  description до 6000 симв., score+reasons), при violations — блок
  «PREVIOUS ATTEMPT FAILED — fix exactly: <список>». Версия в конце system.
- `buildCoverPrompt(master, job, violations?)` — формальный Canadian business
  tone, ≤300 слов, факты только из профиля/вакансии, без зарплатных ожиданий
  и негатива, структура 3-4 абзаца.
- Тип `GenerationJob = { title: string; employer: string; description?: string; score?: number; reasons?: string[] }`

- [ ] **Step 1: RED — тесты**: структура промптов (профиль с индексами
  буллетов, версия, conстрейнты-слова «must preserve»); different jobs →
  different prompts (кэш-ключи); violations → user содержит «PREVIOUS ATTEMPT»;
  схемы: валидный объект проходит, bullets<3 — падает.
- [ ] **Step 2: FAIL → Step 3: GREEN** (по образцу scoring.ts: шаблонные
  строки, slice(0, 6000) для description).
- [ ] **Step 4:** PASS; commit `"S5 T4: generation prompts + zod schemas"`.

---

### Task 5: Репозиторий артефактов (packages/core)

**Files:**
- Create: `packages/core/src/artifacts.ts`
- Modify: `packages/core/src/index.ts`
- Test: `tests/integration/artifact-repo.test.ts` (расширить)

**Interfaces (produces):**
- `saveArtifact(db, input: { jobId: string; kind: 'resume' | 'cover_letter'; status: 'valid' | 'invalid'; content: unknown; validation: ValidationReport; llmRunId: number }): Promise<ArtifactView>` —
  version = max(version)+1 по (job_id, kind); UUID — `crypto.randomUUID()`.
- `listArtifacts(db, jobId: string): Promise<ArtifactView[]>` — все версии,
  created DESC. `ArtifactView = { id: string; jobId: string; kind: string; version: number; status: string; created: string; violations: string[] }` (violations — детали как строки; content НЕ входит — PII наружу из репозитория только по запросу).
- `getArtifactContent(db, artifactId: string): Promise<{ kind: string; version: number; status: string; content: unknown; violations: string[] } | null>`

- [ ] **Step 1: RED:** saveArtifact дважды → версии 1,2; listArtifacts DESC;
  getArtifactContent возвращает content только по id.
- [ ] **Step 2: FAIL → Step 3: GREEN** (insert ... on ConflictDoNothing —
  версия уникальна вычислением max+1 в транзакции `db.transaction()`).
- [ ] **Step 4:** PASS; commit `"S5 T5: artifact repository"`.

---

### Task 6: Генерационный сервис (оркестрация, 2 попытки, лимит)

**Files:**
- Create: `apps/web/lib/generation-service.ts`
- Test: `tests/integration/generation-service.test.ts`
- Modify: `apps/web/package.json` (добавить `"@chinook/llm": "workspace:*"`)

**Interfaces:**
- Consumes: `llm.call` (S3), Task 2-5 (валидаторы, репозиторий, промпты).
- Produces: `generateDocuments(db: Kysely<Database>, llm: Llm, jobId: string, kinds: Array<'resume'|'cover_letter'>, opts?: { dailyLimitUsd?: number }): Promise<{ artifacts: ArtifactView[] }>`
  — кидает `GenerationLimitError` (402) при исчерпании дневного лимита
  (сумма cost_usd по stage in generate_* за сегодня ≥ GEN_DAILY_LIMIT_USD,
  default 1.0), `JobNotEligibleError` (409) если job.rule_status='excluded' или
  job нет. Пайплайн на kind: buildPrompt → llm.call(role 'main', temperature 0.2)
  → validate → valid: (resume) assemble + content={diff, resume} /
  (cover) content={letter}; save status 'valid'. invalid при попытке 1 → повтор
  с violations. invalid при попытке 2 → save status 'invalid' с validation.

- [ ] **Step 1: RED:** мок-Llm (объект с `call: async (input) => ({ data, runId: 1, usage: { costUsd: 0.001 } })`)
  три сценария: valid с первого раза (1 call); invalid→valid (2 calls, второй
  промпт содержит violations — перехватить через мок-историю); double-fail →
  status invalid + violations сохранены. Лимит: в llm_run предзаписать
  stage='generate_resume' cost_usd=1.0 → GenerationLimitError.
- [ ] **Step 2: FAIL → Step 3: GREEN.** **Step 4:** PASS; commit
  `"S5 T6: generation orchestration (2 attempts, daily cap)"`.

---

### Task 7: API routes

**Files:**
- Create: `apps/web/app/api/jobs/[id]/generate/route.ts`
- Create: `apps/web/app/api/jobs/[id]/artifacts/route.ts`
- Create: `apps/web/app/api/artifacts/[id]/route.ts`

**Контракт** (по спеке; паттерн — status/route.ts):
- POST generate: body zod `{ kinds: z.array(z.enum(['resume','cover_letter'])).min(1) }`;
  uuid-проверка; GenerationLimitError → 402 `{error}`; JobNotEligibleError → 409;
  прочее → 500. LLM-инстанс: `createLlm({ db: createPgLlmDb(db) })` (как в golden-set).
- GET artifacts (по job id): listArtifacts → 200.
- GET artifact by id: getArtifactContent → 200 / 404.

- [ ] **Step 1: RED** — integration: POST generate с моком?? route нельзя
  замокать извне → проверяется e2e (Task 9) + здесь smoke: GET artifacts
  пустой список → 200 `[]`; GET неизвестный artifact id → 404.
- [ ] **Step 2-3:** реализация; **Step 4:** PASS; commit `"S5 T7: generation API routes"`.

---

### Task 8: UI — секция Documents (superdesign → frontend-design → код)

**Files:**
- Create: `apps/web/app/job/[id]/documents-section.tsx` (client)
- Modify: `apps/web/app/job/[id]/page.tsx` (секция после Details)
- Test: `tests/e2e/documents.spec.ts`

**PO-checkpoint:** перед кодом — 2-3 варианта секции через `superdesign`
(варианты: инлайн-раскрывашки / табы resume|cover / мастер-детейл список-версий +
просмотр). PO выбирает. Затем frontend-design-пасс по DS v1.1.

**Поведение (независимо от варианта):**
- Кнопки Generate resume · Generate cover · Both → POST generate; состояния:
  loading (disabled), ошибка лимита/excluded — видимое сообщение.
- Список версий: kind · vN · status (valid=--status-success / invalid=
  --status-danger) · дата; клик — просмотр контента (GET artifact): resume —
  секции Summary/Skills/Experience/Education (БЕЗ identity — G1), cover —
  абзацы. invalid — список violations (detail-строки) + кнопка Regenerate
  (POST generate с тем же kind → новая версия).

- [ ] **Step 1: superdesign варианты → PO выбор.**
- [ ] **Step 2: RED e2e** (seed: job + application-строка не нужна; мок-LLM
  невозможен в e2e → генерация заменяется прямым saveArtifact в seed-e2e.ts
  helper `seedArtifact(jobId, kind, status)`): список версий виден; invalid
  флаг + violations видны; просмотр контента открывается; снапшот секции с
  `mask: [page.locator('[data-testid="artifact-content"]')]`.
- [ ] **Step 3: GREEN** — компонент + интеграция в page.tsx.
- [ ] **Step 4:** e2e PASS (включая 63 предыдущих); снапшот baseline
  обновлён (`pnpm e2e:update-snapshots` — только новая маска).
- [ ] **Step 5:** commit `"S5 T8: Documents section UI"`.

---

### Task 9: Golden-прогон + отчёт + деплой

**Files:**
- Create: `apps/worker/src/golden-generation.ts` (+ script `"golden:generation"` в apps/worker/package.json)
- Create: `specs/notes/S5-report.md`

- [ ] **Step 1:** скрипт: 3 вакансии score 74–84 (v5) + Neo Financial; для
  каждой — generateDocuments оба kind (живой glm-5.3); вывод: score, attempts,
  violations, cost per artifact, суммарно. Артефакты пишутся в живую БД
  (реальные документы PO). НЕ печатать контент артефактов в консоль — только
  метрики (PII).
- [ ] **Step 2:** прогон: `pnpm --filter @chinook/worker golden:generation`.
  Ожидание: все valid ≤2 попыток; cost ≤ $0.05 суммарно. Если invalid —
  сохранить отчёт с violations, промпт-итерация (v2) по тем же шагам.
- [ ] **Step 3:** S5-report.md: DoD-чеклист спеки, цифры тестов, cost-таблица,
  security-вывод (Mimosa-хук + ручная верификация: PII-гейт AC8 —
  `git grep -l "<фрагмент реального буллета>"` по репо вне data/ = пусто).
- [ ] **Step 4:** все гейты: `pnpm lint && pnpm arch-lint && pnpm test && pnpm e2e && pnpm typecheck`.
- [ ] **Step 5:** docker: `docker compose build web && docker compose up -d web`.
- [ ] **Step 6:** commit + push ветки; отчёт PO → G6.

---

## Self-Review

- **Spec coverage:** R1→T2-T4; R2→T1,T5 (erratum job_id); R3→T7,T8; R4→T2,T3,T6;
  R5→T6 (лимит), T9 (cost-отчёт); контракт API→T7; UI→T8; AC1-8→T2-T9; PII→T8
  маски,T9 гейт. Пустот нет.
- **Placeholders:** нет TBD; «по образцу scoring.ts» — с указанием файла и
  паттерна, код ключевых функций приведён полностью.
- **Type consistency:** ArtifactView/ValidationReport/Violation — единые имена
  T2→T5→T6→T7→T8; kinds 'resume'|'cover_letter' везде.
