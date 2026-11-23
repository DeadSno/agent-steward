# QA-A2-T3 OS-bound typing

- **Дата:** 2026-11-23 (Mon)
- **trigger:** `cron` (зарегистрировано в планировщике ОС)
- **ОС:** Windows (`win32`), ветка `dev`
- **Модель:** Hy4 flash Free (`opencode` / `hy4-flash-free`)
- **Эпик:** QA-A2 (типизация плагина agent-steward), подзадача A2-T3
- **Цель:** убрать все предупреждения ESLint в `src/db/history-repo.ts`, не изменив поведение работы с историей.
- **Примечание о прогоне:** повторный запуск cron-задачи. Исправление типов уже зафиксировано коммитом `29811fc refactor(qa-a2): type history repo [QA-A2-T3]`; текущий прогон заново измерил файл всеми требуемыми командами и подтвердил результат (0 error / 0 warning). `src/db/history-repo.ts` в этом прогоне **не менялся** — в `git status` файл чистый.

## Корневая причина и стратегия

`src/db/index.ts` объявляет `SqliteStatement.get(): any` и `all(): any[]` (модуль `node:sqlite` грузится через `createRequire` без статических типов; править его вне SCOPE). Отсюда корневые `any` внутри файла:

1. `rowToRecord(row: any)` — каскад из 43 `no-unsafe-member-access` + `no-unsafe-assignment` на `JSON.parse`.
2. `const params: any[]` в `getHistory()` — `no-unsafe-argument` на spread `.all(...params)`.
3. Не типизированные результаты `.get()`/`.all()` в `finishRun`, `getHistoryForBudget`, `getLatestHistoryByTask`, `getHistorySince`, `countHistory`, `countRunningRecords`, `listRunningRecords`.

Применено (в коммите `29811fc`): доменный тип строки `HistoryRow` (поля по схеме: TEXT → `string|null`, INTEGER/REAL → `number|bigint|null`), сужение `unknown` → доменный тип через `as unknown as` **только на границе node:sqlite**, `Pick<HistoryRow, ...>` для частичных `SELECT`, `(string|number)[]` для параметров привязки. `JSON.parse(...)` сужается к `string[]`.

**Не применялись:** `eslint --fix`, `as any`, `@ts-ignore`, `eslint-disable`. Все комментарии с меткой `QA-A2-T3` объясняют, почему сужение нужно именно на границе БД. Runtime-выражения (`String()`, `Number()`, `JSON.parse()`, SQL, `.map()`) остались прежними — изменены только типы и комментарии, поведение работы с историей не изменилось.

## Таблица правил до/после (`src/db/history-repo.ts`)

| Правило ESLint | До | После |
|---|---:|---:|
| `@typescript-eslint/no-unsafe-member-access` | 43 | 0 |
| `@typescript-eslint/no-unsafe-assignment` | 6 | 0 |
| `@typescript-eslint/no-explicit-any` | 2 | 0 |
| `@typescript-eslint/no-unsafe-argument` | 1 | 0 |
| **ИТОГО error / warning** | **0 / 52** | **0 / 0** |

Значения «до» — из первого прогона A2-T3 (файл до коммита `29811fc`); значения «после» — измерены заново текущим прогоном 2026-11-23.

## Команды и exit code

| Команда | Exit code | Результат |
|---|---:|---|
| `npx eslint src/db/history-repo.ts --format json` (до, первый прогон) | 0 | 0 error / 52 warning |
| `npx eslint src/db/history-repo.ts --format json` (после, текущий прогон) | 0 | **0 error / 0 warning** (`errorCount:0`, `warningCount:0`, `messages:[]`) |
| `npm run build` | 0 | `tsc`: 0 ошибок |
| `npm run lint:baseline` | 1 | См. пояснение ниже — регрессия **вне SCOPE A2-T3** |
| `node test-docs.mjs` | 0 | `Docs: 129/129 проверок пройдено` |

**Пояснение к `npm run lint:baseline` (exit 1).** Храповик сравнивает с `eslint-baseline.json` (`totals: 543 warning / 0 error`) и падает из-за одного `error` и роста по конкретному файлу/правилу, которые не относятся к A2-T3:

- `src/db/capability-repo.ts:635` — `@typescript-eslint/array-type` (**error**, 1 > baseline 0);
- `src/db/capability-repo.ts:200` — `@typescript-eslint/no-base-to-string` (warning, файл 2 > baseline 1).

Этот файл зафиксирован коммитом `4200617 feat(execution): ARCH-3 flake aware gate verdict` параллельной задачи и находится **вне SCOPE** подзадачи A2-T3, поэтому не правился. По прямому требованию «не хуже 543»: суммарно по репозиторию **254 warning ≤ 543** (улучшение на 289), целевой файл даёт 0 warning. Измерение сделано `npx eslint src --format json`: `errors=1, warnings=254`, при этом `history-repo` — `e=0, w=0`. Обновлять `eslint-baseline.json` (`npm run lint:baseline:update`) не стали: это вывело бы базу из зоны SCOPE и скрыло бы чужую регрессию.

## Итоговые error/warning

- `src/db/history-repo.ts`: **0 error, 0 warning** (было 0 / 52). ✅
- Репозиторий в целом: **1 error, 254 warning** (warning-счётчик 254 ≤ 543, требование «не хуже 543» выполнено). Единственный error — `src/db/capability-repo.ts` вне SCOPE A2-T3.

## Список изменённых файлов

- `reports/QA-A2-T3-os.md` — настоящий отчёт, обновлён текущим прогоном.
- `src/db/history-repo.ts` — исправление типов уже зафиксировано коммитом `29811fc`; в текущем прогоне файл не изменялся (queries to `git status` — clean).

Не трогались: `dist/`, `gui-experimental.cjs`, `legacy/`, `ROADMAP.md`, `CHANGELOG.md`, `package.json`, `eslint-baseline.json`, любые другие `src`-файлы (включая `src/db/capability-repo.ts`). Временные JSON-артефакты прогона удалены; чужой неотслеживаемый файл `eslint-qa-a2.json` не тронут. `git add` / `git commit` / `git push` не выполнялись — это сделает `afterScript` планировщика.
