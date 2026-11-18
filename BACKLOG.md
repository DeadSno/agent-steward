# BACKLOG — подтверждённые ошибки/доработки agent-stewed (ветка dev)

**Источник:** полный аудит среза ветки dev (HEAD 4c7ae055 от 17.11.2026 11:09 UTC).
**Подтверждение:** все 17 findings проверены на живой Windows-машине и по коду HEAD — см. [AUDIT-VERIFICATION.md](./AUDIT-VERIFICATION.md). Опровергнутых нет.
**Метод:** каждый finding проверен по коду/реестру (помечено «подтверждено»), не предположено.
**Схема:** Деталь → Задача → Подзадача. В работу берётся **1 подзадача за раз**; после выполнения — отчёт, затем следующая подзадача.
**Параллельно:** улучшения/фиксы/доработки добавляются в бэклог (P3) или спринт (P0–P2) в зависимости от важности.

**Источник 2:** независимый аудит от qwen (18.11.2026), перепроверен по коду HEAD вручную. Ниже добавлены только подтверждённые пункты; непроверяемые без живой машины/внешних сервисов помечены `⏸️` и вынесены в P3.

---

## Статусы

| Метка | Значение |
|-------|----------|
| `🔴 P0` | Сломано прямо сейчас, у пользователей (критично) |
| `🟠 P1` | Реальные баги планировщика (код проверен, CI не ловит) |
| `🟡 P2` | Средние проблемы и несоответствия |
| `🔵 P3` | Улучшения / фиксы / доработки (по желанию) |
| `☐` | Запланировано (в бэклоге/спринте) |
| `⏳` | В работе (1 подзадача) |
| `✅` | Выполнено (с отчётом) |
| `⏸️` | Блокировано / требует доступа (npm publish, GitHub репо и т.п.) |

---

## 🔴 P0 — критично, сломано прямо сейчас

### Деталь P0-1: Published-шим opencode-windows-scheduler@1.5.7 не устанавливается (ETARGET)

**Подтверждено:** `legacy/package.json:40` — `"agent-steward": "^1.5.6"`; в npm publicado только `agent-steward@0.0.0-stage, 0.0.1, 0.0.2`. Диапазон `^1.5.6` не удовлетворяется ничем → `npm install opencode-windows-scheduler` падает с ETARGET.

| Задача | Подзадача | Описание | Статус |
|--------|-----------|----------|--------|
| P0-1.T1 | P0-1.T1.1 | Заменить `"agent-steward": "^1.5.6"` → `"agent-steward": "^0.0.2"` в `legacy/package.json` | ✅ |
| | P0-1.T1.2 | Добавить запись о `npm deprecate opencode-windows-scheduler@1.5.7` в CHANGELOG/скрипт релиза | ✅ |
| | P0-1.T1.3 | Добавить smoke-job в CI: `npm i opencode-windows-scheduler` в чистую директорию | ✅ |
| P0-1.T2 | P0-1.T2.1 | Опубликовать `agent-steward` версии, продолжающей линейку (2.0.0 или 0.0.3) — требует npm publish доступа | ✅ |
| | P0-1.T2.2 | Либо выпустить шим `1.5.8` с зависимостью `>=0.0.2` | ✅ |
| | P0-1.T2.3 | Задепрекейтить `opencode-windows-scheduler@1.5.7` через `npm deprecate` | ✅ |

---

### Деталь P0-2: Шим ломает TUI/GUI для пользователей старого имени

**Подтверждено:** `legacy/package.json:24-27` — все три subpath (`.`, `./tui`, `./gui-experimental`) ведут на `./index.js`; `files` содержит только `index.js` и `README.md`. OpenCode, загружая `opencode-windows-scheduler/tui`, получит backend-модуль вместо TUI/GUI.

| Задача | Подзадача | Описание | Статус |
|--------|-----------|----------|--------|
| P0-2.T1 | P0-2.T1.1 | Создать `legacy/tui.js`: `export * from "agent-steward/tui"; export { default } from "agent-steward/tui";` | ✅ |
| | P0-2.T1.2 | Создать `legacy/gui-experimental.cjs`: `module.exports = require("agent-steward/gui-experimental")` | ✅ |
| | P0-2.T1.3 | Обновить `exports` в `legacy/package.json` — маппинг `./tui` → `./tui.js`, `./gui-experimental` → `./gui-experimental.cjs` | ✅ |
| | P0-2.T1.4 | Добавить новые файлы в массив `files` в `legacy/package.json` | ✅ |

---

### ✅ Задача P0-3: «RPC is unavailable: opencode-windows-scheduler» в GUI

**Симптом:** панель «Планировщик» вместо данных показывает «Ошибка загрузки задач: RPC is unavailable: opencode-windows-scheduler»; сохранение настроек — та же ошибка. Повторяется каждые 5 секунд.

**Причина:** `Rpc.define({ id })` в `src/rpc.ts` — это и есть ключ реестра RPC. Сервер регистрирует обработчики как `ctx.rpc.register(SchedulerRpc, handlers)` под `SchedulerRpc.id`, а GUI строит URL `/api/rpc/<SchedulerRpc.id>/<method>` из **своего заранее собранного бандла** `gui-experimental.cjs`. При массовом переименовании id в `src/rpc.ts` стал `agent-steward`, а бандл остался с `opencode-windows-scheduler` → `Rpc.call` не находил запись и отдавал 400 `rpc.unavailable`.

**Подтверждение (лог `~/.local/share/opencode/log/opencode.log`):**
`POST /api/rpc/opencode-windows-scheduler/get_tasks → 400` каждые 5 секунд; при этом плагин загружался без ошибок.

**Исправление:**
- `src/rpc.ts`: id канала возвращён в `opencode-windows-scheduler` (совпадает с plugin id; менять нельзя).
- `npm run build:gui`: пересобран `gui-experimental.cjs` (раньше `npm run build` = только `tsc`, GUI-бандл оставался старым).
- `test-docs.mjs`: добавлен инвариант «id RPC-канала = plugin id = id в собранном бандле», чтобы рассинхрон ловился тестом.

| Задача | Подзадача | Описание | Статус |
|--------|-----------|----------|--------|
| P0-3.T1 | P0-3.T1.1 | Вернуть `SchedulerRpc.id = "opencode-windows-scheduler"` | ✅ |
| | P0-3.T1.2 | Пересобрать GUI-бандл (`npm run build:gui`) | ✅ |
| | P0-3.T1.3 | Инвариант в `test-docs.mjs`: src/rpc.ts = src/index.ts = gui-experimental.cjs | ✅ |
| | P0-3.T1.4 | Проверить в живом OpenCode: 200 на `/api/rpc/.../get_tasks` после перезапуска окна | ✅ |

**Подтверждение на живой машине (17.11.2026):** после перезапуска окна панель «Планировщик» показала задачи, ошибка «RPC is unavailable» не появляется. В логе после 13:01Z нет ни одного `POST /api/rpc/... → 400` (последний — 12:52:29Z, до фикса) и нет записи `RPC is unavailable`; OpenCode логирует только неуспешные RPC-ответы, поэтому успешные вызовы в лог не попадают.

---

## 🟠 P1 — реальные баги планировщика

### Деталь P1-3: Windows: `*/N * * * *` срабатывает не в те минуты

**Подтверждено:** `cron-to-schtasks.ts:126-129` — для N, делящих 60, возвращается `/sc MINUTE /mo N` без `/st`; `windows.ts:339-341` — gate не подключается для N|60 (комментарий в коде ложно утверждает, что семантики совпадают). schtasks якорит MINUTE на момент создания задачи.

| Задача | Подзадача | Описание | Статус |
|--------|-----------|----------|--------|
| P1-3.T1 | P1-3.T1.1 | В `cron-to-schtasks.ts` для паттерна 2 добавить `startTime: "00:00"` в `CronConversion` | ✅ |
| | P1-3.T1.2 | Обновить комментарий в коде — убрать ложное предположение о gate для N|60 | ✅ |
| | P1-3.T1.3 | Добавить unit-тесты: `*/15`, `*/30`, `*/60` проверяют наличие `/st 00:00` | ✅ |

---

### Деталь P1-4: POSIX: gate переноса окна убивается watchdog'ом → задача выполняется ВНЕ окна

**Подтверждено:** `bash.ts:233-238` — gate обёрнут в `run_with_timeout "$GATE_TIMEOUT_SECONDS"` (дефолт 300 с); только `exit 3` блокирует запуск. `schedule-gate.ts:46` — `MAX_POSTPONE_MS = 12 ч`, код возврата 124/137/143 ≠ 3 → враппер считает «можно запускать».

| Задача | Подзадача | Описание | Статус |
|--------|-----------|----------|--------|
| P1-4.T1 | P1-4.T1.1 | Вынести `schedule-gate` из `run_with_timeout` или установить `GATE_TIMEOUT_SECONDS` ≥ 12 ч + запас | ✅ |
| | P1-4.T1.2 | Либо трактовать коды 124/137/143 как «skip» (exit 0) в bash-обёртке — не требуется, выбрано решение T1.1 | ✅ |
| | P1-4.T1.3 | Либо реализовать перенос без сна — через defer-файл и повторную проверку на каждом минутном тике — не требуется, выбрано решение T1.1 | ✅ |
| | P1-4.T1.4 | Исправить оставшийся defer-файл (stale-TTL до 25 часов) — не требуется, gate уже удаляет defer после пробуждения | ✅ |

---

### Деталь P1-5: Linux/macOS: задачи с чужой IANA-таймзоной не запускаются никогда

**Подтверждено:** `linux.ts:51` — `needsPollMode(entry.schedule)` без tz; `mac.ts` не учитывает tz вообще. В `types.ts:36` уже есть `timezone?: string` в `CreateTaskOptions`, но POSIX-бэкенды не используют его.

| Задача | Подзадача | Описание | Статус |
|--------|-----------|----------|--------|
| P1-5.T1 | P1-5.T1.1 | Убедиться, что `RegistryEntry` содержит `timezone` (добавлено в `registry.ts`) | ✅ |
| | P1-5.T1.2 | `linux.ts` `cronLine()` — передавать `tz` в `needsPollMode(schedule, tz)` | ✅ |
| | P1-5.T1.3 | `linux.ts` — при `tz ≠` системной включать `* * * * *` + gate (poll) — `needsPollMode` уже возвращает `true` для чужой зоны | ✅ |
| | P1-5.T1.4 | `mac.ts` `buildPlist()` — при чужой IANA-зоне `StartInterval 60` + gate | ✅ |
| | P1-5.T1.5 | `posix.ts` `createTask` — сохранять `options.timezone` в `RegistryEntry` | ✅ |

---

### Деталь P1-6: macOS: расширенный cron вообще не создаётся + `*/N` не выровнен

**Подтверждено:** `mac.ts:118` — `cronToLaunchdSchedule(entry.schedule)` напрямую без `try/catch` с poll-fallback; бросает ошибку для списков, диапазонов, `L`, `#`, `@daily` и др.

| Задача | Подзадача | Описание | Статус |
|--------|-----------|----------|--------|
| P1-6.T1 | P1-6.T1.1 | Оборачивать `cronToLaunchdSchedule` в `try/catch`, при ошибке ставить `StartInterval 60` (gate уже есть через `buildScheduleGate`) | ✅ |
| | P1-6.T1.2 | Для `*/N` — `StartCalendarInterval` с массивом минут `0, N, 2N, …` (выравнивание по cron-сетке; `StartInterval 60` без gate запускал бы каждую минуту) | ✅ |
| | P1-6.T1.3 | Добавить тесты для неконвертируемых cron и `*/N` на macOS (`test-mac-cron.mjs`: `* * * * *`, `*/15`, `*/7`, `@daily`, фиксированные день/месяц, списки, диапазоны, `L`, `5#2`, `*/0`, число полей) | ✅ |

---

### Деталь P1-7: Linux one-shot: id задания `at` ищется не в том потоке

**Подтверждено:** `linux.ts:205` — парсит только `stdout` (`/job\s+(\d+)/i`), GNU `at` печатает `job N` в `stderr`. `test-posix-e2e.mjs` не покрывает `at` (0 упоминаний).

| Задача | Подзадача | Описание | Статус |
|--------|-----------|----------|--------|
| P1-7.T1 | P1-7.T1.1 | Объединить `stdout` + `stderr` перед regex `/job\s+(\d+)/i` в `scheduleAt()` | ✅ |
| | P1-7.T1.2 | Добавить fallback, если `at` не установлен (`at-fallback.ts`: ENOENT → отвязанный `/bin/bash -c "sleep N; <cmd>"`, id `pid:<pid>`; `cancelAt` снимает процесс; предупреждение о том, что fallback не переживает перезагрузку; `test-at-fallback.mjs`) | ✅ |
| | P1-7.T1.3 | Добавить e2e-проверку с реальным `at`. `test-at-e2e.mjs`: createTask(once) → задание в `atq` + listTasks; deleteTask → снятие из atq/listTasks; реальное выполнение команды at → маркер. На Windows без GNU at — честный SKIP. (18.11.2026: реально прогнан в WSL1 `SchedulerAtE2E1` с GNU at 3.2.5 + Node 22 — 6/6 OK. Найден и исправлен баг `linux.ts:atCommand`: `/bin/bash <cmd>` без `-c` давал exit 127 «No such file or directory», at «выполнял» задание, но команда не запускалась; добавлен `-c`.) **CI run 44299436709 (18.11.2026):** тест падал на `windows-latest` (Git Bash `which at` находил Windows `at.exe` → usage/exit 1) и `macos-latest` (atrun выключен, задание висело в `atq`). Добавлено предусловие: тест идёт только на Linux (`process.platform === "linux"`) и требует GNU at (`at -V`); Windows/macOS → SKIP, WSL1 → 6/6 OK. | ✅ |

---

### Деталь P1-8: Windows: дата `/sd` захардкожена под русскую локаль

**Подтверждено:** `one-shot.ts:129` — `DD.MM.YYYY` (комментарий признаёт русскую локаль); `windows.ts:329` — заглушка `/sc ONCE /sd 31.12.2099`. На en-US (M/d/yyyy) «31.12.2099» невалидна.

| Задача | Подзадача | Описание | Статус |
|--------|-----------|----------|--------|
| P1-8.T1 | P1-8.T1.1 | Определять формат даты через PowerShell `((Get-Culture).DateTimeFormat.ShortDatePattern)` | ✅ |
| | P1-8.T1.2 | Либо регистрировать задачи через `Register-ScheduledTask` (culture-invariant) — не требуется, выбрано решение T1.1 | ✅ |
| | P1-8.T1.3 | Заменить заглушку «никогда» `31.12.2099` на ONCE-дату, вычисленную в формате локали | ✅ |
| | P1-8.T1.4 | Добавить тесты для en-US/zh-CN локалей — невыполнимо в песочнице без Node | ✅ (18.11.2026: `test-windows-locales.mjs` — 12 проверок. Реальные ShortDatePattern получены на этой машине через PowerShell Get-Culture: ru-RU `dd.MM.yyyy`, en-US `M/d/yyyy`, zh-CN `yyyy/M/d`. Проверены /sd для one-shot, /sc ONCE + /st, дата «никогда» 2099 во всех трёх локалях и живые Get-Culture. 12/12 OK, добавлен в `npm test`) |

---

### Деталь P1-9: Цепочки / DAG / retry обходят schedule-gate (молчаливый пропуск запусков)

**Подтверждено:** `record-history.ts` — `triggerTask()` (строки 125-137) и `runRetry()` (218-233) вызывают `createSchedulerBackend().runTask()` напрямую, без force-маркера. DAG-зависимые (`handleCompletion` → `selectDependentsToTrigger` → `triggerTask`, строки 546-557) идут тем же путём. В то же время `run_task_now` уже починен: `index.ts` `runTaskEntry()` (6396-6430) вызывает `requestImmediateRun(name)` (6416), затем `scheduler.runTask`, а при ошибке удаляет маркер (6422). `ps-wrapper.ts` пишет `--force-file` (1100-1101), `schedule-gate.ts` принимает свежий маркер (144-147, TTL 2 мин). Итог: если у цели есть gate (poll-режим, чужая IANA-зона, окно запуска), обёртка вызывает `schedule-gate.js` без маркера → cron не совпал → `exit 3` → `exit 0` (тихий пропуск). Кроссплатформенно.

| Задача | Подзадача | Описание | Статус |
|--------|-----------|----------|--------|
| P1-9.T1 | P1-9.T1.1 | Вынести общий helper «запустить сейчас»: создать force-маркер (`requestImmediateRun`) → `scheduler.runTask` → удалить маркер при ошибке | ✅ |
| P1-9.T2 | P1-9.T2.1 | Использовать helper в `triggerTask()` (`nextTaskOnSuccess` / `nextTaskOnError`) | ✅ |
| | P1-9.T2.2 | Использовать helper в `runRetry()` (detached `record-history.js --retry`) | ✅ |
| | P1-9.T2.3 | DAG-зависимые (`selectDependentsToTrigger` / `handleCompletion`) — через тот же helper | ✅ |
| P1-9.T3 | P1-9.T3.1 | Тест: A с `nextTaskOnSuccess: B`, B в poll-режиме; запуск A вне сетки → B реально стартует | ⏳ |

**Сделано (18.11.2026):** добавлен `src/core/scheduler/run-now.ts` — `runTaskNow(name)` создаёт force-маркер, вызывает `backend.runTask` и удаляет маркер при ошибке. `triggerTask()` и `runRetry()` переведены на helper; DAG-зависимые идут через `triggerTask`. Тест `test-run-now.mjs` (6/6) проверяет маркер, очистку при ошибке и отсутствие прямых вызовов бэкенда в `record-history`; добавлен в `npm test` и `npm run test:run-now`. `npm run build`, `test-schedule-v2` 54/54, `test-dag` 12/12 — OK. Полный e2e A→B в poll-режиме требует живой задачи в планировщике — T3.1 оставлен ⏳.

---

### Деталь P1-10: Коллизии `sanitizeName` → две задачи делят wrapper/prompt/lock/log

**Подтверждено:** `src/types.ts:61-75` — lowercase → транслитерация кириллицы → замена `[^a-z0-9_\-]` на `-` → схлопывание дефисов. Поэтому `"my task"` и `"my-task"` дают один `my-task`, `"задача-1"` и `"zadacha-1"` — один `zadacha-1`. `validateTaskName` (`types.ts:110-139`) пропускает оба имени, в БД это разные задачи, но `index.ts` использует sanitized-имя для wrapper/prompt/lock/log/env (5778-5780, 1583-1595, 1602-1654). Вторая задача перезаписывает промпт/обёртку первой, общий lock даёт ложный no-overlap.

| Задача | Подзадача | Описание | Статус |
|--------|-----------|----------|--------|
| P1-10.T1 | P1-10.T1.1 | При создании проверять занятость sanitized-имени (БД + файлы) и отклонять с понятной ошибкой | ✅ |
| | P1-10.T1.2 | Либо добавлять короткий суффикс-хэш от оригинального имени | ✅ (не требуется: выбран вариант отклонения из T1.1) |
| | P1-10.T1.3 | Учесть fallback `sanitizeName` → `task` для имён из одних разделителей (`---`, `...`, `.`) — подтверждено запуском: `"---"` валидно и даёт `task`, коллизия с задачей `task` | ✅ |
| P1-10.T2 | P1-10.T2.1 | Тест на коллизию: `"my task"` / `"my-task"` / `"my--task"` и `"задача-1"` / `"zadacha-1"` | ✅ |
| | P1-10.T2.2 | Тест на fallback: `"---"`, `"..."`, `"."` не должны молча становиться `task` | ✅ |

**Сделано (18.11.2026):** добавлен `src/core/task-name.ts` — `findSanitizedNameConflict()` проверяет sanitized-имя по списку существующих задач и по оставшимся wrapper/prompt-файлам; `sanitizedConflictMessage()` даёт понятную ошибку с обоими именами. Проверка вызывается в `schedulerCreateTask()` только при создании (`!definitionExisted`), обновление задачи не блокируется. Тест `test-task-name-collision.mjs` покрывает `my task`/`my-task`, `my--task`, `My Task!`, `задача-1`/`zadacha-1`, регистр, независимые имена и осиротевший wrapper; добавлен в `npm test` и `npm run test:task-name-collision`.

**Проверено запуском (18.11.2026):** `sanitizeName("my task")` = `sanitizeName("my-task")` = `"my-task"`; `"задача-1"` = `"zadacha-1"` = `"zadacha-1"`; `"my--task"` → `"my-task"`; `"---"` → `"task"`, при этом `validateTaskName("---")` возвращает `null` (имя валидно).

---

### Деталь P1-11: POSIX: таймаут записывается как `error`, а не `timeout`

**Подтверждено:** `src/core/wrappers/bash.ts:464-465` — статус выставляется только по `EXIT_CODE -eq 0`, иначе `STATUS="error"`; watchdog (405-418) убивает дерево, но не оставляет маркера и не возвращает 124. При этом `record-history.ts:417-418` уже умеет маппить `status === "timeout"`, а Windows-обёртка `ps-wrapper.ts` (770-772, маркер 305-335/369-377) статус `timeout` ставит корректно. Следствие: на Linux/macOS таймаут неотличим от падения — врут `get_history?status=timeout`, аналитика, self-analysis и статистика надёжности.

| Задача | Подзадача | Описание | Статус |
|--------|-----------|----------|--------|
| P1-11.T1 | P1-11.T1.1 | В bash-watchdog писать маркер `.timeout` (или завершаться кодом 124) | ✅ |
| | P1-11.T1.2 | В bash-обёртке по маркеру ставить `STATUS="timeout"` | ✅ |
| P1-11.T2 | P1-11.T2.1 | `test-posix-e2e.mjs`: задача `timeoutSeconds=5`, prompt со `sleep 30` → в истории именно `timeout` | ✅ |

**Реализовано (18.11.2026):** в обёртку добавлен `TIMEOUT_MARKER=<lock>.timeout`; перед запуском маркер удаляется, watchdog пишет его перед `kill`, после `wait` обёртка выставляет `EXIT_CODE=124`, `ERROR_MESSAGE="Таймаут..."`, `STATUS="timeout"` и чистит маркер. В `test-posix-e2e.mjs` секция 2 теперь ждёт `status === "timeout"` и проверяет запись в логе. Проверено реальным запуском через Git Bash: скрипт завершился кодом 124, в логе «прервана по таймауту», фейковый рекордер получил аргумент `timeout` (10/10 проверок). `npm run build` — OK.

---

### Деталь P1-12: Linux one-shot: `pause_task` сбрасывает флаг паузы в реестре

**Подтверждено:** `posix.ts:65-70` — `pauseTask()` берёт `entry` (там `paused === false`), вызывает `registry.setPaused(name, true)`, а затем передаёт в `applyPause(entry, true)` **старый** объект. `linux.ts:296-307` в ветке `once` после `cancelAt`/`scheduleAt` делает `await this.registry.upsert(entry)` — с `paused: false`. At-задание снимается (пауза операционно работает), но `scheduler-linux.json` снова говорит `paused:false`, `listTasks()` отдаёт Ready. Дополнительно: `resume` one-shot с `runAt` в прошлом ничего не делает и не предупреждает.

| Задача | Подзадача | Описание | Статус |
|--------|-----------|----------|--------|
| P1-12.T1 | P1-12.T1.1 | В `applyPause()` выставить `entry.paused = paused;` перед `registry.upsert(entry)` | ✅ |
| | P1-12.T1.2 | `resume` one-shot с `runAt` в прошлом — возвращать предупреждение, а не молчать | ✅ |
| P1-12.T2 | P1-12.T2.1 | Тест: `pause_task` one-shot → в `scheduler-linux.json` `paused:true`; `listTasks` не Ready | ✅ |

**Реализовано (18.11.2026):** в `linux.ts` `applyPause()` первой строкой ставит `entry.paused = paused;` — реестр получает актуальное состояние и после `upsert`. В ветке `resume` для one-shot с прошедшим/отсутствующим `runAt` теперь пишется `console.warn`: «Задача "X" не будет перезапущена: время one-shot запуска уже прошло (...). Создайте новую задачу.» Добавлен `test-pause-one-shot.mjs` (временный профиль, без реального `at`/crontab): проверяет `paused:true` в реестре, `Disabled` в `listTasks`, предупреждение и снятие паузы при прошедшем `runAt` — 4/4 OK. Тест добавлен в `npm test` и `test:pause-one-shot`.

---

### Деталь P1-13: `legacy/gui-experimental.cjs` не лежит в git → публикация невоспроизводима

**Подтверждено:** `.gitignore:6` — голая строка `gui-experimental.cjs` (совпадает в любой директории). `git ls-files legacy` возвращает только `README.md`, `index.js`, `package.json`, `tui.js`; `legacy/gui-experimental.cjs` (315 байт) существует только локально. При этом `legacy/package.json:27` объявляет `exports["./gui-experimental"]`, а `files` (строка 32) включает файл. Публикация из чистого клона соберёт пакет без файла → `require("opencode-windows-scheduler/gui-experimental")` → `ERR_MODULE_NOT_FOUND`.

| Задача | Подзадача | Описание | Статус |
|--------|-----------|----------|--------|
| P1-13.T1 | P1-13.T1.1 | `git add -f legacy/gui-experimental.cjs` (или генерировать в `prepublishOnly`) | ✅ |
| P1-13.T2 | P1-13.T2.1 | Тест: `npm pack --dry-run` обоих пакетов — каждый путь из `exports` существует в тарболе | ✅ |

**Реализовано (18.11.2026):** `legacy/gui-experimental.cjs` добавлен в git принудительно (`git add -f`), теперь `git ls-files` его видит. Добавлен `test-package-exports.mjs`: рекурсивно собирает все строковые цели `package.json#exports`, запускает `npm pack --dry-run --json --ignore-scripts` для legacy и корневого пакета и проверяет, что каждая цель есть в списке `files` тарбола. Дополнительно проверяется, что legacy-шим отслеживается git. 12/12 OK. Для корневого `gui-experimental.cjs` допускается SKIP, если бандл ещё не собран — его генерирует `prepublishOnly -> build:gui`.

**Проверено запуском (18.11.2026):** `git check-ignore -v legacy/gui-experimental.cjs` → `.gitignore:6:gui-experimental.cjs`; `git ls-files legacy` → только `README.md`, `index.js`, `package.json`, `tui.js`.

---

### Деталь P1-14: at-fallback `pid:N` переживает reboot и может убить чужой процесс

**Подтверждено:** `at-fallback.ts` — `PID_JOB_PREFIX = "pid:"`, `scheduleAtFallback()` запускает detached `/bin/bash -c "sleep N; <cmd>"` и возвращает `pid:<pid>`; `cancelAtFallback()` (103-113) делает только `process.kill(pid, "SIGTERM")`, без проверки идентичности. Реестр (`scheduler-linux.json`) персистентный, fallback-процесс — нет. После перезагрузки `pid:N` остаётся, `delete_task`/`pause_task` → `cancelAt` (`linux.ts:262-276`) → `cancelAtFallback` может убить произвольный процесс, занявший N. Если `sleep` уже прошёл, SIGTERM в bash не останавливает дочерний opencode — «отмена» не отменяет.

| Задача | Подзадача | Описание | Статус |
|--------|-----------|----------|--------|
| P1-14.T1 | P1-14.T1.1 | При старте плагина чистить `pid:`-записи (они не переживают reboot) | ✅ |
| | P1-14.T1.2 | Перед kill проверять идентичность: `/proc/<pid>/cmdline` содержит маркер задачи или совпадает start-time | ✅ |
| | P1-14.T1.3 | Для отмены использовать process-group kill, а не kill одного pid | ✅ |

**Реализовано (18.11.2026):**
- В `at-fallback.ts` в конец fallback-скрипта добавляется shell-комментарий-маркер `# opencode-scheduler-at-fallback:<base64url имени>`; `isFallbackProcessAlive()` читает `/proc/<pid>/cmdline` и проверяет маркер.
- `cancelAtFallback(jobId, taskName)` без имени задачи или без совпадения маркера ничего не убивает; при совпадении сначала делает `kill(-pid, SIGTERM)` (группа процессов), затем откатывается на `kill(pid, SIGTERM)`.
- `pruneStaleFallbackEntries()` на старте проходит по реестру: живые `pid:`-записи оставляет, мёртвые удаляет; будущие неприостановленные one-shot пересоздаёт через fallback, для прошедших `runAt` пишет предупреждение и считает пропущенными. Если `/proc` недоступен, очистка пропускается (нельзя проверить идентичность).
- `LinuxScheduler.pruneStaleFallbacks()` вызывается в `index.ts` после `recoverInterruptedRuns()` и логирует итог.
- `cancelAt()` в `linux.ts` передаёт имя задачи.
- `test-at-fallback.mjs` расширен до **33/33 OK**: маркер в скрипте, отказ при несовпадении, group kill и fallback на одиночный pid, сохранение живых, пересоздание будущих, предупреждение о прошедших, `skipped` без `/proc`.

---

## 🟡 P2 — средние проблемы и несоответствия

### Деталь P2-9: package-lock.json не перегенерирован после переименования

**Подтверждено:** корень лока — `opencode-windows-scheduler@1.5.6` против `agent-steward@0.0.2` в `package.json`; зависимости при этом совпадают.

| Задача | Подзадача | Описание | Статус |
|--------|-----------|----------|--------|
| P2-9.T1 | P2-9.T1.1 | Регенерировать `package-lock.json` (`npm install`) — выполнено, лок перегенерирован (пришёлся `npm install` прошёл успешно) | ✅ |
| | P2-9.T1.2 | Закоммитить обновлённый лок | ✅ (LOC уже в git: коммиты `bae7d0b` → `bed6c67` → `ca0fafd`; текущая шапка `agent-steward@0.0.4`. Former ⏸️ «репо не инициализирован» была устаревшей — репо инициализировано и лок закоммичен) |

---

### Деталь P2-10: exports без условия types; плавающие >= у OpenTUI; корневой index.js — мёртвый код

**Подтверждено:** `package.json:40-43` — `exports` без `"types"`; `package.json:143-144` — `"@opentui/core": ">=0.8.1"`, `"@opentui/solid": ">=0.8.1"`; `index.js:1` — `export { default } from './dist/index.js'` (теряет named-экспорты).

| Задача | Подзадача | Описание | Статус |
|--------|-----------|----------|--------|
| P2-10.T1 | P2-10.T1.1 | Добавить `"types": "./dist/index.d.ts"` в условие `exports["."]` | ✅ |
| | P2-10.T1.2 | Добавить `"./package.json": "./package.json"` в `exports` | ✅ |
| P2-10.T2 | P2-10.T2.1 | Заменить `">=0.8.1"` на `"0.8.4"` или `"~0.8.4"` для `@opentui/core` и `@opentui/solid` | ✅ |
| P2-10.T3 | P2-10.T3.1 | Привести корневой `index.js` к `export * + default` (как в legacy) или удалить | ✅ |

---

### Деталь P2-11: PowerShell-инъекция через поля `model` / `workspaceName`

**Подтверждено:** `ps-wrapper.ts:961-969` — `safeModel = model.replace(/[\r\n"]+/g, "")` убирает только кавычки/переносы, `$`, backtick, `()` остаются; `-Model "${safeModel}"` в двойных кавычках → subexpression раскрывается.

| Задача | Подзадача | Описание | Статус |
|--------|-----------|----------|--------|
| P2-11.T1 | P2-11.T1.1 | Валидировать `model` по `^[A-Za-z0-9._:/-]+$` (provider/model id) | ✅ |
| | P2-11.T1.2 | Для строк в `psArgs` использовать одинарные кавычки с удвоением `'` либо `-EncodedCommand`/файл аргументов | ✅ |
| | P2-11.T1.3 | Применить ту же валидацию к `workspaceName` | ✅ (base64 — символы не ограничиваем, чтобы не ломать кириллицу/пробелы) |

---

### Деталь P2-12: мелкие баги кода

| Задача | Подзадача | Описание | Статус |
|--------|-----------|----------|--------|
| P2-12.T1 | P2-12.T1.1 | `posix.ts runTask()` — добавить слушатель `error` на `spawn` (ENOENT при удалённой рабочей директории) | ✅ |
| P2-12.T2 | P2-12.T2.1 | `mac.ts` one-shot — добавить guard `now >= runAt` во враппер (StartCalendarInterval без года срабатывает в ближайшую годовщину) | ✅ |
| P2-12.T3 | P2-12.T3.1 | `windows.ts setTaskField()` — добавить китайский маппинг заголовков CSV schtasks (zh-Windows) | ✅ + нормализация пробелов в EN-ключах («Next Run Time» раньше не маппился вообще; `test-schtasks-locales.mjs` 38 заголовков, в цепочке npm test) |
| P2-12.T4 | P2-12.T4.1 | `types.ts validateTaskName` — исправить комментарий арифметики (префикс 28 → 209, не 30 → 207) | ✅ (также исправлен комментарий в test-task-name-limit.mjs: 29→208 → 28→209; префикс подтверждён запуском: WINDOWS_TASK_PREFIX = `\OpenCode\windows-scheduler\`, 28 символов) |
| P2-12.T5 | P2-12.T5.1 | `cron-to-schtasks.ts previousRunTime()` — мёртвый код (не используется, catch-up не реализован): удалить или доделать catch-up | ✅ удалён (использований в src/ и тестах нет; восстановим из git при реализации catch-up) |
| P2-12.T6 | P2-12.T6.1 | `vite.config.ts` — исправить комментарий (бандл пишется в корень `./gui-experimental.cjs`, не в `dist/`) | ✅ |

---

### Деталь P2-13: Инструмент `self_analysis` «потерян» в документации и тестах

**Подтверждено:** в коде 26 инструментов (`createToolHandlers`, `test-self-analysis.mjs` существует), но не в цепочке `npm test` (63 сюиты); README говорит «25 agent tools»; `test-docs.mjs` хардкодит «22 инструмента».

| Задача | Подзадача | Описание | Статус |
|--------|-----------|----------|--------|
| P2-13.T1 | P2-13.T1.1 | Добавить строку `self_analysis` в `README.md`, `README.ru.md`, `README.zh.md`, `docs/FEATURES.md` | ✅ |
| | P2-13.T1.2 | Исправить счетчики инструментов (25 → 26) во всех README | ✅ |
| P2-13.T2 | P2-13.T2.1 | Добавить `node test-self-analysis.mjs` в цепочку `npm test` | ✅ |
| | P2-13.T2.2 | Обновить `test-docs.mjs` — брать количество инструментов из реестра кода, а не хардкодить | ✅ |
| | P2-13.T2.3 | Обновить числовые заявления (67 сюит вместо 58/56) | ✅ |

**Результат (17.11.2026):** `self_analysis` описан во всех README (`days?`, `topLimit?`, `includeAnomalies?`) и в `docs/FEATURES.md` / `FEATURES.zh.md` («Twenty-six tools» / «二十六个工具»). Счётчики: 26 инструментов в `README.md`, `docs/README.ru.md` (был уже 26), `docs/README.zh.md`; 67 сюит во всех трёх README. `test-self-analysis.mjs` (48 проверок) добавлен в `npm test`. `test-docs.mjs` теперь берёт список инструментов из `src/index.ts` (`name: "<tool>"`) и падает, если инструмент реестра не описан в FEATURES или если счётчик в README разошёлся с реестром. Прогон: `test-docs` 88/88, `test-self-analysis` 48/48.

---

### Деталь P2-14: GitHub-метаданные репозитория

**Подтверждено:** `package.json:7` — `homepage` на npm (старый broken-шим); description про «OpenCode v2 plugin» — проект dual V1/V2.

| Задача | Подзадача | Описание | Статус |
|--------|-----------|----------|--------|
| P2-14.T1 | P2-14.T1.1 | Изменить `homepage` с npm на `agent-steward` GitHub | ✅ |
| | P2-14.T1.2 | Синхронизировать `description` с README (dual V1/V2) | ✅ |

**Результат (17.11.2026):** `homepage` уже указывал на `https://github.com/DeadSno/agent-steward#readme` (совпадает с `repository` и `bugs`). `description` переписана под обе линии: «OpenCode plugin for V1 and V2: …» вместо «OpenCode v2 plugin …».

---

### Деталь P2-15: `lock.ts`: release не проверяет владельца → взаимное вытеснение

**Подтверждено:** `lock.ts:113-120` — `release()` безусловно удаляет lock-файл. `withLockWait()` (170-219) после `staleMs` (60 с) может вытеснить lock через rename и взять свой. Если первая операция длилась дольше `staleMs`, её поздний `release()` в `finally` удалит **чужой** lock → третий процесс войдёт в критическую секцию.

| Задача | Подзадача | Описание | Статус |
|--------|-----------|----------|--------|
| P2-15.T1 | P2-15.T1.1 | Писать уникальный токен владельца при `acquire` | ✅ |
| | P2-15.T1.2 | Удалять только свой lock (compare-and-delete / rename-based release) | ✅ |
| P2-15.T2 | P2-15.T2.1 | Тест: stale-eviction + поздний release не удаляет lock нового владельца | ✅ |

**Реализовано (18.11.2026):** `acquire()` возвращает уникальный токен `${process.pid}-${Date.now()}-${randomUUID()}` и пишет его в lock-файл. `release(name, token)` читает текущее содержимое и удаляет файл только при совпадении токена; при чужом/отсутствующем токене возвращает `false` и ничего не трогает. `withLock` и `withLockWait` сохраняют токен и передают его в `release`. `test-stale-lock.mjs` расширен до 15/15: свой release удаляет, чужой — нет, вытесненный владелец не может удалить lock нового, `withLock`/`withLockWait` освобождают корректно.

---

### Деталь P2-16: `TaskRegistry`: глотает ошибки чтения и не сериализует запись

**Подтверждено:** `scheduler/registry.ts:49-61` — `load()` ловит **любую** ошибку и возвращает `[]`. Повреждённый `scheduler-linux.json` + следующий `rebuildCrontab()` = тихое удаление всех cron-строк плагина. `upsert`/`remove`/`setPaused` (75-100) — RMW без кросс-процессного лока (`crontab-lock` покрывает только crontab); `save()` (63-68) пишет temp+rename. Два процесса на одном профиле (OpenCode + CLI) могут потерять запись.

| Задача | Подзадача | Описание | Статус |
|--------|-----------|----------|--------|
| P2-16.T1 | P2-16.T1.1 | В `load()` отличать `ENOENT` от parse-error | ✅ |
| | P2-16.T1.2 | Карантин `.corrupt-<stamp>` (как уже сделано в `secrets.ts`) | ✅ |
| | P2-16.T1.3 | Не делать `rebuildCrontab()` из пустого реестра при ошибке чтения | ✅ |
| P2-16.T2 | P2-16.T2.1 | Кросс-процессный лок на `upsert`/`load`/`save` (не только crontab) | ✅ |

**Реализовано (18.11.2026):** `TaskRegistry.load()` теперь возвращает `[]` только для `ENOENT`; при битом JSON/неверной структуре файл переименовывается в `scheduler-*.json.corrupt-<stamp>`, рядом пишется маркер `scheduler-*.json.blocked`, а затем бросается понятная ошибка. Пока маркер жив, `load()` не возвращает пустой реестр даже после исчезновения файла — `rebuildCrontab()` в `linux.ts` не перезапишет crontab пустым блоком; `save()` снимает маркер после успешной записи. `upsert`/`remove`/`setPaused` идут через `mutate()` с `withLockWait(..., "registry-<backendId>")`, поэтому параллельные процессы не теряют записи.

**Проверено запуском (18.11.2026):** `npm run build` OK; `node test-registry-resilience.mjs` — ENOENT→`[]`, битый JSON→карантин+маркер+ошибка, снятие маркера через `save()`, 40 параллельных `upsert`→40 записей (9/9 проверок); `node test-schedule-v2.mjs` 54/54; `node test-mac-cron.mjs` OK.

---

### Деталь P2-17: `PosixSchedulerBase.createTask`: запись-призрак при ошибке `installEntry`

**Подтверждено:** `posix.ts:35-55` — `await this.registry.upsert(entry)` выполняется **до** `await this.installEntry(entry)`. Если `installEntry` бросил (нет `at`, fallback не удался), запись остаётся в реестре, `listTasks()` показывает задачу без определения.

| Задача | Подзадача | Описание | Статус |
|--------|-----------|----------|--------|
| P2-17.T1 | P2-17.T1.1 | Откатывать `registry.upsert` (или писать после успешного `installEntry`) | ✅ |
| P2-17.T2 | P2-17.T2.1 | Тест: `installEntry` throws → `listTasks()` не содержит задачу | ✅ |

**Реализовано (18.11.2026):** запись по-прежнему пишется до `installEntry` (Linux пересобирает crontab из реестра, поэтому иначе cron-строка не увидит новую задачу), но при ошибке установки выполняется откат: сохраняется `previous = registry.find(name)`; при сбое восстанавливается прежняя запись либо удаляется новая, затем best-effort вызывается `uninstallEntry` для частично созданной записи. Исходная ошибка не маскируется ошибкой отката.

**Проверено запуском (18.11.2026):** `test-posix-create-rollback.mjs` — 8/8 OK: новая задача при сбое `installEntry` не появляется в `listTasks()`; откат вызывает `uninstallEntry`; при обновлении существующей задачи восстанавливается прежняя команда; успешная установка сохраняет `atJobId` после `installEntry`. `npm run build` — OK. Тест добавлен в `npm test` и `test:posix-create-rollback`.

---

### Деталь P2-18: `LockManager`: staleness только по mtime (24 ч), без liveness

**Подтверждено:** `lock.ts:39-86`, `types.ts:54` — `STALE_LOCK_MAX_AGE_MS = 24 ч`. При `timeoutSeconds: 0` (без таймаута) задача может легально работать дольше 24 ч; рестарт плагина вытеснит «зависший» lock живого запуска → дубль. Bash-обёртка защищена pid-проверкой, Node-локи — нет.

| Задача | Подзадача | Описание | Статус |
|--------|-----------|----------|--------|
| P2-18.T1 | P2-18.T1.1 | Добавить pid/liveness-проверку и для Node-локов | ✅ |
| | P2-18.T2.1 | Тест: lock с живым pid старше 24 ч не вытесняется | ✅ |

**Реализовано (18.11.2026):** в `src/core/lock.ts` добавлены `isProcessAlive(pid)` (`process.kill(pid, 0)`; `ESRCH` → мёртв, `EPERM` и прочие ошибки → жив) и разбор pid из токена владельца `<pid>-<timestamp>-<uuid>`. `initialize()` перед вытеснением по возрасту читает lock-файл: если pid жив, лок остаётся (в лог пишется «старше N с, но процесс M жив — оставляем»). `withLockWait()` в stale-ветке также не вытесняет лок живого владельца, а ждёт до таймаута; мёртвые/нечитаемые локи вытесняются прежним атомарным rename. `.lock.d` по-прежнему чистится по возрасту.

**Проверено запуском (18.11.2026):** `node test-stale-lock.mjs` — **21/21 OK**, в том числе: старый (mtime > 24 ч) lock с pid текущего процесса не вытесняется; старый lock с мёртвым pid вытесняется; `withLockWait` с живым старым владельцем упирается в таймаут и не снимает lock; с мёртвым — вытесняет и выполняет fn. Также `test-mac-cron.mjs` — OK, `test-pause-one-shot.mjs` — 4/4 OK. `npm run build` — OK.

---

### Деталь P2-19: Watchdog оставляет сиротские `sleep`

**Подтверждено:** `bash.ts` — `run_with_timeout` (198-217) и основной watchdog (405-418): после успеха ребёнка `kill $WATCHDOG` убивает подоболочку, но её `sleep` может дожить до `TIMEOUT_SECONDS` (по умолчанию до часа). На минутных задачах накапливаются десятки сирот.

| Задача | Подзадача | Описание | Статус |
|--------|-----------|----------|--------|
| P2-19.T1 | P2-19.T1.1 | `trap` внутри watchdog, убивающий свой `sleep` | ✅ |
| | P2-19.T1.2 | Либо запуск watchdog в отдельной process group с групповым kill | ✅ (не требуется: выбран trap) |

**Реализовано (18.11.2026):** в обоих watchdog (`run_with_timeout` и основной запуск `opencode`) `sleep` запускается в фоне с сохранением `WD_SLEEP_PID`; на `TERM`/`INT` срабатывает `trap`, который убивает именно свой `sleep` и выходит. После `wait "$CHILD"` вызов `kill "$WATCHDOG"` теперь завершает подоболочку вместе с её `sleep`, а не оставляет его до истечения таймаута. Второй `sleep 5` (пауза перед `KILL`) также отслеживается через `WD_SLEEP_PID`.

**Проверено запуском (18.11.2026):** реальная bash-обёртка (`timeoutSeconds=987`, мгновенный фейковый `opencode`) — `ps -ef | grep '[s]leep 987'` даёт 0 процессов сразу после завершения и через 2 с; обёртка завершилась с кодом 0. `test-crash-recovery.mjs` дополнен статическими проверками наличия `WD_SLEEP_PID`/`trap` в обоих watchdog — 25/25 OK. `test-execution-hardening.mjs` — 23/23 OK (таймаут по-прежнему 124, статус `timeout`, убийство быстрое). `npm run build` — OK.

---

### Деталь P2-20: `secrets.ts`: лишний `rm` перед `rename` + RMW без лока

**Подтверждено:** `secrets.ts:252-269` — `writeFileSafe` делает `fs.rmSync(SECRETS_FILE, { force: true })` перед `fs.renameSync(tmp, SECRETS_FILE)`. На Windows и POSIX `rename` и так заменяет существующий файл; `rm` создаёт окно потери при краше. `setSecret` (299-317) — RMW без кросс-процессного лока. Криптография (AES-256-GCM, 12-байтный IV, AAD=имя, 0600/icacls, карантин) в порядке.

| Задача | Подзадача | Описание | Статус |
|--------|-----------|----------|--------|
| P2-20.T1 | P2-20.T1.1 | Убрать `rmSync(SECRETS_FILE)` перед `rename` | ✅ |
| | P2-20.T1.2 | Кросс-процессный лок на `setSecret` (RMW) | ✅ |
| | P2-20.T2.1 | Тест: параллельные setSecret не теряют записи | ✅ |

**Реализовано (18.11.2026):** `writeFileSafe` больше не делает `rmSync(SECRETS_FILE)` перед `rename`; temp-файл уникален (`secrets.json.<pid>.<timestamp>.tmp`). Добавлен синхронный межпроцессный лок `secrets.json.lock` (`openSync(..., "wx")`, 25 мс между попытками, таймаут 5 с, stale 10 с с проверкой `isProcessAlive`); `setSecret` и `deleteSecret` выполняют RMW внутри лока, лок реентерабелен для `loadKey`/`readFileSafe`. Создание `secrets.key` тоже под локом: два процесса больше не могут сгенерировать разные ключи.

**Проверено запуском (18.11.2026):** `node test-secrets.mjs` — 50/50. Новые проверки: в исходнике нет `fs.rmSync(SECRETS_FILE`; 6 параллельных процессов `setSecret` — все 6 записей сохранены и расшифровываются; после записи `.lock`-файла нет. `npm run build` — OK.

---

### Деталь P2-21: Потерянный секрет остаётся литералом `${secret:NAME}` в env

**Подтверждено:** `workspaces.ts:142-158` — `resolveWorkspaceEnv` предупреждает `[workspace] "...": не найдены секреты: ...`, но возвращает env, где ссылки остались литералами (`secrets.ts:379-393` оставляет ref и копит `missing`; `resolveSecretRefs` 402-414). `writeWorkspaceEnvFile` (199+) записывает это в env-файл. Агент запускается с литералом `${secret:NAME}` — без явного падения и без громкого уведомления.

| Задача | Подзадача | Описание | Статус |
|--------|-----------|----------|--------|
| P2-21.T1 | P2-21.T1.1 | При `missing` фейлить запуск или слать громкое уведомление, а не подставлять литерал | ✅ |
| | P2-21.T2.1 | Тест: потерян `secrets.key` → env не содержит `${secret:...}`, запуск отклонён | ✅ |

**Реализовано (18.11.2026):** `workspaces.ts` получил `resolveWorkspaceEnvDetailed()` и `MissingWorkspaceSecretsError`; `writeWorkspaceEnvFile` при `missing` удаляет старый env-файл и бросает ошибку, поэтому задача не создаётся с литералом. `refreshWorkspaceEnvFiles()` логирует сбой и не считает файл обновлённым. Обе обёртки получили fail-closed проверку: bash — `case ... *'${secret:'*)` → `exit 78`, PowerShell — `-match '\$\{secret:[^}]+\}'` → `throw` (внутренний catch больше не глотает ошибку). Дополнительно исправлено экранирование `${secret:...}` в логе bash-обёртки: без `\$` при `set -u` был `secret: unbound variable` вместо понятного сообщения.

**Проверено запуском (18.11.2026):** `test-env.mjs` 59/59 — `resolveWorkspaceEnvDetailed` возвращает `missing`, `writeWorkspaceEnvFile` бросает `MissingWorkspaceSecretsError`, env-файл не создан, обе обёртки содержат проверку. Реальный прогон сгенерированной bash-обёртки под Git Bash с `TOKEN=${secret:missing_p221}` → код **78**, в логе «переменная TOKEN содержит неразрешённый секрет … Запуск отменён». `test-secrets.mjs` 50/50, `test-execution-hardening.mjs` 23/23, `npm run build` — OK.

---

### ✅ Задача P2-22: Замороженные константы путей vs смена профиля на лету — не баг

**Проверено:** `types.ts:40-48` действительно вычисляет `PLUGIN_DIR`/`LOCK_DIR`/`LOG_DIR`/`WRAPPER_DIR` при импорте, но `manage_profiles switch` (`index.ts:2938-2950`) возвращает `restartRequired: true`, а `profiles.ts:328-340` прямо документирует: «Изменение подхватится при следующем запуске OpenCode (директории вычисляются при загрузке модуля)». До рестарта задачи идут в старый профиль осознанно — это не скрытый баг. Остаётся UX-улучшение: убедиться, что GUI явно показывает требование рестарта.

| Задача | Подзадача | Описание | Статус |
|--------|-----------|----------|--------|
| P2-22.T1 | P2-22.T1.1 | Проверено: switch → schedule без рестарта использует старый профиль по дизайну | ✅ |
| | P2-22.T1.2 | UX: GUI/тост явно показывает `restartRequired` после switch (проверить) | ☐ |

---

### Деталь P2-23: `expandField`: `5/15` молча теряет шаг

**Подтверждено:** `schedule-v2.ts:138-195` — regex `^(.*)\/([0-9]+)$` разбирает `5/15` как item `5` + step `15`; так как item не `*` и не диапазон, добавляется только число 5, шаг игнорируется. Пользователь ждёт «с 5-й каждые 15» (Vixie: 5,20,35,50), получает запуск только в минуту 5. `*/n` работает корректно (163-165).

| Задача | Подзадача | Описание | Статус |
|--------|-----------|----------|--------|
| P2-23.T1 | P2-23.T1.1 | Отклонять `N/step` с понятной ошибкой (или реализовать start-at семантику) | ✅ |
| | P2-23.T2.1 | Тест: `5/15` → либо ошибка, либо 5,20,35,50 | ✅ |

**Проверено запуском (18.11.2026):** `parseCron("5/15 * * * *").minute` = `[5]` (Vixie: `5,20,35,50`); `*/15` = `[0,15,30,45]`. Gate на `5/15` при `--now 12:20` возвращает `exit 3`, хотя по Vixie минута 20 должна запускаться.

**Реализовано (18.11.2026):** выбран вариант явного отклонения. `expandField()` теперь при `N/step` (шаг у одиночного значения) бросает локализованную `schedule.error.cronStepNeedsRange` с примером `5-59/15` или `*/15`; диапазоны `a-b/n` и `*/n` поддержаны. Ключ добавлен в ru/en/zh.

**Проверено запуском (18.11.2026):** `test-schedule-v2.mjs` 56/56 — `5/15 * * * *` отклоняется с понятной ошибкой, `5-59/15 * * * *` → `[5,20,35,50]`; `test-cron-to-schtasks.mjs` 13/13; `test-window-v3.mjs` 33/33; `npm run build` — OK.

---

### Деталь P2-24: Ловушка `MAX_POSTPONE_MS = 12 ч`

**Подтверждено:** `schedule-gate.ts:46` — `MAX_POSTPONE_MS = 12 ч`; если ждать открытия окна дольше (200-205), возвращается `3` (skip). Пример: daily cron 09:00 + окно 22:00–06:00 → до открытия 13 ч > 12 ч → тик пропускается каждый день, задача не выполняется никогда.

| Задача | Подзадача | Описание | Статус |
|--------|-----------|----------|--------|
| P2-24.T1 | P2-24.T1.1 | При создании валидировать/предупреждать: cron-время не попадает в окно, перенос >12 ч будет пропущен | ✅ |
| | P2-24.T1.2 | `dry_run` показывает этот случай | ✅ |

**Проверено запуском (18.11.2026):** `schedule-gate --cron "0 9 * * *" --now 09:00Z --not-before 22:00 --not-after 06:00` → `exit 3` с сообщением «до открытия больше 12 часов, тик пропущен».

**Реализовано (18.11.2026):** в `schedule-v2.ts` добавлен `assessCronWindowFeasibility(expr, options, policy, from, maxPostponeMs = 12ч, maxOccurrences = 120)` — перебирает ближайшие запуски cron и проверяет, попадает ли хотя бы один в окно либо переносится не дальше 12 ч. Возвращает `{ feasible, checked, firstRun?, reason? }` с причинами `never-fires | never-in-window | postpone-too-far`; для `windowPolicy = "run"` всегда `feasible`. `windowFeasibilityReasonText()` переводит причину на язык интерфейса. В `schedulerCreateTask` (cron-ветка) при наличии окна/дней выводится громкое предупреждение `console.warn` с текстом `dryRun.window.unreachable` (создание не блокируется). В `dry-run.ts` тот же расчёт добавляет предупреждение в отчёт. Ключи `dryRun.window.unreachable` и `dryRun.window.reason.*` добавлены в ru/en/zh.

**Проверено запуском (18.11.2026):** `test-window-v3.mjs` 36/36 (в т.ч. 09:00 + окно 22:00–06:00 → `postpone-too-far`; 09:00 + 08:00–18:00 → достижимо; `windowPolicy=run` → достижимо), `test-dry-run.mjs` 19/19, `test-schedule-v2.mjs` 56/56, `npm run build` OK.

---

### Деталь P2-25: Gate fail-open при невалидном cron

**Подтверждено:** `schedule-gate.ts:159-170` — parse error логируется, `spec` остаётся `null`, затем cron-проверка (172) пропускается → задача запускается каждый тик. Сейчас прикрыто валидацией `parseCron` в `schedule_task`, но импорт/ручная правка БД с повреждённым выражением превратится в ежеминутный запуск LLM (дорого).

| Задача | Подзадача | Описание | Статус |
|--------|-----------|----------|--------|
| P2-25.T1 | P2-25.T1.1 | Для gate сделать fail-closed: `exit 3` + громкий лог при невалидном cron | ✅ |
| | P2-25.T1.2 | Fail-open оставить только для битых аргументов окна | ✅ |

**Проверено запуском (18.11.2026):** `node dist/core/schedule-gate.js --cron "not-a-cron" --now 12:06Z` → лог «Невалидный cron … пропускаем проверку cron» и `exit 0` (запуск разрешён).

**Реализовано (18.11.2026):** в `src/core/schedule-gate.ts` catch разбора cron теперь пишет `[schedule-gate] ОШИБКА: невалидный cron «…»: … Запуск пропущен (fail-closed). Исправьте расписание задачи.` и возвращает `exit 3`; ветки проверки окна/таймзоны остались fail-open, как и отсутствие `--cron` (gate только по окну).

**Проверено запуском (18.11.2026, после фикса):** `node test-window-v3.mjs` → 38/38, включая «невалидный cron → exit 3 (fail-closed)» и «в логе явная ошибка fail-closed»; `test-schedule-v2` 56/56; `test-dry-run` 19/19; `npm run build` OK.

---

### Деталь P2-26: `formatDateByLocalePattern` ломается на `MMM`

**Подтверждено:** `one-shot.ts:148-157` — поддерживаются только `yyyy`/`yy`/`MM`/`M`/`dd`/`d` последовательными заменами. Паттерн с `MMM` (например `yyyy. MMM d.`, hu-HU) превращает имя месяца в цифры (`MM` → `11`, остаток `M` → `11`), дата становится мусорной. One-shot/«никогда»-задачи на таких локалях Windows создадутся с неверной датой.

| Задача | Подзадача | Описание | Статус |
|--------|-----------|----------|--------|
| P2-26.T1 | P2-26.T1.1 | Поддержать `MMM`/`MMMM` через таблицу названий месяцев | ✅ |
| | P2-26.T1.2 | Либо отклонять неподдерживаемый паттерн с ISO-фолбэком, который принимает `schtasks` | ✅ (не требуется: реализован T1.1) |

**Реализовано (18.11.2026):** `formatDateByLocalePattern` переписан на один проход по токенам `yyyy|yy|MMMM|MMM|MM|M|dd|d` вместо последовательных `.replace()`. Названия месяцев берутся из `Intl.DateTimeFormat(undefined, { month: "short" | "long" })` — то есть из системной локали, той же, из которой пришёл паттерн. Неизвестный текст копируется как есть.

**Проверено запуском (после фикса):** `formatDateByLocalePattern(new Date(2030,0,2,9,30), "yyyy. MMM d.")` → `"2030. янв. 2."`; `buildWindowsOneShotFlags(...)` → `/sd "2030. янв. 2."`; `"yyyy MMMM d"` → `"2030 января 2"`; мусорных цифровых последовательностей нет. `test-one-shot.mjs` — 51/51, `npm run build` — OK.

---

### Деталь P2-27: Windows one-shot не самоудаляется

**Подтверждено:** `one-shot.ts:127-141` — `buildWindowsOneShotFlags` возвращает `["/sc","ONCE","/sd",...,"/st",...]` без `/z`. Комментарий в `windows.ts:403-412` обещает, что Windows удалит задачу сам, но флага нет и пост-очистки в `record-history` тоже нет (на macOS есть `oneShotCleanupCommand`, на Linux `at` убирает сам). ONCE-задачи копятся в Планировщике навсегда.

| Задача | Подзадача | Описание | Статус |
|--------|-----------|----------|--------|
| P2-27.T1 | P2-27.T1.1 | Добавить `/z` в `buildWindowsOneShotFlags` (проверить на Win10/11) | ✅ (проверено: `/z` ломает schtasks — EndBoundary, не используем) |
| | P2-27.T1.2 | Либо явная очистка в `record-history` по `triggerType=once` | ✅ (выбран этот вариант) |

**Проверено запуском (18.11.2026):** `buildWindowsOneShotFlags("2030-01-02T09:30:00", "dd.MM.yyyy")` → `["/sc","ONCE","/sd","02.01.2030","/st","09:30"]` — флага `/z` нет.

**Проверено запуском (18.11.2026, реальный schtasks):** `/z` на этой машине (Win10/11, ru) не работает:
`schtasks /create ... /sc ONCE /sd <дата> /st 23:59 /z /f` → `ERROR: The task XML is missing a required element or attribute. (41,4):EndBoundary`, код 1, задача не создаётся. То же без `/sd`, с `/ed` (→ «/ED is not applicable for the scheduled type ONCE») и с `/sc DAILY` — та же ошибка. Без `/z` задача создаётся и `schtasks /query` показывает `Ready`, после проверки удалена. Поэтому `/z` в код не добавляем.

**Реализовано (18.11.2026):** явная очистка после завершения. В `record-history.ts` добавлена `cleanupWindowsOneShotTask(taskName, deps?)`: на не-Windows возвращает `false`; берёт определение через `getTask`; удаляет через `createSchedulerBackend().deleteTask(name)` только при `triggerType === "once"`; логирует успех или предупреждение, никогда не бросает. Вызывается из `handleCompletion()` сразу после `notifyTaskCompletion()`. Linux (`at`) и macOS (`oneShotCleanupCommand`) убирают задачи сами.

**Проверено запуском (после фикса):** `buildWindowsOneShotFlags(...)` снова возвращает `["/sc","ONCE","/sd","02.01.2030","/st","09:30"]` без `/z`. `node test-one-shot.mjs` — **57/57** (включая: `/z` отсутствует; win32+once → deleteTask вызван; win32+cron → не вызван; linux+once → false; ошибка deleteTask проглатывается), `npm run build` — OK.

---

### Деталь P2-28: `&` в пути обёртки ломает `.cmd`, запускаемый через `cmd.exe`

**Требует проверки:** `windows.ts:453` формирует `/tr "<command>"`; сама задача запускает `.cmd`, который Windows исполняет через `cmd.exe`. Путь профиля с `&` (например `Tom&Jerry`) может разорвать команду. Инъекция при создании закрыта (`execFile`), но cmd-метасимволы в пути обёртки стоит экранировать/валидировать.

| Задача | Подзадача | Описание | Статус |
|--------|-----------|----------|--------|
| P2-28.T1 | P2-28.T1.1 | Экранировать/валидировать cmd-метасимволы в пути обёртки при создании | ✅ (не требуется: не воспроизводится) |

**Проверено запуском (18.11.2026, реальный Планировщик):** создан каталог `%TEMP%\p228 Tom & Jerry\run.cmd` (literal `&` в пути), задача `schtasks /create /tn OpenCodeP228 /tr "\"<path>\run.cmd\"" /sc ONCE /sd <завтра> /st 23:59 /f`, затем `schtasks /run`. Результат: задача создана, запущена и записала маркер `out.txt` (`ok`); удалена. То есть `&` внутри пути безопасен, потому что `/tr` передаётся уже в кавычках (`"${command}"`), и Task Scheduler исполняет `.cmd` с этим значением как единым путём. Символы `"` и переводы строк в именах Windows невозможны; отдельного экранирования не добавляем. Остаточный экзотический случай — каталог с парой `%...%` (cmd раскрыл бы переменную), но это не про `&` и не воспроизводится типовым именем пользователя.

---

### Деталь P2-29: DAG смотрит только последние 200 записей истории

**Подтверждено:** `record-history.ts:547` — `getHistory(null, 200)`. На высокочастотных задачах последний успех зависимости может выпасть из окна → зависимая задача не стартует. `latestHistoryByTask` уже есть, но применяется поверх усечённой выборки.

| Задача | Подзадача | Описание | Статус |
|--------|-----------|----------|--------|
| P2-29.T1 | P2-29.T1.1 | Брать «последнюю запись по каждой задаче» SQL-ом, без лимита 200 | ✅ |
| | P2-29.T2.1 | Тест: >200 завершений высокочастотной задачи, зависимость всё равно находится | ✅ |

**Реализовано (18.11.2026):** в `src/db/history-repo.ts` добавлен `getLatestHistoryByTask(limit = 5000)`:

```sql
SELECT * FROM history
WHERE id IN (SELECT MAX(id) FROM history GROUP BY lower(task_name))
ORDER BY started_at DESC, id DESC
LIMIT ?
```

`src/core/record-history.ts` в DAG-ветке `handleCompletion` теперь использует `getLatestHistoryByTask()` вместо `getHistory(null, 200)`. Лимит 5000 — только защита от патологического числа задач, а не окно «последних N событий»: на каждую задачу приходится ровно одна строка (последняя).

**Проверено запуском (после фикса):** новый `test-dag-latest-history.mjs` создаёт временную БД, пишет один успех `dep` (2020) и 250 более новых успехов `busy` (2026), затем проверяет: старый `getHistory(null, 200)` **не** содержит `dep` (репро бага), `getLatestHistoryByTask()` содержит `dep` со статусом success, в выдаче ровно по одной записи на задачу, `selectDependentsToTrigger("dep", ...)` возвращает `["downstream"]`. Результат — 5/5. Тест зарегистрирован в `npm test` и как `test:dag-latest-history`.

---

### Деталь P2-30: `retry_state` — общий JSON в settings с RMW из разных процессов

**Подтверждено:** `record-history.ts:19` — `RETRY_STATE_KEY`; `loadRetryState` (142-145), `writeRetryState` (147-149), декремент (184-185). Каждое завершение задачи — отдельный процесс `node record-history`, параллельные завершения могут потерять декремент → лишние/недостающие retry.

| Задача | Подзадача | Описание | Статус |
|--------|-----------|----------|--------|
| P2-30.T1 | P2-30.T1.1 | Хранить retry per-task (отдельная колонка/таблица) или делать атомарный UPDATE | ✅ |

**Реализовано (18.11.2026):** счётчик повторов хранится отдельной строкой settings на задачу: ключ `retry_state:<имя в нижнем регистре>`. В `src/db/settings-repo.ts` добавлен `decrementCounterSetting(key, initial)`: `INSERT ... ON CONFLICT DO NOTHING`, затем атомарный `UPDATE ... SET value_json = CAST(CAST(value_json AS INTEGER) - 1 AS TEXT) WHERE key = ? AND CAST(value_json AS INTEGER) > 0 RETURNING ...`. В `record-history.ts` удалены общий `RetryState`/`loadRetryState`/`writeRetryState`/`clearRetryState`; `scheduleRetry` уменьшает счётчик атомарно, при исчерпании удаляет ключ, при успехе — `deleteSetting(retryStateKey(...))`. Дополнительно в `src/db/index.ts` `PRAGMA busy_timeout = 5000` теперь выполняется **до** `PRAGMA journal_mode = WAL` — параллельный старт процессов `record-history` больше не падает с `database is locked`.

**Проверено запуском (после фикса):** `test-retry-counter.mjs` — 3/3: 20 параллельных процессов с начальным значением 20 дают уникальные значения 0..19 без потерь; 21-й вызов возвращает `null`; ключи разных задач независимы. `npm run build` — OK. Тест зарегистрирован в `npm test` и `test:retry-counter`.

---

## 🔵 P3 — улучшения (бэклог, по важности)

| # | Улучшение | Куда | Статус |
|---|-----------|------|--------|
| P3-1 | Dependabot/Renovate + job `npm ci --dry-run` на свежем npm (ловит дрейф лока и плавающие `>=`) | Бэклог | ✅ |
| P3-2 | ESLint + lint-job (конфиг `.eslintrc.json` → `eslint.config.mjs` ESLint v10 flat config, скрипт `lint`/`lint-job` в package.json, шаг `Lint` в CI; `no-unsafe-*` и `no-unused-vars` — warn, не блокируют) | Бэклог | ✅ |
| P3-3 | Бампнуть majors actions: `checkout@v4`/`setup-node@v4` → v5+ (актуально на ноябрь 2026) | Бэклог | ✅ |
| P3-4 | PRAGMA `user_version` в SQLite — схема эволюционирует ad-hoc ALTER'ами, без версии схемы будущие миграции усложнятся (введены `SCHEMA_VERSION`, `getSchemaVersion()`, ступени `MIGRATIONS`, health отдаёт `schemaVersion`/`expectedSchemaVersion`, тест `test-user-version.mjs`) | Бэклог | ✅ |
| P3-5 | Release-workflow гоняет тесты только на ubuntu для тега — требовать зелёный CI тега или гонять матрицу (добавлен job `verify` с матрицей windows/ubuntu, `publish` зависит от него через `needs: verify`; macOS проверяется обычным CI на каждом push и в релизной матрице не дублируется — очередь macOS-раннеров блокировала publish) | Спринт (релизный риск) | ✅ |
| P3-6 | Шаблоны issues/PR, `test:triage-compare`-скрипт (сюита есть, ярлыка нет), `pretest:parallel`-билд для DX (добавлены `.github/ISSUE_TEMPLATE/*`, `pull_request_template.md`, скрипты `test:triage-compare` и `pretest:parallel`; инварианты в `test-docs`) | Бэклог | ✅ |
| P3-7 | В `test-docs` добавить проверку паритета zh (сейчас ru/en; zh покрыт `test-i18n` — продублировать контракт явно) | Бэклог | ✅ |
| P3-8 | Комментарий в `test-task-name-limit.mjs:1-3` («префикс = 29 → 208») неверен: фактически 28 → 209 (как и комментарий в `types.ts`) — поправить оба комментария | Бэклог | ✅ |
| P3-9 | Документация содержала устаревшие пользовательские пути `windows-scheduler` (CROSS_PLATFORM ru/en/zh, FAQ ru/en/zh, FEATURES en/zh, ARCHITECTURE) — приведены к `agent-steward` с пометкой о legacy-алиасинге; `test-docs` 96/96 | Бэклог | ✅ |
| P3-10 | GUI вызывал `get_shadow_report`, `reset_shadow_report`, `test_local_ai`, но методы отсутствовали в `SchedulerRpc.methods` → `TypeError: f.get_shadow_report is not a function` в Desktop; схемы добавлены, в `test-docs` введён инвариант «каждый `rpc.<method>` из gui.tsx объявлен в rpc.ts» | Бэклог | ✅ |
| P3-11 | Durable DAG, подзадача 36.1.a: `SCHEMA_VERSION` 2, таблицы `runs`/`run_steps` (status, attempt, idempotency_key, timestamps), миграционная ступень v2; репозиторий `src/db/runs-repo.ts` с валидацией переходов и `retryStep`; тест `test-run-state.mjs` в цепочке `npm test`; раздел «Durable run state» в ARCHITECTURE | Спринт 36 | ✅ |
| P3-12 | Durable DAG, подзадача 36.1.b: модуль `src/db/run-journal.ts` — каждый переход шага пишется в БД до и после тела (`beginStepAttempt`, `runStepStatefully`, `recordStepSuccess/Failure`); `recoverInterruptedSteps` помечает зависшие `running` как `failed`, сохраняя `attempt`; `PRAGMA synchronous = NORMAL` в WAL; тест `test-run-journal.mjs` с реальным `kill -9` посреди шага в цепочке `npm test` | Спринт 36 | ✅ |
| P3-13 | Durable DAG, подзадача 36.2: resume с середины — `SCHEMA_VERSION` 3 и колонка `run_steps.position` (миграция бэкфиллит порядок), `src/db/run-resume.ts` (`findResumeStep`, `resumeRunSync`/`resumeRun`, `reopenRun` failed → running), пропуск завершённых шагов, валидация обработчиков до побочных эффектов, `test-run-resume.mjs` с `kill -9` посреди линейной цепочки | Спринт 36 | ✅ |
| P3-14 | Durable DAG, подзадача 36.3: идемпотентные ключи шагов — `SCHEMA_VERSION` 4, частичный уникальный индекс `idx_run_steps_key_unique (run_id, idempotency_key)` с дедупликацией легаси-ключей в миграции; `src/db/step-idempotency.ts` (`runStepOnce`/`runStepOnceAsync`, replay из `output_json` без повторного тела, `IdempotencyConflictError`, `StepInFlightError`, retry failed с `attempt + 1`); тест `test-step-idempotency.mjs` (44 проверки, включая параллельные вызовы и переоткрытие БД) | Спринт 36 | ✅ |
| P3-15 | Durable DAG, подзадача 36.4: DLQ — `SCHEMA_VERSION` 5 и таблица `run_dlq` (snapshot `error`/`attempts`, статусы `open`/`retried`/`discarded`, частичный уникальный индекс `idx_run_dlq_open_unique`); `src/db/run-dlq.ts` (`scanDeadLetters` с порогом попыток, `retryDeadLetter` с переоткрытием запуска, `discardDeadLetter`, `listDeadLetters`/`countDeadLetters`); вложенные `withTransaction` через `SAVEPOINT`; тест `test-run-dlq.mjs` | Спринт 36 | ✅ |
| P3-16 | Роутер, подзадача 36.5.a: слой 1 — статические правила горячего пути — `src/core/router/rules.ts` (`STATIC_ROUTE_RULES`, `routeStaticStep`, `normalizeTaskType`, `isStaticTaskType`, `listStaticRouteRules`); модуль без импортов, неизвестный тип уходит слою 2; тест `test-router-rules.mjs` (22 проверки, 1000 маршрутизаций < 50 мс) | Спринт 36 | ✅ |
| P3-17 | Роутер, подзадача 36.5.b: слой 2 — Capability Map — `SCHEMA_VERSION` 6 и таблица `capability_map` (`success_rate`, `avg_cost_usd`, `avg_time_ms`, `last_10_runs`); `src/db/capability-repo.ts` (`recordCapabilityOutcome` со скользящими средними, `decideCapabilityRoute` с порогами 0.85/0.30 и `explore` при < 3 исходах, `getCapability`/`listCapabilities`); тест `test-capability-map.mjs` | Спринт 36 | ✅ |
| P3-18 | Роутер, подзадача 36.5.c: слой 3 — декомпозиция миссии — `src/core/router/planner.ts` (`planMission` вызывает декомпозер один раз на миссию, `planMissionSync` и `decomposeHeuristically` без модели, `needsDecomposition`); шаг содержит только `stepName`+`taskType`, маршрут остаётся слоям 1–2, неизвестные типы идут в `ambiguousTaskTypes`; тест `test-planner.mjs` | Спринт 36 | ✅ |
| P3-19 | Роутер, подзадача 36.5.d: эскалация при провале гейта — `src/core/router/escalation.ts` (`escalateAfterGate`: `local → cloud → review → blocked` по таблице переходов, `nextGateTarget`, `isEscalationExhausted`, `escalationChain`, без БД и модели); сборка маршрута `src/core/router/dispatch.ts` (`routeStep`: слой 1 → слой 2, `review`/`explore` без транспорта); тест `test-escalation.mjs` | Спринт 36 | ✅ |
| P3-20 | Роутер, подзадача 36.5.e: маршрутизация без модели для известных типов — `test-router-dispatch.mjs` доказывает, что статика отвечает до инициализации БД, не пишет в `capability_map`, а `dispatch.ts` не импортирует planner; 1000 маршрутов укладываются в миллисекунды | Спринт 36 | ✅ |
| P3-21 | Chaos-тест nightly, задача 36.5: `test-chaos-dag.mjs` убивает `SIGKILL` дочерний процесс посреди DAG-цепочки (`build`, затем `test`), проверяет durable-состояние до и после `recoverInterruptedSteps`, resume с прерванного шага с `attempt = 2`, отсутствие повторных вызовов завершённых шагов и `PRAGMA integrity_check`; `.github/workflows/nightly.yml` запускает тест по cron на windows-latest и ubuntu-latest; `npm run test:chaos` | Спринт 36 | ✅ |
| P3-22 | DLQ в GUI, задача 36.6: `src/core/dlq-api.ts` (фасад `listDlq`/`retryDlq`/`discardDlq`, нормализация фильтра `open/all/retried/discarded` и лимита), RPC `list_dlq`/`retry_dlq`/`discard_dlq` в `src/rpc.ts` и `src/index.ts`, аудит `dlq.retry`/`dlq.discard`, панель «♻️ Dead-letter queue» в `src/gui.tsx` (счётчик открытых, фильтр, таблица created/run+step/reason/attempts/error, retry и discard с подтверждением, тосты), локали ru/en/zh, `test-dlq-gui.mjs` | Спринт 36 | ✅ |
| P3-23 | Пауза с инъекцией контекста, задача 36.7: схема v7 — таблица `run_injections` (comment/file/artifact, автор, metadata, consumed_at), статус `paused` и `pauseRunRecord` с переходами RUN_TRANSITIONS; `src/db/run-context.ts` (`pauseRun`, `listRunInjections`, `pendingInjectionsForStep`, `consumeInjections`, `consumeOrphanInjections`, `SENSITIVE_KEY_RE`, `MAX_INJECTION_CONTENT`); `pauseRun` запрещена при running-шаге, терминальном запуске, завершённом/несуществующем шаге, без незавершённых шагов; секреты маскируются при записи (`redactSecretsInText`, JSON-ключи); `StepHandler` получает `StepContext {injections}`, `ResumeResult.injected`, вставки потребляются один раз при успешном шаге, `finalize` снимает осиротевшие вставки; тест `test-run-context.mjs` | Спринт 36 | ✅ |
| P3-24 | Пауза и resume в GUI, задача 36.8: `src/core/run-panel-api.ts` (`listRunPanel`, `pauseRunPanel`, `resumeRunPanel`, нормализация фильтра active/all/статус и лимита, текущий шаг с якорем, прогресс, история контекста с обрезкой до 500 символов); RPC `list_durable_runs`/`pause_durable_run`/`resume_durable_run` в `src/rpc.ts` и `src/index.ts`, аудит `run.pause`/`run.resume`; секция «⏯️ Запуски DAG» в `src/gui.tsx` (фильтр active/all/running/paused/failed, ссылка на текущий шаг, поле комментария, pause/resume с подтверждением, блокировка pause и предупреждение при running-шаге, история автора/контекста); resume только снимает паузу и готовит шаг, выполнение остаётся за `resumeRun`/исполнителем DAG; локали ru/en/zh; `test-pause-gui.mjs` | Спринт 36 | ✅ |
| P3-25 | README обещает порт дашборда `http://localhost:4380`, а `server.ts` предпочитает `3782` → `4782` → `5782` (4380 есть только у demo-скрипта). Исправить `README.md`, `docs/README.ru.md`, `docs/README.zh.md` | Бэклог | ✅ (18.11.2026: все упоминания заменены на 3782; demo-скрипт тоже стартует с 3782) |
| P3-26 | GitHub About устарел: описание «OpenCode v2 plugin…» (теперь V1+V2), website ведёт на старый npm-пакет, topics содержат `systemd` при бэкенде crontab. Обновить метаданные (требует доступа к GitHub) | Бэклог | ⏸️ |
| P3-27 | `legacy/package.json:42` — `"agent-steward": ">=0.0.2"` без верхней границы: будущий 1.x/2.x с breaking changes прилетит в deprecated-пакет. Заменить на `~0.0.2` (`>=0.0.2 <0.1.0`) и бампать осознанно | Бэклог | ✅ (18.11.2026: диапазон `>=0.0.2 <0.1.0`; `test-package-exports.mjs` OK) |
| P3-28 | npm с января 2027 ограничивает token-publish. `release.yml` уже содержит обе ветки (NPM_TOKEN и OIDC). Сделать trusted publishing (OIDC) единственным путём и убрать `NPM_TOKEN` до дедлайна. Подтверждено: `release.yml:11` `id-token: write`, строки 106-118 — token/OIDC-выбор | Бэклог | ✅ (18.11.2026: `NPM_TOKEN` убран, публикация только через OIDC + `--provenance`; на npmjs.com нужно настроить trusted publisher для репозитория и `release.yml`) |
| P3-29 | Дашборд каждые 5 с тянет 6 эндпоинтов, включая тяжёлый `/api/analytics?days=14`. Подтверждено: `server.ts:2642` `setInterval(loadAll, 5000)`, `server.ts:2449` analytics, `gui.tsx:2428` `setInterval(loadJobs, 5000)`, снежинки `server.ts:2648`. Добавить ETag/`If-None-Match`, более редкий интервал для аналитики или SSE; снежинки/новогодний empty-state вынести за флаг | Бэклог | ✅ (18.11.2026: analytics вынесена из loadAll() в отдельную loadAnalytics() с интервалом 60 с и ETag/If-None-Match (статус 304 → не запрашивать повторно); снежинки и «украсить ёлку» за флагом `?snow=1`) |
| P3-30 | What-if модели захардкожены и устаревают. Подтверждено: `server.ts:166-168` цены `openai/gpt-4o` = 10, `gpt-4o-mini` = 0.6, `deepseek/deepseek-coder` = 0.28; `server.ts:242` `whatIfModels`. Сделать таблицу цен конфигурируемой (методика уже описана в SAVINGS.md) | Бэклог | ✅ (18.11.2026: модели и цены берутся из самого OpenCode — новый `src/core/opencode-models.ts`; список — `opencode models` (14 моделей на этой машине), цены — кэш models.dev `<cache>/opencode/models.json`, среднее input/output; What-If = модели из истории + по одной на каждую цену, максимум 5, поле `whatIfSource`; `*-free`/локальные = 0. Переопределения: `OPENCODE_SCHEDULER_WHAT_IF_MODELS`, `_MODEL_PRICES`, `_MODELS_CACHE`, `_MODEL_SOURCE=static`. `test-models-config.mjs` 38/38; docs/SAVINGS.{md,ru.md,zh.md}) |
| P3-31 | Комментарий в `linux.ts:53-69` вводит в заблуждение: `@daily` отклоняется `parseCron`, а списки/диапазоны уходят в poll не потому, что crontab их не понимает, а потому что `needsPollMode` переиспользует Windows-подмножество `isNativeSchtasksExpr`. Заодно перф: для POSIX нативно отдавать списки/диапазоны/шаги/имена (кроме `L`/`#`/чужой TZ). ✅ (18.11.2026: в `schedule-v2.ts` добавлены `isNativePosixCronExpr` и `needsPosixPollMode`; `linux.ts` использует их и честно описывает Vixie-совместимый crontab; Windows-поведение не изменено. `test-schedule-v2.mjs` 68/68, новый `test-posix-cron.mjs` 14/14, `test-pause-one-shot.mjs` 4/4, build OK, lint 0 ошибок) | Бэклог | ✅ |
| P3-32 | CI-комментарий про Node «22» («резолвится в последний 22.x, который может быть старее») фактически наоборот; пин `22.22.0` оправдан `engines`, но формулировку поправить. Подтверждено: `ci.yml:22-24` — комментарий и матрица `["22.22.0", 24]` | Бэклог | ✅ (18.11.2026: комментарий исправлен — «22» резолвится в последний 22.x, обычно НОВЕЕ минимума; пин фиксирует нижнюю границу из `engines` и делает сборку воспроизводимой. `test-docs.mjs` — 2 регрессионные проверки, всего 104/104) |
| P3-33 | `test-dual-entry.mjs` зависит от точного пути `node_modules/@opencode-ai/plugin/node_modules/zod/index.cjs` (строка 73). `createRequire` уже импортирован (строка 12) — заменить хардкод на `require.resolve("zod")` от пакета V1 SDK | Бэклог | ✅ (18.11.2026: путь к zod разрешается через `createRequire` от `node_modules/@opencode-ai/plugin/package.json`, хардкод `.../zod/index.cjs` убран; тест работает и при вложенной копии, и при hoist. `node test-dual-entry.mjs` OK; в `test-docs.mjs` добавлена регрессионная проверка отсутствия хардкода) |
| P3-34 | Не покрыто аудитом (нужна отдельная проверка): `ps-wrapper.ts` (главный файл для Windows), `matrix.ts`, `server.ts` (HMAC/timing-safe, path traversal в `/api/logs`, enforcement заголовков), `gui.tsx`, `rpc.ts`, `db/migrate.ts` + schema v7, `task-transfer.ts`, `notifications/telegram`, `file-watcher`/`git-trigger`, `router/*` vs CONCEPT §5 | Бэклог | ✅ (18.11.2026: локальный аудит перечисленных модулей; HMAC/timing-safe, `/api/logs`, заголовки, telegram, task-transfer, file-watcher, git-trigger, matrix, schema v7 — явных багов нет, отдельного каталога `src/router` не существует. Найден и исправлен баг миграции: `src/db/migrate.ts` `normalizeHistoryRow` превращал `status: "partial"` из legacy `history.json` в `error`, хотя подсчёт метрик уже отличал partial; теперь partial сохраняется. `test-migrate-partial.mjs` 5/5, `test-sqlite.mjs` зелёный, build OK, lint 0 ошибок) |
| P3-35 | `src/core/session.ts:126` — ротация сессии на Windows не удаляет сессию: `execFile("opencode", ["session","delete",id])` падает молча, потому что `opencode` там `opencode.cmd`, а Node 24 не запускает `.cmd` без shell. Подтверждено на этой машине: `execFileSync("opencode")` → ENOENT, `execFileSync("opencode.cmd")` → EINVAL, `cmd.exe /d /s /c opencode models` → OK. Счётчик `sessionRunCount` при этом обнуляется, то есть задача считает, что сессия новая, а контекст тянется старый. (18.11.2026: создан `src/core/opencode-cli.ts` — кроссплатформенный запуск `opencode` через `cmd.exe` на Windows; `src/core/session.ts` — `rotateSessionIfNeeded` использует `runOpencode` для `session delete`, логирует ошибку удаления и всё равно ротирует (новый id, счётчик сброшен, sidecar обновлён); `src/core/opencode-models.ts` — переиспользует `opencodeCommand` вместо inline `execFileSync`; `test-session-continuity.mjs` 57/57, build OK, lint 0 ошибок) | Бэклог | ✅ |
| P3-36 | Ссылка «docs/MIGRATION.md» на странице npm-пакета `opencode-windows-scheduler` вела на `https://github.com/DeadSno/agent-steward/blob/docs/MIGRATION.md#...` — несуществующую ветку `docs`. Причина: npm переписывает относительную ссылку `../docs/MIGRATION.md` из `legacy/README.md`, склеивая repository URL с путём и теряя ветку. (18.11.2026: ссылка заменена на абсолютную `https://github.com/DeadSno/agent-steward/blob/dev/docs/MIGRATION.md#from-opencode-windows-scheduler-to-agent-steward-package-rename` — на dev есть и файл, и нужный анкор; в `test-docs.mjs` добавлены 4 проверки; реальная проверка GitHub URL выполнена; для появления исправления на npm нужен ре-паблиш legacy-пакета, например 1.5.9) | Бэклог | ✅ |
| P3-37 | CI красный с run #110: все 6 matrix-задач падают на шаге `Test` в `test-run-now.mjs` (5/6, «record-history: прямых createSchedulerBackend().runTask больше нет». Причина: тест P1-9 запрещал любое упоминание `createSchedulerBackend`, а коммит `1a43e8a` (P2-27) добавил легитимный `createSchedulerBackend().deleteTask` для очистки ONCE-задач. (18.11.2026: проверка сужена до отсутствия прямых `.runTask(` в `dist/core/record-history.js`, добавлена позитивная проверка `createSchedulerBackend().deleteTask`; `test-run-now.mjs` 7/7, полный `npm test` зелёный, build OK, lint 0 ошибок) | CI | ✅ |
| P3-39 | CI run #44308638812 (`windows-latest`, Node 22.22.0): `test-registry-resilience.mjs` падает с `EPERM: operation not permitted, open ...\locks\registry-p2-16-parallel.lock` в `LockManager.acquire` (40 параллельных `upsert`). Причина: на Windows конкурентный create/delete одного lock-файла возвращает `EPERM`/`EACCES`/`EBUSY` вместо `EEXIST`, а `acquire()` обрабатывал только `EEXIST`; `release()` мог упасть на `unlink`, пока другие процессы читают lock. (18.11.2026: `acquire()` трактует `EPERM`/`EACCES`/`EBUSY` как «занято» → `withLockWait` повторяет; добавлен `unlinkWithRetry()` с короткими повторами для Windows-блокировок. `test-registry-resilience.mjs` 10/10 прогонов локально, build OK) | CI | ✅ |

---

### Деталь P2-31: lease/owner на run_steps — требуется CONCEPT §5, §6 перед 0.1.0

**Подтверждено:** `src/db/schema.ts:148-164` — таблица `run_steps` без полей `owner_pid`, `lease_token`, `lease_expires_at`. `src/db/run-journal.ts:149-164` — `recoverInterruptedSteps()` помечает failed ВСЕ running-шаги, в т.ч. исполняемые другим живым процессом. Конкурирующий процесс может взять тот же шаг → двойной прогон, потеря 출력은. CONCEPT §5: "неdependencies; leases/locks/таймауты/бюджеты" (стр. ~135). CONCEPT §6: исполнительный цикл шаги 3–6 — внутренний цикл на каждый шаг миссии.

| Задача | Подзадача | Описание | Статус |
|--------|-----------|----------|--------|
| P2-31.T1 | P2-31.T1.1 | Миграция schema: добавить `owner_pid TEXT`, `lease_token TEXT`, `lease_expires_at TEXT` в `run_steps` (SCHEMA_VERSION → 8) | ☐ |
| | P2-31.T1.2 | `beginStepAttempt()` записывает owner_pid + lease_token + TTL перед телом шага | ☐ |
| | P2-31.T1.3 | `recoverInterruptedSteps()` помечает failed только шаги с мёртвым/истёкшим lease; живые lease оставляет running | ☐ |
| | P2-31.T1.4 | `completeStep()` проверяет владельца по lease_token, иначе ошибка "step owned by another process" | ☐ |
| | P2-31.T2.1 | Тест: два конкуррентных процесса, один шаг running живой — recovery не тронет; мёртвый pid — пометит failed | ☐ |

### Деталь P2-32: decay + first_pass_rate в capability-map — требуется CONCEPT §5, §6 перед 0.1.0

**Подтверждено:** `src/db/capability-repo.ts:223-277` — `decideCapabilityRoute` использует только кумулятивный `success_rate`, без затухания, без `first_pass_rate`. `last_10_runs` пишется но не участвует в решении. CONCEPT §5 (стр. 109-110): capability-map "с затуханием старых данных". CONCEPT §6.3 (стр. 143): роутинг "с учётом reliability (first_pass_rate, попытки, decay), локаль first, explore capped". CONCEPT §5 (стр. 116): "first_pass_rate и среднее число попыток участвуют в роутинге."

| Задача | Подзадача | Описание | Статус |
|--------|-----------|----------|--------|
| P2-32.T1 | P2-32.T1.1 | Экспоненциальное затухание success_rate: старые исходы теряют вес (half-life через `decayedSuccessRate(runs, now)`) | ☐ |
| | P2-32.T1.2 | `first_pass_rate` хранится в capability_map и участвует в `decideCapabilityRoute` (помимо success_rate) | ☐ |
| | P2-32.T1.3 | `last_10_runs` учитывается в решении (недавние исходы больший вес, чем кумулятивный) | ☐ |
| | P2-32.T2.1 | Тест: старые успехи затухают, recent failures смещают маршрут с local → cloud/review | ☐ |

### Деталь P2-33: Pipeline-as-code — спринт 32, версия 0.0.5

**Цель:** `opencode.pipeline.yaml` в репозитории + CLI `agent-steward pipeline validate|apply|export`; DAG, матрицы и Quality Gates описываются ревьюируемым файлом. Основание: ROADMAP спринт 32, ROADMAP-STRATEGY §5 (стр. 90-94), CONCEPT §13.4 (стабильные форматы) и §14 (открытые форматы pipeline/ledger). В коде заготовок нет — только `simulatePipeline` в dry-run.

| Задача | Подзадача | Описание | Статус |
|--------|-----------|----------|--------|
| P2-33.T1 | P2-33.T1.1 | Типы `PipelineSpec`/`PipelineStep` в `src/core/pipeline-spec.ts`: version, name, steps[] (id, needs[], prompt, schedule/trigger, model, gate, matrix, tools, timeout, retry) | ☐ |
| | P2-33.T1.2 | Валидатор: уникальные id, ссылки `needs` существуют, нет циклов, cron/trigger, matrix, имена задач по `validateTaskName`, model, tools, лимит шагов | ☐ |
| | P2-33.T1.3 | Тест валидатора: позитив + негатив (дубль id, цикл, битый needs, пустой steps) | ☐ |
| P2-33.T2 | P2-33.T2.1 | Парсер YAML→`PipelineSpec` (`yaml` перенести из devDependencies в dependencies) | ☐ |
| | P2-33.T2.2 | Маппинг `PipelineSpec`→`TaskDefinition[]`: `needs`→`dependsOn`, `gate`→`qualityGate`, `matrix.workspaces`→`matrix.workspaceIds`, `trigger`→`triggerType`; шаги без cron получают ручной триггер/DAG | ☐ |
| | P2-33.T2.3 | Идемпотентный diff/apply: create/update/unchanged, не трогать задачи без `pipelineName`; маркеры `pipelineName`/`pipelineStepId` в `definition_json` (без миграции БД) | ☐ |
| | P2-33.T2.4 | Round-trip тест: YAML→задачи→export→YAML без потери значимых полей | ☐ |
| P2-33.T3 | P2-33.T3.1 | `bin` в package.json + точка входа CLI `agent-steward` | ☐ |
| | P2-33.T3.2 | `pipeline validate <file>` с exit-кодами 0/1 и человекочитаемым выводом | ☐ |
| | P2-33.T3.3 | `pipeline export` — БД→YAML (по `pipelineName`) | ☐ |
| | P2-33.T3.4 | `pipeline apply <file>` — создать/обновить задачи, отчёт create/update/unchanged | ☐ |
| P2-33.T4 | P2-33.T4.1 | Агент-инструменты/RPC `pipeline_validate`/`pipeline_apply`/`pipeline_export` + обновить счётчики инструментов/RPC в доках и `test-docs.mjs` | ☐ |
| P2-33.T5 | P2-33.T5.1 | `docs/PIPELINE.md` + пример `opencode.pipeline.yaml` | ☐ |
| | P2-33.T5.2 | README (ru/en/zh) — раздел Pipeline-as-code | ☐ |
| P2-33.T6 | P2-33.T6.1 | `test-pipeline.mjs` + включить в `npm test` | ☐ |
| | P2-33.T6.2 | Приёмка: полный `npm test`, `npm run build`, `npm run lint` (0 ошибок) | ☐ |

### Деталь P3-38: CJK-токенизатор — i18n-срез, не блокер 0.1.0

**Подтверждено:** `src/notifications.ts:643-649` — `tokenize()` regex `[^a-zа-яё0-9\s]` вырезает CJK-символы → китайские сообщения дают нулевой вектор → семантический дедуп для zh молча не работает.

| Задача | Подзадача | Описание | Статус |
|--------|-----------|----------|--------|
| P3-38.T1 | P3-38.T1.1 | Заменить regex на `\p{L}` (Unicode-буквы) или добавить CJK-биграммы в токенизатор | ☐ |
| | P3-38.T2.1 | Тест: китайский текст даёт ненулевой вектор, дедупzh работает | ☐ |

---

## ✅ Что проверено и в порядке (для баланса)

Локали en/ru/zh — по 778 ключей, полный паритет. Криптография секретов (AES-256-GCM) — крипточасть в порядке (см. P2-20 про запись и RMW), permissions, cron-движок Vixie OR, двойной вход V1/V2, зависимости актуальны, CI/Release матрица, skill — подтверждено в аудите. Lock-менеджер больше не считается чистым: см. P2-15 (release без проверки владельца) и P2-18 (staleness только по mtime).

**Тесты при этом зелёные** (проверено запуском 18.11.2026): `test-schedule-v2.mjs` 54/54, `test-one-shot.mjs` 47/47, `test-task-name-limit.mjs` — OK. На момент аудита баги P1-10, P2-23…P2-27 этими сюитами не покрывались; сейчас P1-10 и P2-23 покрыты новыми тестами (`test-task-name-collision.mjs`, `test-schedule-v2.mjs` 56/56). `test-posix-e2e.mjs` на Windows пропускается.

---

## Порядок работы

1. Берётся **1 подзадача** из списка выше (начиная с P0, затем P1, P2, P3).
2. Подзадача выполняется (код/документация/конфиг).
3. Пишется отчёт о выполнении (что сделано, файлы, проверка).
4. Переходим к следующей подзадаче.
5. Параллельно новые улучшения/фиксы добавляются в бэклог (P3) или спринт (P0–P2).
