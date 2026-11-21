# QA-A2-T3 OS-bound typing

- **Дата:** 2026-11-21 (Sat)
- **trigger:** `cron` (зарегистрировано в планировщике ОС)
- **ОС:** Windows (`win32`), ветка `dev`
- **Модель:** Hy4 flash Free (`opencode` / `hy4-flash-free`)
- **Эпик:** QA-A2 (типизация плагина agent-steward), подзадача A2-T3
- **Цель:** убрать все предупреждения ESLint в `src/db/history-repo.ts`, не изменив поведение работы с историей.
- **Примечание о прогоне:** повторный запуск cron-задачи. Исправление типов уже зафиксировано в репозитории коммитом `29811fc refactor(qa-a2): type history repo [QA-A2-T3]`; текущий прогон подтвердил результат (0 warning) и перепровёл файл всеми требуемыми командами.

## Корневая причина и стратегия

`src/db/index.ts` объявляет `SqliteStatement.get(): any` и `all(): any[]` (модуль `node:sqlite` грузится через `createRequire` без статических типов и править его вне SCOPE). Отсюда корневые `any` внутри файла:

1. `rowToRecord(row: any)` — каскад из 43 `no-unsafe-member-access` + 2 `no-unsafe-assignment` (`JSON.parse`).
2. `const params: any[]` в `getHistory()` — `no-unsafe-argument` на spread `.all(...params)`.
3. Не типизированные результаты `.get()`/`.all()` в `finishRun`, `getHistoryForBudget`, `getLatestHistoryByTask`, `getHistorySince`, `countHistory`, `countRunningRecords`, `listRunningRecords`.

Применено: доменный тип строки `HistoryRow` (поля по схеме: TEXT → `string|null`, INTEGER/REAL → `number|bigint|null`), сужение `unknown` → доменный тип через `as unknown as` **только на границе node:sqlite**, `Pick<HistoryRow, ...>` для частичных `SELECT`, `(string|number)[]` для параметров привязки. `JSON.parse(...)` сужается к `string[]`.

**Не применялись:** `eslint --fix`, `as any`, `@ts-ignore`, `eslint-disable`. Все комментарии с меткой `QA-A2-T3` объясняют границу БД. Все runtime-выражения (`String()`, `Number()`, `JSON.parse()`, SQL, `.map()`) остались прежними — изменены только типы и комментарии.

## Таблица правил до/после (`src/db/history-repo.ts`)

| Правило ESLint | До | После |
|---|---:|---:|
| `@typescript-eslint/no-unsafe-member-access` | 43 | 0 |
| `@typescript-eslint/no-unsafe-assignment` | 6 | 0 |
| `@typescript-eslint/no-explicit-any` | 2 | 0 |
| `@typescript-eslint/no-unsafe-argument` | 1 | 0 |
| `@typescript-eslint/array-type` (занесено при правке, сразу исправлено) | 0 | 0 |
| **ИТОГО error / warning** | **0 / 52** | **0 / 0** |

## Команды и exit code

| Команда | Exit code | Результат |
|---|---:|---|
| `npx eslint src/db/history-repo.ts --format json` (до) | 0 | 0 error / 52 warning |
| `npx eslint src/db/history-repo.ts --format json` (после) | 0 | **0 error / 0 warning** (`errorCount:0`, `warningCount:0`) |
| `npm run build` | 0 | tsc: 0 ошибок |
| `npm run lint:baseline` | 0 | `QA-A2.0: новых предупреждений нет — 254 warning (baseline 543, -289)` — требование «не хуже 543» выполнено с запасом |
| `node test-docs.mjs` | 0 | `Docs: 129/129 проверок пройдено` |

## Итоговые error/warning

- `src/db/history-repo.ts`: **0 error, 0 warning** (было 0 / 52).
- Репозиторий в целом: **0 error, 254 warning** (baseline 543 → улучшение на 289; храповик `lint:baseline` проходит, exit 0).

## Список изменённых файлов

- `src/db/history-repo.ts` — единственный исходный файл подзадачи (только типы/комментарии, без изменения поведения); изменения зафиксированы коммитом `29811fc`.
- `reports/QA-A2-T3-os.md` — настоящий отчёт (обновлён текущим прогоном).

Прочие файлы в `git status` (`CHANGELOG.md`) изменены параллельными задачами оператора и **не** являются частью этой правки. `dist/`, `gui-experimental.cjs`, `legacy/`, `ROADMAP.md`, `CHANGELOG.md`, `package.json` и другие `src`-файлы в рамках A2-T3 не редактировались; `npm run build` прошёл штатно (exit 0). `git add/commit/push` не выполнялись — это сделает `afterScript` планировщика.
