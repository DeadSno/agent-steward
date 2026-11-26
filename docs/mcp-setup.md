# MCP-адаптер agent-steward (P-2)

`agent-steward mcp` поднимает MCP-сервер на stdio с полным реестром из 34
инструментов — тем же, что регистрирует плагин в OpenCode V1/V2 (`TOOL_NAMES`).
Дополнительно доступны ресурс
`skill://agent-steward/scheduled-job-best-practices/SKILL.md` и промпт
`agent-steward-skill` с тем же содержимым.

Требуется собранный пакет (`npm run build`) и Node ≥ 26.4 (`engines.node`, совместимость с `@opentui/core`).

## Cursor — `.cursor/mcp.json`

```json
{
  "mcpServers": {
    "agent-steward": {
      "command": "npx",
      "args": ["-y", "agent-steward", "mcp"]
    }
  }
}
```

## VS Code — `.vscode/mcp.json`

```json
{
  "servers": {
    "agent-steward": {
      "type": "stdio",
      "command": "node",
      "args": ["node_modules/agent-steward/dist/cli.js", "mcp"]
    }
  }
}
```

## JetBrains IDEA (MCP Server)

Settings → Tools → AI Assistant → Model Context Protocol → Add:
- Server type: `stdio`
- Command: `npx`
- Arguments: `-y agent-steward mcp`

## Ресурс SKILL.md и промпт

- **Ресурс:** `agent-steward-skill`, URI
  `skill://agent-steward/scheduled-job-best-practices/SKILL.md`,
  `title: scheduled-job-best-practices`, `mimeType: text/markdown`.
- **Промпт:** `agent-steward-skill` («Load scheduling best practices»).

Оба читают `SKILL.md` с диска при обращении клиента: ресурс можно открыть как
документ, промпт — подставить в диалог. Клиент должен поддерживать ресурсы,
чтобы получить правила планирования; иначе используйте промпт.

## Ограничения

- Нужен собранный пакет: `npm run build` создаёт `dist/`; запуск из исходников
  без сборки не работает. Минимальная версия Node — 26.4 (`engines.node`, нижняя граница `@opentui/core` 0.9.0).
- MCP публикует **все 34 инструмента** независимо от
  `AGENT_STEWARD_TOOL_PROFILE` в корневом харнессе: урезанный профиль клиента
  относится к вызовам внутри дочернего запуска и может отключить часть
  инструментов там. Рабочий набор клиента сверяйте через `tools/list`.
- В свежем worktree, где `dist/` — junction/symlink на основной чек-аут
  (см. `AGENTS.md`, W-1), дочерний Node ищет зависимости по реальному пути и
  может не найти `@modelcontextprotocol/sdk`. Тест запускает child с флагами
  `--preserve-symlinks --preserve-symlinks-main`; для ручного запуска и для
  конфигов клиентов используйте реальный каталог пакета или те же флаги.
- MCP — переносимая точка входа для внешних агентов, а не замена плагину
  OpenCode: V1/V2-хуки, GUI и дашборд остаются отдельными интерфейсами.

## Проверка

```bash
npm run build
node test-mcp-adapter.mjs   # 7 проверок: реальный stdio-клиент, 34 инструмента, ресурс, prompt, list_tasks
node test-tool-specs.mjs    # снимок схем 34 инструментов и паритет с RPC
node test-docs.mjs          # целостность документации и контрактов
```

Готовые сниппеты лежат в `examples/.cursor/mcp.json` и `examples/.vscode/mcp.json`.
