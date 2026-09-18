# S18 Report — Board Drag & Drop

Инкремент: S18 (M3.5) · Ветка: feat/S18-board-dnd · Дата: 2026-09-18
Спека: specs/S18-board-dnd.md (G1: подсветка accent; мобильная версия → эпик B-007).

## DoD / Acceptance criteria

| AC | Проверка | Статус |
|---|---|---|
| 1 | Drag new → applying, persist после reload (e2e dragTo) | ✅ |
| 2 | Drag applying → applied_manual — channel проставляется (e2e) | ✅ |
| 3 | Запрещённый drag new → interview: карточка остаётся, dnd-error виден (e2e) | ✅ |
| 4 | Dragover-подсветка: класс dropTarget на колонке (imperative-инжектор) | ✅ (код-ревью; подсветка — transient-состояние, снапшотом не тестируется по спеке) |
| 5 | Кнопочный путь: полный регресс S7 (все board-тесты зелёные) | ✅ |
| 6 | Все гейты зелёные (pipeline 0; e2e 28/28); **CI success**; baseline s7-board не менялся | ✅ |

## Тесты (цифры)

- E2E: **28 passed** (+3 DnD). Baseline доски не тронут (визуальных диффов нет).
- Unit/integration: без изменений (граф/API не менялись — по спеке).

## Реализация

- `board-dnd.tsx` (client): `BoardDnd` — сетка с dragover/drop, определение
  колонки через `closest('[data-column]')`, channel-маппинг applied_* колонок,
  PATCH → router.refresh(); `DraggableCard` — draggable-обёртка server-children
  с dataTransfer('text/jobid').
- Подсветка `.dropTarget` (border accent) — глобальное правило в tokens.css.
- Ссылка-заголовок карточки `draggable={false}` — иначе браузер тащит ссылку
  вместо карточки (поймано e2e, см. bugfix).

## Bugfixes / регресс-кейсы (PROCESS.md §9)

| Баг | Регресс-защита |
|---|---|
| Drag из центра карточки тянул LINK (браузер отдаёт приоритет дочерней ссылке над draggable-родителем) → drop без jobId молча игнорировался | `draggable={false}` на title-ссылке; e2e dragTo ловит (карточка не двигалась) |

bugfixes: 1, защит: 1 — совпадают.

## Security-аудит (G5)

- DnD использует существующий PATCH (валидация+граф без изменений); dataTransfer
  несёт только uuid, сервер валидирует. Критических находок: 0.

## Отклонения от спеки

Нет.

## Вердикт

B-006 закрыт: канбан стал канбаном в прямом смысле — перетаскивание с
графовой семантикой, кнопки как a11y-путь. Ноль зависимостей. Готов к
**G6 (approve PO)**.
