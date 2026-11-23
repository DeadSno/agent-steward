# Деталь 3.11 — Диета core-схем и компактная история (без потери качества)

Дата: 23.11.2026
Статус: выполнено

## Цель

Снизить токен-стоимость главного агента после Детали 3.10, **не урезая
возможности** базовых инструментов и не ухудшая диагностику.

## Что сделано

### 1. Краткие описания полей в core-схемах

- В `src/index.ts` добавлена карта `CORE_FIELD_DESCRIPTIONS` с короткими
  описаниями для полей базовых `schedule_task`/`update_task` (name, schedule,
  runAt, delaySeconds, session, timezone, notBefore/notAfter, prompt,
  timeoutSeconds, model, priority, beforeScript/afterScript, qualityGate,
  workingDirectory/workdir, worktree, tokenBudget, allowedTools/deniedTools,
  triggerType, watchPath, gitBranch).
- `slimTaskSchema()` применяет их через `.describe()` только к полям core.
- **Полные руководства сохранены** в `schedule_advanced`/`update_advanced`
  (исходные `scheduleTaskSchema`/`updateTaskSchema`).
- Все поля базовых инструментов остались на месте — функциональность не
  потеряна,缩短了 только текст подсказок.

Замер описаний `schedule_task`: **3521 → 1149 символов** (≈ 600 токенов
экономии на инструмент); `update_task` — сопоставимо. Это реальная
provider-facing экономия: описания полей сериализуются в JSON Schema.

> Замечание о метрике: `measureToolSurface` считает `JSON.stringify` от
> внутреннего представления Zod, куда попадают служебные обёртки `.describe`,
> поэтому его `estimatedTokens` не отражает стоимость для провайдера и для
> регрессии не используется. Регрессия сравнивает именно длину описаний.

### 2. Компактный режим `get_history` (opt-in)

- В `getHistorySchema` добавлен необязательный `compact: boolean`.
- Чистая экспортируемая `compactHistoryRecords(records, maxErrorChars=300)`
  усекает длинные строковые `error` до 300 символов с суффиксом
  `…[truncated]`, не мутируя вход.
- Применяется только при `compact: true`. По умолчанию, а также в RPC и GUI
  история остаётся полной — качество диагностики не страдает.

## Что сознательно НЕ делали

- Не удаляли поля из core (никакой потери возможностей).
- Не трогали refine-сообщения об ошибках: они не сериализуются в JSON Schema
  для провайдера, то есть не дают токен-экономии.
- Не меняли порядок/состав инструментов — стабильность prompt-cache (T-4).

## Проверка

- `npm run build` — exit 0.
- `node test-agent-tools.mjs` — exit 0; проверки Детали 3.11:
  - core сохраняет все базовые поля;
  - advanced-only поля (matrix/dependsOn) отсутствуют в core, но есть в full;
  - описания core короче full, full по-прежнему содержит полное руководство;
  - длина описаний core < full (разница > 500 символов);
  - `compactHistoryRecords` усекает длинный error, сохраняет короткий, не мутирует вход.
- `node test-docs.mjs` — 139/139, exit 0.
- `node test-metrics.mjs` — exit 0.
- `node test-test-plan.mjs` — exit 0.

Записи добавлены в `CHANGELOG.md` под `[Unreleased]`. Открытых строк в
`ROADMAP.md` по Детали 3.11 нет (работа выполнена и закрыта сразу).
