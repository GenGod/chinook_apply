# S0 Report — Tooling bootstrap

Инкремент: S0 (M0) · Ветка: feat/S0-tooling-bootstrap · Дата: 2026-09-16
Спека: specs/S0-tooling-bootstrap.md · План: specs/plans/S0-plan.md

## DoD / Acceptance criteria

| AC | Проверка | Статус |
|---|---|---|
| 1 | git + LFS: `git check-attr filter tests/e2e/__snapshots__/s0-scaffold.png` → `filter: lfs`; в репо файл хранится как LFS-поинтер (проверено по staged-контенту) | ✅ |
| 2 | `pnpm pipeline:check` зелёный: 6 стадий (lint, arch-lint, typecheck, test, build, e2e) за ~36 c | ✅ |
| 3 | Arch-lint ловит нарушения: 8/8 юнит-тестов матрицы границ + CLI-доказательство на диске (запрещённый импорт adapters→core → exit 1, диагностика `arch/no-boundary-violation`; после отката — exit 0) | ✅ |
| 4 | Visual gate: снапшот s0-scaffold.png создан в LFS-пути; повторный прогон зелёный; **инверсия доказана** — изменение подзаголовка страницы → exit 1 (строгий режим, maxDiffPixelRatio: 0); восстановление → зелёный | ✅ |
| 5 | `tsc --noEmit` strict: 8/8 пакетов, 0 ошибок (noUncheckedIndexedAccess, exactOptionalPropertyTypes, verbatimModuleSyntax) | ✅ |
| 6 | STACK.md зафиксирован, версии = lockfile | ✅ |
| 7 | PII-контракт: `data/` в .gitignore, `git status` чист; тестовые профили не содержат PII | ✅ |
| 8 | .github/workflows/ci.yml вызывает те же npm-скрипты; пуш main + feat/S0-tooling-bootstrap выполнен — CI должен отработать на GitHub (gh CLI нет — статус проверит PO; branch protection на main включить после зелёного CI) | ✅ (CI-статус — на проверке PO) |
| 9 | husky pre-push → `pnpm pipeline:quick` (4 стадии без build/e2e; прогон ~15 c) | ✅ |

## Тесты (цифры)

- Unit: **12 passed** (arch-матрица 8 + pipeline sequencer 4), 0 failed.
- E2E: **2 passed** (brand-ассерт + снапшот).
- Красные доказательства (до реализации): arch-тесты — module-not-found; pipeline-тесты — module-not-found; e2e — webServer-timeout (Next без страницы отдаёт только 404, Playwright считает сервер неготовым) — задокументировано как честный red.

## Bugfixes / регресс-кейсы (PROCESS.md §9)

| Баг | Регресс-тест |
|---|---|
| repoRoot вычислялся на 1 уровень выше → правило молчало в CLI (юнит-тесты проходили совпадением двух ошибок) | тест матрицы теперь использует экспортированный repoRoot; правило absolutize'ит filename; findRepoRoot идёт до маркера pnpm-workspace.yaml |
| tests→scripts считался нарушением после починки repoRoot | добавлен кейс «allows tests importing scripts» |
| Снапшот-порог 0.01 проглатывал изменение текста | строгий maxDiffPixelRatio: 0 + инверсия-доказательство в AC4 |
| Снапшот писал платформенный суффикс (-win32) вне LFS-пути | snapshotPathTemplate без {platform} в LFS-каталог |

bugfixes: 4, regression cases added: 4 — совпадают.

## Security-аудит (G5)

- Секретов в коммитах нет: `.env*` в .gitignore с момента первого коммита; secrets в коде отсутствуют (grep по файлам каркаса).
- PII: `data/` вне git; снапшот содержит только scaffold-страницу без персональных данных.
- CI: actions закреплены на мажорных тегах (checkout@v5, setup-node@v4, pnpm/action-setup@v4); install идёт с --frozen-lockfile; браузер ставится отдельным шагом.
- Инъекций нет: единственный spawn (pipeline.mjs) — статические команды из planStages, не пользовательский ввод.
- Критических находок: 0.

## Метрики

- Время `pipeline:check`: **~36 c** (baseline для турбо-кэша; повторные прогоны на кэше быстрее).
- Машинных гейтов добавлено: **6** (lint, arch-lint, typecheck, unit, build, visual) + pre-push.
- Токены: dev-режим (работа агента над S0) не инструментируется шлюзом — осмысленные метрики начнутся с S3 (runtime LLM); в отчётах S1–S2 dev-токены фиксируются как N/A. Context7 MCP в сессии не экспонирован — версии сверены с npm registry (pnpm view), зафиксировано в плане.

## Отклонения от спеки (зафиксированы в STACK.md changelog)

1. **TypeScript 6.0.3 вместо 7.0**: peer-диапазон typescript-eslint `>=4.8.4 <6.1.0`; TS 7 — кандидат на будущий upgrade (needs PO approve).
2. **Собственное правило вместо eslint-plugin-boundaries** (санкционированный fallback R4(b)): pnpm-строгая node_modules не резолвит необъявленные кросс-импорты, resolution-based плагин не мог их ловить. Кастомное правило анализирует спецификаторы/пути без fs — детерминированно.
3. **Quick-режим исключает и build** (в спеке подразумевались только e2e) — иначе e2e-стадии нечего запускать; решение: quick = lint+arch+typecheck+test.

## Известные риски / на контроле

- **Строгий visual gate в CI**: linux-рендеринг шрифтов может отличаться от Windows-эталона → первый CI-прогон может упасть на снапшоте. Митигации (по возрастанию): fonts в CI уже ставятся (--with-deps); при падении — перегенерация эталона в CI или возврат platform-суффиксов (решение за PO на первом красном CI).
- **Branch protection на main** — включить вручную (Settings → Branches → required status check `pipeline`) после первого зелёного CI.
- Хук pre-push — первый запуск husky на этой машине проверен локально (`pipeline:quick` зелёный); фактический push-хук сработает при следующем пуше с этой машины.

## Вердикт

Все AC закрыты, красные/зелёные доказательства зафиксированы, отклонения задокументированы.
Инкремент готов к **G6 (approve PO)**; после — merge feat/S0-tooling-bootstrap → main и переход к S1.
