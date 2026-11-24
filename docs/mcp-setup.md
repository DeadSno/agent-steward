# MCP-адаптер agent-steward (P-2)

`agent-steward mcp` поднимает MCP-сервер на stdio с теми же 32 инструментами,
что регистрирует плагин в OpenCode V1/V2. Дополнительно доступны ресурс
`skill://agent-steward/scheduled-job-best-practices/SKILL.md` и одноимённый prompt.

Требуется собранный пакет (`npm run build`) и Node ≥ 22.22.

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

## Проверка

```bash
npm run build
node test-mcp-adapter.mjs   # 6 проверок: 32 инструмента, ресурс, prompt
node test-tool-specs.mjs    # 7 проверок: снимок и паритет с RPC
```

Готовые сниппеты лежат в `examples/.cursor/mcp.json` и `examples/.vscode/mcp.json`.
