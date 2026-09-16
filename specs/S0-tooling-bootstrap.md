# S0: Tooling bootstrap — репозиторий, гейты, заморозка стека

Статус: **draft** (ждёт G1 approve PO) · Версия: 1.0 · Milestone: **M0**
Спека по PROCESS.md; реестр спек — DESIGN.md §6.1; источник — процесс
(требования PO от 2026-09-16, пункты 4–7).

## Проблема и цель

Проект описан (CONSTITUTION/PROCESS/AGENTS/DESIGN/BACKLOG), но репозитория
как такового нет: каталог даже не является git-репо. Нельзя начать S1,
потому что процесс требует: машинные гейты (lint, arch-lint, typecheck,
тесты, visual diff), git-lfs для снапшотов, зафиксированный стек и CI-скелет.

Цель S0 — минимальный, но полный каркас, на котором все гейты процесса
уже работают и ломаются там, где должны.

## Входные артефакты / зависимости

- PROCESS.md §5 (гейты), §7 (arch-lint), §8 (стек, git-lfs, CI).
- DESIGN.md §8 (структура репозитория).
- Зависимостей от других спек нет — S0 первая.

## Решение (альтернативы из brainstorm, выбор + отказ)

### R1. Менеджер пакетов и монорепо
- **(a) pnpm workspaces + Turborepo** — ✅ выбрано: самый быстрый
  install/CI-кэш, стандарт для TS-монорепо, турбиновые пайплайны напрямую
  выражают наши stage-гейты.
- (b) npm workspaces — без доп. инструмента, но медленнее и без кэша задач;
  для 7+ пакетов с общим пайплайном проигрывает.
- (c) Nx — мощнее, но тянет собственную генерацию/конвенции; для нашего
  размера — избыточная зависимость (ст. 9 YAGNI).

### R2. TypeScript-конфигурация
- **(a) Единый `tsconfig.base.json` (strict-all) + наследование** — ✅:
  strict, noUncheckedIndexedAccess, exactOptionalPropertyTypes,
  verbatimModuleSyntax; package-без-generics не нужна отдельная сложность.
- (b) Project references + composite — даёт инкрементальную сборку, но
  заметно усложняет конфиги; отложить до появления боли сборки.

### R3. Тест-раннер
- **(a) Vitest** — ✅: современный, ESM-native, совместим с TS из коробки,
  watch/in-source типы,单一 runner для unit+integration.
- (b) Jest — легаси-конфигурации, CJS-корни, медленнее на TS.

### R4. Arch-lint (границы пакетов)
- **(a) `eslint-plugin-boundaries` как движок + наш пакет
  `packages/eslint-plugin-arch`** — ✅: существующий поддерживаемый плагин
  (правило PO: «если есть готовый — не писать свой»); наш пакет содержит
  shared-конфиг с моделью слоёв DESIGN.md и место для кастомных правил,
  если появятся пробелы.
- (b) Свой плагин с нуля — только при подтверждённом пробеле покрытий
  (вынужденная мера по PROCESS.md §7, не стартовая).
- (c) dependency-cruiser отдельным гейтом — дублирует boundaries, второй
  инструмент для тех же правил (ст. 9).

### R5. Visual/UI-тесты
- **(a) Playwright `toHaveScreenshot()`** — ✅: ноль внешних сервисов
  (local-first), встроенный diff/maxDiffPixelRatio, PNG под LFS.
- (b) Percy/Chromatic — внешний SaaS: деньги, облако, PII-риск —
  против конституции ст. 3/§8.1.
- (c) Свой pixelmatch-пайплайн — реинвентинг встроенного.

### R6. CI-скелет
- **(a) Пайплайн как npm-скрипты (`pnpm pipeline:check`), вызываемые и из
  husky pre-push, и из GitHub Actions workflow** — ✅: один источник правды,
  локальный прогон = CI-прогон (PROCESS.md §8.2).
- (b) Только GH Actions без локальных хуков — разработчик может запушить
  красное; (c) только хуки — нет защиты main на сервере.

### R7. Runtime и фиксация стека
- **(a) Node LTS актуальной мажорной линии + pnpm latest, точные версии
  фиксируются в момент установки через context7 и lockfile** — ✅: спека
  фиксирует *выбор технологий*; точные версии попадают в STACK.md из
  lockfile в ходе реализации (честно: версии на дату исполнения).
- (b) Зафиксировать версии в спеке заранее — быстро устареет до первого
  коммита; отклонено.

## Контракт

### Структура (создаётся в S0; бизнес-пакеты — заглушки с export)
```
canada_job_search/
  package.json            # pnpm workspace root, скрипты pipeline:*
  pnpm-workspace.yaml     # apps/*, packages/*, tests
  turbo.json              # lint/typecheck/test/build как turbo-задачи
  tsconfig.base.json
  .gitignore              # data/ (PII!), .env*, node_modules, покрытия
  .gitattributes          # tests/__snapshots__/**/*.png → git-lfs
  STACK.md                # точные версии из lockfile + changelog
  .github/workflows/ci.yml
  apps/web/               # Next.js каркас-заглушка (1 страница для снапшотов)
  apps/worker/            # пустой каркас package
  packages/{contracts,core,llm,adapters}/  # каркасы с одним типом-примером
  packages/eslint-plugin-arch/  # shared ESLint-конфиг границ (R4)
  tests/e2e/              # Playwright specs + __snapshots__ (LFS)
  specs/                  # существующие документы + планы + отчёты
```

### Модель слоёв для arch-lint (правила enforced)
```
apps/*          → packages/*            (разрешено)
packages/*      → apps/*                (запрещено всегда)
packages/adapters → только contracts    (не core/llm/generation)
packages/llm    → только contracts
apps/web        → не импортирует BullMQ/pg-клиенты напрямую (только через API)
любой пакет     → packages/llm          (только через core/gateway фасад)
```

### Pipeline-контракт (одинаково локально и в CI)
`pnpm pipeline:check` = lint → arch-lint → typecheck → unit → build →
e2e (в CI добавляется visual diff как blocking). Любой упавший stage —
non-zero exit всей команды.

### PII-контракт (находка G0)
`data/` целиком вне git. Runtime читает профиль с диска по configurable
path. Тестовые/golden профили — синтетические, анонимные фикстуры
(`tests/fixtures/profile.synthetic.json`).

## Acceptance criteria

1. `git init` выполнен, `.gitattributes` подключает LFS к
   `tests/__snapshots__/**/*.png`; `git check-attr` подтверждает filter=lfs.
2. `pnpm pipeline:check` проходит на каркасе зелёно (все stage).
3. **Arch-lint реально ловит**: тест-фикстура с запрещённым импортом
   (packages/adapters → packages/core) даёт ошибку линтера; после удаления
   нарушения пайплайн снова зелёный (red→green доказательство гейта).
4. Playwright-снапшот страницы-каркаса создаётся под LFS; повторный прогон
   проходит; намеренное изменение страницы роняет visual diff (доказательство
   гейта G4).
5. `tsc --strict` = 0 ошибок на всех пакетах.
6. STACK.md существует, версии совпадают с lockfile, changelog заполнен.
7. `git status` не содержит `data/` и `.env` (PII-контракт).
8. `.github/workflows/ci.yml` вызывает те же npm-скрипты; первый пуш в
   `chinook_apply` запускает CI (после чего на `main` включается required
   status check).
9. Husky pre-push запускает `pnpm pipeline:check` (быстрая опция `:quick`
   без e2e для повседневных пушей; полный — в CI).

## Тест-план

- **Unit (Vitest):** тест пайплайн-скриптов — последовательность stage,
  падение любого = non-zero (скрипт-обёртка тестируется как функция);
  тест ESLint-конфига — программный запуск линтера на инлайн-фикстурах
  (нарушение → диагностика с rule-id; чистый код → 0).
- **Integration:** сквозной прогон `pipeline:check` на scaffold; проверка
  `git check-attr`.
- **E2E/visual:** S0-smoke.spec.ts — снапшот страницы-каркаса; тест
  «падение diff при изменении» выполняется один раз ручной инверсией
  (доказательство гейта), результат в отчёте.

## Метрики

- Время `pipeline:check` (baseline фиксируется в отчёте — цель для турбо-кэша).
- Расход токенов на S0 по ролям моделей (архитектор/имплементатор) —
  первый отчёт нового формата.
- Число машинных гейтов, добавленных процессом: 6 (lint, arch, typecheck,
  unit, build, visual) — фиксация стартовой точки для PROCESS.md §5.

## DoD (копируется в отчёт S0)

- [ ] git + LFS настроены, PII вне git (AC 1, 7)
- [ ] pipeline:check зелёный на каркасе (AC 2)
- [ ] arch-lint доказанно ловит нарушения (AC 3)
- [ ] снапшот-гейт доказанно ловит дифф (AC 4)
- [ ] strict 0 ошибок (AC 5)
- [ ] STACK.md зафиксирован (AC 6)
- [ ] CI-скелет + pre-push хук (AC 8, 9)
- [ ] отчёт specs/notes/S0-report.md (тесты цифрами, токены, security)
- [ ] DESIGN.md/структура синхронизированы с реальностью

## Открытые вопросы (к PO, вместе с G1)

1. ~~Git remote~~ — **решено PO 2026-09-16:** приватный GitHub-репозиторий
   **`chinook_apply`**. Следствие: CI-workfile (.github/workflows/ci.yml)
   активен с первого пуша; веточная защита `main` настраивается в GitHub
   (требовать зелёный CI) — включить сразу после первого пуша. Локальная
   папка остаётся `canada_job_search`; remote добавляется командой
   `git remote add origin`.
2. **Node-мажор:** беру актуальную LTS-линию на дату старта (по context7),
   зафиксирую в STACK.md. Возражений нет?
3. Разрешение экранов для снапшотов: одна конфигурация (1280×720) на S0,
   расширение при необходимости в S7 — ок?
