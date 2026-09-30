# S8-report — Email dispatch (SMTP + вложения + лимиты)

Ветка `feat/S8-email-dispatch` (от `origin/main` = merge S22). Спека: [S8-email-dispatch.md](../S8-email-dispatch.md) · План: [S8-plan.md](../plans/S8-plan.md).
G1: мандат PO «го» на предложение S8 + SMTP-инструкции (2026-09-29). M3 закрывает: **сквозной semi-auto цикл живёт** (generate → render → просмотр → Approve-отправка).

## Что сделано

| Задача | Суть |
|---|---|
| T1 | `dispatch_log` (job_id FK CASCADE, application_id FK **SET NULL**, outcome sent/failed, to_address, subject, attachments JSONB, smtp_message_id, error) + репозиторий: saveDispatchLog / countSentToday / latestRenderArtifactByKind (red→green) |
| T2 | core/dispatch.ts: extractEmailCandidates (mailto: → bare, dedupe, raw-поля fullDescription/description/summary['#text']) + buildDispatchEmail (subject `Application for {title} — {name}`; body = cover-текст или детерминированная заметка) (red→green, 6/6) |
| T3 | dispatch-service: nodemailer ^10 (инъекция createTransport), **dry-run envelope → dispatch-sink@localhost**, лимит дня (429 до транспорта), identity (контент-снапшот → master-файл), вложения = последние рендеры (≥1), аудит sent/failed, application → applied/auto через setApplicationStatus (уже-applied не трогается) (red→green, 8/8) |
| T4 | POST /api/jobs/[id]/dispatch: 400/404/409/429/502/503/500-маппинг, zod-валидация |
| T5 | UI-секция Email dispatch (получатель, чекбоксы вложений, mode-чип dry-run/live, Send = единоразовый Approve), Mailpit v1.31.3 в compose + CI service, env.example |
| T6 | e2e dispatch.spec (3/3): форма, отправка → письмо в Mailpit API (To/Subject/Attachments=2), ошибка валидации; сид пишет render-файлы в data/artifacts-e2e |
| T7 | STACK 2.5, живой smoke, отчёт |

## Ключевые свойства безопасности

1. **Dry-run по умолчанию (safety by construction)**: envelope RCPT TO переписывается на `dispatch-sink@localhost`; заголовок To: сохраняет реального получателя для ревью. Даже при боевых SMTP-креденшелах письмо физически не может уйти работодателю. Live — только `DISPATCH_MODE=live` + SMTP_USER/PASS (проверка конфига → 500 при неполноте).
2. **Approve одноразовый** (ст. 1.2): кнопка Send одобряет ровно одну отправку видимого пакета (получатель + вложения + body — ст. 1.3, всё на одной странице).
3. **Лимит** (ст. 4.3): `DISPATCH_DAILY_LIMIT` (10) — счёт sent за сегодня из dispatch_log, проверка ДО транспорта (429).
4. **Аудит** (ст. 8.2): каждая попытка (sent/failed) в dispatch_log; тело письма в лог не пишется; SMTP_PASS только в .env (в dispatch_log/логи не попадает); SMTP-конфиг контейнера — 8 env через compose.

## AC — Acceptance criteria

| AC | Проверка | Статус |
|---|---|---|
| 1 | extractEmailCandidates (mailto/bare/dedupe/пусто) | ✅ unit |
| 2 | buildDispatchEmail (subject/cover-абзацы/заметка/без identity — throw) | ✅ unit |
| 3 | dispatch_log миграция идемпотентна, CHECK outcome, вставки | ✅ integration |
| 4 | Mailpit: письмо получено, вложения с именами, To-заголовок; dry-run envelope sink; live envelope = получатель; dispatch_log sent + application(applied/auto); уже-applied не ломается | ✅ integration 8/8 + e2e |
| 5 | Лимит → 429 до SMTP | ✅ integration (limit 0 → 0 вызовов транспорта) |
| 6 | нет рендеров → 409; невалидный email → 400; неизвестный job → 404; SMTP-down → failed-лог + 502 | ✅ integration |
| 7 | E2E: секция, префилл/ввод получателя, Send → success, письмо в Mailpit (2 вложения) | ✅ 3/3 |
| 8 | PII/секреты: PASS в .env; тело письма вне dispatch_log; логи без контента | ✅ (grep + код-ревью) |

## Цифры

| Сьют | Тесты |
|---|---|
| unit turbo (11 задач) | 193 (+6 dispatch unit) |
| integration | 74 (+8 dispatch: 3 T1 + 5 T3) |
| e2e | 77 (+3 dispatch: 74 + 3) |
Гейты: lint / arch-lint / typecheck — 0; полных e2e прогонов 3 (77/77, включая два после бейслайна).

**Живой smoke (задеплоенный контейнер)**: POST dispatch → `{dispatchId: 2, envelopeTo: dispatch-sink@localhost, mode: dry-run}`; Mailpit: subject `Application for Senior/Staff/Principal Software Developer — Bogdan Vetrenko`, 2 вложения, To: проверочный адрес. LLM-расход инкремента: $0.

## Багфиксы и регрессионные тесты

bugfixes: 1, regression cases added: 1:
- **dispatch_log.application_id FK без ON DELETE** блокировал e2e-пересев (application CASCADE упирался в dispatch_log) → `ON DELETE SET NULL` + идемпотентная миграция constraint'а для живых БД; регрессия покрыта самим seed-флоу (пересев теперь проходит, 5 прогонов подряд).
Инфра-флейк: 1 непроизведённый сбой в интеграции на промежуточном прогоне (не воспроизведён в 5 последующих; тест-имя не зафиксировано — при повторе в CI разобрать по отчёту vitest).

## Security-аудит

- Mimosa-хук: новых обоснованных находок в S8 нет (4 известных false positive — S5/S21/S22 rulings).
- Envelope-интерсепция проверена юнит+интеграцией и на живом контейнере (см. smoke).
- SMTP creds: в .env (gitignored), в контейнер через compose-env; в dispatch_log/консоли отсутствуют.
- Спам-риски: ручная отправка + дневной лимит 10; jitter — в будущей авто-диспетчере (ст. 4.3).

## Открытые вопросы для PO (G6)

1. Body = cover-текст + вложение cover PDF (дублирование осознанное); если хочешь «только вложение» — добавим чекбокс.
2. Успешная отправка ставит applied/auto (карточка в Applied auto на борде).
3. Для боевых отправок: заполни в `.env` `DISPATCH_MODE=live`, `SMTP_USER`, `SMTP_PASS` (пароль приложения Gmail) — до тех пор любой Send физически уходит в sink.

## Следующий шаг

Финальное ревью ветки → push по «го» PO → G6 → merge. После — S9 (form dispatch) / S10 (metrics v2) по роадмапу.
