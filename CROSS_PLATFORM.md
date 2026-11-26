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

### Windows
- Tasks are registered in Windows Task Scheduler via `schtasks` under `\OpenCode\agent-steward\` (profiles use `\OpenCode\agent-steward-<profile>\`). The legacy `\OpenCode\windows-scheduler\` folder is still read, renamed and deleted on demand.
- If the OS refuses the operation (`Access is denied` — hardened machines where task registration needs elevation), the same command is retried through a Windows elevation prompt (`ShellExecute` verb `runas`), so OpenCode itself does not have to run as administrator. Only scheduler-changing commands ask for it; reading never does. Disabled with `AGENT_STEWARD_NO_UAC=1` and skipped where no prompt can be shown (services, session 0).
- Wrapper: `run-task.ps1` plus a per-task `run-<name>.cmd` in `%APPDATA%\opencode\agent-steward\wrapper`. The legacy `%APPDATA%\opencode\windows-scheduler` directory is migrated on first start.
- Logs: `%APPDATA%\opencode\agent-steward\logs\<name>.log`.
- cron is converted to schtasks (`convertCronToSchTasks`) — the same pattern set as before.
- The prompt is passed to `opencode run` after `--`, so a prompt beginning with `-`
  cannot be mistaken for a flag. The wrapper rejects prompts longer than 30 000
  characters before `CreateProcess` (32 767-char command-line limit).
- Timeout watchdog: the process tree is read with `Get-CimInstance`; if CIM fails or
  returns nothing, the wrapper falls back to `Get-WmiObject`, then checks
  `tasklist`/`Get-Process`. If no tree data is available it fails closed and runs
  `taskkill /F /T /PID <root>`, so grandchildren are not left running.

### Linux
- Tasks live in a managed `crontab` block:
  ```
  # >>> opencode-scheduler:agent-steward >>>
  # task: my-task
  */5 * * * * /bin/bash '/…/wrapper/run-my-task.sh' >> '/…/logs/my-task.log' 2>&1
  # <<< opencode-scheduler:agent-steward <<<
  ```
  Legacy blocks without the `:<folder>` suffix are still read and removed.
- Pause = a line prefixed with `# PAUSED: ` (the block is rebuilt from the registry).
- Tasks with a `file` trigger never reach crontab — the plugin's FileWatchManager starts them.
- Wrapper: `~/.config/opencode/agent-steward/wrapper/run-<name>.sh` (chmod 0755).
- Full cron syntax (unlike Windows), because crontab understands it natively.
- One-shot (`once`): `at -t`; if `at` is not installed, the plugin falls back to a detached `sleep && command` process (`pid:<pid>` in the registry). The fallback does not survive a reboot — install the `at` package for durable one-shot runs. `at -t` has minute resolution, so seconds in `runAt` are dropped (up to 59 s early); macOS launchd keeps exact seconds via `StartCalendarInterval.Second`.
- Delete/rebuild touches only its own block; other `crontab` lines are left alone.
- An unclosed plugin block (begin marker without end) fails closed: the plugin reports an error and does not rewrite the crontab, so user lines after the marker are never lost.

### macOS
- Tasks are LaunchAgent plists at `~/Library/LaunchAgents/com.opencode.scheduler.<name>.plist`.
- Schedule: `StartInterval` for `* * * * *` and `*/N`, `StartCalendarInterval` for `M * * * *`,
  `M H * * *`, `M H * * D`.
- Pause = `launchctl unload -w` (legacy) or `bootout gui/<uid> <plist>` + `launchctl disable gui/<uid>/<label>` (macOS 13+); resume = `launchctl load -w` or `enable` + `bootstrap gui/<uid> <plist>`.
- Installing a paused task writes the plist but never calls `load -w` (it would
  clear the pause). On legacy macOS `unload -w` writes `Disabled` to the override database, so the agent stays disabled after the next login; on macOS 13+ `bootout` only unloads the agent, therefore the plugin additionally calls `launchctl disable` — without it launchd would load the plist at the next login.
- `launchctl load` failures are not swallowed: the install/resume error carries
  the command, exit code and stderr (e.g. `Invalid property list` for a broken plist).
- Wrapper is the same `.sh` as on Linux; config paths:
  `~/.config/opencode/agent-steward/` (or `$XDG_CONFIG_HOME`).

### Shared POSIX wrapper (`.sh`)
- `cd` into the working directory, `opencode run` with the prompt read from a file.
  The prompt follows `--`, so a leading `-` is not treated as an option.
- The argv backstop rejects `PROMPT_BYTES >= 131072`: Linux `MAX_ARG_STRLEN`
  includes the trailing NUL, so at most 131 071 payload bytes fit.
- Logs are appended with `>>` and prefixed with timestamps.
- Locking via atomic `mkdir` — protects against parallel runs.
- Lock owner is written as `<pid>-<iso>` by Node/PS/bash; legacy `<iso>|<pid>` (PS)
  and bare `<pid>` are still read, so a live lock is never evicted by another runtime.
- On startup the plugin reads the owner of both `<task>.lock` and `<task>.lock.d/pid`:
  a lock directory is evicted only when its PID is dead or missing; age is a fallback.
- Timeout: child process + watchdog (`TERM`, then `KILL`).
- Quality Gate: `bash -lc "<command>"` (the `cmd.exe /c` equivalent on Windows).
- Metrics: `node "<record-history.js>" <task> <status> <started> <duration> <error> "-" "-"` —
  the same contract as the PowerShell wrapper, so history/metrics/retry/chains work everywhere.
- `PATH` is extended with `/opt/homebrew/bin`, `/usr/local/bin`, `~/.local/bin`, `~/.bun/bin`.

## Feature matrix

| Capability | Windows | Linux | macOS |
|---|---|---|---|
| Scheduler backend | `schtasks` | `crontab` | `launchd` LaunchAgents |
| Native cron subset | `* * * * *`, `*/N * * * *` (N ≤ 1439, 60 % N = 0), `M * * * *`, `M H * * *`, `M H * * D` | full cron | same subset as Windows |
| Other cron expressions | minute-poll + schedule gate | native cron | minute-poll + schedule gate |
| `*/N` in day-of-month / day-of-week | not native → poll | native | not native → poll |
| Pause / resume | `schtasks /change /disable` / `/enable` | `# PAUSED:` line in the managed block | legacy `unload -w` / `load -w`; macOS 13+ `bootout` + `disable` / `enable` + `bootstrap` |
| File triggers | in-process `FileWatchManager` | same | same |
| Task wrappers | `.cmd` + `.ps1` | `.sh` | `.sh` |
| Logs | `%APPDATA%\opencode\agent-steward\logs` | `~/.config/opencode/agent-steward/logs` | same as Linux |
| `secrets.key` protection | `icacls` (owner only) + `chmod` fallback | `chmod 0600` | `chmod 0600` |
| Dashboard | `127.0.0.1`, dynamic title | same | same |
| DAG / matrix / quality gates / notifications | in-plugin, OS-independent | same | same |

### Compromises

1. **Minute-poll.** Cron expressions outside the native subset, and tasks with a non-system
   IANA time zone, are started every minute by the OS scheduler; `schedule-gate` decides
   whether the run proceeds. The cost is one short-lived wrapper process per task per minute.
2. **`M H */N * *` is deliberately not converted to `schtasks /sc DAILY /mo N`.**
   Cron counts days from the 1st of each month and resets at month boundaries; `/mo N`
   counts days from the task creation date and does not reset. The two schedules are not
   equivalent, so the expression stays in poll mode. A native variant would require
   `MONTHLY` with an explicit `/d` list, not `DAILY /mo N`.
3. **DST.** The gate works with local wall-clock time. A nonexistent time (spring forward)
   is skipped; an ambiguous time (fall back) runs at the first occurrence.
4. **`*/N * * * *` on Windows** is native only when `60 % N = 0` and `N ≤ 1439`.
   Otherwise the task falls back to poll mode, because `schtasks /mo N` counts from the
   creation moment while cron counts from the start of the hour.
5. **POSIX wrappers, crontab and launchd have not been executed on real Linux/macOS hosts**
   (see Limitations); syntax and escaping are covered by tests only.

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
3. The Windows task prefix is now `\OpenCode\agent-steward\` (legacy `\OpenCode\windows-scheduler\` is still recognized); the plugin id is kept for backwards compatibility.
4. `src/schtasks.ts` remains as a thin shim for old scripts (`test-create.cjs`, `test-run.cjs`);
   all logic now lives in `core/scheduler/windows.ts`.
