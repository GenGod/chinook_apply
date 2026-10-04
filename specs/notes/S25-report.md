# S25-report — Job Bank apply-адаптер (раскрытие панели подачи + маршрутизация)

Ветка `feat/S25-jobbank-apply-adapter` (от `origin/main` = S24 merge). Спека: [S25-jobbank-apply-adapter.md](../S25-jobbank-apply-adapter.md) · План: [S25-plan.md](../plans/S25-plan.md).
G1: мандат PO «начни делать пер-сайт форм-адаптеры; самый большой рычаг: Job Bank forms — главный канал в AB» (2026-10-03). Первый пер-сайт адаптер из отложенных S9 (v1 — mock only).

## Живое исследование (вход в спеку)

Прямые Job Bank-постинги (~⅓ живой выборки AB) прячут методы подачи за кнопкой «Show how to apply» (JSF-постбэк формы `seekeractivity`). Установлено curl'ом:
- POST `seekeractivity%3Ajobid=<id>&seekeractivity_SUBMIT=1&jakarta.faces.ViewState=stateless` к URL постинга (с JSESSIONID из GET) возвращает ПОЛНУЮ страницу с раскрытой `#howtoapply` — **без браузера**;
- на GET-странице прямых постингов email'ов НЕТ (всё за панелью) → до S25 они недиспетчируемы;
- панель содержит: By Direct Apply (Plus-аккаунт), By email + **скрининг-вопросы работодателя**, Apply online (внешняя ссылка), in person/phone;
- есть **троттлинг** раскрытий (сессия/IP): после нескольких раскрытий панель перестаёт раскрываться.

## Что сделано

| Задача | Суть |
|---|---|
| T1 | `packages/adapters/src/jobbank-apply.ts`: classifyPosting (partner/direct/unknown по маркерам `externalJobLink`/`applynowbutton`), extractApplyMethods (email по h4-заголовкам, webUrl, directApply, скрининг-вопросы с разворотом вложенных списков, notes, otherText), buildRevealPostBody. 6 синтетических фикстур живой разметки (PII обезличен). red→green 9/9 |
| T2 | revealApplyMethods (GET→POST→parse; partner без POST; POST без панели = throttled), httpRevealFetch (egress-guard B-010 + cookie-jar) поверх cookieJarRevealFetch (инъекция политики — урок Mimosa/S9). Интеграция против node:http-сервера, воспроизводящего cookie+троттлинг-поведение |
| T3 | `jobbank-dispatch-service.ts`: revealJobApplyMethods — кэш-first (TTL 15 мин), source-чек, запись `raw.applyMethods` (только сервис), RevealJobNotFoundError; POST `/api/jobs/[id]/reveal-apply` (методы из запроса не принимаются); `/dispatch` — `to` опционален: авто-reveal получателя (клик Send = approve, ст. 1.2). Интеграция 13/13 (кэш/TTL/throttle/egress/404) |
| T4 | Секция «Apply methods (Job Bank)» на `/job/[id]` (reveal/re-check, DS-токены, вопросы — display-only, ответы НЕ генерируются — ст. 2); префилл получателя email-диспетча из раскрытых методов; autoRecipient: пустой получатель разрешён при наличии раскрытого email (hint «auto-resolves») |
| T5 | e2e 4/4 (секция+префилл+вопросы; re-check из кэша без сети; авто-reveal отправка в dry-run; визуальный бейслайн `s25-apply-methods-win32.png` LFS, threshold 0.01); сид: applyMethods-кэш на первой relevant-вакансии (email совпадает с S23-фикстурой — контракт префилла не тронут); скрипт живого смоука tests/scripts/s25-live-smoke.mjs (в tests/ — arch-граница: scripts не импортируют внутренние пакеты) |

## Ключевые свойства (конституция)

1. **Read-only раскрытие**: S25 ничего не отправляет в Job Bank — только GET+один POST постбэка панели по действию PO; submit'ы — только S9/S26.
2. **Консервативная политика** (ст. 11 + DESIGN §7): никогда батчами, TTL-кэш 15 мин, троттлинг → graceful `throttled` без ретраев, ручной фолбэк.
3. **Egress (B-010)**: прод-транспорт только через `assertSafeExternalUrl(EGRESS_JOBBANK_HOSTS)`; http-localhost-тестовый транспорт выделен отдельно (инъекция политики вызывающей стороной).
4. **Цель раскрытия — только job.url из БД**; API не принимает ни URL, ни методы (surface подмены закрыта).
5. **Скрининг-вопросы — display-only** (ст. 2: ответы — факты PO, не агента; авто-ответы запрещены).

## AC

| AC | Статус |
|---|---|
| 1 classifyPosting (partner/direct/unknown/пусто) | ✅ unit 4/4 |
| 2 extractApplyMethods (email+вопросы+заметки+directApply / webUrl / in person / без панели) | ✅ unit 4/4 (+entities) |
| 3 buildRevealPostBody | ✅ unit |
| 4 revealApplyMethods против локального сервера (cookie→panel / throttle / egress) | ✅ integration 4/4 |
| 5 revealJobApplyMethods (raw-кэш запись/чтение, TTL, throttle не перезаписывает, не-jobbank, egress-URL) | ✅ integration 6/6 (+parse 2/2) |
| 6 API: методы только выдаются; 404 | ✅ сервис-уровень + e2e |
| 7 Email-диспетч с авто-reveal (dry-run sink; пустой to) | ✅ e2e |
| 8 E2E: секция/префилл/re-check/визуал (baseline + threshold 0.01) | ✅ 4/4, 2 стабильных прогона |
| 9 Гейты 0 | ✅ pipeline:check — 6 стадий зелёных |

## Цифры

unit (adapters) 18/18 (+18 к S24); integration **110/110** (+13); e2e **92/92** (+4, ×2 стабильных прогона; финальный pipeline — 92); lint/arch-lint/typecheck — 0 (8 пакетов). LLM: **$0** (инкремент без LLM). STACK не меняется (новых внешних пакетов нет; `@chinook/adapters` добавлен в deps пакета tests — workspace-линк).

## Живой smoke (read-only, 3 попытки)

1. `50411103` (AB welder) → `partner` — классификация партнёрского верна live.
2. `50415430` (welder-assembler, прямой) → `throttled` — IP-троттлинг с исследовательской сессии ещё активен; graceful-путь подтверждён live (без краша, без ретраев).
3. `50413289` (ethnic food cook, прямой) → `throttled` — аналогично.

Полный `revealed`-путь против живого сайта валидирован в исследовании (curl-флоу, идентичный адаптеру, вернул панель с email + скрининг-вопросами; разметка зафиксирована в фикстурах). Повторный live-reveal — после сброса троттлинг-окна (окно неизвестно; константы в спеке ОВ-3).

## Отклонения от плана

- `seekeractivity:jobid` — число из **URL** постинга, а не feed-«Job number» (source_job_id): у живых постингов это разные числа (50415430 vs 17407929). Функция `revealJobId` выводит id из URL с fallback на source_job_id.
- httpRevealFetch разделён на cookieJarRevealFetch (транспорт) + guard-обёртка: egress требует https, локальный тестовый сервер — http; строгость guard не ослаблена, транспорт тестируется отдельно.
- Секция/сервис — **data-driven** (кэш-first): сид кладёт фикстуры на adzuna-вакансию (первая relevant по дате); applyMethods пишутся только jobbank-сервисом, поэтому провенанс сохраняется, отображение — по данным.
- EmailDispatchSection: новый опциональный проп `autoRecipient` (кнопка Send активна при пустом получателе, если есть раскрытый email; hint объясняет) — иначе пустой получатель не отправляем (S8-контракт сохранён для остальных вакансий).
- S19–S25 в DESIGN §6.1 не регистрируются (конвенция последних инкрементов — реестр остановился на S11).

## Security (Mimosa / ручной аудит)

- **Новые env/секреты**: нет.
- **Mimosa-флаги на инкремент** (таинт-анализ, тестовый файл tests/integration/jobbank-apply.test.ts): «SSRF entry» на cookieJarRevealFetch в тестах — инъекция fetcher сделана намеренно (политика вызывающей стороны; прод-путь — httpRevealFetch под guard, покрыт юнит-тестами на отказ http:// и чужих хостов); «XSS» на readFileSync фикстуры — HTML-строка в тесте, не рендерится в браузер; «sql-injection» на revealJobApplyMethods — Kysely-параметризация (kysely-гейт зелёный). Флаги не воспроизводимы как эксплойты.
- **L2-флаг «命令注入» (jobbank-apply.ts:46/48/55)** — ложное срабатывание по имени метода: это `RegExp.prototype.exec()` (ECMA-262 §21.2.5.2, сопоставление строки), не исполнение команд; в файле нет ни одного реального sink (child_process/spawn/eval — grep пуст; рекомендация хука ссылалась на Python `subprocess.run`, к TS неприменима). Для чистоты будущих сканов вызовы переписаны на эквивалентные `String.match`/`matchAll` (поведение идентично, тесты 49/49 + 12/12 green).
- **Наследуемые флаги** (не S25): SSRF в tests/e2e/dispatch.spec.ts (fetch к Mailpit по константе 127.0.0.1 — тест-фикстура), ingest.ts:64 (источник URL — фид-адаптер под egress-guard с B-010), llm/gateway.ts «sql-injection» (Kysely + pg-параметризация; проверено ранее). Рекомендация PO: разовая сверка с B-010-аудитом.
- dispatch route: to из запроса проходит EMAIL_RE-валидацию в sendApplicationEmail (400 на мусор); авто-reveal не принимает адрес из запроса.

## DoD

- [x] AC1–9; гейты зелёные (pipeline:check 6 стадий); отчёт; BACKLOG (S26 заведён как B-013, changelog 2.7).
- [x] STACK — без изменений; DESIGN — реестр не трогаем (см. отклонения).
- [ ] Merge-гейт PO (G6) — ветка `feat/S25-jobbank-apply-adapter`.

## Открытые вопросы (G6)

1. **S26 Direct Apply** (B-013): нужен Job Bank Plus-аккаунт PO (env JOBBANK_SEEKER_EMAIL/PASSWORD) + живые снимки пост-логин разметки — слепые селекторы запрещены.
2. TTL 15 мин / политика повторов — скорректировать по живой статистике троттлинга (окно сброса неизвестно).
3. Селектор «Apply online» (webUrl) не встречался в живой выборке — дофиксить по первому живому примеру (фикстура уже есть).
4. Скрининг-вопросы: авто-подстановка ответов PO из профиля — кандидат в бэклог (ст. 2: только PO-факты).
