# S24: Резюме-треки (personas) + ранжирование вакансий по трекам

Статус: accepted (G1 — мандат PO «продолжай S11» = v1.1 спеки S11, ОВ-1; 2026-10-01) · Версия: 1.0 · Milestone: **M5 (продолжение)**
Реестр: B-002 п.3–4 / S11 ОВ-1 · зависит от S11 (факты, merge, approve), S4 (скоринг), S5 (генерация).

## Проблема и цель

Суперпрофиль собирает весь опыт, но генерация и скоринг работают с «плоским» мастером. B-002: вакансия должна оцениваться **против треков** (канонических вариантов-акцентов), генерация — выбирать лучший трек. Данные уже в БД (62 факта golden-прогона: 4 опыта с разными акцентами — AI Engineer, Technical Lead, Frontend Infrastructure Lead, Full-Stack).

## Решение

### R1. Треки выводятся детерминированно из фактов опыта — ✅
`buildTracksProposal(master, experienceFacts, skillFacts)`: для каждого experience-факта — трек `{ id: slug(employer), title: payload.title, skills: [с 己 список: technology-массив факта + skill-факты, чьё имя встречается в bullets] }`. Никакого LLM: треки — перегруппировка уже одобренных provenance-фактов. Дифф-оп `add_track` в общий merge → approve пишет `tracks[]` в мастер (ст. 2.3; PO может править файл руками после).
- (откл.) LLM-кластеризация треков — изобретение; (откл.) категории скиллов как треки — категории шире реальных ролей.

### R2. Скоринг с треками: один вызов, расширенная схема — ✅
`buildScoringPrompt(profile, job, tracks?)`: блок «Candidate career tracks» (id, title, до 8 скиллов). `MatchScoreSchema += best_track (id из переданных, optional), track_scores ([{track_id, score 0-100}] optional)`. Стоимость — тот же один flash-вызов. `scoreJobsBatch` получает треки из мастер-файла (`tracks[]`), кладёт `best_track` в `job_match`.
- (откл.) 4 отдельных вызова по трекам — 4× стоимость без выигрыша для одной вакансии.

### R3. job_match.best_track + бейдж в Jobs Explorer — ✅
Миграция `ALTER job_match ADD COLUMN IF NOT EXISTS best_track TEXT`; `upsertMatch` сохраняет; строка Jobs показывает бейдж трека (токены DS); metrics — счётчик вакансий по трекам в Quality-секции (1 карточка, без новых секций).

### R4. Генерация с треком — ✅
`generateDocuments` читает `best_track` последнего job_match, находит трек в мастере и передаёт `track` в `buildResumePrompt` (блок «Emphasize this track» со списком скиллов трека). Нет трека/не найден — поведение прежнее.

## AC

1. `buildTracksProposal`: трек на каждый опыт; skills из technology+bullet-пересечений; дубли скиллов; конфликтов нет; diff `add_track` — unit.
2. Approve применяет add_track → мастер.tracks — integration.
3. Схема скоринга: best_track валидируется только из переданных id (invalid → reject); без треков поля опциональны — unit.
4. scoreJobsBatch: mock-LLM с best_track → job_match.best_track сохранён — integration.
5. e2e: сид трека в мастере + job_match.best_track → бейдж в Jobs строке; proposal показывает add_track.
6. Генерация: prompt содержит track-блок при best_track — unit.
7. Гейты + CI.

## DoD

AC1–7; STACK не меняется (без новых пакетов); отчёт S24-report.md; деплой.

## Открытые вопросы (G6)

1. Названия/набор треков финализирует PO (правка master.tracks руками + повторный approve не требуется — скоринг читает файл на лету).
2. Расширение NOC — по-прежнему отдельно (B-002 п.4).
