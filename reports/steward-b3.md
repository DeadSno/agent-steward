# steward-b3 — закрытие находок PL-73, PL-75, PL-77, PL-79, PL-82, PL-86, PL-87, PL-99

Дата: 23.11.2026. Ветка: `steward-work`. Рабочая директория: каталог репозитория плагина `agent-steward`.
Коммит и push **не выполнялись** — это делает обёртка плагина через `scripts/steward-commit.ps1`.

## 1. Изменённые файлы

| Файл | Что изменено |
|---|---|
| `src/core/scheduler/windows.ts` | Экспортированы `cronStartBoundary()` и `shouldDeferCronTriggerRecreation()`; в `createTask()` при `avoidCatchUp` добавляется строго будущая `/sd` для cron-триггера (кроме `once`), если конвертер её не задал. |
| `src/core/scheduler/types.ts` | `CreateTaskOptions.avoidCatchUp?: boolean`; `RunTaskResult` расширен полями `skipped?`, `reason?`. |
| `src/core/scheduler/run-now.ts` | Добавлены `extractScopePaths()`, `validateScopePaths()`, `preflightScope()`, `planParallelExecution()`, `detectStaleTask()`; `runTaskNow()` перед созданием force-маркера проверяет stale-задачу и возвращает `skipped` с причиной. |
| `src/core/ps-wrapper.ts` | .cmd передаёт экранированный `-Workdir`; PS-обёртка подставляет `Get-Location`, если флаг не передан; формирование `reports/quota-*.diff` обёрнуто в `try/catch` с фолбэком; в сообщение о квоте добавлена настроенная модель и подсказка `update_task ... model=provider/model`. |
| `src/index.ts` | `schedulerCreateTask()` получил параметр `avoidCatchUp` (передаётся в `scheduler.createTask`); подключены `preflightScope()` и `planParallelExecution()` (worktree на задачу); `update_task` передаёт `avoidCatchUp` для cron. |
| `test-cron-to-schtasks.mjs` | 7 регрессионных проверок PL-75 (37/37 всего). |
| `test-execution-hardening.mjs` | 18 регрессионных проверок PL-79/PL-82/PL-77/PL-86/PL-87/PL-99 (106/106 всего). |
| `ROADMAP.md` | Удалены строки PL-73, PL-75, PL-77, PL-79, PL-82, PL-86, PL-87, PL-99 целиком (без `[x]`, без дубликатов). Строки PL-102..PL-105 (чужой незакоммиченный блок) сохранены. |
| `CHANGELOG.md` | Под `## [Unreleased]` добавлены ровно 8 строк — по одной на закрытый ID. |
| `reports/steward-b3.md` | Настоящий отчёт. |

`dist/`, `gui-experimental.cjs`, `legacy/`, `package.json`, `TEST-PLAN.md`, counter-файлы не трогались; новые `test-*.mjs` не создавались.

## 2. Результат по ID

| ID | Статус | Суть и проверка |
|---|---|---|
| PL-73 | Закрыт (stale) | В `src/core/scheduler/logs.ts` уже есть `isRetriableLogReadError()` (строка 8) и `readLogWithRetry()` (строка 13); коммит `9f6c1c5 fix(logs): resolve task logs by short name` присутствует в истории. Код **не менялся**: удалена строка из ROADMAP, добавлена CHANGELOG-строка с пометкой «уже исправлено». `node test-task-logs.mjs` — 8/8, exit 0. |
| PL-75 | Закрыт | `update_task` (delete+create OS-триггера) теперь передаёт `avoidCatchUp` для cron; `createTask()` добавляет будущую `/sd`, убирающую догон пропущенного старта (корень PL-57). Добавлены `cronStartBoundary()`/`shouldDeferCronTriggerRecreation()`. Регрессия: 7 проверок в `test-cron-to-schtasks.mjs`, 37/37, exit 0. |
| PL-77 | Закрыт | `planParallelExecution()` проверяет `maxConcurrent` и принудительно включает уникальный worktree на задачу; подключён к `schedulerCreateTask()` через настройку `maxConcurrent`. 4 проверки в `test-execution-hardening.mjs`, 106/106, exit 0. |
| PL-79 | Закрыт | `extractScopePaths()`/`validateScopePaths()`/`preflightScope()` разбирают **весь** список SCOPE и проверяют существование каждого пути до записи обёртки и post-flight. 3 проверки, 106/106, exit 0. |
| PL-82 | Закрыт | Та же pre-flight валидация закрывает повтор с `src/core/server.ts`: проверяются все пути списка сразу, а не по одному после падения `git add`. 2 проверки, 106/106, exit 0. |
| PL-86 | Закрыт | .cmd-обёртка получает `-Workdir "<экранированный путь>"` (путь с пробелами проверен); PS-обёртка имеет фолбэк на `Get-Location`. 1 проверка в `test-execution-hardening.mjs`, 106/106, exit 0. |
| PL-87 | Закрыт | `reports/quota-*.diff` формируется в `try/catch` с фолбэком на temp-каталог, поэтому исчерпание квоты Free-модели даёт сообщение с путём diff и подсказкой `update_task ... model=provider/model` вместо Path-ошибки. 3 проверки, 106/106, exit 0. |
| PL-99 | Закрыт | `detectStaleTask()` сверяет ID находки с `ROADMAP.md`/`CHANGELOG.md`/`git diff`; `runTaskNow()` возвращает `skipped` с причиной вместо запуска уже закрытой задачи. 2 проверки, 106/106, exit 0. |

## 3. Реально запущенные команды и exit-коды

| Команда | Результат | Exit code |
|---|---|---|
| `npm run build` | tsc + declarations, без ошибок (запускалась дважды) | 0 |
| `node test-cron-to-schtasks.mjs` | 37/37 проверок | 0 |
| `node test-execution-hardening.mjs` | 106/106 проверок | 0 |
| `node test-task-logs.mjs` | 8/8 проверок | 0 |
| `node test-docs.mjs` | 138/138 проверок (после правки ROADMAP/CHANGELOG) | 0 |
| `git log --oneline --all \| Select-String "9f6c1c5"` | найден `9f6c1c5 fix(logs): resolve task logs by short name` | 0 |
| `grep` по `src/core/scheduler/logs.ts` (`isRetriableLogReadError`, `readLogWithRetry`) | найдены строки 8 и 13 | 0 |
| `npm run lint` | 11 ошибок + 9 предупреждений, **все в файлах вне SCOPE** (см. §4) | **1** |

Примечание: при прогоне `test-execution-hardening.mjs` в stderr попадали безвредные сообщения («дашборд уже слушает 3782», предупреждения `schtasks /run` при восстановлении); они не влияют на результат — exit 0.

## 4. Найденные баги плагина и ограничения

1. **PL-103 (уже открыт в ROADMAP): `npm run lint` красный на ветке.** 11 ошибок и 9 предупреждений: `src/core/execution.ts:808` (quotes), `1298–1304` (indent) + 4 warning, `src/core/run-panel-api.ts:316` (unnecessary type assertion) + 1 warning, `src/db/runs-repo.ts:874–875` (indent). Все файлы **вне SCOPE** задания и не являются нашими правками; в изменённых файлах lint-ошибок нет. Не чинилось, чтобы не выходить за SCOPE. Требует отдельной задачи (PL-103).
2. **PL-73 — stale-находка:** ретраи чтения логов и разрешение коротких имён уже реализованы коммитом `9f6c1c5`; дублирование кода не выполнялось.
3. **PL-75 trade-off:** для не-MONTHLY cron будущая `/sd` вычисляется как завтрашняя дата, поэтому первый тик после обновления может быть отложен до суток. Это осознанная цена за подавление catch-up при отсутствии у `schtasks` флага `<StartWhenAvailable>false</StartWhenAvailable>` (CLI не умеет XML-импорт); для MONTHLY используется точная граница через `nextMonthlyStartBoundary()`.
4. **PL-77 trade-off:** `planParallelExecution()` принудительно включает worktree, когда `maxConcurrent` не ограничен или больше 1; для задач вне git-репозитория это потребует доступного git (fail-closed обёртка уже сообщает об ошибке создания worktree).

## 5. Чек-лист

- [x] ROADMAP.md: закрытые строки удалены целиком, дубликатов нет (проверено `node test-docs.mjs`, 138/138).
- [x] CHANGELOG.md: по одной строке на каждый закрытый ID под `[Unreleased]` (8 строк).
- [x] reports/steward-b3.md: создан, содержит команды и exit-коды.
- [x] Тесты реально запущены: `test-cron-to-schtasks.mjs`, `test-execution-hardening.mjs`, `test-task-logs.mjs`, `test-docs.mjs`; сборка — `npm run build`.
- [ ] `npm run lint` — **не пройден** (exit 1, пре-existing ошибки вне SCOPE, см. §4).
