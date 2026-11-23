# STEWARD-B4 — отчёт по PL-80, PL-81, PL-101, PL-104, PL-105

Дата: 23.11.2026. Ветка: `steward-work`. Работа велась только в
`C:\analytics\Системный аналитик теория\Системный анализ стажировка\.steward-dev`.
Коммиты и push **не выполнялись** — это делает обёртка плагина через
`scripts/steward-commit.ps1`.

## Список изменений

| Файл | Что изменено |
| --- | --- |
| `scripts/pl-commit.ps1` | PL-80: кириллица «Деталь» → `Detail`, три typographic em dash → `-`. Файл полностью ASCII. |
| `scripts/steward-commit.ps1` | PL-101/PL-104: `git rebase origin/dev` → `git rebase --autostash origin/dev`; `rebase --quit` только при подтверждённом активном rebase (`git rev-parse --git-path rebase-merge\|rebase-apply`); при конфликте — копирование файлов в `reports/merge-conflicts/`, маркер `reports/merge-conflict-pending.md`, диагностический лог и `exit 0` вместо `exit 2`. Файл полностью ASCII. |
| `src/core/ps-wrapper.ts` | PL-81: сохранение `$agentExitCode` и `$quotaDetected`, запуск qualityGate при ненулевом коде агента с подтверждёнными артефактами, фиксация расхождения `$gatePassed/$divergenceReason` без перевода задачи в `error`. PL-105: pre-flight `git -C $Workdir rev-parse --is-inside-work-tree` с явным логом о состоянии snapshot/isolation. |
| `src/core/execution.ts` | Не менялся: `shouldRunQualityGate`/`resolveAgentExitVerdict` (PL-62) уже реализуют нужную семантику и дополнительно покрыты регрессией. |
| `test-execution-hardening.mjs` | Добавлена секция из 14 проверок: ASCII-байты и парсинг PS 5.1 для обоих `.ps1`, строки PL-81 и парсинг сгенерированного `run-task.ps1` (с BOM), вердикт `exit=1 + gate=pass → success/diverged/post-flight`, PL-101/PL-104-строки хелпера, PL-105-строки обёртки и синтетический worktree с `.git`-файлом. |
| `ROADMAP.md` | Удалены строки PL-80, PL-81, PL-101, PL-104, PL-105 целиком (без `[x]`), дубликатов этих ID нет. |
| `CHANGELOG.md` | Под `## [Unreleased]` добавлены ровно 5 строк — по одной на каждый закрытый ID. |
| `reports/steward-b4.md` | Настоящий отчёт. |

`reports/merge-conflicts/` и `reports/merge-conflict-pending.md` не создавались: в
этом прогоне реального конфликта rebase не было, создаётся только механизм их
появления в хелпере.

## Статус по ID

| ID | Статус | Суть исправления |
| --- | --- | --- |
| PL-80 | Закрыт | Оба `.ps1` — ASCII (0 байт >127), `Parser::ParseFile` в `powershell.exe` (5.1) даёт 0 ошибок. |
| PL-81 | Закрыт | Код возврата агента больше не приравнивается к провалу верификации; при зелёном гейте и подтверждённых артефактах задача остаётся `success`, post-flight выполняется. |
| PL-101 | Закрыт | Конфликтующие файлы сохраняются, пишется маркер, задача помечается как требующая разрешения конфликта и не роняется (`exit 0`). |
| PL-104 | Закрыт | `rebase --autostash`, защищённый `--quit`, диагностика при отсутствии rebase; наработки не теряются. |
| PL-105 | Закрыт | Pre-flight проверяет, что `WorkingDirectory` — git worktree; `-Workdir` уже передаётся в `run-task.ps1` (PL-86); `decideWorktreeSnapshot` принимает `.git`-файл. |

## Реально запущенные команды и exit-коды

Все команды запускались вручную из корня `.steward-dev`; exit-код фиксировался
через `$LASTEXITCODE`.

| Команда | Результат | Exit |
| --- | --- | --- |
| `npm run build` (базовый замер до правок) | tsc успешно | 0 |
| `node test-execution-hardening.mjs` (базовый замер до правок) | 106/106 | 0 |
| `npm run build` (после правок TypeScript) | tsc с declaration-файлами успешно | 0 |
| `node test-execution-hardening.mjs` (первый прогон с новыми тестами) | 119/120; единственный FAIL — парсинг сгенерированного wrapper без BOM в тестовом fixtures | 1 |
| `node test-execution-hardening.mjs` (после добавления BOM в fixture) | 120/120 | 0 |
| `npm run build` (финальный) | tsc успешно | 0 |
| `node test-execution-hardening.mjs` (финальный, после правок ROADMAP/CHANGELOG) | 120/120 | 0 |
| `node test-docs.mjs` | 137/138; FAIL `PL-100: ID подзадач в ROADMAP уникальны` — дубли **PL-107, PL-108** уже присутствуют в `HEAD` (не в SCOPE) | 1 |
| `npm run lint` | 20 проблем (19 errors, 1 warning) в `src/core/execution.ts`, `src/core/run-panel-api.ts`, `src/core/task-name.ts`, `src/db/runs-repo.ts` и др. — унаследованные ошибки PL-107, файлы вне SCOPE | 1 |
| `git diff --stat` | 6 файлов, 246 insertions / 18 deletions (до добавления CHANGELOG и отчёта) | 0 |

Парсинг `.ps1` через `powershell.exe -NoProfile -Command Parser::ParseFile`
выполняется внутри `test-execution-hardening.mjs`: оба хелпера — 0 ошибок,
сгенерированный `run-task.ps1` (с BOM) — 0 ошибок.

## Найденные баги плагина и окружения

1. **PS 5.1 и кодировка (PL-80, подтверждено).** `powershell.exe` читает UTF-8 без
   BOM как ANSI; кириллица в комментариях `.ps1` превращается в мусор и ломает
   парсинг. Производственный `ensureWrapper()` уже пишет `BOM + WRAPPER_SCRIPT`,
   но тестовый fixture сначала писал файл без BOM — отсюда 119/120 в первом
   прогоне. Это же объясняет исходный PL-80.
2. **PS 5.1 и trailing comma (обнаружено при PL-101/104).** Завершающая запятая в
   `@(..., ...)` — синтаксическая ошибка в Windows PowerShell 5.1; убрана при
   формировании списка строк маркера конфликта.
3. **Rebase в общем worktree (PL-104, подтверждено).** `git rebase` отказывается
   стартовать при чужих unstaged-правках; последующий `rebase --quit` без
   активного rebase даёт `fatal: no rebase in progress`, и задача получала
   `status=error` после успешного коммита и гейта. Исправлено `--autostash` и
   защитой `--quit`.
4. **Смешение «ошибки агента» и «ошибки верификации» (PL-81, подтверждено).** В
   `ps-wrapper.ts` условие `if ($QualityGate -and $script:exitCode -eq 0)` было
   причиной пропуска гейта и статуса `error` при зелёных тестах. В
   `src/core/execution.ts` подобного бага нет — там уже работает
   `resolveAgentExitVerdict` (PL-62).
5. **Пред-existing дубликаты ID в ROADMAP (PL-100).** `test-docs.mjs` красный на
   дублях PL-107/PL-108, пришедших из параллельных задач; в SCOPE не входят,
   поэтому не трогались. Если обёртка использует `test-docs` как qualityGate,
   этот гейт останется красным до отдельной чистки ROADMAP.
6. **Пред-existing lint-ошибки (PL-107).** `npm run lint` падает на 19 ошибок в
   чужих файлах; к данному SCOPE отношения не имеет.
7. **Окружение.** Переменная `WORKSPACE` в дочерних shell'ах ломает git-команды
   (`fatal: not a git repository`) — в диагностических вызовах использовался
   `env -u WORKSPACE`. На само завершение тестов не влияет.
8. **PL-108/PL-109 (наблюдения).** Явный `subagent` недоступен на Free-тарифе;
   чистый git-worktree не содержит `node_modules/` и `dist/`, поэтому все
   проверки проводились в основном worktree `.steward-dev`.
