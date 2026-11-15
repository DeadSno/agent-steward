# Architecture

This document explains how `opencode-windows-scheduler` is put together: the process
model, the modules, the data model and the extension points.

- [Design principles](#design-principles)
- [Process model](#process-model)
- [Data flow](#data-flow)
- [Modules](#modules)
- [Scheduling backends](#scheduling-backends)
- [Run wrapper](#run-wrapper)
- [History, metrics and recovery](#history-metrics-and-recovery)
- [Chains, retries and DAG](#chains-retries-and-dag)
- [Matrix builds](#matrix-builds)
- [Workspaces](#workspaces)
- [Triggers](#triggers)
- [Storage](#storage)
- [Interfaces](#interfaces)
- [Localization](#localization)
- [Security model](#security-model)
- [Extension points](#extension-points)

## Design principles

1. **The OS scheduler owns time.** The plugin never keeps a timer in memory for cron
   jobs. Every recurring task becomes a real OS entry (Task Scheduler, launchd,
   crontab), so jobs survive reboots and closed editor windows.
2. **The host process owns the UI.** Agent tools, the sidebar GUI, the RPC layer and the
   dashboard live inside the OpenCode plugin host. They are stateless wrappers around
   the database and the OS scheduler.
3. **Runs are independent processes.** A job executes `opencode run` through a wrapper
   that enforces timeout, single-instance locking, pre/post hooks and a Quality Gate.
   The wrapper reports the result back to the database, not to the plugin host.
4. **One source of truth for definitions is SQLite.** OS entries are derived artifacts:
   they can always be recreated from the database with export/import.
5. **Local first.** No network services, no telemetry, no accounts. The dashboard binds
   to localhost only.

## Process model

```
┌─────────────────────────────┐
│ OpenCode (plugin host)      │
│  • agent tools (12)         │
│  • sidebar GUI (gui.tsx)    │
│  • RPC ↔ sidebar            │
│  • dashboard HTTP server    │
│  • chokidar file watcher    │
└──────────┬──────────────────┘
           │ creates / updates
           ▼
┌─────────────────────────────┐        ┌──────────────────────────────┐
│ OS scheduler                │        │ SQLite (scheduler.db)        │
│ Windows Task Scheduler      │        │ tasks, history, metrics,     │
│ launchd / crontab           │        │ templates, settings,         │
└──────────┬──────────────────┘        │ workspaces                   │
           │ fires                   │ └──────────────────────────────┘
           ▼                         │            ▲
┌─────────────────────────────┐      │            │ writes
│ Run wrapper (.cmd / .sh)    │      │            │
│  • lock                     │      │  ┌─────────┴──────────────┐
│  • timeout                  │      └──│ recorder process       │
│  • pre-flight hook          │         │ core/record-history.js │
│  • opencode run ...         │────────▶│  • history / metrics   │
│  • Quality Gate             │         │  • retries, chains     │
│  • post-flight hook         │         │  • DAG dependents      │
└─────────────────────────────┘         │  • matrix continuation │
                                        └────────────────────────┘
```

There are four kinds of processes:

| Process | Lifetime | Responsibility |
| --- | --- | --- |
| Plugin host | OpenCode session | Register tools/skill, create OS entries, serve RPC and dashboard, watch files |
| OS scheduler | Always | Fire jobs on schedule or on demand |
| Run wrapper | Per run | Lock, timeout, hooks, Quality Gate, invoke `opencode run`, call the recorder |
| Recorder | Per run (short) | Persist history/metrics, schedule retries, trigger chains and dependents, continue matrices |

Because the recorder is a separate short-lived process, it cannot rely on in-memory
state of the plugin host. Everything it needs (definitions, retry state, matrix queue)
is read from the database or from files under the plugin directory.

## Data flow

**Create a task**

1. Agent tool / GUI / import calls `schedulerCreateTask(...)`.
2. Definitions are validated (cron, workspace path, matrix rules), a prompt file and a
   wrapper script are written under the plugin directory; if the task's workspace has
   env variables, `<PLUGIN_DIR>/env/<sanitized>.env` is written (mode `0600` on POSIX).
3. An OS entry is created through the platform backend.
4. The definition is stored in `tasks.definition_json`.

**Run a task**

1. The OS scheduler starts the wrapper.
2. When the task carries a schedule gate (poll-mode cron, foreign timezone or a
   launch window), the wrapper first runs `node dist/core/schedule-gate.js`: it
   re-checks the extended cron in the task's zone, and if now is outside the
   launch window it waits until the window opens (postpone, deduplicated by a
   defer-file) or exits with code 3 so the wrapper skips silently.
3. The wrapper acquires the lock (`locks/<task>.lock`), writes the log
   (`logs/<task>.log`), loads workspace env from `<PLUGIN_DIR>/env/<sanitized>.env`
   (Windows `-EnvFile`, POSIX `set -a; . "$ENV_FILE"; set +a`) before starting
   `opencode run` with the prompt file. Output is streamed to the log.
4. When the process ends, the wrapper enforces the timeout result, runs the Quality
   Gate and the post-flight hook.
5. The wrapper calls `node dist/core/record-history.js --finish ...` with status,
   duration, tokens, cost, model and hook results.
6. The recorder writes `history` and updates `metrics`, then evaluates retries, task
   chains, DAG dependents and matrix continuation.

**Read state**

`collectTasksView()` (shared by tools, RPC and GUI) merges definitions, the latest
history record and metrics into a `TaskItem`. Matrix parents get an aggregated status
from their clones instead of their own last run.

## Modules

| Path | Role |
| --- | --- |
| `src/index.ts` | Plugin lifecycle, 24 agent tools, RPC handlers, task CRUD, view assembly |
| `src/rpc.ts` | JSON-schema contracts for every RPC method |
| `src/gui.tsx` | OpenCode sidebar panel (SolidJS, built to `gui-experimental.cjs`) |
| `src/server.ts` | Local web dashboard HTTP server and HTML rendering |
| `src/skill.ts` | Loads and registers the bundled agent skill |
| `src/task-transfer.ts` | Export/import, validation, `MatrixConfig` types |
| `src/profiles.ts` | Profile directory resolution: per-profile plugin dir (base for `default`, `<base>/profiles/<name>` for named profiles); profile name, marker, port, create/delete/switch |
| `src/workspaces.ts` | Workspace registry and path validation; env pairs and `.env` file resolution with secret masking |
| `src/templates.ts` | Reusable task templates |
| `src/settings.ts` | Plugin settings: notifications, history retention, audit, interface locale |
| `src/i18n.ts` | Interface locale (`ru` default, `en`), JSON catalogs in `locales/`, ICU subset (`{param}`, `plural`) via built-in `Intl`, fallback to `ru` |
| `src/notifications.ts` | Multi-channel delivery (webhook, Telegram, native OS) with retries/backoff, templates, task filters, quiet hours, matrix and stuck-clone notifications, daily/weekly digest |
| `src/core/telegram.ts` | Telegram Bot API `sendMessage`: parse-mode escaping, dashboard link, token validation and masking |
| `src/core/native-notify.ts` | Native OS notifications: Windows Toast (PowerShell/WinRT), macOS `osascript`, Linux `notify-send`; no external dependency |
| `src/core/secrets.ts` | Encrypted secret store (AES-256-GCM, `secrets.key` 0600, `${secret:NAME}` refs, redaction) |
| `src/core/audit.ts` | SQLite audit journal (`audit_log`), redacted details, retention cleanup |
| `src/history.ts` | History model and status types |
| `src/version.ts` | Runtime plugin version (reads package.json) |
| `src/core/retention.ts` | Daily history prune and incremental vacuum |
| `src/core/analytics.ts` | Pure 14-day analytics and CSV export |
| `src/core/scheduler/` | Platform backends, registry, logs |
| `src/core/ps-wrapper.ts` | PowerShell wrapper template and `.cmd` generation |
| `src/core/wrappers/bash.ts` | POSIX wrapper template |
| `src/core/record-history.ts` | Recorder: history, retries, chains, DAG, matrix continuation |
| `src/core/matrix.ts` | Fan-out, aggregation, sync, cancel, orphan cleanup |
| `src/core/dry-run.ts` | Pipeline simulation (no execution) |
| `src/core/lock.ts` | Single-instance lock manager |
| `src/core/file-watcher.ts` | chokidar-based file triggers |
| `src/core/cron-to-schtasks.ts` | Cron → Task Scheduler translation |
| `src/core/schedule-v2.ts` | Extended cron parser/matcher, timezone math, launch windows, poll-mode decisions |
| `src/core/schedule-gate.ts` | Wrapper-side gate: cron re-check (poll mode), window postpone, defer-file |
| `src/db/` | SQLite access: schema, migrations, repositories, recovery |
| `src/shared/jobs-view.ts` | Task view shared by the GUI and dashboard |

## Scheduling backends

`scheduler/registry.ts` keeps the mapping between a task name and its OS entry.
`scheduler/index.ts` picks a backend from `process.platform`.

| Platform | Backend | Notes |
| --- | --- | --- |
| Windows | `schtasks.exe` | Cron is translated to `MINUTE/HOURLY/DAILY/WEEKLY/MONTHLY` flags; non-cron triggers are registered as `ONCE` at `31.12.2099` |
| Linux | `crontab` | Task lines with the plugin marker are rewritten via `crontab -` |
| macOS | `launchd` | `StartCalendarInterval` plists |
| POSIX fallback | `crontab` | Used when launchd is unavailable |

File and MCP triggers are not time-based. They are still registered as a far-future
one-shot entry so that `runMatrix`, DAG dependencies and manual runs can start them,
while the OS never fires them on its own. File triggers are additionally watched by
chokidar inside the plugin host.

## Run wrapper

The wrapper is generated per task and is the only place where execution policy is
enforced:

| Concern | Implementation |
| --- | --- |
| Working directory | Task `workingDirectory`, or the workspace path, or the plugin directory |
| Prompt | Written to a prompt file, passed to `opencode run` |
| Timeout | `timeoutSeconds`; on expiry the child process tree is stopped and the run is marked `timeout` |
| Workspace env | Variables from the workspace's `.env` file and explicit pairs are injected before `opencode run` (wrapper `env:` / `export`); secret-looking keys are masked in logs |
| No overlap | Lock file per task; a second start exits immediately and records `skipped` |
| Pre-flight | `beforeScript`; non-zero exit marks `preFlight` as failed |
| Quality Gate | `qualityGate` after a successful run; non-zero exit turns the run into an error |
| Post-flight | `afterScript`; non-zero exit is reported but does not rewrite a success |
| Logging | Append-only log per task under `logs/` |
| History | Calls the recorder with `--start` and `--finish` |

Windows uses PowerShell and `.cmd` shims; POSIX uses bash. Both wrappers are generated
from templates so the policy stays identical across platforms.

## History, metrics and recovery

`history` stores one row per run: status (`running`, `success`, `error`, `timeout`,
`partial`), start/finish timestamps, duration, error text, tokens, cost, model,
pre/post-flight results, the chained next task, workspace and tool restrictions.
`metrics` holds per-task counters and totals.

If the host or the machine dies mid-run, the row stays in `running`. On the next
plugin activation, `db/recovery.ts` marks stale `running` rows as `error`, so the UI
never shows a permanently running task.

History is bounded by retention: `settings.json` carries `history.retentionDays` and
`history.maxRecords` (defaults 30 / 5000, `0` disables). Cleanup runs at most once a
day on plugin start (`core/retention.ts`), prunes only finished rows via
`pruneHistory` in `db/history-repo.ts`, then `PRAGMA incremental_vacuum` frees space.
Aggregates in `metrics` are never pruned. Period analytics (per-day buckets, success
rate, tokens, cost, matrix/model breakdowns) are computed by `core/analytics.ts` and
exposed as `get_analytics` / `GET /api/analytics`; the dashboard renders a 14-day
block and `GET /api/history/export` serves CSV/JSON.

## Chains, retries and DAG

All three are evaluated by the recorder after a run finishes:

- **Retries** — `retryCount`/`retryDelay` with a retry-state file so a crash cannot
  loop forever. Retries are attempted before chains and dependents.
- **Chains** — `nextTaskOnSuccess` / `nextTaskOnError` start exactly one follow-up task.
- **DAG** — `dependsOn` is satisfied only when every dependency's latest run is
  successful. For a matrix dependency, all clones must be successful; the parent's own
  aggregate record is not enough.

`selectDependentsToTrigger(taskName, definitions, history)` is a pure function, which
keeps the rules testable.

## Matrix builds

A matrix task is a template, not a runnable job:

1. `expandMatrixTask(parent)` produces one clone per workspace:
   `<parent>-matrix-<workspace>`, each with its own `workspaceId`, `matrixParentId`,
   a file trigger and per-workspace overrides applied.
2. `runMatrix(parent)` starts clones according to `strategy` (`parallel`/`sequential`)
   and `concurrency`; extra clones wait in `matrixQueue` persisted on the parent.
3. On each clone completion, the recorder calls `advanceMatrixAfterClone` (drain the
   queue or start the next sequential clone) and `finalizeMatrixIfComplete`.
4. `aggregateMatrixResults(parent)` derives `success` / `error` / `partial` / `running` /
   `empty` from clone history.
5. `syncMatrixFamily(parent)` diffs existing clones against a fresh expansion on update:
   missing clones are created, changed clones are updated, extra clones are removed.
   Clones whose latest run is `running` are never touched.

The parent is registered in the OS scheduler as a far-future one-shot entry only so it
can be addressed by name; it never fires on its own.

## Workspaces

A workspace is a named directory (usually a git repository) with an id, path, optional
remote and color. Workspaces provide:

- the working directory for a task (`workspaceId` instead of `workingDirectory`);
- matrix targets (`matrix.workspaceIds`);
- per-workspace overrides (`matrix.overrides`);
- dashboard grouping;
- env variables: explicit `KEY=VALUE` pairs plus an optional `.env` file (loaded first,
  explicit pairs override), injected into task runs via the wrapper; secret-looking
  keys are masked in logs.

Paths are validated on creation, update and import: a workspace must point to an
existing directory. Env keys must match `^[A-Za-z_][A-Za-z0-9_]*$`; max 100 pairs.

## Triggers

| Trigger | How it fires |
| --- | --- |
| `cron` | OS scheduler on the translated schedule |
| `file` | chokidar watches `watchPath`; debounced change starts the task |
| `git` | Polls `HEAD` in the task working directory; runs when new commits match branch/path/ignore filters |
| `mcp-event` | `emit_event` RPC/tool matches server + event and starts subscribers |

Cron expressions are standard 5-field. The Windows backend supports the subset that
`schtasks` can express; unsupported shapes are rejected at creation time with a clear
error instead of silently drifting.

## Storage

Everything lives under the plugin directory:

| Platform | Path |
| --- | --- |
| Windows | `%APPDATA%\opencode\windows-scheduler` |
| macOS/Linux | `$XDG_CONFIG_HOME/opencode/windows-scheduler` (default `~/.config/...`) |

```
scheduler.db      SQLite database (WAL)
logs/             per-task run logs
locks/            lock files
wrappers/         generated .cmd / .sh wrappers
prompts/          prompt files
env/              per-workspace env files (<task>.env), mode 0600 on POSIX
```

Named profiles (Sprint 21) each own a copy of this tree under
`<base>/profiles/<name>` (`default` uses the base directory). Profile directory,
database, settings, logs, wrappers and locks all resolve per-profile.

Override the database location with `OPENCODE_SCHEDULER_DB` (used by tests). Override
the whole plugin directory (database, logs, locks, wrappers, prompts) with
`OPENCODE_SCHEDULER_HOME` on any platform. Profile selection uses
`OPENCODE_SCHEDULER_PROFILE` > `active-profile` marker > `default`.

Schema evolution is additive: `applySchema` runs `CREATE TABLE IF NOT EXISTS` on every
connection and adds missing columns after `PRAGMA table_info`, so upgrading the plugin
never requires a manual migration.

## Interfaces

| Interface | Audience | Entry point |
| --- | --- | --- |
| Agent tools | AI agent | 24 tools registered via `ctx.tool.transform` |
| Agent skill | AI agent | `skills/scheduled-job-best-practices` |
| RPC | Sidebar GUI | `src/rpc.ts` contracts, ~30 methods |
| Sidebar GUI | Human | `gui-experimental.cjs` |
| Web dashboard | Human | `startDashboardServer` (localhost, random/fixed port) |

## Localization

User-visible text lives in flat JSON catalogs: `locales/ru.json` (default) and
`locales/en.json`. Keys are dot-separated and grouped by surface — `gui.*`, `notify.*`,
`tool.*`, `dryRun.*`, `matrix.*`, `schedule.*` — and both catalogs must have the same
key set with non-empty values.

`src/i18n.ts` loads the catalogs once and caches them. It exposes `t(key, params)`,
`setLocale(locale)`, `messageIn(locale, key)` and `hasKey(key, locale)`. Lookup order is
active locale → `en` → `ru` → the key itself, so a missing translation never renders as
an empty string. The `locale` setting (`ru` default, `en` optional) is applied
immediately, without restarting OpenCode. The sidebar GUI embeds the catalogs at build
time via `registerCatalog`, because a webview bundle cannot read package files at
runtime.

The template subset is deliberately small and dependency-free:

- `{name}` — interpolation; the caller formats the value (duration, money, date).
- `{count, plural, one {…} few {…} many {…} other {…}}` — plural forms through
  `Intl.PluralRules` for the active locale (`ru` uses one/few/many, `en` one/other).

Rules:

- a user-visible message is a whole phrase in the catalog, including punctuation; never
  concatenate translated fragments;
- store stable codes, not localized text, in the database; translate at render time;
- agent tool descriptions, schemas and API payloads stay English; `console.*`
  diagnostics stay Russian;
- add every new key to both catalogs. `test-docs.mjs` enforces parity and non-empty
  values; `npm run test:en` replays all suites under `en` and CI runs it on Linux.
  `OPENCODE_SCHEDULER_LOCALE` only overrides the initial locale for tests and services —
  it is not a user-facing setting.

## Security model

- The dashboard has **no authentication** and binds to localhost. Do not expose it.
- A job definition is **code**: prompts, hooks, Quality Gates and wrappers all execute
  with your user privileges. Treat task creation like granting shell access.
- `allowedTools` / `deniedTools` are **enforced at the run-wrapper level** (спринт 29.2).
  Before each `opencode run`, the wrapper passes `permissions` rules through
  `OPENCODE_CONFIG_CONTENT`: `deniedTools` are mapped to `effect: "deny"` for the
  corresponding OpenCode action (`shell`, `edit`, `glob`, `grep`, `webfetch`,
  `websearch`, `question`, `subagent`, `skill`), and `allowedTools` (if specified)
  additionally denies every action not in the list. No config file is written, so a
  project-level `opencode.jsonc` is preserved and parallel tasks in one workdir do not
  race. The wrapper passes `--auto` so non-denied permissions are auto-approved.
  `allowedTools`/`deniedTools` metadata is still recorded in history for audit.
- **Audit of blocked tools (спринт 29.4):** when a task definition is saved,
  `recordTaskToolBlocks()` writes one `tool.blocked` audit event per entry in
  `deniedTools` (`target` = task name, `details.tool` = tool, plus `allowedTools`,
  `deniedTools` and `reason`). In allow-list mode one event with `tool: "*"` records
  that every unlisted tool is denied. The event is emitted on create and on update, so
  changing the task policy also changes the audited details. Because the wrapper runs
  `opencode` as an external process, the plugin cannot observe individual blocked
  attempts at runtime; the audit reflects the enforced policy, not each refusal.
- Task prompts, hooks and Quality Gate scripts are **plain text** executed with your
  user privileges; only secrets (in `secrets.json`, AES-256-GCM) are encrypted.
  Workspace `env` can reference secrets as `${secret:NAME}`; values are masked in
  logs, history and audit. Treat task creation like granting shell access.
- Secrets are stored encrypted in `<PLUGIN_DIR>/secrets.json` (AES-256-GCM) with a
  32-byte key file `secrets.key` (rights 0600). Workspace `env` can reference them
  as `${secret:NAME}`; values are substituted at run time and masked in logs,
  history and audit.
- Workspace paths are validated, but hooks are not sandboxed: only schedule jobs from
  repositories you trust.

### Permission model

The effective policy is resolved in this order (later wins):

1. Task `allowedTools` — if present, every action not listed is denied.
2. Task `deniedTools` — always denied and takes priority over `allowedTools`.
3. The generated `opencode.jsonc` — written into the task workdir for the run.
4. Project `opencode.json(c)` and system config — merged by OpenCode; a closer or
   system-level config can weaken task-scoped denies (see limitations below).
5. `--auto` — auto-approves everything that remains, so no interactive prompts block
   an unattended run.

Tool mapping used by both wrappers:

| Task tool | OpenCode action |
| --- | --- |
| `bash`, `shell` | `shell` |
| `write`, `edit`, `apply_patch`, `remove` | `edit` |
| `glob`, `grep`, `webfetch`, `websearch` | same name |
| `question`, `subagent`, `skill` | same name |

Hooks, Quality Gates and wrapper scripts are outside this model: they run before or
after the agent with the user's privileges and are not filtered by tool policy.

### Permission enforcement — known limitations (spike 29.1 findings)

- `opencode run` CLI (v2.2.3) supports only `--auto` (auto-approve non-denied
  permissions). There are **no** `--allow-tool` / `--deny-tool` CLI flags, so
  per-task restrictions cannot be passed via arguments. Enforcement is done by
  generating a task-scoped config and passing it through `OPENCODE_CONFIG_CONTENT`.
- OpenCode merges `opencode.json(c)` from the current directory up to the filesystem
  root. A project-level `opencode.jsonc` with permissive rules can override or weaken
  task-scoped denies (last matching rule wins, closer directory wins for merge).
  System config (`/etc/opencode`, `%ProgramData%\opencode`) overrides project config.
- Nested agent calls (subagents) use their **own** permissions, not a subset of the
  parent's. A task that denies `subagent` prevents launching subagents, but a launched
  subagent is not further restricted by the parent task's policy.
- **Plan B**: if the task-scoped config passed via `OPENCODE_CONFIG_CONTENT` proves
  insufficient, enforcement can be moved to wrapper-level tool filtering (intercepting
  `opencode run` invocation and refusing to start when a denied tool would be needed)
  or to a managed system-level `policies` entry that hard-denies specific tools
  globally.

## Extension points

| Goal | Where to start |
| --- | --- |
| New OS backend | Implement `SchedulerBackend` in `src/core/scheduler/`, register it in `index.ts` |
| New trigger type | Add a `triggerType` branch in `schedulerCreateTask` and in the wrapper |
| New agent tool | Add a zod schema + execute function, register in `ctx.tool.transform`, add an RPC contract |
| New dashboard panel | Extend `server.ts` routes and the HTML template |
| New matrix policy | Extend `MatrixConfig` in `task-transfer.ts` and the logic in `core/matrix.ts` |
