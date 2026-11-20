# PL16 — отчёт исполнителя Детали 1.6 ROADMAP.md (20.11.2026)

Ветка: `dev`. ОС: Windows. Задача: закрыть открытые находки PL-5.1, PL-5.2,
PL-6.1, PL-7.1, PL-7.2, PL-8.1, PL-9.1. PL-7.1 уже исправлен коммитом
`0657654` (`fix(qa-a2): make post-flight push robust to stderr and races`,
изменён только `scripts/qa-a2-commit.ps1`) — код не переделывался, в скилл
перенесена проверенная обвязка.

## Статусы находок

| ID | Статус | Что сделано / причина |
| --- | --- | --- |
| PL-5.1 | сделано | `src/core/record-history.ts`, `handleCompletion()`: успешная ветка теперь дедуплицирует цели через `Set<string>` с ключом `name.trim().toLowerCase()` (та же нормализация, что в `selectDependentsToTrigger`). `chainTarget` добавляется в Set до вызова `triggerTask`; DAG-зависимые, уже присутствующие в Set, пропускаются с событием `dag.dedup_skipped` (`reason: already triggered via nextTaskOnSuccess`). Ветка компенсации (`nextTaskOnError`)变更后 не пересекается с DAG и осталась без изменений. В `src/core/dry-run.ts` добавлен детектор `findChainDagOverlap()` и предупреждение `PL-5.1`, если `nextTaskOnSuccess` и `dependsOn` указывают на одну задачу (оба направления: преемник прямо в `dependsOn` текущей и преемник зависит от текущей). |
| PL-5.2 | сделано | `skills/scheduled-job-best-practices/SKILL.md` §6: правило «один переход — один механизм»: для `A → B` использовать **либо** `A.nextTaskOnSuccess = "B"`, **либо** `B.dependsOn = ["A"]`, но не оба; объяснено, что иначе `B` запускается дважды. Добавлена строка в таблицу антипаттернов §9. |
| PL-6.1 | сделано в SCOPE | В `recipes.md` добавлен раздел 10 с шаблоном `if (Test-Path -LiteralPath '<path>') { Remove-Item -LiteralPath '<path>' -Force }; exit 0`, правилами `-LiteralPath` и явным `exit 0` (в т.ч. Bash-эквивалент `rm -f ...; exit 0`). **Подсказку в текст ошибки pre-flight добавить нельзя в рамках SCOPE**: строка формируется в `src/core/ps-wrapper.ts:707-709` и `src/core/wrappers/bash.ts:523-525` (`"Pre-flight script failed"`), оба файла вне SCOPE. Рекомендация зафиксирована ниже, в разделе «Вне SCOPE». |
| PL-7.1 | сделано (обвязка зафиксирована) | В `recipes.md` добавлен раздел 11 с проверенным паттерном из `scripts/qa-a2-commit.ps1` (только в документации, сам script не трогался): `$ErrorActionPreference='Stop'` глобально, но `Continue` вокруг нативных git-вызовов; подавление stderr (`2>&1`), чтение `$LASTEXITCODE`, 3 ретрая push с паузой, сверка `HEAD`/`origin/dev` перед объявлением неудачи (гонка с параллельным пушем), «nothing to commit» = успех (`exit 0`), коммит только своих файлов и только после гейта. Код не менялся — исправление уже в `0657654`. |
| PL-7.2 | сделано (часть в SCOPE) | `src/core/structured-log.ts`: схема `StructuredLogRecord` расширена полями `preFlightExitCode`/`preFlightStdout`/`preFlightStderr` и `postFlightExitCode`/`postFlightStdout`/`postFlightStderr`; потоки проходят ту же редакцию секретов, что `error`/`reason`. Добавлен экспортируемый помощник `appendHookOutputLog(phase, task, details, runId?)`, пишущий событие `hook.output` с разделёнными stdout/stderr и **реальным** exit code. В `SKILL.md` §8 и `recipes.md` §11 зафиксировано, как отличать диагностику Git в stderr от несостоявшегося пуша. **Полный сквозной probe требует правки обёрток** (`src/core/ps-wrapper.ts` / `src/core/wrappers/bash.ts`) — они вне SCOPE; детали ниже. |
| PL-8.1 | сделано (часть в SCOPE) | В `src/core/dry-run.ts` добавлен `workingDirectoryDriftWarning()`: если `def.createdAt` известен и время HEAD-коммита в cwd новее, выводится предупреждение `PL-8.1` с предложением зафиксировать commit, на котором гейт считается валидным (проверка HEAD внутри `qualityGate`), либо использовать изолированный worktree. Fail-open: нет git / даты / недоступна команда — тишина. В `recipes.md` §12 — рекомендации по pin-коммиту для длинного DAG. **Предупреждение «при старте» требует правки `run-now`/обёрток** — вне SCOPE; детали ниже. |
| PL-9.1 | сделано | В `src/index.ts` описание поля `name` схемы `schedule_task` теперь явно запрещает тире `—` и круглые скобки `()` и предписывает ASCII-дефис `-` и слова, с примером `QA-A2 - Full plugin typing epic`. В `SKILL.md` §2 добавлено то же правило валидации имён, чтобы исходное название не терялось при создании задачи. Валидация и поведение инструмента не менялись. |

## Затронутые файлы (строго по SCOPE)

- `src/core/record-history.ts` — дедупликация целей в `handleCompletion` (Set по имени) + событие `dag.dedup_skipped`.
- `src/core/dry-run.ts` — `findChainDagOverlap()`, `workingDirectoryDriftWarning()`, два предупреждения, импорт `execFileSync`.
- `src/core/structured-log.ts` — поля ExitCode/Stdout/Stderr для pre/post-flight, редакция секретов, `appendHookOutputLog()`.
- `src/index.ts` — только описание поля `name` в `scheduleTaskSchema`.
- `skills/scheduled-job-best-practices/SKILL.md` — правила PL-5.2, PL-9.1, PL-7.2, антипаттерн.
- `skills/scheduled-job-best-practices/references/recipes.md` — разделы 10 (PL-6.1), 11 (PL-7.1), 12 (PL-8.1).
- `reports/PL16-report.md` — настоящий отчёт.

`dist/` не редактировался вручную (пересобран `npm run build` как часть верификации,
тесты идут против `dist/`). `gui-experimental.cjs`, `legacy/`, `ROADMAP.md`,
`CHANGELOG.md`, `package.json`, `scripts/` не редактировались. Коммит и push не
выполнялись, суб-агенты не спавнились, `eslint --fix` не запускался,
`as any`/`@ts-ignore`/новые `eslint-disable` не добавлялись.

## Верификация

| Команда | Результат |
| --- | --- |
| `npm run build` | exit 0, 0 ошибок `tsc` |
| `node test-dag.mjs` | exit 0, 12/12 тестов DAG и учёта токенов |
| `node test-dry-run.mjs` | exit 0, 19/19 проверок |
| `node test-matrix.mjs` | exit 0, 27/27 проверок |
| `npm run lint:baseline` | exit 0, «новых предупреждений нет — 355 warning (baseline 543, -188)», не хуже базовой линии |
| Доп. функциональная проверка (временный скрипт вне репозитория, удалён) | 5/5: предупреждение PL-5.1 при `nextTaskOnSuccess`+`dependsOn` на одну задачу; предупреждение PL-8.1 при HEAD новее `createdAt`; событие `hook.output` с `postFlightExitCode=0` и разделёнными `postFlightStdout`/`postFlightStderr` |

## Вне SCOPE (зафиксировано, не исправлялось)

1. **PL-6.1, текст ошибки pre-flight.** `"Pre-flight script failed"` формируется в
   `src/core/ps-wrapper.ts:707-709` (PowerShell) и `src/core/wrappers/bash.ts:523-525`
   (Bash) — оба файла вне SCOPE. Рекомендуемая подсказка в сообщении:
   «Если это очистка возможно отсутствующего файла — используйте
   `if (Test-Path -LiteralPath '<path>') { Remove-Item -LiteralPath '<path>' -Force }; exit 0`
   и явный `exit 0`; ненулевой код отменяет запуск». Шаблон и без того добавлен в `recipes.md` §10.
2. **PL-7.2, сквозная передача данных.** Структура журнала и API записи готовы
   (`appendHookOutputLog`), но обёртки передают в рекордер только статус
   `success|error` (`ps-wrapper.ts:920/924`) и не передают текст потоков/код выхода.
   Чтобы поля наполнились, обёртка должна вызывать `appendHookOutputLog` (или передавать
   три дополнительных аргумента в `record-history`) — правка `ps-wrapper.ts`/`bash.ts`
   вне SCOPE. Human-readable `get_task_logs` продолжает работать как раньше.
3. **PL-8.1, предупреждение при старте.** Реализовано в `dry_run`; точка старта
   (`src/core/scheduler/run-now.ts` / обёртки) выходит за SCOPE. Для гейта рекомендуется
   pin-коммит по `recipes.md` §12.

Итог: все 7 находок обработаны — 5 полностью в SCOPE, PL-6.1 и PL-7.2/PL-8.1
имеют документальную часть и явно описанные ограничения по файлам вне SCOPE.
