# QA-A2-T3 OS-bound typing

- **Дата:** 2026-11-20 (Fri)
- **trigger:** `cron` (зарегистрировано в планировщике ОС)
- **ОС:** Windows (`win32`), ветка `dev`
- **Модель:** Hy4 flash Free (`opencode` / `hy4-flash-free`)
- **Эпик:** QA-A2 (типизация плагина agent-steward), подзадача A2-T3
- **Цель:** убрать все предупреждения ESLint в `src/db/history-repo.ts`, не изменив поведение работы с историей.

## Корневая причина и стратегия

`src/db/index.ts` объявляет `SqliteStatement.get(): any` и `all(): any[]` (модуль `node:sqlite` грузится через `createRequire` без статических типов и править его вне SCOPE). Отсюда два корневых `any` внутри файла:

1. `rowToRecord(row: any)` — каскад из 43 `no-unsafe-member-access` + 2 `no-unsafe-assignment` (`JSON.parse`).
2. `const params: any[]` в `getHistory()` — `no-unsafe-argument` на spread `.all(...params)`.
3. Не типизированные результаты `.get()`/`.all()` в `finishRun`, `getHistoryForBudget`, `getLatestHistoryByTask`, `getHistorySince`, `countHistory`, `countRunningRecords`, `listRunningRecords`.

Применено: доменный тип строки `HistoryRow` (поля по схеме: TEXT → `string|null`, INTEGER/REAL → `number|bigint|null`), сужение `unknown` → доменный тип через `as unknown as` **только на границе node:sqlite**, `Pick<HistoryRow, ...>` для частичных `SELECT`, `(string|number)[]` для параметров привязки. `JSON.parse(...)` сужается к `string[]`.

**Не применялись:** `eslint --fix`, `as any`, `@ts-ignore`, `eslint-disable`. Все комментарии с меткой `QA-A2-T3` объясняют границу БД. Все runtime-выражения (`String()`, `Number()`, `JSON.parse()`, SQL, `.map()`) остались побайтово прежними — изменены только типы и комментарии.

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
| `npx eslint src/db/history-repo.ts --format json` (после) | 0 | **0 error / 0 warning** |
| `npm run build` | 0 | tsc: 0 ошибок |
| `npm run lint:baseline` | 1 | см. примечание ниже; глобально 302 warning ≤ baseline 543 (улучшение, не регрессия), вклад `history-repo.ts` 52 → 0 |
| `node test-docs.mjs` | 0 | 109/109 проверок |
| `npx eslint src --format json` (доп.) | 0 | всего 302 warning, 0 error; `history-repo.ts` = 0 |
| `npm run test:history-load` (доп.) | 0 | 9 пройдено, 0 упало |
| `npm run test:dag-latest-history` (доп.) | 0 | 5 пройдено |

## Итоговые error/warning

- `src/db/history-repo.ts`: **0 error, 0 warning** (было 0 / 52).
- Репозиторий в целом: **0 error, 302 warning** (baseline 543 → улучшение на 241).

### Примечание про `lint:baseline` (exit 1)

Скрипт-храповик сравнивает покадровые счётчики с `eslint-baseline.json`. Он падает **не на файле этой подзадачи**, а на параллельно изменённом (не мной, вне SCOPE A2-T3) файле `src/core/dry-run.ts`: `2 > baseline 1`, в т.ч. `@typescript-eslint/no-unused-vars: 1 > baseline 0`. Глобальный счётчик при этом 302 ≤ 543, т.е. требование «не хуже 543» выполнено. Обновлять `eslint-baseline.json` и трогать `dry-run.ts` в рамках A2-T3 запрещено — передаётся оператору/следующей задаче.

## Список изменённых файлов

- `src/db/history-repo.ts` — единственный исходный файл, изменённый этой подзадачей (только типы/комментарии, без изменения поведения).
- `reports/QA-A2-T3-os.md` — настоящий отчёт.

Прочие файлы в `git status` (`ROADMAP.md`, `src/core/dry-run.ts`, `test-dry-run.mjs`, `eslint-before.json`) изменены параллельными задачами оператора до/во время A2-T3 и **не** являются частью этой правки. `dist/`, `gui-experimental.cjs`, `legacy/`, `CHANGELOG.md`, `package.json` не редактировались; `npm run build` пересобрал артефакты штатно. `git add/commit/push` не выполнялись — это сделает `afterScript` планировщика.
