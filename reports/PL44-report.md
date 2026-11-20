# PL-44 skill counters gate

- Дата: 2026-11-20
- Trigger: file (реакция на появление файла в каталоге наблюдения, без привязки к расписанию ОС)
- Ветка: dev
- ОС: Windows

## Цель

Защитить счётчики tools/RPC/сюит во всех локальных `SKILL.md` от расхождения с кодом через `test-docs.mjs`.

## Проверенные SKILL.md

- `.opencode/skills/agent-steward-dev/SKILL.md`
- `.opencode/skills/docs-sync/SKILL.md`
- `.opencode/skills/opencode-plugin-dev/SKILL.md`
- `.opencode/skills/plugin-security-review/SKILL.md`
- `.opencode/skills/qa-deep-audit/SKILL.md`
- `.opencode/skills/release-check/SKILL.md`
- `.opencode/skills/roadmap-plugin-workflow/SKILL.md`
- `skills/scheduled-job-best-practices/SKILL.md`

## Эталоны (из кода, без хардкода в тесте)

- **tools = 30** — число записей реестра `name: "..."` в `src/index.ts` (`toolRegistry.length`).
- **RPC = 57** — число методов в блоке `SchedulerRpc.methods` до `events` в `src/rpc.ts`.
- **suites = 115** — число уникальных `node test-*.mjs` в сценарии `npm test` (`package.json`).

## Изменения

1. `test-docs.mjs`: после существующей проверки счётчика сюит добавлен блок PL-44 — вычисляет `rpcCountForSkills` из `src/rpc.ts` (блок `methods` до `events`), собирает все локальные `SKILL.md` из `.opencode/skills/*/SKILL.md` и `skills/*/SKILL.md`, для каждого файла регулярками находит упоминания счётчиков в контекстах `N tools`, `N agent tools`, `N MCP-инструментов`, `инструменты (из N)`, `N RPC-методов`, `RPC-методы (из N)`, `N наборов тестов`, `N test suites` (включая markdown-жирный `**N**`) и проверяет равенство эталонам из кода. Ошибка печатает имя файла, найденное число и ожидаемое.
2. Добавлен предохранитель: проверка падает, если не найдено ни одного совпадения или ни один `SKILL.md` не объявляет все три счётчика.
3. Локальные `SKILL.md` проверены на старые значения (29/57/109) и расхождения — правок не потребовалось (значения уже соответствуют эталонам 30/57/115).
4. `ROADMAP.md`: удалена строка PL-44.
5. `CHANGELOG.md`: в начало списка `[Unreleased] > Added` добавлена запись `PL-44 — счётчики в SKILL.md проверяются test-docs.mjs.`

## Верификация

| Команда | Результат |
| --- | --- |
| `node test-docs.mjs` | Зелёный: `Docs: 127/127 проверок пройдено.` (число проверок выросло; PL-44 добавил проверки счётчиков по SKILL.md и предохранители) |
| `npm run build` | Успешно (`tsc`) |
| Инъекция ошибки (временное изменение `SKILL.md`, с возвратом) | В `.opencode/skills/docs-sync/SKILL.md` временно заменён `**30** MCP-инструментов` на `**29**`; `node test-docs.mjs` упал с `FAIL .opencode/skills/docs-sync/SKILL.md: счётчик tools найдено 29, ожидалось 30` (`Docs: 126/127`, exit 1). Файл восстановлен, повторный прогон зелёный. |

**Результат:** PASS
