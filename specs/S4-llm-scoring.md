# S4: LLM-скоринг вакансий — семантический матчинг под профиль PO

Статус: accepted (G1 2026-09-21: golden-set PO-разметка; Spearman ≥ 0.7; score-гистограмма на /metrics) · Версия: 1.0 · Milestone: **M2**
Реестр: DESIGN §6.1 (S4) · зависит от S3 (done — шлюз живой), S2 (rule_* — первый уровень).

## Проблема и цель

Rule-matcher (S2) отсекает чужие провинции и нерелевантные тайтлы, но это
детерминированный фильтр: «Senior React Developer» в Калгари и «Senior Care
Assistant» в Эдмонтоне оба могут пройти keyword-сеть. Цель S4: LLM-скоринг
каждой relevant/review вакансии — `match_llm` на flash-модели через шлюз (S3):
JSON `{score 0–100, reasons[], risks[], noc_guess}`; результат в `job_match`
(таблица из DESIGN §3.2, зарезервированная с S2). Jobs Explorer получает
score-колонку с сортировкой; фильтр по score-порогу.

## Входные артефакты / зависимости

- S3: шлюз (кэш = повторный скоринг бесплатен; flash ≈ $0.00002/вакансия по ping).
- S2: `rule_status` relevant/review — скоринг только этих корзин (excluded не тратим токены).
- Профиль: `master_profile.json` → summary+skills+experience → промпт-контекст.
- Golden set: **30 вакансий** с ручной разметкой PO (score-калибровка).

## Решение (альтернативы из brainstorm, выбор + отказ)

### R1. Промпт: структура, не свободный текст
- **(a) Системный промпт с жёсткой схемой: роль (recruiter-оценщик), профиль-контекст
  (summary+skills+target NOC из master_profile), вакансия (title+employer+location+
  salary+description-excerpt), инструкция: оцени соответствие 0–100; выведи
  strictly JSON {score, reasons[3–5], risks[0–3], noc_guess}. Flash-модель,
  temperature 0.** — ✅: дёшево, структурировано, zod-валидация шлюзом (S3).
- (b) Chain-of-thought промпт — дороже, неуправляемый вывод, отклонено для flash.
- (c) Main-модель для скоринга — ×50 дороже за то же качество на классификации.

### R2. Хранение: таблица `job_match` (из DESIGN §3.2)
- `job_match (job_id FK, llm_run_id FK, score INT, reasons JSONB, risks JSONB,
  noc_guess TEXT, created_at)` — история скорингов (последний = актуальный,
  но предыдущие не стираются — калибровочный трейл).
- Jobs Explorer: JOIN для score-колонки; `?min_score=70` фильтр; сортировка по score.

### R3. Триггер: post-ingest scoring, не on-demand
- **(a) Scheduler после каждого инжеста: найти relevant/review вакансии без
  свежего скоринга → прогнать через шлюз batch'ем.** — ✅: автоматизм, кэш
  работает на повторных прогонах (canonical_hash стабилен → промпт тот же).
- (b) On-demand по кнопке — ручная работа, противоречит духу автоматики.
- (c) Real-time при просмотре — UX-задержки, дороже.

### R4. Golden set: 30 вакансий, ручная разметка PO
- PO размечает score 0–100 для 30 фиксированных вакансий (10 relevant/10 review/
  10 из excluded как негативные). Тест: LLM-скоринг коррелирует с ручным
  (Spearman ≥ 0.7; средняя дельта ≤ 15 очков). Файл: `tests/fixtures/golden-set.json`.
- Промпт-итерация: если корреляция < 0.7 → правка промпта → повторный прогон
  golden-set (кэш инвалидируется промпт-хэшем). Зафиксировать версию промпта.

### R5. Стоимость: контроль и лимиты
- ~$0.00002/вакансия (ping-данные: 32+58 токенов; скоринг-промпт ~500+200 токенов
  → ~$0.0003/вакансия на flash). 100 вакансий ≈ $0.03. Дневной лимит (env
  LLM_SCORING_DAILY_LIMIT_USD, default $0.50) — scheduler проверяет перед batch.

## Контракт

```ts
// packages/llm/src/scoring.ts (новый)
export const SCORING_PROMPT_VERSION = 'v1';
export interface MatchScore { score: number; reasons: string[]; risks: string[]; noc_guess: string | null }
export function buildScoringPrompt(profile: ProfileSummary, job: Job): { system: string; user: string }
export async function scoreJob(llm: Llm, profile: ProfileSummary, job: Job): Promise<LlmResult<MatchScore>>
// packages/core/src/repository.ts
listUnscoredJobs(db, baskets: ['relevant','review']): Promise<Job[]>
upsertMatch(db, jobId, llmRunId, match: MatchScore): Promise<void>
getJobWithScore(db): Promise<JobListItem[]> // score JOIN
// apps/worker/src/scheduler.ts — post-ingest hook
// apps/web — score-колонка + ?min_score= + сортировка
```
Миграция v7: `job_match` таблица.

## Acceptance criteria

1. `buildScoringPrompt` — юнит-тесты: профиль+вакансия → system/user содержат
   ключевые поля; `SCORING_PROMPT_VERSION` в промпте (для кэш-инвалидации).
2. `scoreJob` — integration против мок-fetch: JSON-вывод валиден (zod),
   llm_run записан с stage='match_llm', job_match создан.
3. Golden set: 30 вакансий прогнаны живым вызовом; Spearman ≥ 0.7 с ручной
   разметкой PO; средняя дельта ≤ 15. Фиксация в отчёте (таблица: вакансия /
   ручной score / LLM score / delta).
4. Scheduler: после инжеста batch-скоринг незаскоренных; дневной лимит
   соблюдается (проверка в тесте).
5. Jobs Explorer: score-колонка, `?min_score=`, сортировка; e2e.
6. Кэш: повторный скоринг той же вакансии = 0 внешних вызовов (интеграционный тест).
7. Все гейты зелёные; CI success.

## Тест-план

- **Unit:** buildScoringPrompt (структура, версия), score-валидация (zod: score
  0–100, reasons 3–5 строк).
- **Integration (мок-fetch):** scoreJob → llm_run + job_match; scheduler batch;
  дневной лимит; кэш-хит на повтор.
- **Golden set (живой, разово при имплементации):** 30 вызовов flash,
  корреляция с разметкой PO. Результаты в отчёте; порог Spearman — G1-вопрос.
- **E2E:** score-колонка + фильтр + сортировка.

## Метрики

- Golden set: Spearman, средняя дельта, стоимость 30 вызовов.
- Production: скоринг-латентность p50/p95; дневная стоимость; % score ≥ 70.

## DoD

- [ ] AC 1–7; RED→GREEN
- [ ] Golden set прогнан, результаты в отчёте
- [ ] Промпт v1 зафиксирован; кэш-инвалидация через версию промпта
- [ ] STACK.md 2.2; B-013 (score-виджет на доске) — backlog
- [ ] Отчёт S4-report.md; CI зелёный

## Открытые вопросы (к PO, вместе с G1)

1. **Golden set**: я подготовлю 30 вакансий из текущей БД (10 relevant / 10
   review / 10 excluded) с их данными; ты размечаешь score 0–100 для каждой —
   ок? (альтернатива: я предлагаю авто-разметку, ты ревьюишь).
2. Spearman ≥ 0.7 как порог качества промпта — ок?
3. Score показывается в Jobs Explorer + Board; на /metrics — гистограмма score
   (граница relevant≥70 подсвечена) — включить?
