# Совместимость версий OpenCode

Единый контракт по версиям OpenCode, на которые рассчитан пакет. Источник истины
для README, CI и тестов: если числа здесь и в коде расходятся — правим здесь и
синхронизируем остальное.

## Матрица версий

| Линия | Минимум | Проверяем | Статус | Точка входа |
|---|---|---|---|---|
| **V1** (`1.x`) | `1.18.29` | `1.19.5` (ветка `1.19.x`) | поддерживается с `1.5.6` | `plugin` в конфиге, SDK `@opencode-ai/plugin` |
| **V2** (`2.x`) | `2.2.7` | `2.2.7` и `2.3.0` (CI в Д5) | поддерживается с `1.0.0` | `plugins` в конфиге, SDK `@opencode/plugin` |

## Где зафиксированы версии

| Что | Где | Значение |
|---|---|---|
| V2, сборка и runtime | `dependencies["@opencode/plugin"]` | `^2.2.7` |
| V2, схемы инструментов | `dependencies["@opencode/schema"]` | `^2.2.7` |
| V1, типы адаптера | `devDependencies["@opencode-ai/plugin"]` | `1.19.5` (pinned) |

`peerDependencies` намеренно не объявляются: plugin API — не runtime-зависимость
пакета, его предоставляет сам OpenCode. Пин V1 в `devDependencies` нужен, чтобы
адаптер компилировался против типов реальной V1-версии, а не «примерно похожей».
Изменение любого из этих трёх значений без правки таблицы роняет `test-docs`.

## Почему минимум V1 — 1.18.29

Двойная совместимость в одном пакете включается объектом
`{ ...Plugin.define({ id, setup }), async server() {...} }`: V2 вызывает
`setup()`, V1 вызывает `server()`. Этот способ появился в OpenCode `1.18.29`.
До него V1 умел только `server()`, а V2 — только `setup()`, поэтому один
default export не мог обслуживать обе линии. Для версий ниже нужен отдельный
legacy-entrypoint; в `1.5.6` его нет.

Проверено по реестру npm: версия `1.18.29` опубликована, последняя V1 — `1.19.5`.

## Почему минимум V2 — 2.2.7

Проверено по опубликованным типам `@opencode/plugin` (47 версий линии `2.x`):

| API | Появилось | Комментарий |
|---|---|---|
| `Plugin.define({ id, setup })` | `2.0.0` | ядро плагина |
| `ctx.tool.transform(editor => ...)` | `2.0.0` | регистрация инструментов |
| домены `ctx.*` (`location`, `storage`, `event`, `tool`, `session`, `permission`, `agent`, `shell`, `skill`, `command`, `mcp`, `worktree`, `rpc`) | `2.0.0` | набор одинаков с `2.2.7` |
| subpath `./gui` | `2.2.0` | в `2.1.4` ещё отсутствует (`404`) |
| subpath `./tui`, `./rpc` (через `./*`) | `2.0.0` | |

Минимум выставлен по **2.2.7**, а не по `2.0.0`, сознательно:

1. GUI — часть поверхности пакета (`exports` содержит `./gui-experimental`), а
   subpath `/gui` появился только в `2.2.0`.
2. Пакет собирается против типов `2.2.7` и объявляет зависимость `^2.2.7`.
   Версии ниже не проверяются, а значит не поддерживаются — обещать их нельзя.
3. Между `2.2.7` и `2.3.0` контракт `Plugin.define` и `ctx.tool.transform` не
   менялся, поэтому `2.3.0` проходит как проверочная версия.

Ядро (инструменты, хуки, SQLite, планировщик) технически работает и на `2.0.0`,
но GUI-часть там не загрузится. Поддержка `2.0.0–2.1.x` — отдельное решение,
в `1.5.6` его нет.

## Контракт V1

Всё ниже — из `@opencode-ai/plugin@1.19.5` (последняя V1-версия SDK).

**Экспорты пакета:** `.`, `./tool`, `./tui`, `./v2/*`. Subpath `/gui` и `/rpc`
отсутствуют — GUI-панель и RPC-методы в V1 недоступны.

**Тип модуля:**

```ts
type PluginInput = {
  client; project; directory; worktree; serverUrl; $
  experimental_workspace: { register(type, adapter): void }
}
type Plugin = (input: PluginInput, options?: Record<string, unknown>) => Promise<Hooks>
type PluginModule = { id?: string; server: Plugin; tui?: never }
```

**Хуки (`Hooks`):** `dispose`, `event`, `config`, `tool` (карта инструментов),
`tool.execute.before`, `tool.execute.after`, `permission.ask`, `chat.message`,
`chat.params`, `chat.headers`, `command.execute.before`, `shell.env`, `auth`,
`provider`, а также группа `experimental.*`.

**Инструменты:** `tool({ description, args, execute })`, где `args` — raw shape
Zod-объекта. `@opencode-ai/plugin@1.19.5` зависит от `zod@4.1.8`, а пакет — от
`zod@^4.6.7`: мажор совпадает, отдельная копия zod для V1 не нужна. `execute`
получает `(args, context)` и возвращает `string` либо `{ title, output, metadata, attachments }`.

**TUI:** отдельный subpath `@opencode-ai/plugin/tui`; модуль TUI регистрируется
не через `setup(ctx)`, а через TUI-API V1 — поэтому в `1.5.6` нужен отдельный
entrypoint (задача З3.4).

## Чего в V1 нет

| Возможность | Причина |
|---|---|
| GUI-панель | нет subpath `@opencode-ai/plugin/gui` |
| RPC-методы | нет subpath `@opencode-ai/plugin/rpc` |
| `ctx.storage` | контекст V1 не предоставляет storage; состояние — SQLite пакета |
| Типизированные домены (`ctx.tool.hook`, `ctx.event.subscribe`) | в V1 хуки — строковые ключи в объекте `Hooks` |

## Связанные документы

- План работ: `docs/V1-V2-COMPATIBILITY-PLAN.md`
- Переносимость ОС и путей: `CROSS_PLATFORM.md`
- Миграция пользователей OpenCode V1 → V2: <https://opencode.ai/docs/migrate-v1>
