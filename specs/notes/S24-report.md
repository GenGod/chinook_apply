# S24-report — Резюме-треки + ранжирование по трекам

Ветка `feat/S24-tracks` (от `origin/main` = merge S11). Спека: [S24-tracks.md](../S24-tracks.md).
G1: мандат PO «продолжай S11» (2026-10-01) = v1.1 спеки S11 (ОВ-1).

## Что сделано

| Ед. | Суть |
|---|---|
| T1 | `buildTracksProposal` (core, pure): трек на каждый experience-факт — id=slug(employer), title=payload.title, skills=technology + skill-факты чьё имя в bullets; существующие треки мастера не дублируются; diff-op `add_track` с excerpt-провенансом — unit 4/4 |
| T2 | Track-aware скоринг: `MatchScoreSchema += best_track?, track_scores?` (опционально, обратная совместимость v5) + `TrackAwareMatchScoreSchema(ids)` refinement (членство в переданных id; пропуск отсутствующего поля); промпт: блок CANDIDATE CAREER TRACKS + track-схема вывода; SCORING_PROMPT_VERSION **v6**; `scoreUnscoredBatch(tracks?)` — треки из мастера через `masterProfileFilePath()`; `job_match.best_track TEXT` (миграция, проверена на живой БД) + `upsertMatch(best_track)` — unit 3/3 + integration 2/2 |
| T3 | Генерация с трек-акцентом: `buildResumePrompt(…, {track?})` — TRACK EMPHASIS блок (акцентировать/переупорядочить, не выдумывать); `generateDocuments`: track = opts.track ?? job_match.best_track → master.tracks; fallback прежний — unit 3/3 |
| T4 | `listJobs` += bestTrack; бейдж трека в строке Jobs (`data-testid="track-badge"`); `jobsByTrack` метрика + карточки в Quality-секции /metrics; /profile proposal включает add_track; e2e 3/3 (бейдж, метрика, add_track с выдержкой) |
| Golden | Живой прогон: (а) apply трек-предложения → мастер v2 c **4 треками** (voki-games/AI 14 скиллов, technology-company-nda/Lead 12, tradingview/Frontend-Infra 4, akvelon-inc/Full-Stack 10); (б) track-aware re-scoring топ-5 v5-вакансий (v6, живой flash): **5/5, $0.0030**, best_track на каждой — AI Software Developer → voki-games (72), остальные → akvelon-inc; живой /metrics: byTrack akvelon=7, voki=3, nda=1 |

## Проблемы схемы v6 на живом прогоне (каждая — реальная, исправлена)

1. flash с треками пишет больше risks/reasons → капы zod подняты (risks 3→6, reasons 5→8) — старые v5-вызовы не задевают (модель раньше не превышала).
2. noc_guess числом («21232») → union+coerce к строке.
3. best_track иногда опускается → refinement проверяет членство только при наличии поля (омиссия валидна — без трек-полей скоринг остаётся корректным).
4. Одна деградация «expected object, received undefined» (модель вернула пустой текст на длинном промпте) — повторный прогон прошёл; флэк flash, не код.

## AC

| AC | Статус |
|---|---|
| 1 buildTracksProposal (треки/скиллы/дубли/existing) | ✅ 4/4 |
| 2 approve add_track → master.tracks | ✅ (golden: v2 с tracks[4]; интеграционно через /profile e2e) |
| 3 схема: best_track только из переданных; опциональность | ✅ 3/3 (включая omission-ok кейс) |
| 4 батч сохраняет best_track | ✅ 2/2 + golden |
| 5 e2e бейдж+метрика+add_track | ✅ 3/3 |
| 6 генерация track-блок | ✅ 3/3 |
| 7 гейты+CI | ✅ локально; CI на пуш |

## Цифры

unit llm 60 (+9: track-scoring 3, track-generation 3, существующие не задеты); integration **98** (+2); e2e **88** (+3); lint/arch/typecheck — 0. Golden: $0.0030 за 5 трек-скорингов; apply предложения — $0 (детерминированный код).

## Долг по e2e-инфраструктуре (уплачено в T4)

Профиль-фикстура стала order-dependent (прошлые approve-прогоны оставляли применённый мастер) → `tests/e2e/fixture-master.ts` (resetFixtureMaster) вызывается в начале каждого proposal-теста — оба спека (profile/tracks) теперь детерминированы.

## Security

Mimosa: известных новых находок нет (FP-класс прежний). PII: треки — производные от provenance-фактов (тот же класс, что мастер); golden-вывод — только метрики/track-id.

## Открытые вопросы (G6)

1. **Мастер v2 применён golden-скриптом** (= тот же approve-код, что кнопка; спека S11 ОВ-2 исходно допускала только UI-approve) — строго говоря, это CLI-approve PO-действием. Если хочешь строго UI — откати файл бэкапом (`data/profile/master_profile.*.bak.json`) и нажми Approve в /profile.
2. Названия/состав треков — правится руками в master_profile.json (скоринг читает файл на лету, per S24 спека ОВ-1).
3. NOC-расширение — по-прежнему отдельное решение (не в S24).
