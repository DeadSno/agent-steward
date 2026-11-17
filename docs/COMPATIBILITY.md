# Совместимость версий OpenCode

Единый контракт по версиям OpenCode, на которые рассчитан пакет. Источник истины
для README, CI и тестов: если числа здесь и в коде расходятся — правим здесь и
синхронизируем остальное.

## Матрица версий

| Линия | Минимум | Проверяем | Статус | Точка входа |
|---|---|---|---|---|
| **V1** (`1.x`) | `1.18.29` | `1.19.5` (ветка `1.19.x`) | поддерживается с `1.5.6` | `plugin` в конфиге, SDK `@opencode-ai/plugin` |
| **V2** (`2.x`) | `2.2.7` | `2.2.7` и `2.3.0` (CI в Д5) | поддерживается с `1.0.0` | `plugins` в конфиге, SDK `@opencode/plugin` |

## Матрица поверхности V1 / V2

| Возможность | V1 (`>=1.18.29`) | V2 (`>=2.2.7`) | Комментарий |
|---|---|---|---|
| 25 инструментов агента | да, `tool()` | да, `ctx.tool.transform` | имена и схемы совпадают |
| Хуки (tool / session / event / config) | да, строковые ключи в `Hooks` | да, типизированные домены `ctx.*` | API есть, но плагин его **не использует** — см. ниже |
| TUI-панель «Планировщик» | да, отдельный entrypoint `@opencode-ai/plugin/tui` | да, `src/tui.tsx` | **обе линии** |
| GUI-панель | **нет** | да | subpath `@opencode/plugin/gui` в V1 отсутствует |
| RPC-методы (`get_platform` и др.) | **нет** | да | subpath `@opencode/plugin/rpc` в V1 отсутствует |
| HTTP-dashboard | да | да | не зависит от plugin API |
| DAG, matrix, gates, история, уведомления | да | да | общее ядро |
| SQLite-состояние | да | да | `<PLUGIN_DIR>/scheduler.db` |
| Ключ конфига | `plugin` | `plugins` | dual-поддержка полей — задача З3.5 |

**Явно:** GUI и RPC — только V2. TUI — обе линии: V2 регистрирует панель
через `setup(ctx)`, V1 — через отдельный `src/tui-v1.tsx` (задача З3.4).
Пакет не обещает GUI/RPC в V1 и не подменяет TUI-панель заглушкой.

**Хуки не используются осознанно.** Плагин не подписывается ни на
`ctx.tool.hook`, `ctx.permission.hook` и `ctx.event.subscribe` в V2, ни на
`Hooks.tool.execute.before/after`, `Hooks.event`, `Hooks.permission.ask` в V1:

- аудит — обёртка `withAudit` вокруг каждого инструмента в `createToolSpecs`,
  поэтому правила журнала одинаковы в обеих линиях и не зависят от hook-API;
- permissions — `resolvePermissions`/`buildOpencodeConfig` из
  `src/core/permissions.ts` в env фонового запуска, а не перехват вызовов;
- события — инструмент `emit_event`, file-watcher и git-trigger, поднятые в
  `createRuntime`.

Следствие для Д3: V1-адаптеру не нужны хуки — достаточно общих handlers и
`createRuntime`. `test-docs` следит, чтобы общий код не начал ссылаться на
V2-only домены без обновления этого раздела.

**Единая выгрузка.** Обе линии используют один `createShutdownHandler(runtime,
registrations)`: `shutdownGate.begin()` → освобождение регистраций →
`runtime.dispose()` → закрытие dashboard → ожидание активных in-process
операций → `closeDb()`. V2 отдаёт этот cleanup из `setup(ctx)`, V1 — из
`server()` (З3.1); порядок и таймаут `15_000` мс общие.

**Двойной экспорт.** В `src/index.ts`:

- `const v2Plugin = Plugin.define({ id, setup })` — entrypoint V2;
- `const v1Plugin: V1PluginModule = { id, server }` — entrypoint V1, `server()`
  вызывает `createV1Hooks()`;
- `export default { ...v2Plugin, ...v1Plugin }` — каждая линия читает свои поля
  (`setup` или `server`) и игнорирует чужие.

`createV1Hooks()` поднимает то же ядро (`createRuntime`), собирает те же
`createToolSpecs`, навешивает тот же `withAudit`, конвертирует `Tool.Result` в
V1 `ToolResult` (`{ output, metadata }`) и возвращает `Hooks` с `tool` и
`dispose`. Дашборд общий — `startSchedulerDashboard()`; GUI, RPC и скиллы в V1
не регистрируются, потому что их API там нет.

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
| Типизированные домены (`ctx.tool.hook`, `ctx.event.subscribe`) | в V1 хуки — строковые ключи в объекте `Hooks`; плагин не использует ни те, ни другие |

## Инварианты состояния

Эти значения не меняются ни при переходе на dual-support в `1.5.6`, ни при
rename в `agent-steward` (`2.0.0`): иначе пользователи теряют историю, задачи,
настройки и уже созданные записи в планировщике ОС. Значения проверяются
`test-docs` по исходникам.

| Что | Значение | Где |
|---|---|---|
| `plugin id` | `opencode-windows-scheduler` | `src/index.ts`, `Plugin.define({ id })` |
| Каталог состояния (default) | Windows: `%APPDATA%\opencode\windows-scheduler`; macOS/Linux: `$XDG_CONFIG_HOME/opencode/windows-scheduler` или `~/.config/opencode/windows-scheduler` | `src/profiles.ts` |
| Каталог нестандартного профиля | `<каталог состояния>/profiles/<profile>` | `src/profiles.ts` |
| SQLite | `<PLUGIN_DIR>/scheduler.db`; `OPENCODE_SCHEDULER_DB` — только для тестов | `src/db/index.ts` |
| Логи, обёртки, locks | `<PLUGIN_DIR>/logs`, `<PLUGIN_DIR>/wrappers`, `<PLUGIN_DIR>/locks` | `src/types.ts` |
| Промпты и env-файлы задач | `<PLUGIN_DIR>/prompts`, `<PLUGIN_DIR>/env` | `src/index.ts` |
| Секреты | `<PLUGIN_DIR>/secrets.json`, `<PLUGIN_DIR>/secrets.key` | `src/core/secrets.ts` |
| Префикс задач Windows | `\OpenCode\windows-scheduler\`; профиль: `\OpenCode\windows-scheduler-<profile>\` | `src/core/scheduler/windows.ts` |
| Блок crontab | `# >>> opencode-scheduler:<folder> >>>` … `# <<< opencode-scheduler:<folder> <<<` (legacy-блок без суффикса читается) | `src/core/scheduler/linux.ts` |
| launchd label | `com.opencode.scheduler.<name>` | `src/core/scheduler/mac.ts` |

Rename `2.0.0` меняет только npm-имя пакета (`agent-steward@0.0.2`): `plugin id`,
пути, имена файлов БД/логов и префиксы задач остаются прежними (П7.2).

## Связанные документы

- План работ: `docs/V1-V2-COMPATIBILITY-PLAN.md`
- Переносимость ОС и путей: `CROSS_PLATFORM.md`
- Миграция пользователей OpenCode V1 → V2: <https://opencode.ai/docs/migrate-v1>
