# План: OpenCode v1 + v2 и переименование в `agent-steward`

Статус: план утверждён по структуре, выполнение — по одной подзадаче.
Версия работ: `opencode-windows-scheduler@1.5.6`.
Переименование: milestone `2.0.0`, пакет `agent-steward` начинается с `0.0.2`
(версия `0.0.1` занята placeholder-резервом).

## Принятые решения

1. **Один пакет, два entrypoint.** Официальный паттерн OpenCode:
   default export = `{ ...Plugin.define({ id, setup }), async server() { return v1Plugin } }`.
   V2 вызывает `setup()`, V1 — `server()`. Минимальная версия V1 — `1.18.29`.
2. **Ядро общее.** SQLite, планировщик, DAG, matrix, quality gates, dashboard,
   история, уведомления не зависят от версии plugin API и переиспользуются.
3. **Границы V1.** В V1 доступны: инструменты, хуки, TUI-плагин
   (`@opencode-ai/plugin/tui`), локальный HTTP-dashboard.
   В V1 **недоступны**: GUI-панель (`@opencode/plugin/gui`) и кастомный RPC
   (`@opencode/plugin/rpc`) — этих subpath в V1-пакете нет.
4. **Идентификаторы сохраняем.** `plugin id`, пути SQLite/логов и префикс задач
   планировщика не меняются при 1.5.6 и при rename — иначе потеряется состояние
   пользователей.
5. **Режим работы.** Одна подзадача → отчёт → предложения по улучшению →
   ожидание команды «дальше».

## Матрица поверхности

| Возможность | V1 (>=1.18.29) | V2 |
|---|---|---|
| 25 инструментов агента | да, через `tool()` | да, `ctx.tool.transform` |
| Хуки (tool/session/event/config) | да, строковые ключи | да, типизированные домены |
| TUI-панель | да, отдельный `tui` entrypoint | да, текущий `tui.tsx` |
| GUI-панель | нет | да |
| RPC-методы | нет | да |
| Dashboard (HTTP) | да, версионно-независим | да |
| DAG / matrix / gates / история | да | да |

---

## Деталь Д0. Инфраструктура имени

### Задача З0.1. Зарезервировать `agent-steward`
- П0.1.1 — создать минимальный placeholder-пакет `agent-steward@0.0.1`
  (README «reserved», LICENSE, repository).
- П0.1.2 — опубликовать `npm publish --access public`.
- П0.1.3 — проверить `npm view agent-steward version` = `0.0.1`.

### Задача З0.2. Удалить `opencode-pipeline`
- П0.2.1 — удалить `packages/opencode-pipeline/`.
- П0.2.2 — снять пакет с npm (`npm unpublish` при возможности, иначе `npm deprecate`).
- П0.2.3 — удалить/поправить ссылки: `test-docs.mjs`, `ROADMAP-STRATEGY.md`,
  активные разделы `ROADMAP.md`, `.github/workflows/publish-placeholder.yml`.
  Исторические записи `CHANGELOG.md` не переписываем.
- П0.2.4 — `npm test` (набор `test-docs`) зелёный.

---

## Деталь Д1. Контракт совместимости

### Задача З1.1. Зафиксировать матрицу версий
- П1.1.1 — V1: минимум `1.18.29`, проверять `1.19.x`.
- П1.1.2 — V2: текущая поддерживаемая (`2.x`) — `2.2.7`. ✅
- П1.1.3 — зафиксировать версии в `package.json` (`peerDependencies` не вводим,
  plugin API не является runtime-зависимостью пакета). ✅
  `dependencies["@opencode/plugin"]` = `^2.2.7`, `devDependencies["@opencode-ai/plugin"]` = `1.19.5`
  (pinned, только типы), `peerDependencies` отсутствуют.

### Задача З1.2. Зафиксировать границы поверхности
- П1.2.1 — таблица «V1 / V2» в `docs/CROSS_PLATFORM.md` или отдельном документе. ✅
- П1.2.2 — явно указать: GUI и RPC — только V2; TUI — обе версии. ✅
- П1.2.3 — README: требование «OpenCode v2» заменить на «V1 >=1.18.29 или V2». ✅

### Задача З1.3. Инварианты состояния
- П1.3.1 — `plugin id` остаётся `opencode-windows-scheduler` до rename. ✅
- П1.3.2 — пути `%APPDATA%/opencode/windows-scheduler`, SQLite и логов не меняются. ✅
- П1.3.3 — префикс задач планировщика не меняется. ✅

---

## Деталь Д2. Извлечение общего ядра

### Задача З2.1. Вынести bootstrap из `setup(ctx)`
- П2.1.1 — `createRuntime(ctxLike)` с инициализацией БД, миграции, recovery, GC,
  retention, таймеров, watcher/git-trigger. ✅
- П2.1.2 — `setup(ctx)` V2 вызывает `createRuntime(ctx)` и регистрацию V2. ✅
- П2.1.3 — `server()` V1 вызывает `createRuntime(v1Context)` и регистрацию V1.
  (ждёт V1-entrypoint из З3.1)

### Задача З2.2. Общий реестр инструментов
- П2.2.1 — вынести 25 `execute`-функций в `createToolHandlers(runtime)`. ✅
- П2.2.2 — V2-обёртка `editor.add` остаётся тонкой. ✅
- П2.2.3 — V1-обёртка `tool()` использует те же handlers.

### Задача З2.3. Общие хуки
- П2.3.1 — проверить и зафиксировать: аудит/permissions/события уже живут в
  общем ядре (`withAudit` в `createToolSpecs`, `core/permissions.ts`, общие
  handlers и триггеры в `createRuntime`). ✅
- П2.3.2 — V2-домены `ctx.tool.hook`, `ctx.permission.hook`,
  `ctx.event.subscribe` **не используются**: для аудита, permissions и событий
  hook-API не нужен. ✅ (не требуется)
- П2.3.3 — V1-хуки `Hooks.tool.execute.*`, `Hooks.event`,
  `Hooks.permission.ask` **не используются**; паритет линий достигается общими
  handlers, а не строковыми ключами. ✅ (не требуется)

### Задача З2.4. Единый shutdown
- П2.4.1 — `createShutdownHandler(runtime, registrations)` — общий сценарий
  выгрузки: `shutdownGate.begin()` → dispose регистраций → `runtime.dispose()`
  → dashboard → `waitForIdle(15_000)` → `closeDb()`. ✅
- П2.4.2 — V2 возвращает cleanup из `setup()`, V1 — из `server()` (ждёт
  V1-entrypoint из З3.1).

---

## Деталь Д3. V1-адаптер

### Задача З3.1. Dual export
- П3.1.1 — `const v2 = Plugin.define({ id, setup })`.
- П3.1.2 — `const v1 = { async server() { ... } }`.
- П3.1.3 — `export default { ...v2, ...v1 }`.
- П3.1.4 — проверить, что V2 игнорирует `server`, а V1 — `setup`.

### Задача З3.2. Инструменты V1
- П3.2.1 — замапить 25 инструментов в `tool({ description, args, execute })`.
- П3.2.2 — привести args-схемы к формату V1.
- П3.2.3 — сохранить `codemode`-семантику, если V1 её поддерживает; иначе
  задокументировать отличие.

### Задача З3.3. Хуки V1
- П3.3.1 — не требуется: аудит — общая обёртка `withAudit`, permissions — env
  фонового запуска (см. П2.3.1).
- П3.3.2 — не требуется: события — `emit_event`, file-watcher и git-trigger в
  `createRuntime`.
- П3.3.3 — не требуется: настройки читаются из `settings.json` пакета, а не из
  `Hooks.config`.

### Задача З3.4. TUI V1
- П3.4.1 — отдельный entrypoint `src/tui-v1.tsx` с `TuiPluginModule`.
- П3.4.2 — использовать `api.slots.register`, `api.route.register`, `api.kv`.
- П3.4.3 — сохранить текущую панель «Планировщик» и действия run/pause/resume/log.
- П3.4.4 — проверить загрузку TUI в V1 >=1.18.29.

### Задача З3.5. Конфигурация
- П3.5.1 — V1 читает `plugin`, V2 — `plugins`; код не должен падать на чужом поле.
- П3.5.2 — обновить README-примеры для обеих версий.

---

## Деталь Д4. Регрессия V2

### Задача З4.1. Entrypoint
- П4.1.1 — V2 по-прежнему загружает `setup` и 25 инструментов.
- П4.1.2 — GUI и RPC не затронуты.

### Задача З4.2. Поведение
- П4.2.1 — DAG, matrix, gates, dashboard, уведомления без изменений.
- П4.2.2 — существующие 61 набор тестов зелёные.

---

## Деталь Д5. Тесты совместимости

### Задача З5.1. Unit-тесты адаптера
- П5.1.1 — форма default export: есть `setup` и `server`.
- П5.1.2 — `server()` возвращает объект с `tool` и хуками.
- П5.1.3 — набор имён инструментов совпадает V1/V2.

### Задача З5.2. Интеграция V1
- П5.2.1 — установить `@opencode-ai/plugin@1.19.x` в тестовый стенд.
- П5.2.2 — загрузить пакет как V1-плагин, вызвать 2–3 инструмента.
- П5.2.3 — проверить TUI entrypoint.

### Задача З5.3. Интеграция V2
- П5.3.1 — текущий V2 smoke-тест.
- П5.3.2 — проверить GUI/RPC.

### Задача З5.4. CI
- П5.4.1 — job `compat-v1` и `compat-v2`.
- П5.4.2 — не блокировать основные 3 ОС, если V1-стенд недоступен; вынести в отдельный job.

---

## Деталь Д6. Релиз 1.5.6

### Задача З6.1. Подготовка
- П6.1.1 — `package.json` version `1.5.6`.
- П6.1.2 — CHANGELOG: dual support, границы V1.
- П6.1.3 — README/CROSS_PLATFORM/FAQ.

### Задача З6.2. Публикация
- П6.2.1 — полный прогон `test:parallel` + en/zh.
- П6.2.2 — тег `v1.5.6`, release workflow.
- П6.2.3 — проверить npm и GitHub Release.

---

## Деталь Д7. Rename 2.0.0 → `agent-steward` 0.0.2

- П7.1 — rename-only релиз без фич.
- П7.2 — сменить `name` пакета, сохранить `plugin id` и пути состояния.
- П7.3 — старый пакет — thin re-export с deprecation на один major.
- П7.4 — миграционная инструкция: `plugin`/`plugins`, npm-имя, тег.
- П7.5 — первый реальный релиз `agent-steward@0.0.2`.

---

## Деталь Д8. За пределами 1.5.6

- П8.1 — Agent Executor Interface (абстракция исполнения).
- П8.2 — вынос OpenCode-адаптера.
- П8.3 — MCP/standard API для других агентов.

---

## Порядок выполнения

1. Д0 (инфраструктура имени).
2. Д1 (контракт).
3. Д2 (ядро).
4. Д3 (V1-адаптер).
5. Д4 (регрессия V2).
6. Д5 (тесты).
7. Д6 (релиз 1.5.6).
8. Д7 (rename, отдельный milestone).

## Статус

| Деталь | Статус |
|---|---|
| Д0 | ✅ 17.11.2026 |
| Д1 | ✅ 17.11.2026 |
| Д2 | в работе (П2.1.1–П2.4.1; П2.1.3, П2.2.3 и П2.4.2 — вместе с Д3) |
| Д3 | не начата |
| Д4 | не начата |
| Д5 | не начата |
| Д6 | не начата |
| Д7 | отложена |
| Д8 | отложена |

## Журнал выполнения

### Д0. Инфраструктура имени — ✅ 17.11.2026

| Подзадача | Результат |
|---|---|
| П0.1.1 | Placeholder `agent-steward@0.0.1` создан во временном каталоге: `package.json`, `README.md`, `LICENSE`. `npm pack --dry-run` — 3 файла, 1.6 kB, без зависимостей и скриптов. |
| П0.1.2 | `npm publish --access public` — успешно. npm создал служебную stub-версию `0.0.0-stage`, версия `0.0.1` ушла на automated review. |
| П0.1.3 | Имя зарезервировано: maintainer `deadsno`, пакет существует в реестре. `0.0.1` станет `latest` после завершения проверки; при отказе следующий релиз — `0.0.2`. |
| П0.2.1 | `packages/opencode-pipeline/` удалена (`git rm -r`), каталог `packages/` исчез. |
| П0.2.2 | `npm unpublish` отклонён: E403 — granular access token с bypass 2FA не может выполнять деструктивные операции. Fallback: `npm deprecate opencode-pipeline@0.0.1` — применён, сообщение видно в `npm view`. Пакет решено оставить депрекейченным, а не удалять. |
| П0.2.3 | `test-docs.mjs`: 4 проверки заглушки заменены на «нет локальных пакетов» + «workflow удалён». Workflow `publish-placeholder.yml` удалён. Обновлены `ROADMAP.md` (28.6, 37.1, решение 2, таблица действий) и `ROADMAP-STRATEGY.md` (переименование в `agent-steward`). `CHANGELOG.md` и исторические строки `ROADMAP.md` не тронуты. |
| П0.2.4 | `node test-docs.mjs` — 42/42. Полный `npm test` (61 сюита) — exit 0, ни одного `FAIL`, все сводки `0 failed`. |

Побочный результат: `opencode-windows-scheduler@1.5.5` прошла automated review и стала `latest`.

### Д1. Контракт совместимости — ✅ 17.11.2026

| Подзадача | Результат |
|---|---|
| П1.1.1 | Создан `docs/COMPATIBILITY.md`: матрица версий (V1 — минимум `1.18.29`, проверочная `1.19.5`), обоснование минимума, контракт V1 (типы `PluginInput`/`Plugin`/`PluginModule`, состав `Hooks`, формат инструментов), таблица «чего в V1 нет». Проверено по реестру: `1.18.29` опубликована; последняя V1 SDK — `1.19.5`; V1 SDK зависит от `zod@4.1.8`, а пакет от `zod@^4.6.7` — мажор совпадает, отдельная копия zod не нужна. `test-docs` расширен на 3 проверки → 45/45. |
| П1.1.2 | V2-строка заполнена: минимум `2.2.7`, проверяем `2.2.7` и `2.3.0`. Проверено по опубликованным типам всех 47 версий линии `2.x`: `Plugin.define` и `ctx.tool.transform` есть с `2.0.0`; набор доменов `ctx.*` с `2.0.0` совпадает с `2.2.7`; subpath `./gui` отсутствует в `2.1.4` и появляется в `2.2.0`; `./tui` и `./rpc` есть с `2.0.0`; между `2.2.7` и `2.3.0` контракт `Plugin.define`/`tool.transform` не менялся. Минимум выставлен по `2.2.7` (пол сборки и зависимости `^2.2.7`), а не по `2.0.0`: ядро там работает, GUI — нет. Добавлена таблица «что появилось когда» + раздел «Почему минимум V2 — 2.2.7». `test-docs` расширен на 2 проверки → 47/47. |
| П1.1.3 | В `package.json` добавлена `devDependencies["@opencode-ai/plugin"] = "1.19.5"` (pinned, только типы адаптера); `dependencies["@opencode/plugin"]` остаётся `^2.2.7`; `peerDependencies` не объявляются. `npm install` — 18 пакетов, `package-lock.json` +324 строки; `npm ls` подтверждает `@opencode-ai/plugin@1.19.5` и `@opencode/plugin@2.2.7`. Импорт `@opencode-ai/plugin` и `@opencode-ai/plugin/tool` работает, `tool` — функция. Две копии zod (`4.1.8` внутри V1 SDK, `4.6.7` в корне), мажор один — схемы переиспользуются. В `docs/COMPATIBILITY.md` добавлен раздел «Где зафиксированы версии»; `test-docs` расширен на 3 проверки (пол V2, пин V1, отсутствие peerDependencies) → 50/50. |
| П1.2.1 | В `docs/COMPATIBILITY.md` добавлен раздел «Матрица поверхности V1 / V2» на 9 строк: инструменты, хуки, TUI, GUI, RPC, dashboard, общее ядро, SQLite, ключ конфига. Выбран отдельный документ, а не `CROSS_PLATFORM.md`: версии и границы поверхности живут в одном источнике истины, `CROSS_PLATFORM.md` остаётся про ОС и пути. |
| П1.2.2 | В матрице GUI и RPC помечены «**нет**» для V1 (subpath `/gui` и `/rpc` в V1-пакете отсутствуют), TUI — «**обе линии**»: V2 регистрирует панель через `setup(ctx)`, V1 — через отдельный `src/tui-v1.tsx` (З3.4). Под таблицей добавлен явный абзац «GUI и RPC — только V2»; пакет не обещает их в V1 и не подменяет TUI заглушкой. |
| П1.2.3 | README (en/ru/zh) обновлены: tagline и раздел Install больше не требуют «OpenCode v2», теперь «V1 ≥ 1.18.29 или V2» + ссылка на `docs/COMPATIBILITY.md` (GUI/RPC — только V2, TUI — обе линии). Переводы `docs/README.ru.md` и `docs/README.zh.md` поправлены в том же коммите. |
| П1.3.1 | `plugin id` остаётся `opencode-windows-scheduler` (`src/index.ts`, `Plugin.define({ id })`). Зафиксировано в разделе «Инварианты состояния»; `test-docs` сверяет значение в коде и документе. |
| П1.3.2 | Пути состояния сведены в таблицу: Windows `%APPDATA%\opencode\windows-scheduler`, macOS/Linux `$XDG_CONFIG_HOME/opencode/windows-scheduler` или `~/.config/opencode/windows-scheduler`; профили — `<base>/profiles/<name>`; SQLite — `<PLUGIN_DIR>/scheduler.db` (`OPENCODE_SCHEDULER_DB` только для тестов); логи/обёртки/locks/prompts/env и `secrets.json`/`secrets.key` — под `<PLUGIN_DIR>`. `test-docs` сверяет `profiles.ts`, `db/index.ts`, `types.ts`. |
| П1.3.3 | Префикс задач не меняется: Windows default — `\OpenCode\windows-scheduler\`, профиль — `\OpenCode\windows-scheduler-<profile>\` (`windows.ts`); crontab-блок — `opencode-scheduler:<folder>` (legacy без суффикса читается); launchd label — `com.opencode.scheduler.<name>`. В таблице инвариантов указано, что rename 2.0.0 меняет только npm-имя. Итог: `test-docs` 50 → 60/60. |

### Д2. Извлечение общего ядра — в работе

| Подзадача | Результат |
|---|---|
| П2.1.1 | В `src/index.ts` добавлен `createRuntime(ctxLike)` с типом `RuntimeContextLike` (только `location.directory`): язык из настроек, `initDb()`, `migrateJsonToDb()`, `recoverInterruptedRuns()`, `checkJsonBackups()`, GC артефактов, retention, таймеры автопродолжения и дайджеста, инициализация `LockManager`, catch-up пропущенных cron-запусков, `FileWatchManager`/`GitTriggerManager` + `refreshTriggers()`. Возвращает `SchedulerRuntime { projectDirectory, dispose() }`; `dispose` гасит оба таймера и останавливает watcher/git-менеджеры, не закрывая БД (это делает entrypoint после `waitForIdle`). |
| П2.1.2 | `setup(ctx)` V2 теперь начинается с `const runtime = await createRuntime(ctx)`, регистрация инструментов/RPC/хуков осталась в `setup`. В общем cleanup вместо ручного `clearInterval` и `fileWatcherManager.stop()` вызывается `runtime.dispose()`. Порядок shutdown не изменён: `shutdownGate.begin()` → dispose регистраций → `closeDashboardServer()` → `waitForIdle()` → `closeDb()`. `test-docs` расширен проверкой «setup стартует через createRuntime» → 61/61. |
| П2.1.3 | Отложено до появления V1-entrypoint (`server()` в З3.1): `createRuntime` уже экспортирован и не зависит от V2-контекста. |
| П2.2.1 | Добавлены экспортируемые `ToolHandlers` и `createToolHandlers(runtime)` — реестр из 26 фактических инструментов (ключ = имя инструмента). Все 26 `execute` в `setup` переведены с прямых имён `*Execute` на `handlers.<name>`; сами обработчики пока остаются модульными, `runtime` зарезервирован под перенос состояния. `test-docs` получил две статические проверки: набор ключей `ToolHandlers` совпадает с именами инструментов, в регистрации не осталось прямых `*Execute` → 63/63. `npm run build`, `test-agent-tools` (23/23), `test-audit` (33/33) — OK. |
| П2.2.2 | Метаданные всех 26 инструментов вынесены в декларативный `createToolSpecs(runtime)`: `ToolSpec { name, input, description, execute, audit? }`. `setup` теперь содержит один цикл `for (const spec of createToolSpecs(runtime))` и общий `editor.add` с `options: { codemode: true }`; аудит навешивается в цикле через `withAudit`, поэтому правила журнала заданы один раз в спецификации. В `setup` осталось два `editor.add` — цикл инструментов и регистрация скилла. `test-docs` расширен проверкой тонкой обёртки → 64/64; `npm run build`, `test-agent-tools` 23/23, `test-audit` 33/33 — OK. |
| П2.3.1 | Проверено по исходникам: hook-домены (`ctx.tool.hook`, `ctx.permission.hook`, `ctx.event.subscribe`) в коде отсутствуют. Аудит уже общий — `withAudit` навешивается в `createToolSpecs`; permissions — `resolvePermissions`/`buildOpencodeConfig` в env фонового запуска (`src/core/permissions.ts`); события — `emit_event`, `FileWatchManager` и `GitTriggerManager` из `createRuntime`. В `docs/COMPATIBILITY.md` строка матрицы уточнена («API есть, но плагин его не использует») и добавлен абзац «Хуки не используются осознанно» с причинами и следствием для Д3. `test-docs` расширен двумя защитными проверками (общий код не ссылается на V2-домены; документ фиксирует отказ) → 66/66. |
| П2.3.2 | Не требуется: V2 hook-домены не используются, отдельный hook-адаптер не нужен. ✅ |
| П2.3.3 | Не требуется: V1-хуки не используются; паритет линий достигается общими handlers и `createRuntime`, а не строковыми ключами. ✅ |
| П2.4.1 | В `src/index.ts` добавлен `createShutdownHandler(runtime, registrations, { waitMs })`: `shutdownGate.begin()` → последовательный `dispose()` регистраций (ошибка одной логируется и не мешает остальным) → `runtime.dispose()` → `closeDashboardServer()` → `waitForIdle(15_000)` → `closeDb()`. `setup` V2 теперь возвращает этот обработчик с `rpcRegistration`, `registration` и (если есть) `skillRegistration`; ручной cleanup удалён, `shutdownGate.begin()` встречается в коде один раз. В `docs/COMPATIBILITY.md` добавлен абзац «Единая выгрузка». `test-docs` расширен двумя проверками (порядок шагов, использование обработчика) → 68/68. |
| П2.4.2 | Отложено до V1-entrypoint (З3.1): V2 уже отдаёт cleanup из `setup()`; V1 вернёт тот же `createShutdownHandler` из `server()`. |


