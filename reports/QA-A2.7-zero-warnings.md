# QA-A2.7 — нулевые предупреждения ESLint в `src/`

- Задача: закрыть последнюю открытую подзадачу бэклога QA-A2.7 в `ROADMAP.md` — 0 ошибок и 0 предупреждений ESLint в `src/` без изменения поведения, снять baseline-гейт, зафиксировать результат.
- Репозиторий: `opencode-windows-scheduler`, ветка `dev`, стартовый HEAD `781c585`.
- Дата прогона: 2026-11-23.
- Коммит и пуш НЕ выполнялись: изменения оставлены в рабочем дереве для post-flight обёртки.

## Счётчик предупреждений

| Этап | Команда измерения | warnings | errors |
|---|---|---:|---:|
| Исходное состояние | `npx eslint src --format json` | 254 | 0 |
| После партии 1 (мелкие файлы) и партии 2 (`src/db`) | `node $env:TEMP\qa-a27\count.mjs <файлы>` | 133 | 0 |
| После ядра (audit, structured-log, telegram, self-analysis, planner) | тот же счётчик | 59 | 0 |
| После остальных 10 файлов ядра | тот же счётчик | 9 | 0 |
| Финальная проверка всего `src/` | `npx eslint src --format json` | **0** | **0** |

`eslint --fix` НЕ запускался (в дереве ~7990 предупреждений от автofiкса). Каждый файл правился вручную; после правки проверялись `npm run build`, счётчик и точечный тест затронутой детали.

## Команды верификации с реальными результатами

| Команда | Exit code | Результат |
|---|---:|---|
| `npm run build` | 0 | `tsc` без ошибок |
| `npm run lint` | 0 | ESLint: 0 warning / 0 error |
| `npm run lint:strict` | 0 | `eslint src --max-warnings=0` — 0 warning / 0 error |
| `npx eslint src --format json` | 0 | Итог: `warnings=0 errors=0` |
| `npm run test:parallel` | 0 | 115/115 наборов за ~36 с |
| `node test-docs.mjs` | 0 | Docs: 129/129 проверок |
| `node test-eslint-baseline.mjs` | 0 | ESLint baseline: 11/11 проверок |

Примечание о тестовом окружении: в сессии выставлены внешние переменные `AGENT_STEWARD_GATE_ALLOW_PATHS=src` и `AGENT_STEWARD_CHILD_RUN=1`. Первый пробный прогон `npm run test:parallel` дал 114/115 (`test-dual-entry.mjs`: «V1 tool не пустой» — дочерний прогон пропускает регистрацию плагина). Повторный прогон после снятия обеих переменных в той же оболочке (`Remove-Item Env:AGENT_STEWARD_GATE_ALLOW_PATHS; Remove-Item Env:AGENT_STEWARD_CHILD_RUN`) дал 115/115, exit 0. Это окружение, не регрессия кода: до правок эпика тесты тоже проходили только без этих переменных.

## Что сделано

- Корневые `any` заменены на `unknown` с локальным `isRecord`-guard и доменными типами; каскад `no-unsafe-*` ушёл сам. Для строк БД добавлены `rowToX(row: unknown)` и `const row: unknown = ...get()`.
- Добавлен `src/text.ts` с `safeStringify(value: unknown)`: защищает `String(...)` от `[object Object]` после сужения типа (правило `no-base-to-string`).
- Удалены мёртвые импорты/переменные (`dayStartUtc`, `shortTaskName`, `needsPollMode`, `timer` и др.) и лишние `await` перед синхронными вызовами.
- Три умышленных fire-and-forget вызова в `src/index.ts` помечены `void` с комментарием; аргумент `input` → `_input`, локальная `action` подавлена через `void action;` (argsIgnorePattern действует только на аргументы).
- Единственный `eslint-disable` — граница внешнего API `node:sqlite` в `src/db/index.ts`, с комментарием «почему» и ссылкой QA-A2.7. `as any`, `@ts-ignore` и новые disable без обоснования не добавлены.
- Baseline-гейт снят: `.github/workflows/ci.yml` использует `npm run lint:strict`; `eslint-baseline.json` обнулён (0/0, пустые срезы); `test-eslint-baseline.mjs`, `scripts/check-eslint-baseline.mjs` и `skills/scheduled-job-best-practices/references/recipes.md` обновлены под строгий режим; скрипт `lint:strict` сохранён.
- Строка `- [ ] QA-A2.7 ...` удалена из `ROADMAP.md`; строки PL-67 и PL-68 не тронуты. В `CHANGELOG.md` добавлена одна запись **QA-A2.7 — ...**.

## Изменённые файлы (45 в `src/`, 10 вне `src/`)

`src/` (45):
```
src/core/analytics.ts
src/core/audit.ts
src/core/dry-run.ts
src/core/execution.ts
src/core/file-watcher.ts
src/core/git-trigger.ts
src/core/glob.ts
src/core/matrix.ts
src/core/permissions.ts
src/core/pipeline-map.ts
src/core/pipeline-spec.ts
src/core/prometheus.ts
src/core/ps-wrapper.ts
src/core/record-history.ts
src/core/router/planner.ts
src/core/schedule-v2.ts
src/core/scheduler/at-fallback.ts
src/core/scheduler/linux.ts
src/core/scheduler/mac.ts
src/core/scheduler/registry.ts
src/core/scheduler/windows.ts
src/core/secrets.ts
src/core/self-analysis.ts
src/core/session.ts
src/core/structured-log.ts
src/core/summary.ts
src/core/telegram.ts
src/core/triage-rules.ts
src/core/triage-shadow.ts
src/core/worktree.ts
src/core/wrappers/bash.ts
src/db/capability-repo.ts
src/db/index.ts
src/db/metrics-repo.ts
src/db/run-context.ts
src/db/run-dlq.ts
src/db/run-journal.ts
src/db/run-resume.ts
src/db/settings-repo.ts
src/db/step-idempotency.ts
src/db/tasks-repo.ts
src/db/templates-repo.ts
src/i18n.ts
src/index.ts
src/text.ts
```

Вне `src/` (10, включая этот отчёт и создаваемый последним манифест):
```
.github/workflows/ci.yml
eslint-baseline.json
scripts/check-eslint-baseline.mjs
skills/scheduled-job-best-practices/references/recipes.md
test-eslint-baseline.mjs
ROADMAP.md
CHANGELOG.md
scripts/bl-commit.ps1
reports/QA-A2.7-zero-warnings.md
reports/bl-qa.manifest
```

Чужие файлы, 존재вшие в рабочем дереве до запуска задачи, НЕ трогались и в коммит не включаются: `docs/QA-A2-GUI-TUI.md`, `reports/QA-A2-alert.md`, `reports/QA-A2-final.md`, `reports/QA-A2.7-verify-os.md`.
