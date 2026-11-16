# Cross-platform: Windows → macOS → Linux

The plugin is no longer tied to `schtasks`. The scheduler is an abstract layer with
three implementations, and run wrappers are generated for the target OS.

Translations: [Русский](docs/CROSS_PLATFORM.ru.md) · [中文](docs/CROSS_PLATFORM.zh.md)

## Architecture

```
src/
  index.ts                     # tools, RPC, plugin lifecycle
  gui.tsx                      # GUI panel (title comes from RPC)
  server.ts                    # web dashboard (dynamic title)
  core/
    scheduler/
      types.ts                 # SchedulerBackend, CreateTaskOptions, RunTaskResult
      index.ts                 # factory createSchedulerBackend() + getSchedulerTitle()
      windows.ts               # WindowsScheduler  (schtasks)
      linux.ts                 # LinuxScheduler    (crontab)
      mac.ts                   # MacScheduler      (launchd / LaunchAgents)
      posix.ts                 # shared base for Linux/macOS (task registry)
      registry.ts              # persistent task registry for POSIX backends
      logs.ts                  # cross-platform task log reader
    wrappers/
      bash.ts                  # .sh wrapper generator for Linux/macOS
    ps-wrapper.ts              # .ps1/.cmd wrappers for Windows (unchanged)
    record-history.ts          # metrics/history + retry/chains (via backend)
    cron-to-schtasks.ts        # cron → schtasks (Windows only)
```

### Interface

```ts
interface SchedulerBackend {
  readonly platform: NodeJS.Platform;
  readonly title: string;              // "Windows Task Scheduler" / "OpenCode Scheduler"
  createTask(options: CreateTaskOptions): Promise<void>;
  deleteTask(name: string): Promise<void>;
  runTask(name: string): Promise<RunTaskResult>;
  listTasks(): Promise<ScheduledTaskInfo[]>;
  pauseTask(name: string): Promise<void>;
  resumeTask(name: string): Promise<void>;
}
```

The factory picks an implementation from `process.platform`:
`win32 → WindowsScheduler`, `darwin → MacScheduler`, everything else → `LinuxScheduler`.

## How each OS works

### Windows (behaviour unchanged)
- Tasks are registered in Windows Task Scheduler via `schtasks` under `\OpenCode\windows-scheduler\`.
- Wrapper: `run-task.ps1` plus a per-task `run-<name>.cmd` in `%APPDATA%\opencode\windows-scheduler\wrapper`.
- Logs: `%APPDATA%\opencode\windows-scheduler\logs\<name>.log`.
- cron is converted to schtasks (`convertCronToSchTasks`) — the same pattern set as before.

### Linux
- Tasks live in a managed `crontab` block:
  ```
  # >>> opencode-scheduler >>>
  # task: my-task
  */5 * * * * /bin/bash '/…/wrapper/run-my-task.sh' >> '/…/logs/my-task.log' 2>&1
  # <<< opencode-scheduler <<<
  ```
- Pause = a line prefixed with `# PAUSED: ` (the block is rebuilt from the registry).
- Tasks with a `file` trigger never reach crontab — the plugin's FileWatchManager starts them.
- Wrapper: `~/.config/opencode/windows-scheduler/wrapper/run-<name>.sh` (chmod 0755).
- Full cron syntax (unlike Windows), because crontab understands it natively.
- Delete/rebuild touches only its own block; other `crontab` lines are left alone.

### macOS
- Tasks are LaunchAgent plists at `~/Library/LaunchAgents/com.opencode.scheduler.<name>.plist`.
- Schedule: `StartInterval` for `* * * * *` and `*/N`, `StartCalendarInterval` for `M * * * *`,
  `M H * * *`, `M H * * D`.
- Pause = `launchctl unload -w`, resume = `launchctl load -w`.
- Wrapper is the same `.sh` as on Linux; config paths:
  `~/.config/opencode/windows-scheduler/` (or `$XDG_CONFIG_HOME`).

### Shared POSIX wrapper (`.sh`)
- `cd` into the working directory, `opencode run` with the prompt read from a file.
- Logs are appended with `>>` and prefixed with timestamps.
- Locking via atomic `mkdir` — protects against parallel runs.
- Timeout: child process + watchdog (`TERM`, then `KILL`).
- Quality Gate: `bash -lc "<command>"` (the `cmd.exe /c` equivalent on Windows).
- Metrics: `node "<record-history.js>" <task> <status> <started> <duration> <error> "-" "-"` —
  the same contract as the PowerShell wrapper, so history/metrics/retry/chains work everywhere.
- `PATH` is extended with `/opt/homebrew/bin`, `/usr/local/bin`, `~/.local/bin`, `~/.bun/bin`.

## GUI and dashboard
- The title is dynamic: "Windows Task Scheduler" on Windows, "OpenCode Scheduler" on macOS/Linux.
- The title comes from the `get_platform` RPC method → `{ platform, title }`.
- The title is used in the GUI panel, in the error fallback panel, and in the dashboard `<title>/<h1>`.
- Buttons, statuses, tables, DAG and metrics do not depend on the OS.
- Tool descriptions (`schedule_task` and others) substitute the actual scheduler name.

## Build and checks
- `npm run build` — OK, no errors.
- `npm run build:gui` — OK (`gui-experimental.cjs`, ~47.7 kB).
- Verified at runtime:
  - titles for win32/darwin/linux;
  - `cronToLaunchdSchedule` on several expressions;
  - live `listTasks()` on Windows — tasks come back with short names (no prefix);
  - `shellQuote` escaping (quotes, spaces, Cyrillic);
  - `dist/index.js` imports fine, `dist` does not pull `schtasks.js` directly.

## Limitations and what to verify on real machines
1. `.sh` wrappers and crontab/launchd were **never executed** — the current Windows box has no
   `bash`/WSL. Syntax and escaping were checked by hand; a run on Linux and macOS is still needed.
2. cron → launchd supports the same limited pattern set as Windows
   (`* * * * *`, `*/N * * * *`, `M * * * *`, `M H * * *`, `M H * * D`).
   Linux gets full cron.
3. The Windows task prefix (`\OpenCode\windows-scheduler\`) and the plugin id are kept for backwards compatibility.
4. `src/schtasks.ts` remains as a thin shim for old scripts (`test-create.cjs`, `test-run.cjs`);
   all logic now lives in `core/scheduler/windows.ts`.
