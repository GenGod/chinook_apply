# S25: Job Bank apply-адаптер — раскрытие панели «How to apply» и маршрутизация каналов

Статус: accepted (G1 — мандат PO «начни делать пер-сайт форм-адаптеры; самый большой рычаг: Job Bank forms — главный канал в AB», 2026-10-03) · Версия: 1.0 · Milestone: **M6 (пер-сайт адаптеры)**
Реестр: продолжение S9 (пер-сайт адаптеры были отложены как «будущие спеки») + S23 (статический apply-email — расширяется динамическим раскрытием) · зависит от S8 (email-канал), S9 (form-механизм), B-001 (external apply).

## Проблема и цель

Job Bank — главный канал в AB. Постинги делятся на **партнёрские** (apply по внешней ссылке — Indeed/Jobillico/…) и **прямые** (~⅓ живой выборки AB, 2026-10-03): у прямых методы подачи спрятаны за кнопкой «Show how to apply», которая делает JSF-постбэк. Следствия для системы:

- **Прямые постинги сейчас недиспетчируемы**: GET-страница НЕ содержит ни email, ни formConfig — S23 ловит только статические адреса (в живой выборке у прямых постингов — ноль email на GET-странице), S9 не срабатывает (formConfig нет). Единственный путь — ручной.
- Для email-постингов адрес и **скрининг-вопросы работодателя** («What you must include in your application») остаются невидимыми.

Цель S25 — **первый пер-сайт адаптер**: HTTP-раскрытие apply-панели Job Bank (без браузера), извлечение методов подачи (email / веб-ссылка / Direct Apply / вопросы), кэш в `job.raw`, маршрутизация в существующие каналы (S8 email, B-001 external, ручной фолбэк). Подача через сам Job Bank (**Direct Apply**, требует Plus-аккаунт) — отдельная спека S26 (нужны creds PO, см. открытые вопросы).

## Находки живого исследования (2026-10-03, фиксируются для воспроизводимости)

1. Маркеры типа постинга: партнёрский — `<a id="externalJobLink">` внутри `#applynow` (ссылка на внешний сайт в `href`); прямой — `<button id="applynowbutton">Show how to apply</button>` + форма `<form id="seekeractivity">` (POST к URL самого постинга, поля: `seekeractivity:jobid=<id>`, `seekeractivity_SUBMIT=1`, `jakarta.faces.ViewState=stateless`).
2. **Раскрытие без браузера**: GET постинга (получаем JSESSIONID) → POST того же URL с телом формы → сервер возвращает ПОЛНУЮ страницу с раскрытой `#howtoapply` (JSF stateless; AJAX-вариант не нужен). Проверено curl.
3. **Троттлинг**: после нескольких раскрытий подряд сервер перестаёт раскрывать панель (POST отрабатывает, `#howtoapply` отсутствует) — на сессию/IP. Адаптер обязан быть консервативным.
4. Состав панели `#howtoapply`: «By Direct Apply» (попап `#direct-apply-popup` → Sign in → `/login`); в `details` «Additional ways to apply»: `h4#htaemail` «By email» + `mailto:`/адрес; «Apply online»-вариант — `h4` + внешняя ссылка; `h4` «What you must include in your application:» → `ul/li` (скрининг-вопросы); «What might be required…» → `li` (заметки). Прочие способы (in person/mail/phone) — текст.
5. Страница входа Job Bank: `GET /login` → форма POST `/connexion` (email+пароль); капчи при первом GET не обнаружено. Используется только S26.
6. Партнёрские постинги (в т.ч. Indeed-агрегаты) — применяем только чтение external-ссылки; авто-заполнение чужих сайтов по-прежнему запрещено (S9 R1).

## Решение (brainstorm, выбор + отказ)

### R1. Раскрытие — HTTP-адаптер в packages/adapters, без Playwright — ✅
`packages/adapters/src/jobbank-apply.ts`: чистые функции + инъекция fetch. `classifyPosting(html)` → `partner|direct|unknown`; `extractApplyMethods(panelHtml)` → `ApplyMethods`; `revealApplyMethods(deps, postingUrl, jobId)` — GET (cookie-jar) → POST → парсинг. Egress — только через `assertSafeExternalUrl(EGRESS_JOBBANK_HOSTS)` (B-010). UA — `crawlerUserAgent()` (идентификация, DESIGN §7).
- (откл.) Playwright-раскрытие — браузер не нужен для stateless-постбэка; он нужен только S26.
- (откл.) эмуляция JSF AJAX (`Faces-Request: partial/ajax`) — сложнее, даёт тот же результат, что полный POST.

### R2. Извлечение — по заголовкам h4, не только по id — ✅
`extractApplyMethods` идёт по `#howtoapply`: email — от `h4` «By email» (mailto-ссылка приоритетна, иначе текст); webUrl — от `h4` «Apply online»/«By web» (первая внешняя http(s)-ссылка); screeningQuestions — `li` из блока «What you must include»; notes — «What might be required…» (в т.ч. `data-appinst`); `directApply: true` при наличии `#direct-apply-popup`/`a.openDA`; прочее — `otherText` (in person/phone) одной строкой. Результат — `ApplyMethods | null` (панели нет → null). Фикстуры — из живых страниц (обезличенные email'ы).

### R3. Кэш в `job.raw.applyMethods`, запись только сервисом — ✅
При успешном раскрытии: `raw.applyMethods = { …ApplyMethods, revealedAt: ISO }`. Запись — только серверным сервисом (паттерн S23 `raw.fullDescription`); клиентский API не принимает методы. UI показывает кэш; кнопка «Reveal» — явное действие PO (read-only запрос к Job Bank, ничего не отправляет — ст. 1.1 не задета).
- (откл.) отдельная таблица apply_method — YAGNI: один источник (Job Bank), данные атомарны вакансии.

### R4. Консервативная политика раскрытия (троттлинг, ст. 11) — ✅
Раскрытие — ТОЛЬКО по требованию (кнопка в UI / попытка диспетча), никогда батчем в ingest/scheduler. Один POST на попытку; повторное раскрытие не чаще раза в N минут (кэш `revealedAt`; N=15 — константа в core). Троттлинг (POST успешен, панели нет) → статус `throttled` в ответе, UI — «показать вручную» + внешняя ссылка на постинг; аудит — `event_log` не нужен (read-only), троттлинг не ретраится автоматически.
- (откл.) авто-раскрытие при ingest — 20-30 POST за цикл на источник = гарантированный троттлинг + чужая нагрузка.

### R5. Маршрутизация каналов по методам — ✅
`apps/web/src/lib/jobbank-dispatch-service.ts`: `revealAndRoute(db, jobId)`:
- `email` → предложение email-диспетча: UI-блок Email получает адрес (фронт вызывает существующий POST /dispatch с `to` из кэша — одобрение остаётся явным, ст. 1.2);
- `webUrl` → рядом с «↗» появляется извлечённая прямая ссылка (B-001 контракт; авто-заполнение чужих форм запрещено — S9 R1);
- `directApply` → бейдж «Direct Apply» со ссылкой на постинг (S26 — будущая автоматизация);
- ничего/unknown → «manual» подсказка.
Скрининг-вопросы и заметки — display-only на странице вакансии: ответы НЕ генерируются (ст. 2 — не порождать факты), PO отвечает вручную в письме.

### R6. Диспетч-флоу с авто-reveal — ✅
`POST /api/jobs/[id]/reveal-apply` (read-only раскрытие + кэш + возврат методов). Если PO жмёт Email-dispatch у jobbank-вакансии без сохранённого адреса — сервис сначала делает reveal (тот же код), при успехе отправляет на найденный адрес (одобрением считается клик по Send — ст. 1.2 соблюдена), иначе 409 с методами/троттлингом.

### R7. Тест-стратегия: фикстуры живой разметки + локальный mock-сервер — ✅
Фикстуры: GET/POST-страницы прямого постинга (обезличены), партнёрский, expired, троттлинг-вариант. Unit: classify/extract (7+ вариантов). Integration: локальный http-сервер с cookie-сессией — reveal-флоу (GET→POST→методы), троттлинг-вариант → `throttled`, не-jobbank URL → отказ egress. E2E: сид raw с фикстурной разметкой → страница вакансии → Reveal → блок методов → Email-диспетч на демо-адрес (dry-run sink) → visual baseline. Прямых запросов к www.jobbank.gc.ca из тестов НЕТ (только фикстуры).
- (откл.) golden-тесты против живого сайта в CI — троттлинг + недетерминизм.

### R8. Дефолтный reveal — браузерный (Playwright), HTTP-постбэк — тестовая стратегия (дополнение 2026-10-04) — ✅
Live-диагностика 2026-10-04: разметка/JS-хэндлер постинга НЕ менялись, но «голый» fetch-POST постбэка стал стабильно получать страницу без панели (200, без rate-limit заголовков) — в т.ч. на свежих постингах и с браузерным UA, при этом **реальный chromium (клик по кнопке) раскрывает панель с того же IP**. Вывод: клиентский фингерпринт-гейт Job Bank на HTTP-эмуляции. Решение — reveal тем же действием, что и пользователь (ст. 11): Playwright открывает постинг, кликает `#applynowbutton`, ждёт `#howtoapply`, извлекает методы `extractApplyMethods(page.content())`; капча-маркер на странице → немедленный stop (ст. 11.3, `detectCaptcha` до клика). Это НЕ обход анти-бота: настоящий браузер выполняет штатное действие интерфейса, никакого спуфинга/ретраев/ротаций. HTTP-`revealApplyMethods` сохранён в адаптере (unit/integration покрытие, стратегия для тестов и будущих деплоев с «чистым» egress), но прод-дефолт сервиса — браузерный путь. Egress для браузерного пути: https + allowlist-хосты до `goto`.
- (откл.) каскад «HTTP → при throttled браузер» — формально повторная попытка после анти-бот-стоп (11.3); (откл.) подгонка заголовков/TLS под браузер в fetch — спуфинг, запрещён.

## Контракт

```ts
// packages/adapters/src/jobbank-apply.ts
export type PostingKind = 'partner' | 'direct' | 'unknown';
export interface ApplyMethods {
  email: string | null;
  webUrl: string | null;
  directApply: boolean;
  screeningQuestions: string[];
  notes: string[];
  otherText: string | null;
}
export function classifyPosting(html: string): PostingKind;
export function extractApplyMethods(pageHtml: string): ApplyMethods | null;   // null = панели нет
export interface RevealFetch {
  get(url: string): Promise<{ status: number; body: string; cookies?: string[] }>;
  post(url: string, body: string, headers?: Record<string, string>): Promise<{ status: number; body: string }>;
}
export function buildRevealPostBody(jobId: string): string;                    // seekeractivity:jobid=…&_SUBMIT=1&ViewState=stateless
export async function revealApplyMethods(fetcher: RevealFetch, postingUrl: string, jobId: string):
  Promise<{ kind: 'revealed'; methods: ApplyMethods } | { kind: 'throttled' | 'partner' | 'unavailable' }>;
// web/src/lib/jobbank-dispatch-service.ts
revealJobApplyMethods(db, jobId, opts?): Promise<{ status: 'revealed'|'throttled'|'cached'|'partner'|'unavailable'; methods: ApplyMethods|null }>
  // кэш свежый (<15 мин) → 'cached'; пишет raw.applyMethods; egress-guard; source!=='jobbank' → 'unavailable'
// API: POST /api/jobs/[id]/reveal-apply → 200 { status, methods? } | 404
// UI: /job/[id] — секция «Apply methods (Job Bank)»: Reveal-кнопка; email → подстановка в Email dispatch; webUrl → ссылка; вопросы/notes — display-only
```

## Acceptance criteria

1. classifyPosting: партнёрский/прямой/expired-мусор → верный kind — unit (фикстуры).
2. extractApplyMethods: email+вопросы+заметки; только Direct Apply; Apply online (webUrl); in person → otherText; без панели → null — unit.
3. buildRevealPostBody: точное тело POST (экранирование id) — unit.
4. revealApplyMethods против локального mock-сервера: GET→POST→revealed; POST без панели → throttled; не-2xx → unavailable — integration.
5. revealJobApplyMethods: кэш в raw читается/пишется (revealedAt), не-jobbank → unavailable, повтор ≤15 мин → cached — integration.
6. API reveal-apply: 200/404, методы не принимаются из запроса (только выдача) — integration.
7. Email-диспетч с автo-reveal: jobbank-вакансия без to → reveal найдёт email → sendApplicationEmail уходит на него (dry-run sink); троттлинг → 409 — integration.
8. E2E: сид → страница вакансии → Reveal → блок методов (email/вопросы) → Email Send (dry-run) → dispatch_log; visual baseline + инверсия.
9. Гейты: lint/arch-lint/typecheck 0; unit/integration/e2e зелёные; секреты не затронуты (новых env нет).

## Тест-план

Unit (adapters): AC1–3. Integration (web): AC4–7 (локальный http-сервер + БД). E2E: AC8. Фикстуры — `tests/fixtures/jobbank/*.html` (обезличенные живые страницы, git-lfs не нужен — HTML маленький).

## Метрики

LLM: $0 (без LLM). dispatch_log — без изменений (email-канал уже пишется). Отчёт: число прямых постингов, где reveal нашёл email (живой smoke), троттлинг-статистика.

## DoD

- [ ] AC1–9; STACK не меняется (без новых пакетов); отчёт specs/notes/S25-report.md; BACKLOG: S26 (Direct Apply) заведён.
- [ ] Живой smoke (опционально, ручной): reveal на реальном AB-постинге — результат в отчёте (без отправки).

## Открытые вопросы (G6)

1. **S26 Direct Apply**: требует Job Bank Plus-аккаунт PO (env `JOBBANK_SEEKER_EMAIL/PASSWORD`, docker secret) — заводить creds и спеку после предоставления. Пост-логин разметка (`Apply on Job Bank` → выбор резюме аккаунта → submit) в спеку S25 не включена — она кодится только по живым снимкам, слепо писать селекторы запрещено (S23-урок).
2. Скрининг-вопросы: v1 — display-only. Авто-подстановка ответов PO (шаблон ответов в профиле) — кандидат в бэклог (ст. 2: ответы — факты PO, не агента).
3. Окно повторного раскрытия (15 мин) и лимит раскрытий в день — константы в core; скорректировать по живой статистике троттлинга.
4. Веб-вариант панели («Apply online») в живой выборке не встретился — селектор по h4-заголовку, дофиксить по первому живому примеру (фикстуру добавить при первой встрече).
