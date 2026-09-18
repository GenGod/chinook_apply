# S7 Report — Applications Dashboard (канбан-доска откликов)

Инкремент: S7 (M3) · Ветка: feat/S7-board · Дата: 2026-09-18
Спека: specs/S7-applications-dashboard.md (G1: 6 колонок — applied manual/auto).
Дизайн: superdesign-драфт «Chinook — Kanban Board» (PO approved 2026-09-18);
реализация на DS v1.1 (S17).

## DoD / Acceptance criteria

| AC | Проверка | Статус |
|---|---|---|
| 1 | `getBoard`: 6 колонок; New = relevant без application (лимит 30, total-счётчик с «+»); порядок posted DESC | ✅ integration |
| 2 | `PATCH /api/jobs/:id/status`: zod-валидация тела, transition-граф (400 со списком разрешённых), channel manual\|auto только для applied, идемпотентность; `new` = удаление строки (back из applying) | ✅ unit (7) + integration (5) |
| 3 | Доска: 6 колонок, карточки, кнопки переходов; перемещение persist после reload; вернуться в New (строка удалена) | ✅ e2e |
| 4 | `/job/[id]`: детали (описание из raw, зарплата, ссылка с noopener), те же статус-контролы | ✅ e2e |
| 5 | Миграция v5: `applied_manual` → `applied`+`manual`; уникальный индекс; channel NOT NULL | ✅ integration |
| 6 | Дизайн по superdesign-драфту на DS v1.1 (fixed-px колонки 300/180/180/140/180/140 — иерархия New шире, auto-колонка приглушена opacity 0.65, active-count в Crimson Pro — смелое место); visual-gate s7-board + **инверсия** (--accent → 1, откат → 0, в изолированном и полном режимах) | ✅ |
| 7 | Все гейты зелёные: pipeline:check 0; unit 56; integration 24; e2e 25; arch-lint чист | ✅ |

## Тесты (цифры)

- Unit (core): **56 passed** (+7 board: граф переходов, channel-требования).
- Integration: **24 passed** (+5 board: миграция легаси, getBoard, перемещения,
  forbidden-переходы, markAppliedManually-совместимость).
- E2E: **25 passed** (+5 board: колонки, persist-перемещение с возвратом,
  applied_manual-сплит, страница деталей, visual).

## Реализация

- `packages/core/src/board.ts`: BOARD_STATUSES/TRANSITIONS/canTransition/
  requiredChannel/getBoard/setApplicationStatus (+TransitionError).
- Миграция v5 (SCHEMA_SQL): `application.channel NOT NULL`, легаси-UPDATE.
- API: `GET /api/board`, `PATCH /api/jobs/[id]/status`.
- UI: `/board` (server) + `status-controls.tsx` (client, CSS-модули после
  провала styled-jsx в Turbopack) + `/job/[id]` (server, описание из raw,
  noopener-ссылка); навигация Jobs/Board/Metrics сквозная.
- Модель: строка application создаётся при первом действии; `new` виртуальна.

## Bugfixes / регресс-кейсы (PROCESS.md §9)

| Баг | Регресс-защита |
|---|---|
| **КРИТИЧЕСКОЕ ПОВТОРЕНИЕ S12: kysely-билдеры без `.execute()` молча не исполнялись** — fresh-делиты в runIngest не чистили application с S15; локально e2e-БД копила строки (маски визуала плыли, счётчики врали); CI не видел (сервис-БД свежая каждый прогон) | **`scripts/check-kysely.mjs`** — греп-гейт в lint: любой `await db.deleteFrom/insertInto/updateTable` без `.execute()` = красный пайплайн; класс бага закрыт навсегда |
| styled-jsx не компилируется Turbopack'ом в client-компоненте → кнопки без стилей (прозрачные) | стили переведены в board.module.css; styled-jsx исключён из практики |
| fr-колонки грида рендерились с разной шириной от контента → маски визуала плавали между прогонами | фиксированные px-колонки (fixed-box дисциплина распространена на гриды) |
| Visual-тест зависел от мутаций предыдущих тестов файла (baseline ≠ изолированный прогон) | visual-тест первым в файле (состояние = чистый сид); проверено в обоих режимах |
| e2e-селектор `.cardTitle` (хешированный CSS-модуль) не матчился | data-атрибуты вместо классов (уже практика) |

bugfixes: 5, защит: 5 — совпадают.

## Security-аудит (G5)

- PATCH-статус: uuid+zod-валидация, transition-граф — состояние меняется только
  по валидному пути; никакого SQL из ввода (kysely-параметризация).
- `/job/[id]` рендерит описание из raw как ТЕКСТ (stripHtml, без dangerouslySetInnerHTML) —
  XSS из фидов исключён.
- Критических находок: 0.

## Отклонения от спеки

1. `canTransition('applying'→'new')` реализовано как DELETE строки (виртуальная
   колонка) — семантика спеки сохранена.
2. styled-jsx → CSS-модули (Turbopack-несовместимость).

## Известные риски / на контроле

- Board visual требует сид перед изолированным прогоном (документировано в
  тесте); в CI полный прогон детерминирован.
- B-006 (drag&drop) заведён; авто-канал применит диспетчер S8/AI-эпохи.

## Вердикт

B-003 закрыт: полный цикл откликов на одной доске, авто/ручной разделены (G1),
легаси-данные мигрированы. Готов к **G6 (approve PO)**.
