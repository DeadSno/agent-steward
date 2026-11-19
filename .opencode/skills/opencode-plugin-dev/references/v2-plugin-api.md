# V2 Plugin API — шпаргалка (проверено 2026-11-19)

Источники (все — <https://opencode.ai/docs/>):
- `/build/plugins/` — `Plugin.define`, хуки, transforms, tools, context, entrypoints;
- `/build/plugins/server/`, `/build/plugins/cli/`, `/build/plugins/gui/`, `/build/plugins/rpc/`;
- `/config/` — JSONC, locations, приоритеты, `plugins`, `mcp.servers`, `skills`, `instructions`,
  `permissions`, `experimental`;
- `/skills/` — discovery, precedence, frontmatter, IDs, permissions;
- `/instructions/` — `AGENTS.md`, массив `instructions`;
- `/permissions/` — `action`/`resource`/`effect`, wildcard `*`/`?`, skill ID как ресурс;
- `/llms.txt` — индекс V2-доков (LSP-страницы там нет).

## Ключевые факты

- `Plugin.define({ id, setup })`; парт-импорты: `@opencode/plugin`, `/tui`, `/gui`, `/rpc`.
- Точки входа: `.` (server), `./tui`, `./gui-experimental`, `./rpc`. `./rpc` экспортируют,
  когда контракт нужен другим плагинам/клиентам.
- Server register: `await ctx.rpc.register(Contract, handlers)`; local call: `ctx.rpc(Contract)`;
  GUI/TUI call: `ctx.client.rpc(Contract)`; `ctx.client` читать в момент вызова.
- `Rpc.define` поддерживает JSON Schema и Standard Schema (Zod и др.); события — объект,
  scalars/arrays не допускаются; имена ошибок с префиксом `rpc.` зарезервированы.
- Скилл: ID = путь (каталог `foo/SKILL.md` → `foo`); приоритет: проект > глобальный;
  `metadata.opencode/autoinvoke: false` скрывает из автопоказа.
- `permissions`: последнее совпадение побеждает; `deny` всегда доминирует; `skill` — отдельное
  действие с resource = skill ID. `lsp` НЕ является V2 permission action.
- `instructions`: `AGENTS.md` discovers автоматически; конфиг-массив `instructions` грузится после.
- Конфиг применяется без рестарта; `/reload` — принудительно.

## Антипаттерны

- V1-поля (`permission`, `bash`, `task`, `plugin`) в V2-конфиге/коде.
- Попытка подключить LSP («в V2 его нет»).
- Хранение RPC-контракта только внутри реализации без публичного экспорта.
- Редактирование сгенерированного GUI-бандла вручную.
- Тестирование неопубликованного workspace-link вместо установленного пакета.
