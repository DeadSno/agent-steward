# Портабельность: OpenCode → MCP / dsh / ACP (P-5)

Пакет остаётся **одним**: `@modelcontextprotocol/sdk` и адаптеры не требуют
монорепо. OpenCode V1/V2-адаптер остаётся неизменным; все новые точки входа
переиспользуют один реестр из 34 инструментов.

## Subpath exports

| Импорт | Что даёт |
| --- | --- |
| `agent-steward/core` | `createRuntimeCore`, `buildToolSpecs`, `RuntimeDeps`, `ToolSpec`, `TOOL_NAMES`, `AgentInvoker`/`resolveInvoker`/`HARNESS_VALUES` — только контекст-free ядро (P-1.2/P-3.1); `createRuntime`/`createToolSpecs` остаются в корневом `agent-steward` и не импортируются фасадом |
| `agent-steward/mcp` | `createMcpServer`, `startMcpServer`, `mcpToolSpecs` |
| `agent-steward/dsh` | `defineDshTools`, `submitDshJob`, `DSH_ADAPTER_VERSION`, `DSH_HARNESS`, `buildDshCommand`, `invokeDsh` |

## Команды

```bash
agent-steward mcp             # MCP stdio, 34 инструмента + SKILL.md ресурс
agent-steward serve           # локальный дашборд без OpenCode
agent-steward serve --port 3800
```

`serve` переиспользует `src/server.ts` и SQLite, не загружая плагин OpenCode.
Доступность точки входа проверяется реальным запросом `GET /api/health`
(LOCAL-only: нужен `X-Scheduler-Client` или локальный Origin/Host) в
`test-portability-exports.mjs`.

## dsh

Зафиксированная версия API: `dsh-developer-preview-2026-11` (см.
`DSH_ADAPTER_VERSION`). Менять её можно только вместе с контрактным тестом
`test-dsh-adapter.mjs`. Скилл для агентов лежит в `.agents/skills/agent-steward/SKILL.md`.
Команда dsh и её запуск идут через единый `AgentInvoker`: `DSH_HARNESS`,
`buildDshCommand()` и `invokeDsh()` (с local/docker/ssh runner, fail-open).

## Harness в задаче

Поле `harness` (`opencode` по умолчанию, также `dsh-headless`, `acp`,
`cursor-cli`) хранится в определении задачи и используется инвокером.
Обёртки Windows/POSIX читают `AGENT_COMMAND_PATH` и `AGENT_ARGS`; без них
поведение прежнее — `opencode run --auto`.

## Тонкие расширения редакторов (опционально)

MCP-конфига достаточно для Cursor/VS Code/IDEA — см. `docs/mcp-setup.md`.
Расширения нужны только для UX (кнопка «Запустить дашборд», вставка сниппета
задачи); функциональность плагина от них не зависит.

## Публикация пакета (QA-PORT-9)

`npm pack` / `npm publish` запускайте только из чистого чек-аута с реальной
`dist/` после `npm run build`. В свежих worktree `dist/` может быть junction на
основной чек-аут (PL-109/W-1): npm не упаковывает симлинки и джункшены, поэтому
такой tarball содержит только `package.json` — без `dist/index.js`, `dist/mcp.js`
и остальных entrypoint'ов. Опубликованный из worktree пакет будет битым.

Защита: CI на реальной сборке проверяет состав tarball (шаг `Verify package
contents`, `npm pack --dry-run`, и `test-portability-exports.mjs` в матрице
`npm run test:parallel`). Локальный тест при junction `dist/` проверяет только
доки и скилл и печатает предупреждение; отдельная регрессия создаёт временный
каталог с junction и фиксирует, что `dist/*` в tarball не попадает. При
`CI=true` junction `dist/` считается ошибкой — сборка в CI обязана быть чистой.

## Проверки

```bash
npm run build
npm run test:portability-exports   # --preserve-symlinks: dist/ может быть junction (QA-PORT-8)
node test-mcp-adapter.mjs
node test-dsh-adapter.mjs
node test-invokers.mjs
node test-tool-specs.mjs
node test-docs.mjs
```
