# QA-A2.7 — финальная верификация эпика типизации

- Дата: 2026-11-20
- Ветка: `dev`
- Исполнитель: QA-A2.7 (финальная верификация)
- Старт подзадач: **543 warning**
- Итоговый замер (свежий прогон): **355 warning, 0 error** (46 файлов)

## Вердикт

**Эпик НЕ закрыт.** Условие закрытия (`warning = 0 И error = 0`) не выполнено:
`warning = 355 > 0`.

По правилам подзадачи:

- `ROADMAP.md` **не трогался** — QA-A2.2–A2.7 не отмечены `[x]`, эпик не помечен выполненным;
- `.github/workflows/ci.yml` **не трогался** — строка `npm run lint:baseline` **не удалялась**;
- коммит/push **не выполнялись** (это сделает afterScript);
- суб-агенты **не спавнились**.

Динамика: `543 (старт) → 355 (финальный замер, −188)`. На всех замерах
`error = 0`, но `warning > 0` — критерий «ноль предупреждений» не достигнут.

## Результаты команд (свежий прогон)

| Команда | Результат |
| --- | --- |
| `npm run build` | ✅ PASS (`tsc`, без ошибок) |
| `npm run lint` | ⚠️ 355 warning, 0 error |
| `npm run test:parallel` | ❌ 111/112 наборов, упал `test-docs.mjs` (exit 1) |
| `npm run lint:baseline` | ✅ PASS — «новых предупреждений нет — 355 warning (baseline 543, -188)» |
| `npx eslint src --format json` | 0 error / **355 warning** / 46 файлов |

### Детали падения `test-docs.mjs`

Мета-гейт `Docs: 108/109 проверок пройдено`. В момент полного прогона
не проходила проверка
`package.json: все 117 test-*.mjs на диске упомянуты в скриптах (не упомянуто: 1)`
— не был упомянут `test-test-plan.mjs`.

В ходе верификации рабочее дерево менялось параллельными подзадачами:
`package.json` был дополнен (теперь все 117 файлов упомянуты, `unlisted = 0`),
из-за чего повторный `node test-docs.mjs` падает уже по другой проверке:
`README: число test suites (112) = число node test-*.mjs в npm test (113)`.
То есть тестовый набор **не зелёный** в обеих точках замера; причина
сдвинулась, но факт провала `test-docs.mjs` остаётся. Для закрытия эпика
требуется привести счётчик в README (112 → 113) и заново прогнать 112/112.

## Разбивка по правилам ESLint (355 warning, 0 error)

| Правило | Кол-во | Причина |
| --- | ---: | --- |
| `@typescript-eslint/no-unsafe-member-access` | 162 | Чтение полей с `any` — главным образом строки, возвращаемые `node:sqlite` (`prepare().get()/all()`) |
| `@typescript-eslint/no-unsafe-assignment` | 50 | Присваивание `any` типизированным переменным/полям |
| `@typescript-eslint/no-unused-vars` | 29 | Неиспользуемые импорты, переменные, параметры |
| `@typescript-eslint/no-explicit-any` | 28 | Явные `any` в сигнатурах и локальных типах |
| `@typescript-eslint/no-base-to-string` | 27 | Интерполяция значений, строкующихся как `[object Object]` |
| `@typescript-eslint/prefer-optional-chain` | 18 | Ручные проверки `x && x.y` вместо `x?.y` |
| `@typescript-eslint/no-redundant-type-constituents` | 17 | Литералы (`"success"`, `"manual"` и т.п.), поглощённые `string` в union |
| `@typescript-eslint/no-unsafe-argument` | 11 | Передача `any` в типизированные параметры |
| `@typescript-eslint/await-thenable` | 7 | `await` на значениях, не являющихся Promise |
| `@typescript-eslint/no-floating-promises` | 3 | Promise без `await`/`.catch`/`void` |
| `@typescript-eslint/no-unsafe-call` | 1 | Вызов значения с типом `any` |
| `@typescript-eslint/no-unsafe-return` | 1 | Возврат `any` из типизированной функции |
| `@typescript-eslint/consistent-type-imports` | 1 | Импорт типа как значения |
| **ИТОГО** | **355** | |

Корень почти всех находок — **не типизированный SQLite-слой**: `node:sqlite`
возвращает `any`, который размножается по репозиториям (member access,
assignment, argument, call). Вторая группа — `*unsafe*`/`any` в `src/index.ts`,
`src/core/*`. Третья — локальные «культурные» правила (unused-vars,
base-to-string, optional chain, redundant union), исправляются без изменения
архитектуры.

## Оставшиеся файлы со счётчиками (46 файлов, 355 warning)

| Файл | Warning | Файл | Warning |
| --- | ---: | --- | ---: |
| `src/db/history-repo.ts` | 52 | `src/core/triage-shadow.ts` | 7 |
| `src/db/runs-repo.ts` | 47 | `src/core/pipeline-spec.ts` | 6 |
| `src/core/audit.ts` | 24 | `src/core/scheduler/windows.ts` | 5 |
| `src/index.ts` | 23 | `src/db/templates-repo.ts` | 5 |
| `src/core/structured-log.ts` | 21 | `src/core/file-watcher.ts` | 4 |
| `src/db/run-context.ts` | 20 | `src/core/session.ts` | 4 |
| `src/db/metrics-repo.ts` | 18 | `src/db/settings-repo.ts` | 4 |
| `src/db/tasks-repo.ts` | 15 | `src/core/record-history.ts` | 3 |
| `src/db/run-dlq.ts` | 14 | `src/core/schedule-v2.ts` | 3 |
| `src/db/index.ts` | 12 | `src/core/scheduler/mac.ts` | 3 |
| `src/core/telegram.ts` | 11 | `src/core/scheduler/registry.ts` | 3 |
| `src/core/self-analysis.ts` | 10 | `src/i18n.ts` | 3 |
| `src/core/router/planner.ts` | 8 | `src/core/triage-rules.ts` | 2 |
| `src/core/secrets.ts` | 7 | `src/core/worktree.ts` | 2 |
| `src/db/step-idempotency.ts` | 2 | `src/core/analytics.ts` | 1 |
| `src/core/dry-run.ts` | 1 | `src/core/execution.ts` | 1 |
| `src/core/git-trigger.ts` | 1 | `src/core/glob.ts` | 1 |
| `src/core/matrix.ts` | 1 | `src/core/permissions.ts` | 1 |
| `src/core/pipeline-map.ts` | 1 | `src/core/prometheus.ts` | 1 |
| `src/core/ps-wrapper.ts` | 1 | `src/core/scheduler/at-fallback.ts` | 1 |
| `src/core/scheduler/linux.ts` | 1 | `src/core/summary.ts` | 1 |
| `src/core/wrappers/bash.ts` | 1 | `src/db/capability-repo.ts` | 1 |
| `src/db/run-journal.ts` | 1 | `src/db/run-resume.ts` | 1 |

Уже закрыто параллельными подзадачами (в финальном снимке 0 warning):
`src/server.ts` (A2.2), `src/notifications.ts` (A2.3), `src/db/migrate.ts` (A2.4),
`src/task-transfer.ts`, `src/workspaces.ts` (A2.5).

## Что осталось сделать

1. **Типизировать SQLite-слой** (главный источник ~300 находок): завести общий
   типизированный враппер над `node:sqlite` (`Row` → `unknown` → валидация/тип),
   убрать `.get()/.all()` с `any`. Файлы: `history-repo.ts` (52), `runs-repo.ts` (47),
   `run-context.ts` (20), `metrics-repo.ts` (18), `tasks-repo.ts` (15), `run-dlq.ts` (14),
   `db/index.ts` (12), `templates-repo.ts` (5), `settings-repo.ts` (4),
   `step-idempotency.ts` (2), `capability-repo.ts`, `run-journal.ts`, `run-resume.ts` (по 1).
   Это **durable-слой** (leases, идемпотентность, recovery, DLQ) — самое хрупкое
   место по `AGENTS.md`; правки требуют `test-run-*`, `test:worktree`, `test:guards`,
   `test:w4` и nightly chaos.
2. **`src/index.ts` (23)**, `src/core/audit.ts` (24), `src/core/structured-log.ts` (21),
   `src/core/telegram.ts` (11), `src/core/self-analysis.ts` (10) и остальные `src/core/*`
   (1–8), `src/i18n.ts` (3) — убрать явные `any`, `no-base-to-string`,
   `no-floating-promises`, `await-thenable`, неиспользуемые импорты/аргументы.
3. **QA-A2.6 / GUI/TUI** — проверить покрытие `src/gui.tsx`, `src/tui*.tsx` ESLint и
   довести их до нуля (в текущем снимке они в ESLint-покрытии не фигурируют).
4. **Мета-гейт (P1)**: счётчик в README (112) не совпадает с числом `node test-*.mjs`
   в `npm test` (113) после добавления `test-test-plan.mjs`. Формат находки:
   `тестовый мета-гейт: test-docs.mjs / README.md (README 112 vs npm test 113) — P1. Действие: обновить счётчик "# 113 test suites" в README.`
5. **Повторить QA-A2.7** после завершения всех подзадач и стабилизации дерева:
   `npm run build`, `npm run lint`, `npm run test:parallel` (цель 112/112),
   `npm run lint:baseline`, `npx eslint src --format json` → ожидается
   `0 error / 0 warning`. Только после этого отмечать QA-A2.2–A2.7 как `[x]` и
   удалять строку `lint:baseline` из CI.

## Итоговая цифра

**355 warning** (0 error, 46 файлов). Эпик открыт, закрытие заблокировано.
