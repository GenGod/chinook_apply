# S11: Мульти-резюме → суперпрофиль с provenance

Статус: accepted (G1 — мандат PO «давай S11», 2026-10-01) · Версия: 1.0 · Milestone: **M5**
Реестр: B-002 / DESIGN §6.1 (S11) · зависит от S3 (шлюз), S5 (генерация — потребитель мастера), S6/S21 (рендеры).

## Проблема и цель

Один `master_profile.json` (v1, один исходный docx) сужает охват: релевантный опыт из других
резюме не попадает ни в промпты генерации, ни в факт-чек. Цель S11 v1: **ingest N документов →
атомарные факты с provenance → детерминированное слияние в предложение суперпрофиля → approve PO →
применение** (конституция 2.1–2.3: ничего не выдумывается, каждый факт прослеживается до документа,
merge применяет только человек).

## Стейджинг (в рамках одной спеки)

- **v1 (этот инкремент)**: пункты B-002 1–2 + база 5 (факт-чек автоматически работает против
  более широкого мастера — код не меняется). NOC-search_config переносится в предложение
  без изменений (расширение NOC — отдельное явное решение PO, B-002 п.4).
- **v1.1 (отложено, дефолт для G6)**: резюме-треки/personas + ранжирование вакансий по трекам
  (B-002 п.3–4) — отдельный заход после того, как PO оценит качество суперпрофиля на живых
  документах. Мотив: треки имеют смысл только поверх наполненного суперпрофиля (ст. 9 — пустые
  треки не создаются).

## Решение

### R1. Хранение: `profile_source` + `profile_fact` — ✅
Источник: file_name, format(docx|pdf|txt), storage_path (относительно gitignored
`data/profile/sources/`), sha256 UNIQUE, text_chars. Факт: source_id FK CASCADE, kind
(summary|skill|experience|education|certification), payload JSONB, **excerpt** — дословный
фрагмент текста документа (provenance). (откл. хранить факты в master-файле — теряется
provenance и история источников.)

### R2. Извлечение текста: DOCX через fflate (core, pure), PDF через pdf-parse (web) — ✅
DOCX = unzip `word/document.xml` + тег-стрип (у core уже есть fflate из S6; отдельная лёгкая
функция `extractDocxText`, без mammoth). PDF = `pdf-parse` (web-dep; обёртка `pdf-text.ts`).
TXT — как есть. (откл. mammoth/pdfjs-dist — тяжелее поверхность.)

### R3. LLM-извлечение фактов: flash-роль, строгая zod-схема — ✅
`packages/llm/profile-facts.ts`: `ProfileFactsSchema` (дискриминированный по kind payload),
`buildFactExtractionPrompt(text)` — жёсткие правила: только факты из текста; excerpt копируется
дословно; ничего не домысливается. Stage `extract_profile_facts`, role flash (DESIGN §4.1).

### R4. Provenance-гейт: excerpt ⊆ текст документа — ✅ (ядро правдивости)
Инжест-сервис: каждый факт проходит проверку «нормализованный excerpt — подстрока
нормализованного текста документа»; провал → факт отбрасывается (счётчик rejected, в БД не
попадает). LLM-вывод — untrusted input (ст. 7.1), zod + этот гейт.

### R5. Слияние: детерминированный код, не LLM — ✅ (как assembleResume в S5)
`core/superprofile.ts`: `buildSuperprofileProposal(masterRaw, facts)` → `{proposed, diff}`.
- skills: добавление в категорию факта (категория валидируется по словарю мастера; новая
  категория → запись диффа `new_category`, применяется); дедуп по name lower.
- experience: ключ (employer lower + start); новый → add; совпал ключ, но расходится
  title/end/bullets → **conflict** (в proposed НЕ попадает — очередь решений PO, B-002 п.2).
- education: ключ degree+institution lower. certification: новый раздел `certifications`
  (в v1 мастера его нет — добавляется только если факты есть). summary-факты: НЕ применяются
  (варианты summary остаются в фактах; смена summary — ручное решение PO).
- proposed: тот же shape файла (version+1, updated_at=сегодня), identity/search_config
  переносятся без изменений (ст. 2.3: identity не трогает автоматика).
- diff: [{op, line, factIds, excerpts}] — UI показывает с выдержками источников.

### R6. Apply: только approve PO, с бэкапом — ✅
`POST /api/profile/approve`: применяет все non-conflict add-записи диффа → atomic-запись
`master_profile.json` (предварительно `master_profile.<ts>.bak.json` рядом, gitignored).
Путь мастера: env `MASTER_PROFILE_PATH` (первичный) → дефолт по расположению модуля
(dev=репо-корень, docker=/app). e2e/CI работают на изолированном fixture-файле через env.
Потребители (document-generation, render/dispatch identity, core/profile search) переведены
на этот env-первичный загрузчик.

### R7. API — ✅
`POST /api/profile/sources` (multipart: file) → инжест (R2–R4) → {sourceId, factsSaved, factsRejected};
`GET /api/profile/state` → {sources[{id,file_name,format,sha256,text_chars,facts}], masterVersion};
`GET /api/profile/proposal` → {diff, conflicts}; `POST /api/profile/approve` → {applied, version}.

### R8. UI: страница /profile — ✅
DS v1.1 (паттерн секции Documents): загрузка файла, список источников (+счётчики фактов),
Build proposal → дифф-лист (op + line + выдержки, конфликты красным), Approve (применяет
non-conflict). PII-дисциплина: e2e-снапшоты на синтетике; страница серверная, содержимое
мастера не рендерится — только версия и дифф-строки. superdesign-пасс: страница строится в
существующей DS-идиоме; полный пасс — по просьбе PO на G6 (прецедент S8).

## AC

1. Схема/репо: source+facts, UNIQUE sha256 идемпотентен — integration.
2. `extractDocxText`: из буфера, сгенерированного docx-энкодером в тесте, извлекается текст — unit.
3. Схема/промпт: валидные факты проходят, мусор отбрасывается; промпт содержит правила
   дословности — unit.
4. Provenance-гейт: факт с excerpt-подстрокой сохраняется; с искажённым excerpt — отвергнут — integration (mock LLM).
5. Builder: новые skill/experience/education добавляются; дубли пропускаются; конфликт
   (тот же employer+start, другой title) → op=conflict и в proposed не попадает;
   identity/search_config неизменны; version+1 — unit.
6. Approve: fixture-мастер (env путь) → файл переписан, бэкап создан, version вырос;
   повторный approve — пустой дифф — integration.
7. E2E /profile: сид source+фактов → дифф виден (вкл. конфликт) → Approve → success;
   fixture-мастер изменён; снапшот (win32/linux).
8. Потребители env-мастера: generation/render грузят MASTER_PROFILE_PATH — integration.
9. Живой golden: master_resume_source.docx → flash-извлечение → provenance-гейт; предложение
   построено; **НЕ применяется** (PO решает в UI) — отчёт.

## DoD

AC1–9; гейты 0; STACK 2.8 (pdf-parse); отчёт S11-report.md; деплой; живой golden без применения.

## Открытые вопросы (дефолты G6)

1. Треки/personas + ранжирование по трекам — v1.1 (дефолт: отложить).
2. Конфликты v1: показываются, не применяются; UI-редактор мастера — вне v1 (ст. 2.3).
3. summary-факты не применяются автоматически.
4. Расширение NOC — не в v1; отдельный заход с обоснованием по фактам.
