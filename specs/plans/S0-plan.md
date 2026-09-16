# S0 Plan — Tooling bootstrap

Спека: specs/S0-tooling-bootstrap.md (accepted, G1 2026-09-16)
Модель-исполнитель плана: Архитектор GLM-5.3; реализация — Имплементатор.

## Фиксация окружения (факты)
- Node v26.7.0, pnpm 11.21.0, git-lfs 3.7.1. gh CLI нет.
- Remote: git@github.com:GenGod/chinook_apply.git, локально 0 коммитов, ветка master.
- Решение по Node: пиним 26 (текущая машина PO; LTS-статус по графику Node — октябрь 2026,
  т.е. через недели; рассинхрон локаль/CI исключаем единым пином). Отражено в STACK.md.

## Шаги (каждый с критерием проверки)

1. **Git-база.** branch main; .gitignore (data/, .env*, node_modules, .turbo, dist,
   coverage, playwright artifacts); .gitattributes (LFS: tests/**/__snapshots__/**/*.png);
   `git lfs install`; первый коммит с проектными документами в main.
   Критерий: `git status` чист от data/; `git check-attr` на тестовом png → filter=lfs.

2. **Каркас workspace (не прод-код).** package.json root (scripts pipeline:*),
   pnpm-workspace.yaml, turbo.json, tsconfig.base.json; пакеты-каркасы:
   packages/{contracts,core,llm,adapters}, packages/eslint-plugin-arch (JS),
   apps/web (минимальный Next.js, 1 страница), apps/worker, tests (unit+e2e).
   Установка зависимостей (последние версии из registry → lockfile).
   Критерий: `pnpm install` проходит; структура совпадает с DESIGN.md §8.

3. **RED-тесты (до реализации гейтов).**
   - packages/eslint-plugin-arch/test/boundaries.test.mjs: программный ESLint-ран
     на инлайн-фикстурах: adapters→core = ошибка; pkg→apps = ошибка; чистый = 0.
   - tests/unit/pipeline.test.mjs: порядок stage, fail-fast, quick-режим без e2e.
   - tests/e2e/s0-smoke.spec.ts: страница содержит "Chinook"; toHaveScreenshot.
   Критерий: прогон тестов падает (красный) по отсутствию конфига/скрипта/страницы.

4. **GREEN: arch-lint.** src/index.js с flat-config на eslint-plugin-boundaries +
   модель слоёв из спеки; корневой eslint.config.js реэкспорт.
   Критерий: boundaries-тесты зелёные; `turbo lint` чист.

5. **GREEN: pipeline.** scripts/pipeline.mjs (тестируемый sequencer: stage list,
   spawn, fail-fast, quick-mode) + корневые скрипты; turbo-задачи lint/arch-lint/
   typecheck/test/build; e2e через playwright.
   Критерий: pipeline-тесты зелёные; `pnpm pipeline:check` зелёный end-to-end.

6. **GREEN: web + snapshot.** apps/web страница-каркас; playwright.config
   (webServer = next start, 1280x720, snapshots в LFS-путь).
   Критерий: снапшот создаётся, повторный прогон зелёный; инверсия страницы
   (врем. правка) роняет diff — вернуть и зафиксировать в отчёте.

7. **DoD-обвязка.** husky pre-push → pipeline:quick; .github/workflows/ci.yml
   (pnpm, node 26, LFS checkout, playwright chromium, pipeline:check);
   STACK.md из lockfile + changelog; engines/packageManager pins.
   Критерий: AC 1–9 спеки зелёные; коммиты на feat/S0-tooling-bootstrap;
   push → CI стартует.

8. **Отчёт.** specs/notes/S0-report.md: тесты цифрами, время pipeline,
  токены-замечание (dev-метрики вне инструментирования — честно фиксируем),
   security-выводы, AC-чеклист. → G6 у PO.

## Риски/примечания
- Playwright browser download (~120 МБ) — при блокировке сети fallback: channel chrome.
- typescript-eslint + boundaries на ESLint 9 flat — сверить мажоры при установке.
- Context7 MCP в сессии не экспонирован — версии берём из npm registry
  (pnpm view), фиксируем отклонение в отчёте.
