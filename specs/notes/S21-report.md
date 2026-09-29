# S21-report — Конвенция папок рендеров + история рендеров в UI

Ветка `feat/S21-render-history` (от `origin/main` = merge S6, G6 2026-09-28).
Спека: [S21-render-history.md](../S21-render-history.md) · План: [S21-plan.md](../plans/S21-plan.md).
G1: мандат PO «давай папку-конвенцию с поддержкой просмотра истории в UI» (2026-09-28), сразу после G6 S6.

## Что сделано

| Задача | Коммит | Суть |
|---|---|---|
| T1 | `S21 T1` | `renderFolderName` (UTC-дата + employer-slug + job8), `employerSlug` (latin-only, fallback `job`), dual-scheme `safeJoin` (uuid ИЛИ датированная папка) (red→green) |
| T2 | `S21 T2+T3` | append-версии: `nextRenderVersion` (max+1), явная `version` в `saveRenderArtifact` (upsert убран), `findRenderArtifact` → последняя версия (red→green) |
| T3 | `S21 T2+T3` | `renderArtifact`: employer из job → датированная папка, пара форматов получает version = max+1 каждая; `opts.now` для детерминизма тестов |
| T3b | `S21 T2+T3` | golden-скрипт идемпотентен: источники с существующим рендером — skip |
| T4 | `S21 T4` ×2 | e2e истории рендеров (retry-устойчивые относительные ассерты); **изоляция e2e-артефактов** (`ARTIFACTS_DIR=data/artifacts-e2e`); чистка живой папки от синтетики; lint-фикс скрипта |

## Решение изолированности e2e (главная находка инкремента)

Первый же golden/e2e-прогон по новой конвенции вскрыл: **e2e-рендеры писали в живую
`data/artifacts/`** (дефолтный путь общий у web-сервера e2e и прода) — синтетические
фикстуры замусоривали живой просмотр (папка с resume v1…v12 от накопленных прогонов).
Фикс: playwright webServer получает `ARTIFACTS_DIR=../../data/artifacts-e2e` (gitignored
как весь `data/`); живая папка вычищена (удалены папки, чьи job-id отсутствуют в живой БД:
3 uuid- és 3 датированных синтетических; 7 живых датированных + 7 legacy uuid остались).
Regression-механизм: e2e-прогон теперь не может смешиваться с живыми документами по построению.

## AC — Acceptance criteria

| AC | Проверка | Статус |
|---|---|---|
| 1 | `renderFolderName`: slug-правила, формат, UTC, fallback 'job' (кириллица без транслита → 'job') | ✅ unit (integration-сьют) |
| 2 | safeJoin: uuid + датированная схема принимаются, traversal/мусор/чужое расширение — null | ✅ unit |
| 3 | `nextRenderVersion`/`saveRenderArtifact(version)`: v1→v2, обе строки, UNIQUE держит дубли | ✅ integration |
| 4 | `findRenderArtifact` → последняя версия | ✅ integration |
| 5 | Файлы в `2026-09-28_fixture-corp_<job8>/`, content_path новой схемы, читаются; legacy-uuid читается (регресс S6) | ✅ integration |
| 6 | E2E: два рендера → «Resume · DOCX v1» и «v2» в списке, старая версия скачивается | ✅ e2e |
| 7 | Golden skip: 2-й прогон — 14 skipped, 0 новых | ✅ живой прогон |
| 8 | PII: в папках только slug+hex; grep имени/email по папкам = 0; git = 0 | ✅ |

## Цифры

| Сьют | Тесты |
|---|---|
| e2e (документы) | 9/9 — в т.ч. на накопленной БД без пересида (retry-устойчивость) |
| e2e полный | 72/72 |
| unit turbo | 92 (lint: OK, arch-lint: OK, typecheck: 8/8) |
| core vitest | 95 |
| integration | 62 (+4 S21) |

Golden (живая БД): прогон 1 — 7 rendered / 7 skipped (легаси-upsert S6 коллапсировал
render-строки на последнем источнике; после append у каждого источника своя строка),
прогон 2 — 14 skipped / 0 rendered / $0. Папки: `2026-09-28_neo-financial_40f8c3c5/…`,
`2026-09-28_royal-bank-of-canada_bff4786f/…` и т.д. Docker web пересобран/задеплоен
(:3000, download 200).

## UI

Новых контролов нет — история появилась сама: append-версии рендеров видны в существующем
списке версий («Resume · DOCX v1/v2/…», meta «Rendered <дата>»), каждая кликабельна и
скачивается; кнопки DOCX/PDF в превью создают новую версию и скачивают её. Бейслайн
визуального снапшота не изменился (9/9 documents e2e, включая pixel-гейт).

## Багфиксы и регрессионные тесты

bugfixes: 1, regression cases added: 1:
- **e2e-рендеры в живой папке** (описано выше) — фикс изоляцией `ARTIFACTS_DIR`;
  регрессионное покрытие — сам documents-сьют теперь физически не может писать в живую папку
  (env webServer'а), плюс ручная проверка `ls data/artifacts` после e2e (14, без изменений).

## Security

- Mimosa pre-push hook — известные pre-existing false positives (S5/S6 rulings), новых находок нет.
- Пути: dual-scheme regex + whitelist имени файла + startsWith-гвард — без изменений по существу;
  тест traversal-гварда остаётся зелёным.
- PII: slug работодателя и 8-hex вакансии — не персональные данные; grep-гейты 0/0.

## Открытые вопросы для PO

1. Легаси-uuid-папки (7 шт., ~26 файлов S6) остались на диске и читаются; если хочется
   единообразия — один прогон `render:documents` с предварительным удалением render-строк
   создаст новые версии по новой схеме (скажи — сделаю).
2. Дата в имени папки — UTC (решение спеки, ОВ-1).
