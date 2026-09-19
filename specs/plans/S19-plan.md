# S19 Province Filters — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Серверная фильтрация вакансий по провинциям Канады (13 кодов + сентинел REMOTE) на Jobs Explorer и Board, через `?province=` в URL и API.

**Architecture:** Фильтр ложится в существующий паттерн S1a/S14: слой запросов (`JobFilters`/`getBoard`) → API-роуты с whitelist → GET-form селекты в UI. Новая сущность не вводится; `PROVINCE_CODES` выводится из карты `PROVINCES` (источник истины один — `normalize.ts`). Синтетические строки в e2e-seed закрывают отсутствие non-AB relevant и remote данных в фикстурах.

**Tech Stack:** pnpm/turbo monorepo, Kysely + raw SQL, Next.js App Router (server components, CSS modules), vitest (unit/integration, real Postgres), Playwright (e2e + строгие снапшоты `maxDiffPixelRatio: 0`).

**Spec:** `specs/S19-province-filters.md` (v1.1, accepted PO 2026-09-19)

## Global Constraints

- URL-параметр один: `?province=` — `''` (нет фильтра) | 2-буквенный код | `REMOTE` (= `remoteOnly`). Неверное значение молча игнорируется, 200 без фильтра (консистентно с `source`/`rule`).
- Семантика строгая: `province = X` не показывает remote (R4); remote достижим только опцией `REMOTE`.
- Лейблы опций: «Full name (XX)» (напр. «Alberta (AB)»), порядок — алфавит по полному имени (решения PO 2026-09-19).
- UI-дисциплина S1a: поле фильтра 180×64px, select после Source; ноль клиентского JS, GET-навигация.
- Снапшоты: маски по дисциплине S1a/S14/S18; любое обновление базлайна — осознанное (проверить дифф), регресс «без параметра» — стабильный скрин.
- Гейты перед завершением каждого таска: `pnpm --filter <pkg> run test` (затронутый), финально — `pnpm test && pnpm lint && pnpm arch-lint && pnpm typecheck && pnpm e2e`; 0 ошибок типов (LSP/tsc).
- **Коммиты:** ZCode-хук Mimosa может заблокировать `git commit` (известные FP в `ingest.ts`, разбиралось 2026-09-19). Если блокирует — оставить изменения staged и отдать PO команду на коммит в терминале; не использовать обходные трюки.
- Новых зависимостей нет; секретов нет; PII не затрагивается.

---

### Task 1: Core — `PROVINCE_CODES` / `ProvinceCode` (экспорт из normalize)

**Files:**
- Modify: `packages/core/src/normalize.ts` (после `PROVINCES`, строки 8–13)
- Modify: `packages/core/src/index.ts` (блок export из './normalize', строки 1–6)
- Test: `packages/core/test/provinces.test.ts` (новый)

**Interfaces:**
- Consumes: `PROVINCES: Record<string, string>` (name→code) в `normalize.ts:8`.
- Produces: `PROVINCE_CODES: readonly ['AB','BC','MB','NB','NL','NS','NT','NU','ON','PE','QC','SK','YT']`; `type ProvinceCode = (typeof PROVINCE_CODES)[number]`; реэкспорт `PROVINCE_CODES`, `ProvinceCode`, `PROVINCES` из `@chinook/core`.

- [ ] **Step 1: Написать красный тест**

```ts
// packages/core/test/provinces.test.ts
import { describe, it, expect } from 'vitest';
import { PROVINCE_CODES, PROVINCES } from '../src/normalize.js';

describe('PROVINCE_CODES (S19)', () => {
  it('is the sorted tuple of all 13 province/territory codes', () => {
    expect(PROVINCE_CODES).toEqual([
      'AB', 'BC', 'MB', 'NB', 'NL', 'NS', 'NT', 'NU', 'ON', 'PE', 'QC', 'SK', 'YT',
    ]);
  });

  it('stays in sync with the PROVINCES name map (single source of truth)', () => {
    expect(new Set(PROVINCE_CODES)).toEqual(new Set(Object.values(PROVINCES)));
  });
});
```

- [ ] **Step 2: Прогнать, убедиться в красном**

Run: `cd packages/core && npx vitest run test/provinces.test.ts`
Expected: FAIL — import `PROVINCE_CODES` не существует (экспорта нет).

- [ ] **Step 3: Минимальная реализация**

```ts
// packages/core/src/normalize.ts — добавить после PROVINCES (строка 13)
/** S19: egress of the province universe for filters/whitelists; sync-tested against PROVINCES. */
export const PROVINCE_CODES = [
  'AB', 'BC', 'MB', 'NB', 'NL', 'NS', 'NT', 'NU', 'ON', 'PE', 'QC', 'SK', 'YT',
] as const;
export type ProvinceCode = (typeof PROVINCE_CODES)[number];
```

```ts
// packages/core/src/index.ts — блок './normalize' становится:
export {
  normalizeTitle,
  normalizeEmployer,
  parseLocation,
  PROVINCES,
  PROVINCE_CODES,
  type ParsedLocation,
  type ProvinceCode,
} from './normalize';
```

- [ ] **Step 4: Прогнать, убедиться в зелёном**

Run: `cd packages/core && npx vitest run`
Expected: PASS (все суиты core, включая новый файл).

- [ ] **Step 5: Коммит**

```bash
git add packages/core/src/normalize.ts packages/core/src/index.ts packages/core/test/provinces.test.ts
git commit -m "S19: PROVINCE_CODES/ProvinceCode exported from core (sync-tested against PROVINCES)"
```

---

### Task 2: Core — `JobFilters.province/remoteOnly` + `listJobs` + индекс

**Files:**
- Modify: `packages/core/src/repository.ts` (`JobFilters`, строки 7–14; wheres, после строки 116)
- Modify: `packages/core/src/db.ts` (`SCHEMA_SQL`, после строки 82)
- Test: `tests/integration/repository.test.ts` (расширить; новый describe)

**Interfaces:**
- Consumes: `ProvinceCode` из Task 1; `listJobs(db, filters)`.
- Produces: `JobFilters { …, province?: ProvinceCode; remoteOnly?: boolean }` — поведение: `province` → `where job.province = code`; `remoteOnly` → `where job.remote = true`. Индекс `job_province_idx`.

- [ ] **Step 1: Написать красные интеграционные тесты**

В конец `tests/integration/repository.test.ts` (файл уже импортирует `createDb, ensureSchema, listJobs`; добавить импорты `upsertJobs` из `@chinook/core`, `type Job` из `@chinook/contracts`, `sql` из `kysely`; если `kysely`/`@chinook/contracts` не объявлены в devDeps `@chinook/tests` — добавить их туда версиями из `packages/core/package.json`):

```ts
// S19 synthetic rows: fixtures are Alberta-only and have no remote jobs.
const SYNTHETIC_ON: Job = {
  id: '11111111-1111-4111-8111-111111111111',
  canonicalHash: 's19-it-on-developer',
  title: 'S19 it Ontario developer',
  employer: 'Chinook Fixtures Inc.',
  location: { city: 'toronto', province: 'ON', remote: false },
  url: 'https://www.jobbank.gc.ca/jobsearch/jobposting/91000001',
  urls: [],
  source: 'jobbank',
  sourceJobId: '91000001',
  postedAt: '2026-09-18T12:00:00Z',
  salaryMin: 90000,
  salaryMax: null,
  salaryCurrency: 'CAD',
  nocCode: null,
  raw: null,
  ingestedAt: '2026-09-18T12:00:00Z',
};
const SYNTHETIC_REMOTE: Job = {
  id: '22222222-2222-4222-8222-222222222222',
  canonicalHash: 's19-it-remote-developer',
  title: 'S19 it remote developer',
  employer: 'Chinook Fixtures Inc.',
  location: { city: '', province: '', remote: true },
  url: 'https://www.jobbank.gc.ca/jobsearch/jobposting/91000002',
  urls: [],
  source: 'jobbank',
  sourceJobId: '91000002',
  postedAt: '2026-09-18T12:00:00Z',
  salaryMin: 100000,
  salaryMax: null,
  salaryCurrency: 'CAD',
  nocCode: null,
  raw: null,
  ingestedAt: '2026-09-18T12:00:00Z',
};

async function seedS19Synthetics(databaseUrl: string): Promise<void> {
  const db = createDb(databaseUrl);
  await upsertJobs(db, [SYNTHETIC_ON, SYNTHETIC_REMOTE]);
  await db
    .updateTable('job')
    .set({ rule_status: 'relevant' })
    .where('canonical_hash', 'in', ['s19-it-on-developer', 's19-it-remote-developer'])
    .execute();
  await db.destroy();
}

describe('job repository province filters (S19)', () => {
  beforeAll(async () => {
    await seedS19Synthetics(databaseUrl);
  });

  it('filters strictly by province code (AC1, R4)', async () => {
    const db = createDb(databaseUrl);
    const onJobs = await listJobs(db, { province: 'ON' });
    expect(onJobs.length).toBeGreaterThan(0);
    expect(onJobs.every((j) => j.location.province === 'ON')).toBe(true);
    // strict semantics: the synthetic remote job (province '') must be hidden
    expect(onJobs.some((j) => j.canonicalHash === 's19-it-remote-developer')).toBe(false);
    await db.destroy();
  });

  it('remoteOnly returns only remote jobs (AC2)', async () => {
    const db = createDb(databaseUrl);
    const remote = await listJobs(db, { remoteOnly: true });
    expect(remote.length).toBeGreaterThan(0);
    expect(remote.every((j) => j.location.remote)).toBe(true);
    expect(remote.some((j) => j.canonicalHash === 's19-it-remote-developer')).toBe(true);
    await db.destroy();
  });

  it('combines province with source and rule (AC3)', async () => {
    const db = createDb(databaseUrl);
    const combined = await listJobs(db, { province: 'ON', source: 'jobbank', rule: 'relevant' });
    expect(combined.length).toBeGreaterThan(0);
    expect(
      combined.every(
        (j) => j.location.province === 'ON' && j.source === 'jobbank' && j.ruleStatus === 'relevant',
      ),
    ).toBe(true);
    await db.destroy();
  });

  it('job_province_idx exists after ensureSchema (R6)', async () => {
    const db = createDb(databaseUrl);
    await ensureSchema(db);
    const res = await db.executeQuery(
      sql`select indexname from pg_indexes where tablename = 'job' and indexname = 'job_province_idx'`,
    );
    expect(res.rows.length).toBe(1);
    await db.destroy();
  });
});
```

- [ ] **Step 2: Прогнать, убедиться в красном**

Run: `cd tests && npx vitest run integration/repository.test.ts` (нужен локальный Postgres: `docker compose up -d postgres`; DATABASE_URL по умолчанию `postgres://chinook:chinook_dev@localhost:5433/chinook`)
Expected: FAIL/compile-error — `JobFilters` не принимает `province`/`remoteOnly` (TS error), индекс не найдён.

- [ ] **Step 3: Минимальная реализация**

```ts
// packages/core/src/repository.ts
import { PROVINCE_CODES, type ProvinceCode } from './normalize.js'; // добавить к импортам

export interface JobFilters {
  source?: JobSourceId;
  days?: number;
  salaryMin?: number;
  sort?: 'posted' | 'salary';
  rule?: RuleStatus;
  province?: ProvinceCode;
  remoteOnly?: boolean;
  limit?: number;
}
```

В `listJobs`, после блока `if (rule) {…}` (строка 116):

```ts
  if (province) {
    query = query.where('job.province', '=', province);
  }
  if (remoteOnly) {
    query = query.where('job.remote', '=', true);
  }
```

```ts
// packages/core/src/db.ts — в SCHEMA_SQL после строки 82 (job_posted_at_idx):
CREATE INDEX IF NOT EXISTS job_province_idx ON job (province);
```

- [ ] **Step 4: Прогнать, убедиться в зелёном**

Run: `cd tests && npx vitest run integration/repository.test.ts`
Expected: PASS — все тесты файла (старые + 4 новых).
Run: `cd packages/core && npx vitest run && npx tsc --noEmit`
Expected: PASS, 0 ошибок типов.

- [ ] **Step 5: Коммит**

```bash
git add packages/core/src/repository.ts packages/core/src/db.ts tests/integration/repository.test.ts
git commit -m "S19: JobFilters province/remoteOnly in listJobs + job_province_idx (integration-tested)"
```

---

### Task 3: Core — `getBoard(db, filters)`

**Files:**
- Modify: `packages/core/src/board.ts` (сигнатура `getBoard`, строка 96; оба SQL-запроса, строки 98–114; экспорт типа)
- Modify: `packages/core/src/index.ts` (добавить `type BoardFilters` в экспорт board-блока)
- Test: `tests/integration/board.test.ts` (расширить)

**Interfaces:**
- Consumes: `ProvinceCode` (Task 1); `getBoard` из `@chinook/core`.
- Produces: `interface BoardFilters { province?: ProvinceCode; remoteOnly?: boolean }`; `getBoard(db, filters?: BoardFilters)` — фильтр применяется к New-запросу и к application-запросу (карточки и totals всех колонок).

- [ ] **Step 1: Написать красный тест**

В `tests/integration/board.test.ts` добавить импорт `upsertJobs` и `type Job` (как в Task 2 — те же SYNTHETIC_ON/SYNTHETIC_REMOTE + `seedS19Synthetics` скопировать в файл; для простоты дублировать константы в каждом тест-файле — тестовый код не DRY-им через прод-модули) и новый describe:

```ts
describe('getBoard province filters (S19)', () => {
  beforeAll(async () => {
    await seedS19Synthetics(databaseUrl);
  });

  it('New column only contains filtered province; totals agree (AC4)', async () => {
    const db = createDb(databaseUrl);
    const board = await getBoard(db, { province: 'ON' });
    const newCol = board.columns[0]!;
    expect(newCol.cards.length).toBeGreaterThan(0);
    expect(newCol.cards.every((c) => c.location.endsWith(', ON'))).toBe(true);
    expect(newCol.total).toBeGreaterThanOrEqual(newCol.cards.length);
    // strict filter hides the remote synthetic
    expect(newCol.cards.some((c) => c.title === 'S19 it remote developer')).toBe(false);
    await db.destroy();
  });

  it('remoteOnly board keeps only remote cards in New (AC4)', async () => {
    const db = createDb(databaseUrl);
    const board = await getBoard(db, { remoteOnly: true });
    const newCol = board.columns[0]!;
    expect(newCol.cards.length).toBeGreaterThan(0);
    expect(newCol.cards.every((c) => c.remote)).toBe(true);
    await db.destroy();
  });

  it('unfiltered getBoard is unchanged (regression)', async () => {
    const db = createDb(databaseUrl);
    const board = await getBoard(db);
    const newCol = board.columns[0]!;
    expect(newCol.cards.some((c) => c.title === 'S19 it remote developer')).toBe(true);
    expect(newCol.cards.some((c) => c.location.endsWith(', ON'))).toBe(true);
    await db.destroy();
  });
});
```

- [ ] **Step 2: Прогнать, убедиться в красном**

Run: `cd tests && npx vitest run integration/board.test.ts`
Expected: FAIL/compile-error — `getBoard` не принимает второй аргумент.

- [ ] **Step 3: Минимальная реализация**

```ts
// packages/core/src/board.ts
import { type ProvinceCode } from './normalize.js'; // добавить к импортам

export interface BoardFilters {
  province?: ProvinceCode;
  remoteOnly?: boolean;
}
```

Тело `getBoard` (заменить строки 96–114; фрагменты вкладываются в kysely-шаблоны, пустой `sql\`\`` ничего не добавляет):

```ts
export async function getBoard(db: Kysely<Database>, filters: BoardFilters = {}): Promise<BoardData> {
  const provinceCond = filters.province ? sql` and j.province = ${filters.province}` : sql``;
  const remoteCond = filters.remoteOnly ? sql` and j.remote = true` : sql``;

  const newRows = (
    await sql<Row>`select j.id, j.title, j.employer, j.city, j.province, j.remote, j.url,
        j.source, j.rule_status, j.salary_min, j.salary_max, j.posted_at,
        count(*) over ()::int as total
      from job j
      where j.rule_status = 'relevant'
        and not exists (select 1 from application a where a.job_id = j.id)${provinceCond}${remoteCond}
      order by j.posted_at desc nulls last
      limit ${NEW_COLUMN_LIMIT}`.execute(db)
  ).rows as Array<Row & { total: number }>;

  const appRows = (
    await sql<Row & { status: string; channel: string }>`select j.id, j.title, j.employer,
        j.city, j.province, j.remote, j.url, j.source, j.rule_status,
        j.salary_min, j.salary_max, j.posted_at, a.status, a.channel
      from application a join job j on j.id = a.job_id
      where true${provinceCond}${remoteCond}
      order by a.created_at desc`.execute(db)
  ).rows;
```

(остальное тело без изменений; в `index.ts` добавить `type BoardFilters` в board-экспорт.)

- [ ] **Step 4: Прогнать, убедиться в зелёном**

Run: `cd tests && npx vitest run integration/board.test.ts && npx vitest run integration/repository.test.ts`
Expected: PASS оба файла.
Run: `cd packages/core && npx tsc --noEmit`
Expected: 0 ошибок.

- [ ] **Step 5: Коммит**

```bash
git add packages/core/src/board.ts packages/core/src/index.ts tests/integration/board.test.ts
git commit -m "S19: getBoard accepts province/remoteOnly filters (cards+totals, both queries)"
```

---

### Task 4: Web lib — парсинг параметра и опции селекта

**Files:**
- Create: `apps/web/lib/province.ts`

**Interfaces:**
- Consumes: `PROVINCES`, `PROVINCE_CODES`, `ProvinceCode` из `@chinook/core` (Task 1).
- Produces:
  - `PROVINCE_SELECT_OPTIONS: ReadonlyArray<{ value: string; label: string }>` — `[All provinces, Remote, …13 провинций «Full name (XX)» сортировка по полному имени]`;
  - `parseProvinceParam(raw: string | null | undefined): { province?: ProvinceCode; remoteOnly?: boolean }` — `REMOTE`→remoteOnly, код→province, прочее→`{}`.

**Примечание:** юнит-инфраструктуры в apps/web нет (вводить ради одной чистой функции не будем — YAGNI); поведение функции покрывается e2e-тестами Task 5 (валидный/невалидный параметр). Это осознанное решение, а не пропуск TDD: прод-код Web-слоя в этом репо тестируется e2e по precedent S14.

- [ ] **Step 1: Реализация (данные для e2e Task 5–7)**

```ts
// apps/web/lib/province.ts
import { PROVINCES, PROVINCE_CODES, type ProvinceCode } from '@chinook/core';

const titleCase = (s: string) => s.replace(/\b[a-z]/g, (c) => c.toUpperCase());

/** S19 filter-bar options: All, Remote sentinel, provinces alphabetical by full name (PO 2026-09-19). */
export const PROVINCE_SELECT_OPTIONS: ReadonlyArray<{ value: string; label: string }> = [
  { value: '', label: 'All provinces' },
  { value: 'REMOTE', label: 'Remote' },
  ...Object.entries(PROVINCES)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, code]) => ({ value: code, label: `${titleCase(name)} (${code})` })),
];

/** URL param → repository fields; unknown values silently ignored (source/rule semantics). */
export function parseProvinceParam(
  raw: string | null | undefined,
): { province?: ProvinceCode; remoteOnly?: boolean } {
  if (raw === 'REMOTE') return { remoteOnly: true };
  if (raw && (PROVINCE_CODES as readonly string[]).includes(raw)) {
    return { province: raw as ProvinceCode };
  }
  return {};
}
```

- [ ] **Step 2: Проверить типы**

Run: `cd apps/web && npx tsc --noEmit`
Expected: 0 ошибок.

- [ ] **Step 3: Коммит**

```bash
git add apps/web/lib/province.ts
git commit -m "S19: shared web helper — province select options + URL-param parser (REMOTE sentinel)"
```

---

### Task 5: API — `/api/jobs?province=` и `/api/board?province=` + e2e-seed синтетика

**Files:**
- Modify: `apps/web/app/api/jobs/route.ts`
- Modify: `apps/web/app/api/board/route.ts`
- Modify: `apps/worker/src/seed-e2e.ts`
- Test: `tests/e2e/s1a-jobs.spec.ts` (новые API-тесты)

**Interfaces:**
- Consumes: `parseProvinceParam` (Task 4), `listJobs` с новым полем (Task 2), `getBoard` с фильтром (Task 3).
- Produces: `GET /api/jobs?province=AB|REMOTE`, `GET /api/board?province=AB|REMOTE`; в e2e-БД две детерминированные relevant-вакансии: `S19 e2e Ontario developer` (ON) и `S19 e2e remote developer` (remote).

- [ ] **Step 1: Красные e2e-тесты API (плюс данные для них)**

В `tests/e2e/s1a-jobs.spec.ts` добавить:

```ts
test('API province filter narrows strictly; invalid is ignored (S19 AC5)', async ({ request }) => {
  const on = await (await request.get('/api/jobs?province=ON&limit=100')).json();
  expect(on.jobs.length).toBeGreaterThan(0);
  expect(on.jobs.every((j: { location: { province: string } }) => j.location.province === 'ON')).toBe(true);
  // strict: remote jobs (province '') are not in the ON slice
  expect(on.jobs.some((j: { location: { remote: boolean } }) => j.location.remote)).toBe(false);

  const remote = await (await request.get('/api/jobs?province=REMOTE&limit=100')).json();
  expect(remote.jobs.length).toBeGreaterThan(0);
  expect(remote.jobs.every((j: { location: { remote: boolean } }) => j.location.remote)).toBe(true);

  const bogus = await (await request.get('/api/jobs?province=XX&limit=100')).json();
  const all = await (await request.get('/api/jobs?limit=100')).json();
  expect(bogus.jobs.length).toBe(all.jobs.length); // invalid → ignored, no 4xx
});

test('API board filter narrows New column (S19 AC4/AC5)', async ({ request }) => {
  const on = await (await request.get('/api/board?province=ON')).json();
  const newCol = on.columns.find((c: { status: string }) => c.status === 'new');
  expect(newCol.cards.length).toBeGreaterThan(0);
  expect(newCol.cards.every((c: { location: string }) => c.location.endsWith(', ON'))).toBe(true);
});
```

Расширить `apps/worker/src/seed-e2e.ts` (после `runIngest`, в конце файла):

```ts
// S19: deterministic non-AB relevant + remote jobs — fixtures are Alberta-only (e2e-only rows)
const { createDb, ensureSchema, upsertJobs } = await import('@chinook/core');
const db = createDb(E2E_URL);
await ensureSchema(db);
const s19 = (n: number, hash: string, title: string, city: string, province: string, remote: boolean) => ({
  id: `${n}${n}${n}${n}${n}${n}${n}${n}-${n}${n}${n}${n}-4${n}${n}${n}-8${n}${n}${n}-${n}${n}${n}${n}${n}${n}${n}${n}${n}${n}${n}${n}`,
  canonicalHash: hash,
  title,
  employer: 'Chinook Fixtures Inc.',
  location: { city, province, remote },
  url: `https://www.jobbank.gc.ca/jobsearch/jobposting/9100000${n}`,
  urls: [],
  source: 'jobbank',
  sourceJobId: `9100000${n}`,
  postedAt: '2026-09-18T12:00:00Z',
  salaryMin: 90000 + n,
  salaryMax: null,
  salaryCurrency: 'CAD',
  nocCode: null,
  raw: null,
  ingestedAt: '2026-09-18T12:00:00Z',
});
await upsertJobs(db, [
  s19(1, 's19-e2e-on-developer', 'S19 e2e Ontario developer', 'toronto', 'ON', false),
  s19(2, 's19-e2e-remote-developer', 'S19 e2e remote developer', '', '', true),
]);
await db
  .updateTable('job')
  .set({ rule_status: 'relevant' })
  .where('canonical_hash', 'in', ['s19-e2e-on-developer', 's19-e2e-remote-developer'])
  .execute();
await db.destroy();
```

- [ ] **Step 2: Прогнать e2e, убедиться в красном**

Run: `pnpm e2e` (поднимет e2e-БД, пересеет, запустит Playwright; создать/обновить снапшоты не нужно — новые тесты их не делают)
Expected: FAIL — `/api/jobs?province=ON` сейчас игнорирует параметр и возвращает все провинции (ассерт `every ON` падает); board-тест — `columns[?]` без фильтра содержит AB-карточки.

- [ ] **Step 3: Реализация роутов**

```ts
// apps/web/app/api/jobs/route.ts — импорт и парсинг:
import { parseProvinceParam } from '@/lib/province';
// в GET, после разбора rule:
const { province, remoteOnly } = parseProvinceParam(params.get('province'));
// передача:
const jobs = await listJobs(getDb(), { source, days, salaryMin, sort, rule, province, remoteOnly, limit });
```

```ts
// apps/web/app/api/board/route.ts — заменить тело GET:
import { parseProvinceParam } from '@/lib/province';
export async function GET(request: NextRequest) {
  const { province, remoteOnly } = parseProvinceParam(request.nextUrl.searchParams.get('province'));
  return getBoard(getDb(), { province, remoteOnly });
}
```
(сохранить существующий стиль файла; `NextRequest` уже импортирован, если нет — добавить.)

- [ ] **Step 4: Прогнать e2e, убедиться в зелёном**

Run: `pnpm e2e`
Expected: PASS — новые API-тесты зелёные, регрессия сьюта не сломана.

- [ ] **Step 5: Коммит**

```bash
git add apps/web/app/api/jobs/route.ts apps/web/app/api/board/route.ts apps/worker/src/seed-e2e.ts tests/e2e/s1a-jobs.spec.ts
git commit -m "S19: ?province= in /api/jobs + /api/board (whitelisted, REMOTE sentinel); e2e seed gains ON+remote relevant rows"
```

---

### Task 6: UI Explorer — селект Province в фильтр-баре

**Files:**
- Modify: `apps/web/app/page.tsx` (`SearchParams` + `parseFilters`, строки 15–40; фильтр-бар после поля Source, строки 72–82)
- Test: `tests/e2e/s1a-jobs.spec.ts` (новые UI-тесты)
- Test artifacts: `tests/e2e/__snapshots__/s1a-jobs.png` (осознанный реген)

**Interfaces:**
- Consumes: `PROVINCE_SELECT_OPTIONS`, `parseProvinceParam` (Task 4); `listJobs` (Task 2).
- Produces: select `#province` в фильтр-баре; `parseFilters` пробрасывает province/remoteOnly.

- [ ] **Step 1: Красные e2e-тесты UI**

В `tests/e2e/s1a-jobs.spec.ts` добавить:

```ts
test('filter by province narrows the list to that province (S19 AC1)', async ({ page }) => {
  await page.goto('/');
  const all = await page.getByTestId('jobs-table').locator('tbody tr').count();
  await page.locator('#province').selectOption('ON');
  await page.getByRole('button', { name: 'Apply filters' }).click();
  await page.waitForURL(/province=ON/);
  const rows = page.getByTestId('jobs-table').locator('tbody tr');
  const filtered = await rows.count();
  expect(filtered).toBeGreaterThan(0);
  expect(filtered).toBeLessThan(all);
  // Location is column 3; strict filter → every cell is "city, ON" (no Remote cells)
  const cells = await rows.locator('td:nth-child(3)').allTextContents();
  expect(cells.every((c) => c.includes('ON'))).toBe(true);
  expect(cells.some((c) => c === 'Remote')).toBe(false);
});

test('REMOTE option shows only remote jobs (S19 AC2)', async ({ page }) => {
  await page.goto('/?province=REMOTE');
  const cells = await page.getByTestId('jobs-table').locator('tbody tr td:nth-child(3)').allTextContents();
  expect(cells.length).toBeGreaterThan(0);
  expect(cells.every((c) => c === 'Remote')).toBe(true);
});

test('combined province+source+rule filter works (S19 AC3)', async ({ page }) => {
  await page.goto('/?province=ON&source=jobbank&rule=relevant');
  const rows = page.getByTestId('jobs-table').locator('tbody tr');
  expect(await rows.count()).toBeGreaterThan(0);
  const cells = await rows.locator('td:nth-child(3)').allTextContents();
  expect(cells.every((c) => c.includes('ON'))).toBe(true);
  const sources = await page.getByTestId('jobs-table').locator('tbody .source').allTextContents();
  expect(sources.every((s) => s === 'jobbank')).toBe(true);
});
```

- [ ] **Step 2: Прогнать, убедиться в красном**

Run: `pnpm e2e -- tests/e2e/s1a-jobs.spec.ts` (или полный `pnpm e2e`)
Expected: FAIL — `#province` не существует (locator timeout).

- [ ] **Step 3: Реализация**

```tsx
// apps/web/app/page.tsx
import { PROVINCE_SELECT_OPTIONS, parseProvinceParam } from '@/lib/province';
// SearchParams (строка 15): добавить province?: string;
interface SearchParams {
  source?: string;
  days?: string;
  salaryMin?: string;
  sort?: string;
  rule?: string;
  province?: string;
}
// parseFilters: в конец функции перед return:
Object.assign(filters, parseProvinceParam(sp.province));
```

В фильтр-бар, сразу после поля `Source` (после закрывающего `</div>` поля source, строка 82):

```tsx
<div className={styles.field}>
  <label htmlFor="province">Province</label>
  <select id="province" name="province" defaultValue={sp.province ?? ''}>
    {PROVINCE_SELECT_OPTIONS.map((o) => (
      <option key={o.value} value={o.value}>
        {o.label}
      </option>
    ))}
  </select>
</div>
```

- [ ] **Step 4: Прогнать e2e; снапшот упадёт — осознанно обновить**

Run: `pnpm e2e`
Expected: новые тесты PASS; визуальный тест `jobs screen visual snapshot` FAIL — бар стал на поле шире (маски полей остаются, но геометрия бара/таблицы сместилась; это ожидаемый осознанный дифф — новый селектор внутри замаскированного филда, как в S14).

Проверить дифф: `pnpm e2e:update-snapshots`, затем глазами сравнить старый/новый PNG (изменение — только фильтр-бар). Записать в отчёт: «baseline s1a-jobs.png перегенерирован: +1 поле Province (замаскировано)».

Run: `pnpm e2e` ещё раз
Expected: PASS полностью (регрессия «без параметра» — стабильный новый базлайн).

- [ ] **Step 5: Коммит**

```bash
git add apps/web/app/page.tsx tests/e2e/s1a-jobs.spec.ts tests/e2e/__snapshots__/s1a-jobs.png
git commit -m "S19: Province select in Explorer filter bar (strict filter, REMOTE option; baseline regen)"
```

---

### Task 7: UI Board — фильтр-бар над доской (superdesign → вёрстка)

**Files:**
- Modify: `apps/web/app/board/page.tsx` (searchParams + фильтр-бар + CSS-классы)
- Modify: `apps/web/app/board.module.css` (добавить `.bar`, `.field`, `.submit` — копия из `jobs.module.css`)
- Test: `tests/e2e/board.spec.ts` (новый тест + маски снапшота)
- Test artifacts: `tests/e2e/__snapshots__/s7-board.png` (осознанный реген)

**Interfaces:**
- Consumes: `PROVINCE_SELECT_OPTIONS`, `parseProvinceParam` (Task 4); `getBoard(db, filters)` (Task 3).
- Produces: `GET`-форма фильтра с `#province` над доской; страница принимает `?province=`.

- [ ] **Step 1: superdesign — варианты размещения (обязателен по AGENTS.md п.4; спека S19 R3)**

Сгенерировать на канвасе superdesign 3 варианта размещения фильтр-бара на доске:
A (рекомендуется) — полноширинный бар между `horizon` и доской, точная копия паттерна Explorer-бара (единый дизайн-язык S16/S17);
B — компактный инлайн-бар в строке заголовка справа от active-count;
C — свернутый «чип» фильтра, раскрывающийся по клику.
Выбор: по умолчанию A (консистентность с Explorer, ноль нового дизайна); зафиксировать выбор PO на чекпойнте плана. Если PO недоступен — A.

- [ ] **Step 2: Красный e2e-тест**

В `tests/e2e/board.spec.ts` (после snapshot-теста, до `test.beforeEach`):

```ts
test('board province filter narrows New column; DnD unaffected (S19 AC4)', async ({ page }) => {
  await page.goto('/board');
  await page.locator('#province').selectOption('ON');
  await page.getByRole('button', { name: 'Apply filters' }).click();
  await page.waitForURL(/province=ON/);
  const cards = page.locator('[data-column="new"] [data-card-id]');
  await expect(cards.first()).toBeVisible();
  expect(await cards.count()).toBe(1); // только синтетика S19 e2e Ontario developer
  expect(await cards.first().textContent()).toContain('S19 e2e Ontario developer');

  // фильтр не ломает статус-переход: карточка уходит в applying и в фильтрованном виде
  await cards.first().getByRole('button', { name: 'Start applying' }).click();
  await expect(page.locator('[data-column="applying"] [data-card-id]')).toBeVisible();
  // cleanup — вернуть в new для детерминизма остальных тестов
  await page.locator('[data-column="applying"] [data-card-id]').first().getByRole('button', { name: 'Back' }).click();
  await expect(page.locator('[data-column="new"] [data-card-id]')).toBeVisible();
});

test('board REMOTE filter shows only the remote card (S19 AC2/AC4)', async ({ page }) => {
  await page.goto('/board?province=REMOTE');
  const cards = page.locator('[data-column="new"] [data-card-id]');
  expect(await cards.count()).toBe(1);
  expect(await cards.first().textContent()).toContain('S19 e2e remote developer');
});
```

- [ ] **Step 3: Прогнать, убедиться в красном**

Run: `pnpm e2e`
Expected: FAIL — `#province` на /board отсутствует.

- [ ] **Step 4: Реализация**

`apps/web/app/board.module.css` — добавить в конец (копия из `jobs.module.css:1-60`):

```css
.bar {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  align-items: flex-end;
  padding: 12px 16px;
  background: var(--bg-raised);
  border: 1px solid var(--border-subtle);
  border-radius: 8px;
}

.field {
  display: flex;
  flex-direction: column;
  gap: 4px;
  height: 64px;
  width: 180px;
}

.field label {
  width: 180px;
  height: 16px;
  line-height: 16px;
  font-size: 11px;
  letter-spacing: 0.08em;
  color: var(--text-muted);
  white-space: nowrap;
  overflow: hidden;
}

.field select,
.field input {
  height: 36px;
  width: 180px;
  box-sizing: border-box;
  padding: 0 10px;
  border-radius: 6px;
  border: 1px solid var(--border-strong);
  background: var(--bg-base);
  color: var(--text-primary);
  font-size: 14px;
}

.submit {
  height: 36px;
  width: 150px;
  padding: 0 18px;
  border-radius: 6px;
  border: none;
  background: var(--accent);
  color: var(--accent-text);
  font-size: 14px;
  font-weight: 600;
  cursor: pointer;
}

.submit:hover {
  background: var(--accent-hover);
}
```

`apps/web/app/board/page.tsx`:

```tsx
import { PROVINCE_SELECT_OPTIONS, parseProvinceParam } from '@/lib/province';
// сигнатура страницы:
export default async function BoardPage({
  searchParams,
}: {
  searchParams: Promise<{ province?: string }>;
}) {
  const sp = await searchParams;
  const board = await getBoard(getDb(), parseProvinceParam(sp.province));
```

В JSX между `<div className="horizon" … />` и `<BoardDnd>` (вариант A):

```tsx
<form className={styles.bar} method="get" data-testid="board-filters" action="/board">
  <div className={styles.field}>
    <label htmlFor="province">Province</label>
    <select id="province" name="province" defaultValue={sp.province ?? ''}>
      {PROVINCE_SELECT_OPTIONS.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  </div>
  <button className={styles.submit} type="submit">
    Apply filters
  </button>
</form>
```

Маски в board-снапшоте (`tests/e2e/board.spec.ts`, в массив `mask` добавить):

```ts
page.getByTestId('board-filters').locator('div'),
page.getByTestId('board-filters').locator('label'),
page.getByTestId('board-filters').locator('button'),
```

- [ ] **Step 5: Прогнать e2e; реген снапшота осознанно**

Run: `pnpm e2e`
Expected: новые тесты PASS; `board visual snapshot` FAIL (бар сместил доску вниз — осознанный дифф). `pnpm e2e:update-snapshots`, проверить PNG-дифф (изменения — только новый бар и сдвиг доски вниз), повторить `pnpm e2e` → PASS полностью, включая S18 DnD-сьют (регрессия AC4).

- [ ] **Step 6: Коммит**

```bash
git add apps/web/app/board/page.tsx apps/web/app/board.module.css tests/e2e/board.spec.ts tests/e2e/__snapshots__/s7-board.png
git commit -m "S19: board filter bar (province select, Explorer pattern); snapshot masks + baseline regen; DnD regression green"
```

---

### Task 8: Верификация, security, отчёт, закрытие

**Files:**
- Create: `specs/notes/S19-report.md`
- Modify: `BACKLOG.md` (B-009 → done, changelog)
- Modify: `specs/S19-province-filters.md` (статус → done)

**Interfaces:**
- Consumes: всё выше; DoD-чеклист спеки.

- [ ] **Step 1: Полный прогон гейтов**

Run: `pnpm test && pnpm typecheck && pnpm lint && pnpm arch-lint && pnpm e2e`
Expected: всё зелёное; зафиксировать цифры (сколько тестов unit/integration/e2e).

- [ ] **Step 2: Security-аудит (claude-security) — вывод в отчёт и PR**

Скан изменений ветки (`git diff main...feat/S19-province-filters`): whitelist-параметры, Kysely-параметризация, PII не затронут. Результат (что проверено/найдено/исправлено) — в S19-report.md. Известные FP Mimosa в ingest.ts — упомянуть со ссылкой на B-010 и sealed-scan ID.

- [ ] **Step 3: Отчёт по формату S14**

`specs/notes/S19-report.md`: что сделано; DoD-чеклист спеки (AC 1–7) с пометками; тесты с цифрами; снапшот-диффы описанием; security кратко; метрики — не затронуты (не-LLM инкремент).

- [ ] **Step 4: BACKLOG + статус спеки**

B-009 → done (дата), changelog-строка; в спеке `Статус: done (G6 …)`.

- [ ] **Step 5: Финальный коммит**

```bash
git add specs/notes/S19-report.md BACKLOG.md specs/S19-province-filters.md
git commit -m "S19: report + DoD checked; B-009 done"
```

После — merge-гейт PO (PROCESS.md): PR в main с выводом security-аудита в описании.
