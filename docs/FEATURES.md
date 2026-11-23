# Features

A complete catalog of what the scheduler can do, with examples and the caveats that
matter in practice.

Translations: [中文](FEATURES.zh.md).

- [Scheduling](#scheduling)
- [Execution policy](#execution-policy)
- [Orchestration](#orchestration)
- [Multi-repository workspaces](#multi-repository-workspaces)
- [Profiles (multi-project)](#profiles-multi-project-sprint-21)
- [Workspace environment variables](#workspace-environment-variables-sprint-21)
- [Observability](#observability)
- [Management](#management)
- [Agent interface](#agent-interface)
- [Platform support](#platform-support)
- [Limits and non-goals](#limits-and-non-goals)
- [Documentation site (GitHub Pages)](#documentation-site-github-pages)

## Scheduling

### Cron schedules

Five-field cron: `minute hour day-of-month month day-of-week`. Supports lists,
ranges and steps in every field (`0 8-10,18 * * 1-5/2`), month and weekday names
(`0 9 * * MON-FRI`), `@every` sugar (`@every 15m`, `@every 2h`, `@every 1d`),
`L` as the last day of the month and the `d#n` n-th weekday form (`0 9 * * FRI#3`).

| Pattern | Example | Meaning |
| --- | --- | --- |
| Every N minutes | `*/15 * * * *` | Every 15 minutes |
| Fixed time | `0 9 * * *` | Daily at 09:00 |
| Weekdays | `30 8 * * 1-5` | 08:30 Monday to Friday |
| Monthly | `0 3 1 * *` | 03:00 on the 1st |
| Last day | `0 3 L * *` | 03:00 on the last day of the month |
| N-th weekday | `0 9 * * FRI#3` | 09:00 on the third Friday |
| Sugar | `@every 15m` | Every 15 minutes |

The Windows backend translates simple cron expressions to native Task Scheduler
triggers. Expressions `schtasks` cannot express (`L`, `#`, complex lists) or tasks
with a timezone other than the system one are registered in poll mode: the OS task
wakes the wrapper every minute and `schedule-gate` decides whether the agent runs.

### One-shot runs

`triggerType: "once"` runs a task exactly once at a specific moment. Use either
`runAt` (ISO-8601, or a local date string such as `2026-11-13 22:40`) or
`delaySeconds` (delay from now):

```json
{
  "name": "deploy-once",
  "triggerType": "once",
  "runAt": "2026-11-13T22:40:00+03:00",
  "prompt": "Deploy the current main branch."
}
```

```json
{ "name": "remind-later", "triggerType": "once", "delaySeconds": 3600, "prompt": "..." }
```

`runAt` wins when both are present. `schedule` is ignored. One-shot tasks are
registered natively (`schtasks /sc ONCE`, Linux `at`, macOS launchd cleanup
agent), are not repeated after a plugin restart, and cannot be combined with a

> **Windows locale note.** `schtasks /sd` only accepts dates in the format of the
> current Windows locale. The plugin emits `DD.MM.YYYY`, which matches Russian
> (and most European) locales. On a system with an English/US locale (`MM/DD/YYYY`)
> `schtasks` rejects the date, so one-shot tasks are not available there.
matrix.

### Session continuity

Each scheduled run can either start a fresh OpenCode session (`new`, default),
reuse a persistent session stored on the task, or continue the latest session
(`last`, mapped to `opencode --continue`). Set `session` on the task; for
`reuse` a `sessionId` is auto-generated and stored with the task definition —
it is never accepted from user input or exported as plain text.

```json
{
  "name": "nightly-analyst",
  "schedule": "0 3 * * *",
  "session": "reuse",
  "sessionMaxRuns": 10,
  "prompt": "Refresh the analysis."
}
```

- `session`: `new` (default), `reuse` (pass `--session <id>`), `last` (pass `--continue`).
- `sessionMaxRuns` (only for `reuse`): how many runs the reused session
  survives before it is deleted (`opencode session delete`) and a fresh session
  is started. Unset/0 means no limit.
- `sessionId` is per machine/profile. The internal run counter
  (`sessionRunCount`) is never exported.
- Old export/import files without session fields import as `new`.

### Timezones and launch windows

- `timezone` — IANA zone per task (e.g. `Europe/Moscow`). `nextRun`/`prevRun`,
  dry-run next-run estimates and the gate evaluate cron in this zone; DST
  transitions are handled (nonexistent spring-forward times are skipped).
- `notBefore` / `notAfter` — daily launch window in `HH:MM` (may cross midnight,
  e.g. `22:00`–`06:00`). A run that fires outside the window is **postponed**
  until the window opens (once, via a defer-file), not skipped.
- `activeDays` — allowed weekdays `0`=Sunday … `6`=Saturday (Sprint 27). Empty or
  all seven means every day. Applies to cron and event triggers.
- `windowPolicy` — behaviour outside the window or on a disallowed day (Sprint 27):
  `postpone` (default) waits for the next opening (max 12 hours), `skip` drops the
  run, `run` executes anyway.
- `pausedUntil` — pause a task until an ISO moment. `pause_task` accepts
  `until`; the plugin re-enables the task automatically at startup and on a
  5-minute timer, and `resume_task` resumes early.

### File triggers

```json
{
  "name": "regen-api-client",
  "triggerType": "file",
  "watchPath": "C:\\projects\\api\\openapi.yaml",
  "prompt": "Regenerate the API client from openapi.yaml and run contract tests."
}
```

The file is watched with chokidar in the plugin host, changes are debounced. File
triggers ignore `schedule`.

#### Glob masks for file triggers (Sprint 27)

`watchGlobs` and `watchIgnore` restrict which changes count as a trigger:

Masks support `*` (does not cross `/`), `**` (any segments, including zero),
`?` (one character), `[abc]` / `[a-z]` (classes), `{a,b}` (alternatives) and `!`
(negation). Empty `watchGlobs` means "any change". Paths are normalized to POSIX
form (`\` → `/`), comparison is case-insensitive on Windows.

### Git triggers (Sprint 27)

```json
{
  "name": "deploy-on-push",
  "triggerType": "git",
  "workingDirectory": "C:\\projects\\api",
  "gitBranch": "main, release/*",
  "gitPaths": ["src/**", "package.json"],
  "gitIgnore": ["**/*.md", "CHANGELOG.md"],
  "gitPollSeconds": 60,
  "prompt": "Deploy the changed services to staging."
}
```

A task with `triggerType: "git"` starts when a new commit appears in its working
directory. The first poll only remembers the current `HEAD` (baseline) and does not
start anything. Later polls compare `git diff --name-only <last>..HEAD` and start
the task when masks `gitPaths` (empty — any file) match and are not excluded by
`gitIgnore`. Filter `gitBranch` limits branches (comma-separated, supports `*` and `?`).

Poll period `gitPollSeconds` — minimum 5 seconds, default 60. State (the last
processed commit) is stored in SQLite table `git_state`, so a plugin restart does
not cause repeated runs.

### MCP event triggers

```json
{
  "name": "on-pr-opened",
  "triggerType": "mcp-event",
  "mcpEvent": { "server": "github", "event": "pull_request.opened", "filter": "repo=acme/api" },
  "prompt": "Review the newly opened pull request."
}
```

Events are emitted through the `emit_event` RPC method.

### Manual runs and pause

- `run_task_now` starts a task immediately, through the same wrapper (timeout, lock,
  hooks, Quality Gate).
- `pause_task` / `resume_task` disable and re-enable the OS entry. For a matrix parent
  every clone is paused.

### Logon mode (Windows)

By default a task is **interactive only**: Task Scheduler runs it only while the user
who created it is logged on. That is the safe default — the job sees the user profile,
mapped drives, the project's `opencode.json` and saved credentials.

Some jobs must run outside business hours or on a locked/signed-out machine. Pass
`runWhenLoggedOff: true` (agent tool `schedule_task` / `update_task`, or the sidebar) to
register the task as `schtasks /ru SYSTEM` instead. The run then happens in session 0,
without the user's profile, mapped drives, network shares or saved credentials. Tasks
that depend on the user environment can fail with `Access is denied` or missing files,
so check them with `dry_run` first and prefer absolute paths.

`runWhenLoggedOff` is Windows-only: Linux crontab already runs without a logged-on user,
and a macOS launchd agent runs only inside a user session. `list_tasks` reports both the
OS value (`logonMode`) and the plugin setting (`runWhenLoggedOff`); `dry_run` shows the
same pair before the task is registered.

## Execution policy

### Timeout and no-overlap

Every run has `timeoutSeconds` (default 3600). On expiry the process tree is stopped
and the run is recorded as `timeout`. A lock file prevents two runs of the same task
from overlapping; the second start exits immediately and is recorded as `skipped`.

### Pre-flight, Quality Gate, post-flight

```json
{
  "name": "nightly-deps",
  "schedule": "0 2 * * *",
  "beforeScript": "git pull --ff-only",
  "prompt": "Update dependencies, fix breaking changes, keep the diff minimal.",
  "qualityGate": "npm test",
  "afterScript": "git push",
  "timeoutSeconds": 2400
}
```

| Hook | When | Effect of non-zero exit |
| --- | --- | --- |
| `beforeScript` | before the agent starts | run is cancelled, pre-flight marked failed |
| `qualityGate` | after a successful response | run is marked as a Quality Gate failure (error) |
| `afterScript` | after the run, even on failure | reported in history, does not rewrite a success |

### Retries

`retryCount` and `retryDelay` (seconds) retry a failed run. Retry state is persisted,
so a crash cannot produce an infinite retry loop. Retries happen before chains and
dependents.

### Model and priority

`model` selects an OpenCode model (for example `anthropic/claude-3-5-sonnet`);
omitting it uses the OpenCode default. `priority` is `0..10` and is passed through to
the scheduler entry.

### Tool restrictions

The baseline comes from `permissions.defaultPolicy`: `hybrid` (default) allows
read/edit/glob/grep/subagent/skill/webfetch/websearch and denies `shell` and `question`,
`secure` allows only read/glob/grep/skill, and `legacy` restores the 1.5.x behaviour that
allowed everything. Task-level `legacyShell: true` re-enables `shell` under `hybrid` for
jobs migrated from older versions; `legacy` is the blunt alternative.

> **Autonomous tasks and `tool.blocked`:** with the default `hybrid` policy the agent
> is denied `shell` and `question`, so an unattended task that tries to run `git status`
> (or ask a clarifying question) will log `tool.blocked` and cannot complete that step.
> This is intentional — do **not** switch `defaultPolicy` to `legacy` globally just to
> silence it. Grant the capability to the specific task instead: add `shell`
> (and/or `question`, if truly needed) to that task's `allowedTools`, use
> `legacyShell: true` for migrated jobs, or move the command into `beforeScript` /
> `qualityGate` / `afterScript`, which run with your user privileges and are not subject
> to agent tool restrictions. `shell` commands inside scripts are the recommended path.

`allowedTools` and `deniedTools` are enforced for the `opencode run` process that the
task wrapper starts. The wrapper passes the generated `permissions` rules to the
process through `OPENCODE_CONFIG_CONTENT`; no file is written to the task workdir, so a
project-level `opencode.jsonc` is never overwritten. Each `deniedTools` entry becomes an
`effect: "deny"` rule for the matching OpenCode action, and `allowedTools` (when set)
denies every action that is not listed. The wrapper runs `opencode` with `--auto`, so
only non-denied permissions are auto-approved. Restrictions apply to the agent process,
not to hooks, Quality Gates or scripts, which still run with your user privileges. See
[ARCHITECTURE.md](ARCHITECTURE.md#permission-enforcement--known-limitations-spike-291-findings)
for the exact action mapping and known limitations (project/system config, nested
subagents).

### One-off git worktree (W-1)

Set `worktree: true` to run every tick in a fresh `git worktree` of
`workingDirectory` on its own `agent-steward/...` branch. The wrapper creates the
worktree after the schedule gate and before `opencode`, passes the path to the agent
through the prompt preamble and `AGENT_STEWARD_WORKTREE`, and fails the run closed
if creation fails (for example, the directory is not a git repository). Paths and
branches are unique per run, so matrix clones and parallel missions can write files
without touching the main checkout or each other — safe fan-out without Docker.

Worktrees live under `PLUGIN_DIR/worktrees` with a `.json` sidecar used by cleanup.
After the run the wrapper removes the worktree and its `agent-steward/...` branch
even when the task fails (W-2.1). Leftovers from crashes are swept opportunistically
on the next run: worktrees older than 24 hours are removed, sidecars without a
checkout are pruned, and a `.cleanup-lock` serialises concurrent sweeps (W-2.2).
Cleanup only touches paths under the worktree root that have a sidecar and an
`agent-steward/` branch, so foreign directories and fresh active runs are never
deleted. A worktree does not isolate network, API or database access, and Quality
Gates still run with your user privileges.

### Guard conditions (W-3)

Set `guards` on a task to require conditions before it runs: an optional shell
`command` (exit 0 — пройден, non-zero — скип, `timeoutSeconds` 1..3600) and/or
`semantic` conditions — `filesExist` / `filesMissing` (relative paths, resolved
inside the worktree or cwd), `branch` (glob), and `changedPaths` (glob, at least
one path in the diff of `changedSince..HEAD`, default `HEAD~1`). All conditions
are ANDed: when any check fails or errors, the run is skipped gracefully with a
visible `skipped` status in history and the GUI (`record-history --skip`, no
notification and no success/error chain). Guards are evaluated after the
worktree is created, so they run inside the fresh worktree when combined with
`worktree: true`; the `guard-run.js` helper lives in `src/core/guard-run.ts` and
`src/core/guard.ts` provides normalization, evaluation and the exit-code
convention (4 = skip).

## Orchestration

### Chains

```json
{ "name": "build", "nextTaskOnSuccess": "deploy", "nextTaskOnError": "notify-failure" }
```

Exactly one follow-up task is started after a run.

### DAG dependencies

```json
{ "name": "smoke-tests", "dependsOn": ["deploy"], "schedule": "0 * * * *" }
```

A dependent starts only when every dependency's latest run is successful. If a
dependency is a matrix, **all clones** must be successful — a `partial` matrix blocks
dependents.

### Matrix builds (fan-out)

One definition, one clone per workspace:

```json
{
  "name": "deploy",
  "schedule": "0 3 * * *",
  "prompt": "Build, test and deploy this repository. Report what changed.",
  "matrix": {
    "workspaceIds": ["ws-frontend", "ws-backend", "ws-mobile"],
    "strategy": "parallel",
    "failureMode": "continue",
    "concurrency": 2,
    "overrides": {
      "ws-mobile": { "qualityGate": "flutter test", "prompt": "Use the Flutter toolchain." }
    }
  }
}
```

| Field | Default | Meaning |
| --- | --- | --- |
| `strategy` | `parallel` | `sequential` starts the next clone only after the previous one finishes |
| `failureMode` | `continue` | `stop` aborts the remaining clones after the first failure |
| `concurrency` | unlimited | Maximum clones running at once (ignored for `sequential`) |
| `aggregation` | `summary` | `summary` writes one aggregate record for the parent |
| `createAggregator` | `false` | Also create `<parent>-matrix-complete` depending on every clone |
| `overrides` | none | Per-workspace prompt/model/Quality Gate/hooks |

Behavior worth knowing:

- Clones are named `<parent>-matrix-<workspace>`, inherit the parent definition and get
  their own working directory.
- The parent never runs itself; its status is the aggregate: `success`, `error`,
  `partial` (some clones failed under `continue`), or `running`.
- Editing the parent (workspaces, prompt, overrides, concurrency) **syncs** the clone
  set: missing clones are created, changed ones updated, removed ones deleted. Clones
  with a running job are never touched.
- Cancelling a matrix (`matrix_control` with `action: "cancel"`) marks pending clones
  as cancelled and stops running ones. Deleting a parent deletes its whole family.
- `matrix_control` with `action: "cleanup"` removes orphaned clones whose parent is
  gone; the same cleanup also runs at plugin startup.

### Pipeline as code

A whole DAG can be declared in `opencode.pipeline.yaml` and applied as code:

- `version: 1`, a pipeline `name`, optional `defaults` and 1..200 `steps`.
- Each step has a stable `id`, a `prompt` and an optional `needs` list that becomes
  `dependsOn`.
- `trigger: cron` (default) needs a `schedule`; `trigger: once` needs `runAt`;
  `trigger: dag` runs only after its `needs` succeed.
- `matrix.workspaces` fans a step out over workspace names or ids.
- `agent-steward pipeline validate|apply|export` and the `pipeline_validate`,
  `pipeline_apply`, `pipeline_export` tools cover the lifecycle; apply is idempotent,
  skips unchanged steps and never deletes stale tasks.
- Full format and limits: [PIPELINE.md](PIPELINE.md).

### Agent orchestration helpers

Pure helpers in `src/core/agents.ts` (re-exported from `src/core/execution.ts`)
can be composed around a pipeline step:

- `buildContextArtifact` gathers text from earlier step results into a stable,
  deduplicated, size-limited context; secrets are redacted before collection.
- `assignRole` alternates `worker` and `reviewer` deterministically and never
  assigns a reviewer without a preceding worker step.
- `postmortem` classifies a failed step and proposes a correction, while
  `retryWithPostmortem` produces an updated spec with an incrementing attempt
  and an attempt limit; only correctable failures are retried and the input
  spec is never mutated.
- `fallbackModel` switches to another available model only when confidence
  drops below a threshold, and fails open to the primary model when no
  fallback is available.

## Multi-repository workspaces

A workspace is a named directory: id, name, path, optional git remote and color.

```json
{ "id": "ws-api", "name": "API", "path": "C:\\projects\\api", "color": "#3b82f6" }
```

Use `workspaceId` instead of `workingDirectory` to run a task in a workspace. Paths are
validated on add/update/import, and the dashboard groups tasks and runs by workspace.
Workspaces are the unit that matrix builds fan out to.

## Profiles (multi-project, Sprint 21)

Profiles let you run several independent scheduler installations inside one plugin,
each with its own SQLite database, settings, logs, wrappers and dashboard port.
This is useful for separating projects, clients or environments (e.g. `default` and
`work`) without them seeing each other's data.

- Profile `default` uses the plugin's base directory (no migration, behaves exactly
  as before Sprint 21). Named profiles live in `<base>/profiles/<name>`.
- Profile selection order: `OPENCODE_SCHEDULER_PROFILE` env var → file `active-profile`
  in the base directory → `default`. Switching profiles writes the marker and requires
  an OpenCode restart because plugin directories are resolved at module load time.
- Dashboard port per profile: `OPENCODE_SCHEDULER_PORT` env var → port from
  `profile.json` → server default (3782, then 4782/5782 fallback). A new profile is
  allocated the first free port from 3783 up, skipping 3782/4782, ports already
  recorded in other profiles' `profile.json`, and `OPENCODE_SCHEDULER_PORT`.
- RPC: `get_profiles` lists profiles with dirs, ports and the active flag;
  `set_profile` switches the active profile (restart hint); `create_profile` /
  `delete_profile` manage named profiles (`default` cannot be deleted).

### Workspace environment variables (Sprint 21)

Each workspace can carry env variables that are injected into every task run in that
workspace:

- `env` — explicit `KEY=VALUE` pairs stored in SQLite as JSON;
- `envFile` — optional path to a `.env` file whose variables are loaded first, then
  explicit pairs override them;
- File format: `KEY=value` lines, `#` comments, blank lines, leading `export `,
  values in matching quotes are unquoted;
- Key validation: `^[A-Za-z_][A-Za-z0-9_]*$`, max 100 pairs per workspace;
- Delivery: at task create/update the plugin writes `<PLUGIN_DIR>/env/<sanitized>.env`
  with real values (mode `0600` on POSIX) and passes it to the wrapper
  (Windows: `-EnvFile "<path>"`; POSIX: `set -a; . "$ENV_FILE"; set +a` before the
  `opencode run` invocation);
- Secret masking: keys matching `/(TOKEN|SECRET|PASS|PASSWORD|KEY|CREDENTIAL|AUTH)/i`
  are shown as `***` in logs and masked API responses — values never leak into logs.
- Caution (PL-84): these variables are injected into the whole task process, including
  any test suites started by its Quality Gate. In particular, setting
  `AGENT_STEWARD_GATE_ALLOW_PATHS` from a workspace changes the result of the PL-25/PL-47
  worktree checks in `test-execution-pipeline.mjs`. Gate suites must therefore clear
  inherited gate/child variables explicitly; do not rely on a clean interactive shell.

### Environment profiles and run artifacts

Task and run specs carry an explicit environment profile: `dev`, `staging` or `prod`.
Profiles are hard-isolated — each exposes only its own variables, plus a shared
cross-environment deny-list (tokens, credentials, database URLs). With no explicit
selection both task and run default to `dev`; a mismatch blocks execution before a run
is created, writes an `execution.environment.mismatch` audit record, and returns a
verdict containing both profiles and the reason.

Run artifacts are registered as a deterministic list of `{path, sha256, size}` entries
for report/coverage outputs (`reports/`, `coverage/`, `*.lcov`, `*.info`, coverage JSON/XML).
Registration is a pure function over supplied paths and contents: entries are normalized,
sorted and deduplicated, hashes are SHA-256 of UTF-8 bytes, and no filesystem clock or
file reads are involved. The list is stored in the run record metadata and returned in
the execution result, so tests can exercise it without creating real files.

## Observability

### History

Every run becomes a row: status, start/finish, duration, error, tokens, cost, model,
pre/post-flight results, next chained task, workspace and tool restrictions. Statuses:

| Status | Meaning |
| --- | --- |
| `running` | started, not finished |
| `success` | finished, no Quality Gate failure |
| `error` | agent error, hook failure or Quality Gate failure |
| `timeout` | killed by the timeout |
| `partial` | matrix aggregate with both successes and failures |

### Metrics

Per-task counters and totals: runs, successes, errors, tokens, cost. Available through
`get_history`, the RPC layer and the dashboard header. A 14-day analytics slice —
Per-day buckets (UTC), success rate, token-based cost estimate, top tasks by cost,
matrix and model breakdowns — is available through `get_analytics` /
`GET /api/analytics` and the dashboard's **Analytics for the period** block.
pruned automatically (age and size limits, see Settings) and can be exported as
CSV/JSON (`GET /api/history/export`), or as OTLP/JSON for OpenTelemetry
(`GET /api/history/export?format=otlp`).

The same slice carries a **"Saved"** counter: runs that spent tokens without
a recorded cost (local models, prepaid plans) are priced against a reference cloud
rate of $0.01 / 1k tokens. The KPI is labelled as an estimate and links to
[docs/SAVINGS.md](SAVINGS.md) with the full methodology; `report.savings` exposes
`savedUsd`, `runs`, `tokens` and a per-task breakdown.

Daily and weekly **budgets** (Economy v2) are configured through `manage_settings`
(`budgets: { enabled, dailyUsd, weeklyUsd }`, USD; `0` means no limit) or the
`get_settings`/`save_settings` RPC methods. Spending is accounted from finished
history rows in the current UTC day / UTC week (Monday start) using the same
cost rule as analytics; unfinished runs are ignored. `get_analytics` (and
`GET /api/analytics`) expose `report.budgets` with `day`/`week` usage
(`spentUsd`, `runs`, `limitUsd`, `remainingUsd`, `ratio`, `exceeded`, `disabled`)
and a combined `exceeded` flag. When a limit is enabled and reached, new runs
are paused automatically: `run_task`, `run_mission`, `run_task_now` and the
RPC/GUI, file-trigger and MCP entry points all refuse to start until the next
period, with a human-readable reason. An alert is sent to the configured
notification channels (webhook/Telegram/native) when a run is blocked; repeated
alerts with the same reason are suppressed for 24 hours. Budgets are fail-open:
disabled groups and zero limits never block a run, and accounting stays visible
regardless.

### Prometheus

`GET /metrics` exposes the Prometheus text format (0.0.4): `opencode_scheduler_info`,
`up`, `queue_depth`, `history_records`, `runs_total{task,status}`,
`errors_total{task}`, `tokens_total{task}`, `cost_usd_total{task}` and the
`run_duration_seconds` histogram (1 s … 3600 s + `+Inf`). `runs_total` has
separate `success`, `error` and `partial` statuses; `errors_total` counts only
errors and timeouts, so `partial` never inflates it. Values are read from
SQLite at scrape time, so no extra agent or exporter process is required.

### Structured logs

Every run start/finish and every webhook decision is appended to
`<PLUGIN_DIR>/logs/runs.jsonl` (one JSON object per line, 10 MiB rotation to
`runs.jsonl.1`). `GET /api/logs` returns newest-first records and supports `task`,
`status`, `event`, `since`, `until`, `limit` and `format=jsonl`. The database
`history` table remains the source of truth for aggregates; JSONL is for log
shipping and debugging and never blocks a run if writing fails.

### Incoming webhooks

`POST /api/hooks/:task?token=…` starts a task from GitHub Actions, GitLab CI or any
external system. The request must carry an HMAC-SHA256 of the raw body in
`X-Scheduler-Signature: sha256=<hex>` (GitHub's `X-Hub-Signature-256` and a bare
hex digest are also accepted). The token may instead come from `X-Scheduler-Token`
or `X-Gitlab-Token`. An optional `X-Scheduler-Timestamp` is checked against
`timestampToleranceSeconds`. Hooks are disabled by default; enabling them with empty
credentials generates a token and secret automatically. Errors: 401 (bad
token/signature/timestamp), 403 (channel disabled or credentials missing), 404
(unknown task), 413 (body over `maxBodyBytes`). The dashboard still binds to
localhost only, so external CI needs a tunnel or self-hosted runner.

#### Replay protection guidance for senders

Both remaining authentication modes are replayable at the transport level, so
senders should be chosen with that in mind:

- **Signature with `timestampToleranceSeconds = 0` (legacy).** The HMAC covers
  only the body, so any intercepted request can be replayed verbatim, forever.
  Set a non-zero tolerance and send `X-Scheduler-Timestamp` (unix seconds or
  milliseconds): the signature then covers `<timestamp>.<body>` and a captured
  request stops working outside the window.
- **Token-only mode.** A bearer token in a query parameter or header is also
  replayable — the scheduler cannot distinguish a repeat from a replay. If you
  cannot switch to timestamp-signed HMAC, mitigate instead: keep the token in
  CI secrets (not in code), rotate it regularly, scope one token per task, and
  make the target task idempotent so an accidental replay does no harm.
- **GitHub Actions.** GitHub does not send `X-Scheduler-Timestamp` itself, so
  `X-Hub-Signature-256` alone runs in legacy (replayable) mode. Prefer a
  workflow step that signs `<timestamp>.<body>` with the shared secret, or rely
  on short-lived workflow runs and idempotent tasks.
- The scheduler itself performs no replay cache: unique-request deduplication
  (e.g. event IDs) is the sender's responsibility.

### OpenTelemetry

History can be exported as OTLP/JSON: one span per run, deterministic 32-hex
`traceId` and 16-hex `spanId`, nanosecond timestamps, task/status/duration/tokens/
cost/model/error attributes and OK/ERROR status. The output can be posted to an
OpenTelemetry Collector or inspected directly.

### Logs

Each run appends to `logs/<task>.log` — pre/post hooks, Quality Gate output and the
agent's stdout/stderr. `get_task_logs` returns the tail (1–1000 lines).

### Dry run

`dry_run` simulates one task or every task: execution order, DAG prerequisites, matrix
fan-out and estimated time. Nothing is executed and nothing is created.

The ad-hoc mission API (`runMission` / `agent-steward run --dry-run`) has its own
`dryRun` contract: it builds the step plan and its description, but does not acquire
the `activeWorkspaces` lock and does not write `runs`/`run_steps` to the ledger.
This is intentional — several dry runs in the same `cwd` run in parallel and leave
no trace in history. Only a real mission is locked to one workspace at a time.

### Dashboard

A local web dashboard shows tasks, matrix tabs, per-workspace summaries, DAG markers,
metrics, a 14-day analytics block (KPIs, daily bar chart, top tasks by cost, matrices),
recent runs and CSV/JSON history export. It binds to localhost and has no authentication
— do not expose it. `GET /api/health` reports plugin version, scheduler backend, queue
depth and database status for external monitoring.

## Management

### Templates

Save a definition as a reusable template, then create tasks from it with one click or
one tool call.

### Export and import

`export_tasks` produces a versioned JSON document with definitions, including matrix
configuration and `matrixParentId`. `import_tasks` validates every record and reports
per-record errors instead of failing the whole batch. Unknown workspaces and invalid
matrix combinations are rejected explicitly.

### Notifications

Notifications on run completion through three independent channels — webhook, Telegram
and native OS notifications — configurable in settings and testable with
`test_notification`.

- **Webhook delivery:** per-task completion (success/error/timeout) through a
  Discord/Slack compatible webhook (`{ content, text }`). `webhook.timeoutMs`
  (default 10 000), `webhook.retryCount` (default 2) and `webhook.retryDelayMs`
  (default 1000) control the request; network errors, timeouts, HTTP 5xx and 429 are
  retried with exponential backoff (capped at 30 s), other 4xx are not.
- **Telegram:** Bot API `sendMessage` with `chat_id`, `parse_mode` (`HTML`,
  `MarkdownV2`, `Markdown` or plain text), optional silent mode, forum topic
  (`messageThreadId`) and a dashboard link (`includeDashboardLink`). Configured in the
  GUI or with `manage_settings` → `notifications.telegram`. `botToken` and `chatId`
  may instead come from `OPENCODE_SCHEDULER_TELEGRAM_BOT_TOKEN` and
  `OPENCODE_SCHEDULER_TELEGRAM_CHAT_ID` so no secret is stored in `settings.json`;
  the token is masked in every error message and log line.
- **Native OS notifications:** Windows Toast (PowerShell/WinRT), macOS Notification
  Center (`osascript`) and Linux `notify-send`. No extra dependency: `node-notifier`
  is not required. `notifications.native.sound` toggles the sound where supported.
- **Templates:** `templates.success` and `templates.error` accept placeholders
  `{task}`, `{status}`, `{duration}`, `{error}`, `{emoji}`, `{cost}` and `{tokens}`.
  When token/cost data is present the message gains a ` · 1500 tok · $0.0060` suffix.
- **Filters:** `filters.include` / `filters.exclude` are task-name patterns with `*`
  wildcards; an empty include list means all tasks, exclude wins.
- **Quiet hours:** `quietHours.enabled` with `from`/`to` in `HH:MM` (an overnight
  range such as 22:00 → 08:00 is supported). During the window `success` and
  `partial` are suppressed while `error` and `timeout` are still delivered.
- **Dedup (31.2):** `notifications.dedup.enabled` groups identical task + status
  notifications inside `windowMinutes` (default 60). With `suppressDuplicates`,
  non-important repeats are suppressed; statuses listed in `importantStatuses`
  (default `error`, `timeout`) are always delivered and get a localized repeat
  suffix, e.g. `(repeat 3)`. Counters live in the SQLite `notification_dedup`
  table, so they survive the short-lived `record-history` processes, and
  `maxCount` caps the counter.
- **Matrix notifications:** on family completion — success, `partial` (`onPartial`)
  and all clones failed (`onAllFailed`). A stuck detector reports clones running
  longer than `matrix.stuckAfterMinutes` (default 60, `0` disables) once per run.
- **Digest:** `digest.enabled` sends a daily (`frequency: "daily"`, at `digest.time`)
  or weekly (Mondays, catch-up afterwards) summary: runs, success rate, cost, tokens
  and top errors through every enabled channel. Also available as the
  `send_digest` RPC and the GUI's **Send digest now** button (manual sends
  do not move the schedule).
- **Test button:** sends a test message to `all`, `webhook`, `telegram` or `native`
  and reports per-channel success/failure. Failures in one channel never block the
  others and never throw into the task run.

### Secrets (Sprint 26)

Encrypted secret storage in `<PLUGIN_DIR>/secrets.json` with AES-256-GCM and a
32-byte key file `secrets.key` (mode 0600 on POSIX; on Windows an ACL granting only
the current user, applied via `icacls`). The `manage_secrets` tool (and the **Secrets**
GUI panel) supports `list`, `set` and `delete`. Secret names match
`[A-Za-z0-9_.-]` and are up to 64 characters; list shows only name, masked preview
(`••••` + last 4 chars) and update time — never the value.

In task workspace `env`, reference a secret as `${secret:NAME}`. The value is
substituted at run time (missing secrets resolve to an empty string with a
name-only warning). Secret references survive masking — they are shown verbatim in
the GUI env editor — while literal secret-like values (`TOKEN=`, `PASSWORD=`, …)
are masked as `***` in logs, structured logs, history and audit.

#### Recovering a quarantined secrets store

If `secrets.json` fails to parse, it is quarantined, not deleted: the file is
renamed to `secrets.json.corrupt-<timestamp>` next to the original. This is a
side effect of a read operation — recovery is **manual by design** so that no
automatic rewrite can destroy data:

1. Find the quarantined file in the plugin directory: `secrets.json.corrupt-*`
   (Windows: `%APPDATA%\opencode\agent-steward\`, macOS/Linux:
   `~/.config/opencode/agent-steward/` or `$XDG_CONFIG_HOME`).
2. Inspect it: the corruption is usually truncated JSON (interrupted write) or
   manual editing. Fix the JSON syntax in a text editor.
3. Copy the fixed file back to `secrets.json` (keep the `.corrupt-*` copy as a
   backup) and verify with `manage_secrets` (`action: "list"`).
4. If the file cannot be repaired, secrets are re-set with `manage_secrets`
   (`action: "set"`); values encrypted with a lost `secrets.key` cannot be
   recovered — re-enter them.
5. In the rarer case where even the rename failed, writes stay blocked
   (`corruptedStore` is set) until the `.corrupt-*` path is cleared manually —
   move the broken file away yourself, then re-set the secrets.

### Audit log (Sprint 26)

Every mutation — task create/update/delete/run, settings, templates, profiles,
workspaces, secrets, import, history cleanup — is recorded in an `audit_log`
table in SQLite with action, target type/target, actor (`mcp`/`gui`/`http`),
source, redacted details and remote address. Indexes on `ts` and `action`;
retention defaults to 90 days / 10 000 records with automatic cleanup.

The `get_audit_log` tool (and the **Audit log** GUI panel) reads the journal
with filters by `action`, `target`, `actor`, `since`/`until` and `limit`. Also
available as RPC `get_audit` and HTTP `GET /api/audit`. Secret values in details
are redacted; `${secret:NAME}` references are preserved verbatim.

### Crash recovery

Runs left in `running` after a crash are marked `error` on the next plugin start, so
the timeline never lies. Orphaned matrix clones are cleaned up at startup as well.

### Settings

Global defaults (timeout, concurrency, notifications, history retention) live in
`settings.json` and are editable from the GUI/RPC layer. History retention keeps the
raw run log bounded: `history.retentionDays` (default 30) and `history.maxRecords`
(default 5000); `0` disables the respective limit. Cleanup runs at most once a day on
plugin start, records `lastCleanupAt` / `lastCleanupDeleted`, and is also available as
the `cleanup_history` RPC and the GUI's **Clear now** button. Aggregates in
`metrics.json` are not affected by retention.

## Agent interface

Thirty-two tools: `schedule_task`, `list_tasks`, `update_task`, `schedule_advanced`, `update_advanced`, `delete_task`,
`run_task_now`, `pause_task`, `resume_task`, `get_history`, `get_task_logs`, `dry_run`,
`manage_workspaces`, `matrix_control` (results/cancel/cleanup/preview), `get_metrics`,
`get_analytics`, `self_analysis` (health score, anomalies, trends), `manage_settings`,
`manage_local_ai`, `manage_templates`, `manage_profiles`,
`transfer_tasks`, `send_notification`, `report_bug`, `get_dashboard_info`, `cleanup_history`,
`manage_secrets`, `get_audit_log`,
`emit_event`,
`pipeline_validate`, `pipeline_apply`, `pipeline_export`.

A bundled skill, `scheduled-job-best-practices`, teaches the agent safe defaults:
least privilege, Quality Gates, timeout, matrix concurrency, DAG rules and a
create → dry-run → run-now → inspect loop. It is registered automatically by the
plugin, no installation step required.

The `manage_local_ai` tool reads, updates and tests the local triage settings
(`action: "get" | "update" | "test"`); see [LOCAL-AI.md](LOCAL-AI.md).

## Author feedback (bug reports)

`report_bug` sends a structured report to the plugin author through a **write-only**
receiver (a Cloudflare Worker that creates a GitHub Issue in `DeadSno/agent-steward`).
The npm package contains **no tokens**: the fine-grained PAT (`issues: write` only)
lives in the receiver secrets. See [infra/feedback-worker/README.md](../infra/feedback-worker/README.md)
for deployment.

Arguments: `description` (required), `destination: "author" | "local" | "both"`
(default `author`), `dryRun` (preview only, no network), `includeLogs` (default
**false**), `includeAnalytics` (default true), `contactEmail`, `taskName`, `channel`.

What is sent in the payload (`schemaVersion: 1`): plugin/OS/Node versions,
locale, active profile, optional task name, the description, and — only when
explicitly allowed — redacted logs and aggregate metrics. What is **not** sent by
default: logs, emails, raw environment variables. Client-side redaction removes
`sk-`/`ghp_`/`xox*`/bot tokens, all values stored via `manage_secrets`, the home
directory (replaced with `~`) and email addresses (replaced with `[EMAIL]`).
`contactEmail` is included only if the user provided it explicitly.

Privacy controls: `feedback.enabled` defaults to **false**; `includeLogs` defaults
to **false**; the endpoint must be HTTPS (HTTP only for localhost) and is validated
on save. Use `report_bug` with `dryRun: true` to inspect the exact payload before
sending — the plugin displays `schemaVersion`, `reportId`, OS, locale, profile,
description, contact email, logs and metrics (F-3.1). The GUI has a dedicated
**Author feedback** settings section. Messages are localized to ru/en/zh.

Delivery is fail-open (F-1.6): if the receiver is unavailable, the report is saved
to the local `feedback_outbox` table and retried on plugin start (max 5 attempts);
it never blocks task execution. A hash of the description, a 5-minute window and
an hourly limit (default 6) prevent spam; only hashes, never report text, are stored
in `feedback_spam`.

## Local assistant (triage)

An optional offline model classifies failed and partial runs (category, severity,
confidence, reason). The model never suppresses a notification by itself: only a
matching rules-engine rule with `action: "skip"` can do that. It is opt-in and
fail-open: without a model the rules engine or direct delivery takes over, and
notifications are never blocked by an unavailable model.
It never changes run status, retries, Quality Gates, DAG dependencies or history.

- `mode`: `off` (default), `rules`, `llm` or `auto` (model, then rules).
- `fallback`: `rules` (default) or `notify` when the model fails or is unsure.
  The legacy value `skip` is accepted as an alias for `notify`.
- `confidenceThreshold`: minimum model confidence (0..1).
- `rules` omitted means the built-in rules; `rules: []` disables them; a custom
  array replaces the built-in set.
- Built-in rules cover errors, status, cost and task name
  (deploy/release/backup/migration); all are notify-only. Examples are in
  [LOCAL-AI.md](LOCAL-AI.md).
- The GUI shows a colored connection status (not checked / checking /
  connected / no connection) and resets it when the mode, URL or model changes.
- In `llm`/`auto`, triage is asynchronous: the notification is delivered
  immediately and a detached worker writes the verdict to the audit. Only
  `rules` mode triages before delivery, because only rules can suppress.
- `notifications.embedding` adds semantic dedup on top of the exact dedup:
  messages are converted to normalized bag-of-words vectors stored in SQLite,
  compared by cosine similarity against the window, and suppressed above
  `threshold` (0.85 default). Important statuses are never suppressed. No new
  dependencies and no external embedding model are required. CJK text (Chinese,
  Japanese, Korean) is tokenized into overlapping bigrams, so messages without
  spaces produce non-zero vectors and participate in dedup too.
- `notifications.summary` renders at most three short lines for Telegram and
  toasts. The model returns strict JSON `{"lines": [...]}`; any failure falls
  back to deterministic truncation (status, error, runtime/tokens/cost), and
  delivery waits at most `summary.timeoutMs` (8 s default).
- Shadow mode logs decisions to the persistent audit journal
  (`get_audit_log`, action `triage.decision`) without suppressing notifications,
  so triage can be evaluated safely before it is enforced and the report
  survives restarts.

Setup, model tiers by RAM, the `npm run bench:local` benchmark, shadow workflow
and troubleshooting (including `OLLAMA_CONTEXT_LENGTH`) are documented in
[LOCAL-AI.md](LOCAL-AI.md).

## Platform support

| Capability | Windows | Linux | macOS |
| --- | --- | --- | --- |
| Cron scheduling | Task Scheduler | crontab | launchd |
| Fallback | — | — | crontab |
| Timeout and lock | PowerShell wrapper | bash wrapper | bash wrapper |
| File triggers | chokidar | chokidar | chokidar |
| History, metrics, dashboard | yes | yes | yes |
| Agent tools and skill | yes | yes | yes |
| Runs without a logged-on user | opt-in (`runWhenLoggedOff`) | always (crontab) | no (per-user agent) |

### Runner backends (opt-in)

Task execution goes through a small `Runner` interface (`name`, `available`,
`buildCommand`, `execute`). The default `resolveRunner()` returns the **local**
runner: no Docker or SSH binary is required and existing installations keep
working unchanged. Docker (`docker run --rm ...`) and SSH (`ssh -o BatchMode=yes
...`) are opt-in backends selected by configuration, not by the host OS. They
only build a deterministic command at resolve/dry-run time; the CLI is invoked
only by an explicit `execute`. With a missing binary or an explicit opt-out the
factory fails open to `local`. The same specification always yields the same
command and verdict (no clock or randomness), so verdicts are byte-stable.
No new tools or RPC methods are added.

## Limits and non-goals

- **No one-shot scheduling without `triggerType: "once"`.** One-shot runs exist
  via `runAt`/`delaySeconds`; use `run_task_now` for immediate runs.
- **No session continuity beyond the built-in `session` modes.** `new`, `reuse`
  and `last` cover the common cases; per-message session forking/branching is
  not supported.
- **No sandbox.** Hooks, Quality Gates and prompts run with your user privileges.
- **No authentication on the dashboard.** Localhost only by design.
- **Secrets are encrypted at rest with AES-256-GCM** in `<PLUGIN_DIR>/secrets.json`
  (see the Secrets section). The key lives in `secrets.key`; losing it makes stored
  values unrecoverable. For higher-sensitivity values, prefer environment variables
  or an external secret manager.
- **`allowedTools` / `deniedTools` restrict the agent process, not the whole job.**
  Hooks, Quality Gates and wrapper scripts still run with your user privileges, and a
  project-level or system `opencode.jsonc` can weaken task-scoped denies. See the
  permission-enforcement limitations in ARCHITECTURE.md.
- **Matrix clones are separate tasks.** They appear in the task list (grouped under the
  parent) and consume global concurrency slots like any other run.

## Documentation site (GitHub Pages)

The `docs/` tree is plain Markdown; the repository has no dedicated site generator yet,
so publishing is an external GitHub-side action, not something the plugin or its test
suites do. English remains the primary source; keep the ru/zh pairs in sync — the
`test-docs.mjs` meta-gate checks h2/code-fence parity and the README suite counter.

Runbook:

1. Validate the source locally before publishing:

   ```sh
   npm run build
   node test-docs.mjs        # docs/meta-gate: parity, counters, ROADMAP rules
   ```

2. In the GitHub repository open **Settings → Pages → Build and deployment**, choose
   **Deploy from a branch**, then select the branch (`main`) and the `/docs` folder —
   or a `gh-pages` branch containing the published files.
3. Pages renders Markdown with Jekyll. If pages are served as raw text, add a
   `docs/_config.yml` with a Pages-supported theme and YAML front matter on entry
   pages; re-run `node test-docs.mjs` after any documentation edit.
4. After the push verify `https://<owner>.github.io/<repo>/` and the translated entry
   pages. Pages rebuilds automatically on every push to the selected branch.
