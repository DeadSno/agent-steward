# QA-A2-T4 event-bound typing

- Дата: 2026-11-20 (Fri)
- Ветка: `dev`
- Trigger: `mcp-event` (запуск через `emit_event`, без привязки к ОС); ОС выполнения — Windows
- Модель: Hy4 flash Free (`opencode/hy4-flash-free`)
- Цель: убрать все предупреждения ESLint в `src/db/runs-repo.ts`, не изменив поведение репозитория запусков

## Подход

Корневой источник предупреждений — `any` на границе `node:sqlite`: `SqliteStatement.get()/all()`
объявлены как `any`/`any[]` в `src/db/index.ts` (файл вне SCOPE). Вместо правки драйвера
введён type guard на границе репозитория:

1. `any` из `.get()`/`.all()` сразу присваивается в `unknown` (`const raw: unknown = ...`) —
   `no-unsafe-assignment` не срабатывает, значение дальше сужается явно.
2. `isSqliteRow(value: unknown): value is SqliteRow` проверяет, что значение — не массивный
   объект и все его ячейки имеют один из реальных SQLite-типов (`string | number | bigint | null`).
3. Хелперы `queryRow()` / `queryRows()` возвращают типизированный `SqliteRow`, после чего
   `runRowToRecord` / `stepRowToRecord` работают с обычными типизированными полями.
4. `parseJson` больше не вызывает `String(unknown)` (источник `no-base-to-string`): он принимает
   `string | null`, что точно соответствует содержимому TEXT-колонок `metadata_json` / `output_json`.
5. Доменные приведения `as RunStatus` / `as StepStatus` сохранены без изменений — это не `as any`,
   а исходное поведение (значения приходят из CHECK-ограниченных записей репозитория).

`eslint --fix` НЕ запускался. `as any`, `@ts-ignore`, `eslint-disable` не использовались.

## Правила: до / после

| Правило ESLint | До | После |
| --- | ---: | ---: |
| `@typescript-eslint/no-explicit-any` | 2 | 0 |
| `@typescript-eslint/no-base-to-string` | 2 | 0 |
| `@typescript-eslint/no-unsafe-member-access` | 38 | 0 |
| `@typescript-eslint/no-unsafe-assignment` | 5 | 0 |
| **Итого по файлу (error / warning)** | **0 / 47** | **0 / 0** |

Каскад `no-unsafe-member-access` (38) ушёл сам после устранения двух корневых `any` и
типизации результатов `.get()/`.all()` — отдельные правки каждого поля не потребовались.

## Команды и exit code

| Команда | Exit code | Результат |
| --- | ---: | --- |
| `npx eslint src/db/runs-repo.ts --format json` | 0 | `errorCount: 0, warningCount: 0, fixableWarningCount: 0` |
| `npm run build` | 0 | tsc без ошибок |
| `node test-docs.mjs` | 0 | Docs: 109/109 проверок пройдено |
| `node test-run-state.mjs` | 0 | Durable-состояние пройдено |
| `node test-run-journal.mjs` | 0 | Журнал шагов пройден |
| `node test-run-resume.mjs` | 0 | Resume пройден |
| `node test-step-idempotency.mjs` | 0 | Идемпотентные ключи пройдены |
| `node test-run-dlq.mjs` | 0 | DLQ пройден |
| `node test-run-context.mjs` | 0 | Пауза с контекстом пройдена |
| `npm run lint:baseline` | 1 | См. примечание ниже (вне SCOPE) |

## Итоговые счётчики

- `src/db/runs-repo.ts`: **0 error / 0 warning** (было 0 / 47).
- Всего по `src`: **254 warning** (baseline эпика 543 — «не хуже 543» выполнено), **3 error**.

### Примечание про `lint:baseline` (exit 1)

Гейт падает не из-за правок A2-T4, а из-за трёх уже существовавших до задачи ошибок в
`src/index.ts`, которые находятся вне SCOPE подзадачи и не трогались:

- `src/index.ts:3891` — `@typescript-eslint/consistent-type-definitions` (1)
- `src/index.ts:3897`, `src/index.ts:3935` — `@typescript-eslint/array-type` (2)

Baseline хранит `errors: 0`, поэтому любая error в любом файле делает гейт красным. После того
как владелец `src/index.ts` исправит эти три ошибки, гейт пройдёт: новых предупреждений по
сравнению с baseline нет, а общее число warning снизилось с 543 до 254 (в том числе −47 по целевому файлу).

## Изменённые файлы

- `src/db/runs-repo.ts` — типизация границы `node:sqlite`, правки в рамках SCOPE
- `reports/QA-A2-T4-event.md` — настоящий отчёт

Не изменялись: `dist/`, `gui-experimental.cjs`, `legacy/`, `ROADMAP.md`, `CHANGELOG.md`,
`package.json` и другие `src`-файлы. `git add` / `commit` / `push` не выполнялись — это делает
afterScript планировщика.
