# Портабельность: OpenCode → MCP / dsh / ACP (P-5)

Пакет остаётся **одним**: `@modelcontextprotocol/sdk` и адаптеры не требуют
монорепо. OpenCode V1/V2-адаптер остаётся неизменным; все новые точки входа
переиспользуют один реестр из 32 инструментов.

## Subpath exports

| Импорт | Что даёт |
| --- | --- |
| `agent-steward/core` | `createRuntimeCore`, `buildToolSpecs`, `RuntimeDeps`, `ToolSpec`, `TOOL_NAMES` — только контекст-free ядро (P-1.2); `createRuntime`/`createToolSpecs` остаются в корневом `agent-steward` и не импортируются фасадом |
| `agent-steward/mcp` | `createMcpServer`, `startMcpServer`, `mcpToolSpecs` |
| `agent-steward/dsh` | `defineDshTools`, `submitDshJob`, `DSH_ADAPTER_VERSION` |

## Команды

```bash
agent-steward mcp             # MCP stdio, 32 инструмента + SKILL.md ресурс
agent-steward serve           # локальный дашборд без OpenCode
agent-steward serve --port 3800
```

`serve` переиспользует `src/server.ts` и SQLite, не загружая плагин OpenCode.

## dsh

Зафиксированная версия API: `dsh-developer-preview-2026-11` (см.
`DSH_ADAPTER_VERSION`). Менять её можно только вместе с контрактным тестом
`test-dsh-adapter.mjs`. Скилл для агентов лежит в `.agents/skills/agent-steward/SKILL.md`.

## Harness в задаче

Поле `harness` (`opencode` по умолчанию, также `dsh-headless`, `acp`,
`cursor-cli`) хранится в определении задачи и используется инвокером.
Обёртки Windows/POSIX читают `AGENT_COMMAND_PATH` и `AGENT_ARGS`; без них
поведение прежнее — `opencode run --auto`.

## Тонкие расширения редакторов (опционально)

MCP-конфига достаточно для Cursor/VS Code/IDEA — см. `docs/mcp-setup.md`.
Расширения нужны только для UX (кнопка «Запустить дашборд», вставка сниппета
задачи); функциональность плагина от них не зависит.

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
