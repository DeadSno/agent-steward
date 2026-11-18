# Кроссплатформенность: Windows → macOS → Linux

Плагин больше не привязан к `schtasks`. Планировщик вынесен в абстрактный слой с тремя реализациями,
а обёртки запуска генерируются под целевую ОС.

Translations: [English](../CROSS_PLATFORM.md) · [中文](CROSS_PLATFORM.zh.md)

## Архитектура

```
src/
  index.ts                     # инструменты, RPC, жизненный цикл плагина
  gui.tsx                      # панель GUI (заголовок берётся из RPC)
  server.ts                    # веб-дашборд (заголовок динамический)
  core/
    scheduler/
      types.ts                 # SchedulerBackend, CreateTaskOptions, RunTaskResult
      index.ts                 # фабрика createSchedulerBackend() + getSchedulerTitle()
      windows.ts               # WindowsScheduler  (schtasks)
      linux.ts                 # LinuxScheduler    (crontab)
      mac.ts                   # MacScheduler      (launchd / LaunchAgents)
      posix.ts                 # общая база для Linux/macOS (реестр задач)
      registry.ts              # персистентный реестр задач POSIX-бэкендов
      logs.ts                  # чтение логов задач (кроссплатформенно)
    wrappers/
      bash.ts                  # генератор .sh-обёрток для Linux/macOS
    ps-wrapper.ts              # .ps1/.cmd-обёртки для Windows (как раньше)
    record-history.ts          # метрики/история + retry/цепочки (через бэкенд)
    cron-to-schtasks.ts        # cron → schtasks (только Windows)
```

### Интерфейс

```ts
interface SchedulerBackend {
  readonly platform: NodeJS.Platform;
  readonly title: string;              // «Планировщик Windows» / «OpenCode Scheduler»
  createTask(options: CreateTaskOptions): Promise<void>;
  deleteTask(name: string): Promise<void>;
  runTask(name: string): Promise<RunTaskResult>;
  listTasks(): Promise<ScheduledTaskInfo[]>;
  pauseTask(name: string): Promise<void>;
  resumeTask(name: string): Promise<void>;
}
```

Фабрика выбирает реализацию по `process.platform`:
`win32 → WindowsScheduler`, `darwin → MacScheduler`, остальные → `LinuxScheduler`.

## Как работает каждая ОС

### Windows (поведение не изменилось)
- Задачи регистрируются в Планировщике Windows через `schtasks` в папке `\OpenCode\agent-steward\` (профили — `\OpenCode\agent-steward-<profile>\`). Legacy-папка `\OpenCode\windows-scheduler\` по-прежнему читается, переименовывается и удаляется по требованию.
- Обёртка: `run-task.ps1` + персональный `run-<name>.cmd` в `%APPDATA%\opencode\agent-steward\wrapper`. Legacy-каталог `%APPDATA%\opencode\windows-scheduler` переносится при первом запуске.
- Логи: `%APPDATA%\opencode\agent-steward\logs\<name>.log`.
- cron конвертируется в schtasks (`convertCronToSchTasks`) — поддерживается тот же набор шаблонов.

### Linux
- Задачи живут в управляемом блоке `crontab`:
  ```
  # >>> opencode-scheduler:agent-steward >>>
  # task: my-task
  */5 * * * * /bin/bash '/…/wrapper/run-my-task.sh' >> '/…/logs/my-task.log' 2>&1
  # <<< opencode-scheduler:agent-steward <<<
  ```
  Блоки без суффикса `:<folder>` (legacy) по-прежнему читаются и удаляются.
- Пауза = строка с префиксом `# PAUSED: ` (блок пересобирается из реестра).
- Задачи с триггером `file` в crontab не попадают — их запускает FileWatchManager плагина.
- Обёртка: `~/.config/opencode/agent-steward/wrapper/run-<name>.sh` (chmod 0755).
- Полный cron-синтаксис (в отличие от Windows), т.к. crontab понимает его нативно.
- Разовый запуск (`once`): `at -t`; если `at` не установлен, плагин ставит отвязанный процесс `sleep && команда` (`pid:<pid>` в реестре). Fallback не переживает перезагрузку — для надёжности установите пакет `at`.
- Удаление/пересборка — только своего блока, остальные строки `crontab` не трогаются.
- Незакрытый блок плагина (маркер начала без конца) — fail-closed: плагин сообщает об ошибке и не перезаписывает crontab, поэтому строки пользователя после маркера не теряются.

### macOS
- Задачи — LaunchAgent-плисты `~/Library/LaunchAgents/com.opencode.scheduler.<name>.plist`.
- Расписание: `StartInterval` для `* * * * *` и `*/N`, `StartCalendarInterval` для `M * * * *`,
  `M H * * *`, `M H * * D`.
- Пауза = `launchctl unload -w`, возобновление = `launchctl load -w`.
- Установка приостановленной задачи пишет plist, но не вызывает `load -w`
  (он снял бы паузу); `unload -w` оставляет агент выключенным и после входа.
- Ошибки `launchctl load` не глотаются: ошибка установки/возобновления содержит
  команду, exit code и stderr (например, `Invalid property list` у битого plist).
- Обёртка — тот же `.sh`, что и на Linux; пути конфигов:
  `~/.config/opencode/agent-steward/` (или `$XDG_CONFIG_HOME`).

### Общая POSIX-обёртка (`.sh`)
- `cd` в рабочую директорию, `opencode run` с промптом из файла.
- Логи пишутся в файл через `>>` и дублируются метками времени.
- Блокировка через атомарный `mkdir` — защита от параллельных запусков.
- Node, PS и bash пишут владельца lock как `<pid>-<iso>`; старые форматы
  `<iso>|<pid>` (PS) и голый `<pid>` тоже читаются, поэтому живой lock не
  вытесняется другой средой исполнения.
- При старте плагин читает владельца и из `<task>.lock`, и из `<task>.lock.d/pid`:
  каталог lock вытесняется только если PID мёртв или отсутствует; возраст — fallback.
- Таймаут: дочерний процесс + watchdog (`TERM`, затем `KILL`).
- Quality Gate: `bash -lc "<команда>"` (аналог `cmd.exe /c` на Windows).
- Метрики: `node "<record-history.js>" <task> <status> <started> <duration> <error> "-" "-"` —
  тот же контракт, что и в PowerShell-обёртке, поэтому история/метрики/retry/цепочки работают везде.
- `PATH` дополняется `/opt/homebrew/bin`, `/usr/local/bin`, `~/.local/bin`, `~/.bun/bin`.

## Матрица возможностей

| Возможность | Windows | Linux | macOS |
|---|---|---|---|
| Бэкенд планировщика | `schtasks` | `crontab` | `launchd` LaunchAgents |
| Нативный cron-поднабор | `* * * * *`, `*/N * * * *` (N ≤ 1439, 60 % N = 0), `M * * * *`, `M H * * *`, `M H * * D` | полный cron | тот же поднабор, что на Windows |
| Остальные cron-выражения | minute-poll + schedule gate | нативный cron | minute-poll + schedule gate |
| `*/N` в дне месяца / дне недели | не нативно → poll | нативно | не нативно → poll |
| Пауза / возобновление | `schtasks /change /disable` / `/enable` | строка `# PAUSED:` в управляемом блоке | `launchctl unload -w` / `load -w` |
| Файловые триггеры | in-process `FileWatchManager` | так же | так же |
| Обёртки задач | `.cmd` + `.ps1` | `.sh` | `.sh` |
| Логи | `%APPDATA%\opencode\agent-steward\logs` | `~/.config/opencode/agent-steward/logs` | как на Linux |
| Защита `secrets.key` | `icacls` (только владелец) + `chmod` как fallback | `chmod 0600` | `chmod 0600` |
| Дашборд | `127.0.0.1`, динамический заголовок | так же | так же |
| DAG / matrix / quality gates / уведомления | в плагине, не зависят от ОС | так же | так же |

### Компромиссы

1. **Minute-poll.** Cron-выражения вне нативного поднабора и задачи с чужой IANA-зоной
   запускаются планировщиком ОС каждую минуту; `schedule-gate` решает, выполнять ли запуск.
   Цена — один короткоживущий процесс-обёртка на задачу в минуту.
2. **`M H */N * *` сознательно не конвертируется в `schtasks /sc DAILY /mo N`.**
   Cron считает дни от 1-го числа каждого месяца и сбрасывается на границе месяца;
   `/mo N` считает дни от даты создания задачи и не сбрасывается. Это не эквивалентные
   расписания, поэтому выражение остаётся в poll-режиме. Нативный вариант потребовал бы
   `MONTHLY` с явным списком `/d`, а не `DAILY /mo N`.
3. **DST.** Шлюз работает с локальным настенным временем. Несуществующее время
   (переход весной) пропускается; неоднозначное время (переход осенью) выполняется
   в первом вхождении.
4. **`*/N * * * *` на Windows** нативно только при `60 % N = 0` и `N ≤ 1439`.
   Иначе задача уходит в poll-режим: `schtasks /mo N` считает от момента создания,
   а cron — от начала часа.
5. **POSIX-обёртки, crontab и launchd не исполнялись на реальных Linux/macOS**
   (см. «Ограничения»); синтаксис и экранирование покрыты только тестами.

## GUI и дашборд
- Заголовок динамический: на Windows — «Планировщик Windows», на macOS/Linux — «OpenCode Scheduler».
- Источник заголовка — новый RPC-метод `get_platform` → `{ platform, title }`.
- Заголовок используется и в панели GUI, и в fallback-панели ошибки, и в `<title>/<h1>` веб-дашборда.
- Кнопки, статусы, таблица, DAG и метрики не зависят от ОС.
- Описания инструментов (`schedule_task` и др.) подставляют актуальное название планировщика.

## Сборка и проверки
- `npm run build` — OK, ошибок нет.
- `npm run build:gui` — OK (`gui-experimental.cjs`, ~47.7 kB).
- Проверено в runtime:
  - заголовки для win32/darwin/linux;
  - `cronToLaunchdSchedule` на нескольких выражениях;
  - живой `listTasks()` на Windows — задачи возвращаются короткими именами (без префикса);
  - экранирование `shellQuote` (кавычки, пробелы, кириллица);
  - импорт `dist/index.js` проходит, `dist` не тянет `schtasks.js` напрямую.

## Ограничения и что проверить на реальных машинах
1. `.sh`-обёртки и crontab/launchd **не исполнялись** — на текущей Windows-машине нет `bash`/WSL.
   Синтаксис и экранирование проверены вручную; нужен прогон на Linux и macOS.
2. cron → launchd поддерживает тот же ограниченный набор шаблонов, что и Windows
   (`* * * * *`, `*/N * * * *`, `M * * * *`, `M H * * *`, `M H * * D`).
   На Linux доступен полный cron.
3. Префикс задач Windows теперь `\OpenCode\agent-steward\` (legacy `\OpenCode\windows-scheduler\` по-прежнему распознаётся); id плагина сохранён для обратной совместимости.
4. `src/schtasks.ts` оставлен как тонкий shim для старых скриптов (`test-create.cjs`, `test-run.cjs`),
   вся логика теперь в `core/scheduler/windows.ts`.
