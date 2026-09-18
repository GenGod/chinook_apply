# S7: Applications Dashboard — канбан-доска откликов

Статус: accepted (G1 2026-09-18: Applied разделён на manual/auto — 6 колонок) · Версия: 1.0 · Milestone: **M3** (адаптирован к без-AI треку)
Реестр: DESIGN §6.1 (S7 переопределён: approve-флои AI-генерации недоступны до возврата
S3+; вместо этого — рабочий цикл откликов PO). Реализует B-003 (kanban, PO 2026-09-16).
Дизайн — через скиллы: superdesign (направления на канвасе) + frontend-design (дисциплина).

## Проблема и цель

Сейчас отклик = две точки на экране Jobs («не откликался» / «✓ Applied») без процесса
между ними. Реальный цикл длиннее: выбрал → изучаю/готовлюсь → откликнулся →
интервью → исход. Цель: дашборд `/board` — канбан-доска всего пайплайна поиска,
единое место управления откликами; Jobs Explorer остаётся сканером-инбоксом.

## Входные артефакты / зависимости

- DS v1.1 (S17): токены, шрифты, компоненты, гейты.
- Таблица `application` (S1a) — расширяем статусы; `job.rule_status` (S2) —
  колонка New наполняется relevant-вакансиями.

## Решение (альтернативы из brainstorm, выбор + отказ)

### R1. Форма: канбан-доска (реализация B-003)
- **(a) 6 колонок: New / Applying / Applied · manual / Applied · auto / Interview / Rejected** (G1-ответ №2: авто и ручной раздельно) — ✅:
  PO сам просил канбан (B-003, ответ на G1 S1a); доска = естественная
  визуализация воронки этапов; метрики дашборда потом читаются из тех же статусов.
- (b) Список-таблица с фильтром статуса — уже есть на Jobs (rule-фильтр);
  дашборд дублировал бы. (c) Timeline — вертикаль времени, а не состояния.
  Отклонены.

### R2. Статусная модель: расширение `application.status`
- `new` — НЕ строка в БД: вью (relevant jobs без application) — не мусорим
  таблицу пустышками, строка создаётся при первом действии.
- Строки БД: `applying`, `applied` **+ channel: `manual` | `auto`** (G1: разделение;
  авто-канал — задел под email-диспетчер S8/AI-эпоху), `interview`, `rejected`.
- Миграция v5: расширение enum + channel-колонка; существующие
  `applied_manual` → `applied` c channel `manual` (одна UPDATE-команда).
- UNIQUE(job_id, status, channel) сохраняется; одна вакансия — одна активная
  карточка (rejected потом можно реактивировать — новая строка? Нет: UPDATE
  статуса, история этапов — будущее S10+, пока последний статус).

### R3. Переходы статусов: кнопки v1, drag&drop — B-006
- Карточка несёт кнопки «← / →» соседних переходов + прямые в Interview/Rejected
  из Applied. Каноничный transition-граф: new→applying→applied→interview|rejected;
  applying→applied (реальный мануальный отклик = бывшая кнопка Applied).
- DnD красив, но дорог (a11y, e2e-стабильность, touch) — отложен в B-006;
  кнопки полностью покрывают сценарий.

### R4. Детали вакансии: отдельная страница `/job/[id]`
- **(a) SSR-страница** — ✅: полная карточка (описание из raw, зарплата, ссылки,
  статусы, история), шаребельная, тривиальная для e2e/visual-гейтов.
- (b) Drawer на доске — состояние клиента, сложнее тестировать, меньше места.
  Отклонён для v1.

### R5. Наполнение колонки New
- Все `rule_status='relevant'` без application, сортировка posted DESC, лимит
  колонки 30 + счётчик; на карточке — бейдж источника и зарплата.

### R6. Дизайн: через скиллы (регламент PO)
- superdesign: SOP «new target in existing codebase» — стилевой якорь /metrics
  (подтверждённый драфт v1.1), направления доски на канвасе (2 ветки по
  VARIANT COUNT RULE), PO выбирает.
- frontend-design: доска — рабочая сетка, не карточный кит: разная ширина
  колонок по смыслу (New шире — поток), sentence case, никаких градиентов
  кроме horizon, boldness в одном месте (заголовок доски с числом активных).

## Контракт

```ts
// packages/core
BOARD_STATUSES = ['new','applying','applied_manual','applied_auto','interview','rejected'] as const; // колонки; в БД status='applied' + channel
getBoard(db): Promise<{ columns: Record<BoardStatus, BoardCard[]>; counts }>
setApplicationStatus(db, jobId, status): Promise<ApplicationRow>  // idempotent upsert
// API
GET /api/board → columns
PATCH /api/jobs/:id/status { status } → application row
// UI
/board — kanban 5 колонок, карточки с кнопками переходов; /job/[id] — детали.
```
Миграция v5: расширение status + UPDATE applied_manual→applied + индекс (job_id).

## Acceptance criteria

1. `getBoard`: New = relevant без application (лимит 30, счётчик), остальные
   колонки из application по статусам; порядок posted DESC. Integration-тесты
   на посеянных данных.
2. `PATCH /status` идемпотентен, валидирует enum и transition-граф
   (запрещённые переходы → 400 со списком разрешённых).
3. Доска рендерит 5 колонок; кнопки переходов двигают карточку между колонками
   без reload (optimistic) и переживают reload (persist). E2E.
4. `/job/[id]` показывает полные детали + те же действия статусов. E2E.
5. Миграция applied_manual→(applied, manual): существующие ручные отклики
   попадают в колонку Applied · manual; авто-колонка пуста до S8 (integration).
6. Дизайн выбран на superdesign-канвасе (направления A/B) и реализован на DS
   v1.1; visual-gate на /board и /job/[id] (маски по дисциплине) + инверсия.
7. Все гейты зелёные; CI success.

## Тест-план

- Unit: transition-граф (разрешённые/запрещённые), валидация.
- Integration: getBoard counts/лимиты, setApplicationStatus идемпотентность,
  миграция applied_manual.
- E2E: переход new→applying→applied через кнопки (persist после reload),
  страница деталей, визуал ×2 + инверсия, keyboard-фокус.
- Метрики: время первого рендера доски (dev) — baseline в отчёт.

## DoD

- [ ] AC 1–7; STACK 1.9 (без новых зависимостей — kanban чистым CSS-grid)
- [ ] B-003 → done; B-006 (DnD) заведён
- [ ] Отчёт S7-report.md (включая superdesign-канвас-ссылку выбранного направления)

## Открытые вопросы (к PO, вместе с G1)

1. Колонки New/Applying/Applied/Interview/Rejected — ок? (Archived как 6-я —
   отдельная корзина «не актуально» — добавить сейчас или позже?)
2. Applied объединяет ручные отклики (бывший applied_manual) — ок?
3. Кнопки-переходы вместо drag&drop в v1 (DnD → B-006) — ок?
4. `/job/[id]` отдельной страницей (SSR, шаребельно) вместо drawer — ок?
