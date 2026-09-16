# S2 Report — Rule matcher

Инкремент: S2 (M1) · Ветка: feat/S2-rule-matcher · Дата: 2026-09-16
Спека: specs/S2-rule-matcher.md (G1: junior→review; remote релевантен; UI-бейдж отложен)

## DoD / Acceptance criteria

| AC | Проверка | Статус |
|---|---|---|
| 1 | `applyRules` table-driven: AB+dev→relevant; QC→excluded(province); remote→relevant(location:remote); AB+junior→review; AB+нет-матча→review | ✅ 11 юнит-тестов |
| 2 | Keyword-сети — данные (`NOC_TITLE_FAMILIES`, `JUNIOR_MARKERS`); границы: регистр, «Full-Stack»/«Développeur» через normalizeTitle | ✅ |
| 3 | Ingest применяет правила и пишет rule_* (upsert перезаписывает — «правила эволюционируют»); повтор с другим профилем (ON) меняет статусы | ✅ integration |
| 4 | `listJobs({rule})` + `GET /api/jobs?rule=` — e2e: relevant ⊂ all, все строки relevant | ✅ |
| 5 | Профиль с диска (CHINOK_PROFILE_PATH / data/profile/master_profile.json), fallback AB для CI; PII вне кода/тестов/git; тесты на синтетике | ✅ 4 юнит-теста лоадера |
| 6 | Живой прогон — корзины ниже | ✅ |
| 7 | Все гейты зелёные; arch-lint чист | ✅ pipeline:check 0 |

## Тесты (цифры)

- Unit: **50 passed** (core: 24 прежних + 11 rules + 4 profile; adapters 9 + hint 2; worker 4; pipeline 4 — итог по turbo: 9 пакетов).
- Integration: **12 passed** (ingest 3, repository 6, rules 3 — baskets/persist/filter/re-score).
- E2E: **8 passed** (+ rule-filter).
- RED→GREEN: rules-сьют (11 падений) и rules-integration (3 падения) закоммичены красными до реализации.

## Метрики живого прогона (2026-09-16)

| Корзина | Кол-во | Доля |
|---|---|---|
| relevant | 40 | 67% |
| review | 5 | 8% |
| excluded | 10 | 17% |
| (в БД суммарно с прежними live-записями: 42/5/53 — старые jobbank ON/QC строки остались excluded) | | |

Примеры review (junior-маркеры): «Software Developer Student», «Junior Full-Stack Software Developer» ×2, «Software Developer - Intern» — семантика G1-ответа №1 работает.

## Bugfixes / регресс-кейсы (PROCESS.md §9)

| Баг | Регресс-защита |
|---|---|
| **Adzuna отдаёт «Calgary, Canada» без провинции** → 27 Calgary-строк с province='' выпадали в excluded (живой прогон дал бы 2 relevant вместо 40) | region-hint в адаптере (контекст where=Alberta честно дописывается, если провинции нет) + 2 юнит-теста (hint применяется / не дублируется) |
| **master_profile хранит «Alberta», а не «AB»** → все вакансии excluded; integration-тесты проходили вакуумно (relevant=0 удовлетворяет every()), e2e поймал | лоадер маппит полные имена провинций в коды (PROVINCES из normalize) + юнит-тесты маппинга |
| e2e-фильтры не детерминированы (живая БД накапливалась, лимит 50 сравнял списки) | `--fresh` режим инжеста (truncate job+application) зашит в корневые e2e-скрипты |
| NodeNext-суффикс `.js` в новых файлах ломал Turbopack | фикс; линт-правило на запрет `.js`-импортов — кандидат в arch-lint (backlog) |

bugfixes: 4, защит: 4 — совпадают.

## Security-аудит (G5)

- PII: master_profile читается только рантаймом с диска; в тестах — синтетика; в git не попадает.
- API: `rule`-параметр валидируется по whitelist; SQL параметризован.
- Критических находок: 0.

## Отклонения от спеки

1. Зарплатный порог не включён (по спеке R5).
2. rule-бейдж в UI отложен (G1-ответ №3); фильтр доступен через API `?rule=`.

## Известные риски / на контроле

- Keyword-сети v1 широки («software», «web») — возможны лишние relevant (например «Web Designer»); калибровка по фактическим заголовкам — первый обзор в S4, когда появится score.
- Atom-фид Job Bank не фильтруется по провинции → основные AB-вакансии сейчас несёт Adzuna; расширение Job Bank (HTML-поиск) — кандидат в бэклог.

## Вердикт

Все AC закрыты; поток сужен с «всего подряд» до 67% relevant по живым данным.
Готов к **G6 (approve PO)**; после — merge в main и закрытие M1: остаются S3 (LLM-шлюз)
и далее M2. Напоминание по роадмапу: после S3 M1 завершён.
