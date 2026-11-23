# STEWARD-B2 — отчёт

Ветка: `steward-work`. Задача: закрыть PL-72, PL-74, PL-76, PL-88, PL-90.

SCOPE: `src/index.ts`, `src/core/opencode-cli.ts`, `src/core/task-name.ts`, `test-agent-tools.mjs`, `test-model-validation.mjs`, `test-dry-run.mjs`, `skills/scheduled-job-best-practices/SKILL.md`, `ROADMAP.md`, `CHANGELOG.md`, `reports/steward-b2.md`.

Не коммитил и не пушил (коммит/пуш делает обёртка через `scripts/steward-commit.ps1`). Артефакты сборки (`dist/`, `gui-experimental.cjs`, `legacy/`), `package.json`, `TEST-PLAN.md`, counter-файлы и чужие тесты не трогал. Новых `test-*.mjs` не создавал. Адаптер совместимости `opencode/hy4-flash-free` сохранён: модель без префикса по-прежнему отклоняется с понятным сообщением, а валидная `provider/model` проходит все проверки.

## Изменения по подзадачам

| ID | Статус | Изменение |
| --- | --- | --- |
| PL-74 | ✅ закрыт | В `src/core/task-name.ts` добавлены `MODEL_FORMAT_EXAMPLES` и `validateModelReference()`: пустая модель → `null`, модель без префикса провайдера отклоняется с сообщением «Используйте формат "provider/model", например: … Доступные модели смотрите командой `opencode models`». В `src/index.ts` схема `schedule_task` получила `.refine()` с этим сообщением (Zod v4 — `{ message }`, не функция), обновлено описание параметра `model`. Регрессия в `test-agent-tools.mjs` (отклонение схемой + handler-level) и `test-model-validation.mjs`. |
| PL-88 | ✅ закрыт | Аналогичный `.refine()` добавлен в схему `update_task`. Все три write-пути записи модели в `src/index.ts` (обработчик schedule/update, matrix override, `schedulerCreateTask`) переведены с `validateModelId()` на `validateModelReference()`. Форму модели проверяет и `modelAvailabilityWarning()` в `src/core/opencode-cli.ts`, используемый `dry_run`. Регрессия в `test-agent-tools.mjs` и `test-model-validation.mjs`. |
| PL-76 | ✅ закрыт | В `src/core/opencode-cli.ts` добавлены `normalizeModelKey()`, `chooseFallbackModel()` (Free той же модели → тот же провайдер → Free → первая доступная) и `modelAvailabilityWarning()`: при недоступной модели или причине «Free usage limit reached» предупреждение называет запасную модель и явно требует «Сохраните qualityGate без изменений: «…»»; пустой список моделей → fail-open. В `src/index.ts` добавлены `availableModelsForDryRun()` (оверрайд `OPENCODE_SCHEDULER_AVAILABLE_MODELS` для тестов, иначе `listAvailableModels()`) и `annotateDryRunModelWarnings()`, подключённые к обоим режимам `dryRunExecute`. `src/core/dry-run.ts` не менялся. Регрессия в `test-dry-run.mjs`: хелперы + интеграция через env-оверрайд и задачу `PL-76-Unavailable`. |
| PL-72 | ✅ закрыт (окружение, не баг репозитория) | В `skills/scheduled-job-best-practices/SKILL.md` добавлен пункт о формате модели в §4 и новый раздел 4.1 «Sub-agents on Free-tier providers (PL-72/PL-90)»: перед запуском суб-агента проверить доступность провайдера; при «Free usage limit reached» фолбэчиться на основного агента; сохранить причину в `reports/steward-b2.md`; не имитировать завершение. **Повтор подтверждён в текущей сессии:** суб-агент по DOC-2 упал с этой же ошибкой, задачу завершил основной агент. |
| PL-90 | ✅ закрыт (окружение, не баг репозитория) | Политика фолбэка зафиксирована в том же разделе 4.1 `SKILL.md`. **Повтор подтверждён в текущей сессии:** суб-агент упал с «Free usage limit reached», основной агент довёл работу до конца и сохранил причину здесь. Строка удалена из `ROADMAP.md` целиком, дублей нет. |

Дополнительно:

- Из `ROADMAP.md` удалены строки PL-72, PL-74, PL-76, PL-88, PL-90 целиком (без `[x]`); проверка `Select-String` подтвердила отсутствие этих ID и дублей.
- В `CHANGELOG.md` под `## [Unreleased]` добавлена ровно одна строка на каждый ID в формате `- **PL-N - кратко.** Что сделано и как проверено.` — 5 строк, без дубликатов.
- Совместимость: `opencode/hy4-flash-free` — валидная модель `provider/model`, все новые проверки её принимают; `test-model-validation.mjs` и `test-agent-tools.mjs` это покрывают.

## Фактически запущенные команды и коды выхода

| Команда | Результат |
| --- | --- |
| `npm run build` | **exit 0** (финальный прогон после всех правок; промежуточные тоже были зелёными). |
| `node test-model-validation.mjs` | **exit 0** — 22 базовые проверки + PL-74/PL-88 (формат `provider/model`) + base64-обёртка. |
| `node test-agent-tools.mjs` | **67/67 проверок, exit 0** — включая новые проверки схемы и write-путей PL-74/PL-88. |
| `node test-dry-run.mjs` | **68/68 проверок, exit 0** — включая 7 проверок PL-76 (хелперы + интеграция). |
| `node test-docs.mjs` | **138/138 проверок, exit 0** — мета-гейт после правок ROADMAP/CHANGELOG/SKILL. |
| `npm run lint` | **exit 1** — 12 problems (11 errors, 1 warning) в `src/core/execution.ts`, `src/core/run-panel-api.ts`, `src/db/runs-repo.ts`. Все три файла вне SCOPE и одновременно правились другим агентом. В моих файлах (`src/index.ts`, `src/core/task-name.ts`, `src/core/opencode-cli.ts`) ошибок нет. |
| `node test-dual-entry.mjs` | **exit 1** — `AssertionError: V1 tool не пустой` в `test-dual-entry.mjs:42`. Причина окружения: `AGENT_STEWARD_CHILD_RUN=1`, тест явно пропускает регистрацию плагина в дочернем прогоне, поэтому `hooks.tool` пуст. Не вызвано моими правками. |
| `npm test` | **exit 1** — падение на том же `test-dual-entry.mjs:42` (V1 tool не пустой) по той же причине `AGENT_STEWARD_CHILD_RUN=1`. Остальные сюиты, включая целевые, прошли. |

Ранее в ходе работы, пока другой агент правил `src/core/execution.ts`, полный прогон давал `ReferenceError: gateOutcome is not defined` в `dist/core/execution.js` и `npm run build` временно падал. К финальным прогонам эти ошибки исчезли (файл починен параллельно); в финальных результатах их нет.

## Найденные баги плагина и замечания

1. **Гонка агентов за один файл.** Пока шла работа, другой процесс закоммитил `159bcfe fix(steward): batch 1 feedback and docs gates` и одновременно изменил `src/core/execution.ts`, `src/core/scheduler/{run-now,types,windows}.ts`, `test-cron-to-schtasks.mjs`, `test-escalation.mjs`, `test-execution-hardening.mjs`, `test-execution-pipeline.mjs`, `test-router-dispatch.mjs`, а также создал `reports/steward-b3.md`. Мои правки в `src/index.ts`, `test-agent-tools.mjs` и `ROADMAP.md` попали в этот коммит; `src/core/task-name.ts`, `src/core/opencode-cli.ts`, `test-model-validation.mjs`, `test-dry-run.mjs`, `SKILL.md` остались в рабочем дереве. Чужие строки не перезаписывал и не удалял.
2. **`npm run lint` красный на ветке.** 11 ошибок и 1 предупреждение в чужих файлах: `quotes` в `execution.ts:808`, `indent` в `execution.ts:1299–1305` и `runs-repo.ts:874–875`, `no-unnecessary-type-assertion` в `run-panel-api.ts:316`. Все — после параллельной правки, в мой SCOPE не входят; исправление за владельцами этих файлов. В моих файлах линтер ошибок не показал.
3. **`npm test` / `test-dual-entry.mjs` падают в дочернем прогоне.** Из-за `AGENT_STEWARD_CHILD_RUN=1` пропускается регистрация плагина, и проверка «V1 tool не пустой» закономерно проваливается. Это ограничение окружения, а не регрессия кода; для честного прогона нужно запускать suites вне дочернего агента.
4. **Окружение Free-лимита (PL-72/PL-90).** Суб-агент, запущенный для DOC-2, упал с «Free usage limit reached»; повторение подтверждено в текущей сессии. Репозиторий здесь ни при чём — на уровне плагина можно только задокументировать политику проверки провайдера и фолбэка (сделано в `SKILL.md` §4.1) и не выдавать фейковый «выполнено».
5. **_fail-open в `dry_run` по дизайну._** Когда список моделей пуст (статический режим или недоступен CLI), `modelAvailabilityWarning()` возвращает `null` — симуляция не проваливается, а предупреждение не выводится. Это осознанный компромисс, чтобы не ломать офлайн-прогоны; для реального предупреждения нужен доступный `opencode models` или env-оверрайд `OPENCODE_SCHEDULER_AVAILABLE_MODELS`.
6. **Zod v4: `.refine()` требует строку или `{ message }`.** Попытка передать функцию-генератор сообщения давала `TS2345`/`TS7006`; в схемах `schedule_task`/`update_task` используется статический текст с примерами. Замечание для будущих правок schematics.
