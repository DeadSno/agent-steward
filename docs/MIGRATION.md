# Migration guide

How to move existing automation into `agent-steward` (plugin id
`opencode-windows-scheduler`) from cron, systemd
timers, launchd, Windows Task Scheduler, or another scheduler plugin.

- [Before you start](#before-you-start)
- [From cron / crontab](#from-cron--crontab)
- [From systemd timers](#from-systemd-timers)
- [From launchd](#from-launchd)
- [From Windows Task Scheduler](#from-windows-task-scheduler)
- [From another scheduler plugin](#from-another-scheduler-plugin)
- [Bulk import and export](#bulk-import-and-export)
- [Verification checklist](#verification-checklist)
- [Common pitfalls](#common-pitfalls)
- [Rollback](#rollback)

## Before you start

1. **Install and build.**

   ```bash
   npm install -g agent-steward
   ```

   Add the plugin to `opencode.json` and reload OpenCode (V2 reloads config
   automatically; on V1 restart it). If OpenCode's built-in
   schedules are enabled, disable them so two schedulers do not run the same work.

2. **Check Node.** `node --version` must be 22.22+ (the built-in SQLite driver and
   chokidar 6 require 22.22+; Node 24 recommended).

3. **Inventory the old jobs.** For each job write down: name, schedule, command,
   working directory, environment variables, timeout, and what "success" means. The
   last one becomes your Quality Gate.

4. **Do not delete the old jobs yet.** Run both schedulers side by side for a few days,
   then remove the old entries.

## From cron / crontab

Cron expressions are compatible (five fields). The differences are in the command.

**Before (crontab)**

```cron
0 2 * * * cd /srv/api && /usr/bin/git pull && /usr/bin/npm test >> /var/log/api.log 2>&1
```

**After (agent tool or GUI)**

```json
{
  "name": "api-nightly",
  "schedule": "0 2 * * *",
  "workingDirectory": "/srv/api",
  "beforeScript": "git pull --ff-only",
  "prompt": "Inspect the repository, apply safe dependency updates, and explain every change you made.",
  "qualityGate": "npm test",
  "timeoutSeconds": 1800
}
```

Mapping table:

| Cron concept | Scheduler equivalent |
| --- | --- |
| `cd /path && command` | `workingDirectory` or `workspaceId` |
| `>> file 2>&1` | log file is written automatically (`logs/<task>.log`) |
| `&&` chains | `beforeScript`, `prompt`, `qualityGate`, `afterScript` |
| exit code check | Quality Gate |
| `MAILTO` | webhook notifications |
| `%` escapes | not needed; write the prompt as normal text |
| `@reboot` | not supported; use a file/MCP trigger or a frequent cron |

Notes:

- `@daily`, `@hourly` and similar macros are not supported — write `0 0 * * *`,
  `0 * * * *`, and so on.
- `@reboot` and `@yearly` have no direct equivalent.
- Cron environments are minimal. The wrapper inherits the user environment of the OS
  scheduler entry, not your interactive shell. Absolute paths are safer than relying on
  `PATH` from `.bashrc`.

## From systemd timers

The plugin schedules through the user crontab on Linux, so systemd calendar syntax is
translated to a cron expression when you migrate.

**Before**

```ini
# api-nightly.timer
[Timer]
OnCalendar=*-*-* 02:00:00
Persistent=true
```

```ini
# api-nightly.service
[Service]
WorkingDirectory=/srv/api
ExecStart=/usr/bin/npm run nightly
```

**After**

```json
{
  "name": "api-nightly",
  "schedule": "0 2 * * *",
  "workingDirectory": "/srv/api",
  "prompt": "Run the nightly routine described in package.json and summarize the result.",
  "qualityGate": "npm test"
}
```

| systemd | Scheduler |
| --- | --- |
| `OnCalendar=*-*-* 02:00` | `0 2 * * *` |
| `OnUnitActiveSec=15min` | `*/15 * * * *` |
| `WorkingDirectory` | `workingDirectory` / `workspaceId` |
| `Environment=` | set it in the hook or in the user environment |
| `TimeoutStartSec` | `timeoutSeconds` |
| `Persistent=true` | catch-up is not implemented; a missed window is skipped |
| `Requires=` / `After=` | `dependsOn` |

Disable the old units (`systemctl --user disable --now api-nightly.timer`) only after
the new task has run successfully at least once.

## From launchd

**Before**

```xml
<key>StartCalendarInterval</key>
<dict><key>Hour</key><integer>2</integer></dict>
```

**After**

```json
{
  "name": "mac-nightly",
  "schedule": "0 2 * * *",
  "workingDirectory": "/Users/me/projects/api",
  "prompt": "Run the nightly maintenance and report anything unusual."
}
```

| launchd | Scheduler |
| --- | --- |
| `StartCalendarInterval` | cron expression |
| `StartInterval` (seconds) | `*/N * * * *` (minute granularity) |
| `WorkingDirectory` | `workingDirectory` |
| `StandardOutPath` / `StandardErrorPath` | automatic log file |
| `RunAtLoad` | not supported; use a manual run or a file trigger |

## From Windows Task Scheduler

Existing tasks usually point to a `.bat`/`.ps1` file or a command line.

**After**

```json
{
  "name": "win-nightly",
  "schedule": "0 2 * * *",
  "workingDirectory": "C:\\projects\\api",
  "prompt": "Run the nightly maintenance for this repository.",
  "qualityGate": "npm test"
}
```

| Task Scheduler | Scheduler |
| --- | --- |
| Trigger "Daily" | `0 2 * * *` |
| Trigger "At log on" | not supported; use a file trigger or a start-up hook |
| "Run whether user is logged on" | the plugin registers tasks in the current user context |
| "Stop task if it runs longer than" | `timeoutSeconds` |
| "If the task is already running" | lock file, the second run is `skipped` |
| Action "Start a program" | you describe the goal in a prompt instead of a command |
| Multiple actions | `beforeScript` + `prompt` + `qualityGate` + `afterScript` |

Delete the old task only after verifying the new one:
`schtasks /delete /tn "<old task>" /f`.

## From another scheduler plugin

There is no universal importer, because definition formats differ. The workflow is:

1. List the old jobs and copy their schedules, prompts and working directories.
2. Recreate them with `schedule_task` or the GUI.
3. If the old plugin exports JSON, transform it into the import format below and use
   `import_tasks` — validation reports per-record errors.
4. Disable the old plugin before the first overlapping run.

## Bulk import and export

**Export format**

```json
{
  "version": 1,
  "exportedAt": "2026-01-01T00:00:00.000Z",
  "tasks": [
    {
      "name": "api-nightly",
      "schedule": "0 2 * * *",
      "prompt": "Nightly maintenance.",
      "qualityGate": "npm test",
      "workspaceId": "ws-api"
    }
  ]
}
```

**Import**

Use `import_tasks` from the GUI or the RPC layer. Rules:

- `name` and `prompt` are required.
- `cron` tasks need a schedule; `file` tasks need `watchPath`; `mcp-event` tasks need
  `mcpEvent.event`.
- Matrix tasks cannot also set `workspaceId`, and `matrix.workspaceIds` must not be
  empty.
- Workspace ids must exist in the target installation, or the record is rejected.
- Errors are reported per record; valid records are imported.

Workspaces are not exported as directories — recreate them with
`manage_workspaces` first, then map old paths by hand.

## Verification checklist

For every migrated job:

1. `dry_run` with the task name — check order, dependencies and estimated time.
2. `run_task_now` — confirm the log shows the expected work.
3. Check the Quality Gate result in `get_history`.
4. Confirm the next scheduled run appears with a correct "next run" timestamp.
5. For matrix jobs, expand the parent in the dashboard and verify every clone has the
   right workspace path.
6. Wait for at least one natural scheduled run before deleting the old definition.

## From `opencode-windows-scheduler` to `agent-steward` (package rename)

The npm package `opencode-windows-scheduler` was renamed to `agent-steward` at milestone
**Д7** (release `agent-steward@0.0.2`). This section covers the rename migration only — task definitions, schedules,
history and settings are **unchanged**.

### What changes

| Item | Before (`opencode-windows-scheduler`) | After (`agent-steward`) |
|------|--------------------------------------|-------------------------|
| npm package name | `opencode-windows-scheduler` | `agent-steward` |
| GitHub repository | `DeadSno/opencode-windows-scheduler` | `DeadSno/agent-steward` |
| Install command | `opencode plugin add opencode-windows-scheduler` | `opencode plugin add agent-steward` |
| V1 config key | `"plugin": ["opencode-windows-scheduler"]` | `"plugin": ["agent-steward"]` |
| V2 config key | `"plugins": ["opencode-windows-scheduler"]` | `"plugins": ["agent-steward"]` |
| `plugin id` | `opencode-windows-scheduler` | same (unchanged) |
| State paths | `%APPDATA%\opencode\windows-scheduler` / `~/.config/opencode/windows-scheduler` | `%APPDATA%\opencode\agent-steward` / `~/.config/opencode/agent-steward` (migrated automatically) |
| Windows task folder | `\OpenCode\windows-scheduler\` | `\OpenCode\agent-steward\` (legacy folder still recognized) |

**The npm package name, config entries and user-facing data/task paths changed.**
The plugin id, SQLite filename and log file names stay the same. On first start the
legacy state directory is copied to the new location and absolute paths in settings
are rewritten; existing tasks and history are preserved.

### Migration steps

1. **Update the OpenCode config** (`opencode.jsonc`) — the value is the npm package
   name, so it changes to `agent-steward`:

   V1:
   ```jsonc
   {
     "$schema": "https://opencode.ai/config.json",
     "plugin": ["agent-steward"]
   }
   ```

   V2:
   ```jsonc
   {
     "$schema": "https://opencode.ai/config.json",
     "plugins": ["agent-steward"]
   }
   ```

   The `plugin id` reported by the plugin remains `opencode-windows-scheduler`.
   OpenCode V2 reloads the config automatically (use `/reload` if needed); on V1
   restart OpenCode after saving.

2. **Install from the new package**:

   ```bash
   opencode plugin add agent-steward
   ```

   Existing installations that still list `opencode-windows-scheduler` keep working
   until the thin re-export wrapper is deprecated.

3. **Old package (`opencode-windows-scheduler`)** — remains published as a thin
   re-export wrapper around `agent-steward` for one major version. It receives only
   critical patches. No action required if you already have it installed; it will
   continue to work until `npm deprecate` (planned for `>= 2.1`, after download parity
   with the new package).

4. **Verify** — run `dry_run` on any existing task and confirm it executes. Check
   `get_history` for the latest runs. Task behaviour should not change; after the first
   start your data appears in the new state directory.

### Rollback

The `plugin id`, SQLite filename and log names are identical before and after the
rename, so the plugin itself needs no rollback. If you prefer the old npm package name,
switch the config entry back to `opencode-windows-scheduler` while the thin re-export is
still published. Note that `agent-steward` is the authoritative state directory after
migration: copy it back to the legacy path if the old package must read the migrated
data.


## Local AI / triage migration

If you are migrating from a setup that used cloud AI for lightweight task triage or
classification, you can move that load to a local model to save tokens:

1. Install Ollama: `ollama serve` and `ollama pull qwen3:4b` (or a smaller model for
   RAM-constrained machines — see `docs/LOCAL-AI.md` for tier recommendations).
2. Configure triage via `manage_local_ai({action: "update", mode: "auto", ...})` or
   through the GUI notifications panel.
3. Start in `shadow` mode so decisions are logged but not applied, then switch to `auto`
   once confidence is acceptable.
4. Ollama is optional — if it is unavailable, the plugin falls back to rules-only mode
   (fail-open) and never blocks notifications.

## Common pitfalls

| Symptom | Cause | Fix |
| --- | --- | --- |
| `skipped` in history | previous run still holds the lock | wait, or lower `timeoutSeconds` |
| `timeout` every run | the agent needs more time | raise `timeoutSeconds` |
| Quality Gate fails but the work looks fine | gate runs in the task directory, not a subdirectory | prefix the command with `cd subdir && ...` |
| Agent cannot find the project | no `workingDirectory`/`workspaceId`, so it ran in the plugin directory | set the working directory |
| "Workspace path does not exist" on import | workspace ids belong to another machine | recreate workspaces and remap ids |
| Two runs at once after migration | old scheduler is still enabled | disable the old job |
| Cron rejected | expression not expressible by `schtasks` | use a supported pattern (`*/N`, fixed minute/hour, weekdays) |
| Prompts behave differently at night | interactive shell environment vs scheduler environment | use absolute paths, avoid alias-dependent commands |
| Local AI (Ollama) unreachable | `manage_local_ai` test fails or triage falls back to rules | run `ollama serve`, `ollama pull <model>`, check `OLLAMA_CONTEXT_LENGTH` |
| Local AI confidence too low | rules fire instead of LLM, more tokens used than expected | raise `confidenceThreshold` in `manage_local_ai`, review rule reasons in audit |


## Rollback

If something goes wrong:

1. Re-enable the old jobs (they were never deleted).
2. `pause_task` the migrated ones, or delete them.
3. Export the plugin definitions before major changes: `export_tasks` gives a single
   JSON file you can re-import on any machine.

Definitions live in `scheduler.db`; deleting the plugin directory removes all state.
Export first if you might want it back.
