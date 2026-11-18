# Architecture

This document explains how `agent-steward` (plugin id
`opencode-windows-scheduler`) is put together: the process
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
5. **Local first.** No network services, no telemetry, no accounts by default. The dashboard binds
   to localhost only. Local AI triage (Ollama) is optional and connects only when explicitly enabled
   via `manage_local_ai`.

## Process model

```
┌─────────────────────────────┐
│ OpenCode (plugin host)      │
│  • agent tools (26)         │
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

## Router (3-layer)

The router decides *how* each task step executes — direct local call, MCP transport, or
cloud model — without involving a model for known step types.

### Слой 1 — статические правила (0 токенов, мгновенно)

Таблица соответствий тип задачи → транспорт + исполнитель. Большинство операций
известны заранее, модель не нужна.

| Тип задачи | Транспорт | Исполнитель |
| --- | --- | --- |
| `read_file` | direct | local |
| `write_file` | direct | local |
| `run_tests` | direct | local |
| `apply_diff` | direct | local |
| `github_create_pr` | mcp | local |
| `jira_update_task` | mcp | cloud |

Агент хочет прочитать файл → роутер смотрит в таблицу → видит `direct + local` →
выполняет напрямую, без MCP, без модели.

Реализация (Спринт 36.5.a): `src/core/router/rules.ts` — замороженная таблица
`STATIC_ROUTE_RULES`, `routeStaticStep(taskType)` (нормализует `Run Tests` /
`run-tests` → `run_tests`), `isStaticTaskType`, `listStaticRouteRules`.
Модуль не импортирует ни БД, ни модель, ни транспорт, поэтому горячий путь
физически не может стоить токенов; неизвестный тип возвращает `undefined` и
передаётся слою 2. Покрытие — `test-router-rules.mjs` (22 проверки, включая
1000 маршрутизаций быстрее 50 мс).

### Слой 2 — Capability Map (0 токенов, быстро)

SQLite-таблица `task_type → model / success_rate / avg_cost / avg_time /
last_10_runs`. Обучается на исходах гейта (CONCEPT §9 learning loop).

- `success_rate ≥ 0.85` → маршрут локально
- `success_rate ≤ 0.30` → эскалация в облако или «нужно ревью»

Это и есть learning loop: роутер учится на гейтах и становится точнее без затрат
токенов на само решение.

Реализация (Спринт 36.5.b): `src/db/capability-repo.ts`, таблица `capability_map`
(`SCHEMA_VERSION = 7`). `recordCapabilityOutcome` обновляет счётчики, считает
`success_rate` и скользящие средние стоимости/времени, хранит `last_10_runs`
(JSON, новые справа). `decideCapabilityRoute` решает по правилам:
меньше `MIN_RUNS_FOR_DECISION = 3` исходов → `explore` (решает слой 3),
`≥ 0.85` → `local`, `≤ 0.30` → `cloud`, между порогами → `review`. Пороги
передаются параметром, поэтому политика меняется без миграции данных.
Покрытие — `test-capability-map.mjs`.

### Слой 3 — локальная модель (только декомпозиция и неоднозначность)

Модель не маршрутизирует каждый шаг. Она только:
1. Разбивает миссию на шаги с типами (планирование);
2. Разрешает неоднозначность (Explore-режим, когда в Capability Map нет данных).

После этого каждый шаг проходит через Слой 1 и Слой 2.

**Реализация (Спринт 36.5.c):** `src/core/router/planner.ts`. `planMission(mission, { decomposer, maxSteps })` вызывает декомпозер — локальную модель — один раз на миссию и нормализует типы через `normalizeTaskType`; без декомпозера работает `decomposeHeuristically` по ключевым словам, без сети и модели. `planMissionSync` — вариант для синхронных мест. Шаг плана содержит только `stepName` и `taskType`, маршрут по-прежнему выбирают слои 1–2; типы вне статических правил собираются в `ambiguousTaskTypes` для `decideCapabilityRoute`. Пустая миссия, пустой или битый план модели — ошибка, а не молчаливый план. Покрытие — `test-planner.mjs`.

**Реализация (Спринт 36.5.d):** `escalateAfterGate(current, gate)` в `src/core/router/escalation.ts` решает судьбу шага по одному флагу `passed` и таблице переходов `local → cloud → review → blocked`. Модуль не импортирует ни БД, ни модель, ни сеть: это чистые функции (`nextGateTarget`, `isEscalationExhausted`, `escalationChain`), поэтому 1000 решений стоят доли миллисекунды. Переход в `blocked` означает, что автоматических уровней больше нет и нужен человек.

Слои 1–2 собираются в `routeStep(taskType, thresholds)` из `src/core/router/dispatch.ts`: сначала статическое правило (0 токенов), затем Capability Map. Для `review` и `explore` маршрут возвращается без транспорта и исполнителя — исполнять пока нечего. Модуль не импортирует `planner`, поэтому известный тип задачи не может случайно дойти до модели; это закреплено тестом `test-router-dispatch.mjs`, который также проверяет, что статика не оставляет записей в `capability_map` и работает ещё до инициализации БД.

### Эскалация

При провале гейта роутер эскалирует в облако **по правилу**, без участия модели.

---

## Modules

| Path | Role |
| --- | --- |
| `src/index.ts` | Plugin lifecycle, 26 agent tools, RPC handlers, task CRUD, view assembly |
| `src/rpc.ts` | JSON-schema contracts for every RPC method |
| `src/gui.tsx` | OpenCode sidebar panel (SolidJS, built to `gui-experimental.cjs`) |
| `src/server.ts` | Local web dashboard HTTP server and HTML rendering |
| `src/skill.ts` | Loads and registers the bundled agent skill |
| `src/task-transfer.ts` | Export/import, validation, `MatrixConfig` types |
| `src/profiles.ts` | Profile directory resolution: per-profile plugin dir (base for `default`, `<base>/profiles/<name>` for named profiles); profile name, marker, port, create/delete/switch |
| `src/workspaces.ts` | Workspace registry and path validation; env pairs and `.env` file resolution with secret masking |
| `src/templates.ts` | Reusable task templates |
| `src/settings.ts` | Plugin settings: notifications, history retention, audit, interface locale (`auto`/`ru`/`en`/`zh`) and last known UI locale, local AI/triage |
| `src/i18n.ts` | Interface locale (`ru` default, `en`/`zh`), BCP 47 mapping, JSON catalogs in `locales/`, ICU subset (`{param}`, `plural`) via built-in `Intl`, fallback to `ru` |
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
| `src/core/local-ai.ts` | Local AI triage: LLM classifier with rules fallback, shadow mode, fail-open, manage_local_ai backing |
| `src/core/cron-to-schtasks.ts` | Cron → Task Scheduler translation |
| `src/core/schedule-v2.ts` | Extended cron parser/matcher, timezone math, launch windows, poll-mode decisions |
| `src/core/schedule-gate.ts` | Wrapper-side gate: cron re-check (poll mode), window postpone, defer-file |
| `src/db/` | SQLite access: schema, migrations, repositories, recovery; `runs-repo.ts` keeps durable `runs`/`run_steps` state, `run-journal.ts` writes transitions around each step, `run-resume.ts` continues a crashed chain, `step-idempotency.ts` replays steps by key, `run-dlq.ts` parks deterministically failed steps |
| `src/core/router/rules.ts` | Router layer 1: static rules task type → transport + executor, normalization, no imports (0 tokens) |
| `src/db/capability-repo.ts` | Router layer 2: Capability Map - gate outcomes per task type, success_rate, moving averages, last 10 runs, threshold decision |
| `src/core/router/planner.ts` | Router layer 3: mission decomposition (model once per mission) and heuristic fallback, steps carry type only, routing stays in layers 1-2 |
| `src/core/router/dispatch.ts` | Router assembly: `routeStep` runs layer 1 then layer 2 and returns transport/executor, never imports the planner |
| `src/core/router/escalation.ts` | Gate failure escalation `local → cloud → review → blocked` by pure transition table, no DB, no model |
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
| Windows | `%APPDATA%\opencode\agent-steward` (legacy `windows-scheduler` переносится автоматически) |
| macOS/Linux | `$XDG_CONFIG_HOME/opencode/agent-steward` (default `~/.config/...`) |

```
scheduler.db      SQLite database (WAL; схема версионируется через PRAGMA user_version)
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
never requires a manual migration. `SCHEMA_VERSION` (currently `7`) is stored in
`PRAGMA user_version`; incremental steps live in `MIGRATIONS`.

### Durable run state (Sprint 36.1)

Sprint 36.1 adds `runs` and `run_steps`, the persistence layer for resumable DAG
execution:

| Table | Purpose |
| --- | --- |
| `runs` | One row per execution (`pending → running → passed/failed/cancelled`), with `task_name`, `parent_run_id`, `workspace_id`, `started_at`, `finished_at`, `metadata_json` |
| `run_steps` | One row per step (`pending → running → passed/failed/skipped`), with `position`, `attempt`, `idempotency_key`, `started_at`, `finished_at`, `error`, `output_json`; unique per `(run_id, step_name)`, cascade-deleted with the run |

`src/db/runs-repo.ts` owns the transitions and rejects invalid ones
(`InvalidTransitionError`). A failed step can be retried explicitly (`retryStep`),
which increments `attempt` and returns it to `running`. The tables survive process
crashes and reconnects, which is the prerequisite for resume (36.2),
idempotent steps (36.3) and the dead letter queue (36.4).

`src/db/run-journal.ts` (Sprint 36.1.b) writes every transition to disk before
and after executing the step body: `beginStepAttempt` commits `running` + `started_at`
before the body runs; `recordStepSuccess`/`recordStepFailure` commit `passed`/`failed`
(and `finished_at`/`error`/`output_json`) after it. The high-level wrappers
`runStepStatefully` / `runStepStatefullyAsync` execute `body` between those two
commits and propagate its error while still recording `failed`. `recoverInterruptedSteps`
marks any `running` steps left after a process crash as `failed` — preserving
`attempt`, so the next repeat gets `attempt + 1` and never restarts from 1.
SQLite runs in WAL mode with `synchronous = NORMAL`, so a committed transition
survives a `kill -9` (only the last in-flight commit can be lost with a power cut).

### Resume from the middle (Sprint 36.2)

`src/db/run-resume.ts` continues a run after a crash. `run_steps.position`
(schema v3) fixes the order of a linear chain — `created_at` can be identical
for steps inserted in one transaction, so it cannot be used for ordering; on an
existing v2 database the migration backfills `position` from the insertion order.
The `(run_id, position)` index is created after migrations, not in `SCHEMA_SQL`:
on an old database the column does not exist yet, so an early `CREATE INDEX`
would fail before the `ALTER TABLE` step.
`findResumeStep` returns the first step that is not `passed`/`skipped`.
`resumeRunSync` / `resumeRun` then:

1. recover dangling `running` steps (`recoverInterruptedSteps`), so the crash
   victim is retried with `attempt + 1`;
2. skip already passed/skipped steps without invoking their handlers;
3. validate that every remaining step has a handler **before** any side effect;
4. reopen a `failed` run (`reopenRun`, the only `failed → running` transition);
5. execute the rest through the journal and finalize the run as `passed` or
   `failed`.

The result reports `resumedFrom`, `resumedFromAttempt`, `executed`, `skipped`,
`failedStep` and `error`. With `stopOnError: false` the chain continues after a
failure, but the run still ends `failed`. This is covered by
`test-run-resume.mjs`, including a real `kill -9` in the middle of a four-step
chain.

The crash path is also exercised nightly by `test-chaos-dag.mjs`: a child process
runs a four-step chain, the parent sends `SIGKILL` right after the next step has
committed `running`, and the test then verifies the durable state (`passed` steps
are untouched, the victim is `running` with `attempt = 1`, later steps are
`pending`), `PRAGMA integrity_check = ok`, recovery to `failed` with
`attempt = 1`, and a resume that retries the victim with `attempt = 2` and never
re-invokes handlers of completed steps. `.github/workflows/nightly.yml` runs it
on a schedule on Windows and Ubuntu; locally it is `npm run test:chaos`.

### Idempotent steps (Sprint 36.3)

`run_steps.idempotency_key` is unique per run: schema v4 deduplicates legacy
duplicates (keeping the first row, nulling the rest) and replaces the old
non-unique index with the partial unique index `idx_run_steps_key_unique
(run_id, idempotency_key) WHERE idempotency_key IS NOT NULL`. The index is
created in the migration, after the dedupe — the same ordering trap as
`position`.

`src/db/step-idempotency.ts` exposes `runStepOnce` / `runStepOnceAsync`:

1. a key that belongs to another step in the same run is rejected with
   `IdempotencyConflictError`;
2. an already `passed`/`skipped` step is **replayed** from `output_json` — the
   body is not called, `attempt` does not grow and no side effect repeats
   (`replayed: true`, `executed: false`);
3. a `failed` step is retried with `attempt + 1`, so a transient error does not
   turn into a permanent skip;
4. a `running` step, or a second call for the same key while the first is still
   inside the body, raises `StepInFlightError` — the in-process `inFlight` set
   covers parallel async calls, the unique index covers the database;
5. a missing step is created with the key, then executed through the journal
   from 36.1.b.

The same key is allowed in different runs; `test-step-idempotency.mjs` covers
first execution, replay from cache (including after reconnect), conflicts,
retry and parallel deduplication.

### Dead letter queue (Sprint 36.4)

A step that fails on every attempt is not transient: resuming the run again just
burns another attempt and hides the real problem. Schema v5 adds `run_dlq`, the
durable queue of deterministically failed steps:

| Column | Purpose |
| --- | --- |
| `run_id`, `step_name` | Which step dead-lettered; cascade-deleted with the run |
| `status` | `open → retried` or `open → discarded` |
| `reason` | `attempts-exhausted` (automatic scan) or `manual` |
| `error`, `attempts` | Snapshot of the failure at the moment of enqueue |
| `resolved_at`, `resolution` | When and how the entry was closed (`manual-retry`, `discarded`) |

`src/db/run-dlq.ts` provides:

1. `scanDeadLetters({ runId?, minAttempts = 3, limit })` selects steps with
   `status = failed` and `attempt >= threshold` and enqueues only new ones. The
   partial unique index `idx_run_dlq_open_unique (run_id, step_name) WHERE
   status = 'open'` makes enqueue idempotent, so a repeated scan does not create
   duplicates.
2. `retryDeadLetter(id)` is the manual retry: it reopens the failed run, calls
   `retryStep` (attempt + 1, step back to `running`) and closes the entry as
   `retried` with `resolution = manual-retry`. Closed entries cannot be retried
   or discarded twice.
3. `discardDeadLetter(id, resolution = "discarded")` closes the entry without
   touching the step — the run stays failed.
4. `listDeadLetters` / `countDeadLetters` filter `open` or `all` for dashboards
   (36.6) and metrics.

`retryDeadLetter` calls `reopenRun` and `retryStep`, which each open their own
transaction. `withTransaction` therefore nests through `SAVEPOINT` when a
transaction is already active, keeping the whole retry atomic instead of failing
with `cannot start a transaction within a transaction`. `test-run-dlq.mjs`
covers the threshold, idempotent scans, manual retry, discard, cascade delete,
reconnect and the v4 → v5 migration.

### Dead letter queue in the GUI (Sprint 36.6)

The side panel exposes the queue through `src/core/dlq-api.ts`, a thin facade
that normalises the filter (`open` by default, plus `all`/`retried`/`discarded`)
and clamps the limit, then calls `listDeadLetters` / `retryDeadLetter` /
`discardDeadLetter`. RPC methods `list_dlq`, `retry_dlq` and `discard_dlq` are
declared in `src/rpc.ts` and handled in `src/index.ts`; the two mutations are
audited as `dlq.retry` and `dlq.discard`. `retry_dlq` only prepares the step
(reopen + `attempt + 1` + entry closed) — the handler itself is executed by a
later resume, so the panel never claims a step has already run. The UI section
shows the open count, status filter, creation time, run/step, reason, attempts,
error and status-aware actions; retry and discard ask for confirmation and
refresh the list through the same facade. `test-dlq-gui.mjs` checks the RPC/GUI
wiring, locale parity and the facade behaviour on a temporary SQLite database.

### Pause with context injection (Sprint 36.7)

The durable run model gains a new table `run_injections` (`SCHEMA_VERSION = 7`, migration step 7)
with columns `id`, `run_id` (cascade delete from `runs`), `step_name`, `kind` (`comment` /
`file` / `artifact`), `content`, `author`, `metadata_json`, `created_at`, `consumed_at`,
`consumed_by_step`, `consumed_attempt`, plus indexes `idx_run_injections_run(run_id, created_at)`
and a partial index `idx_run_injections_pending(run_id, step_name) WHERE consumed_at IS NULL`.

A run can be paused between steps: `RunStatus` gains `paused` with transitions
`pending → running/paused/cancelled`, `running → paused/passed/failed/cancelled`,
`paused → running/passed/cancelled`. `pauseRunRecord(id)` sets `paused` without filling
`finished_at`. `pauseRun(runId, input)` in `src/db/run-context.ts` requires an existing,
non-terminal run with no step currently `running`, addresses the first unfinished step (or an
explicit `stepName`), rejects completed/missing targets, and stores one injection per provided
payload (`comment`, `file` with path/content/title, `artifact` with name/content). Secrets are
masked on write: `redactSecretsInText` covers text/comment/file content, and a recursive
`redactValue` with `SENSITIVE_KEY_RE` masks whole values of sensitive JSON keys
(`*TOKEN*`, `*SECRET*`, `*PASSWORD*`, `*API_KEY*`, `*CREDENTIAL*`, `*AUTH*`, ...) to `***`.
A single injection is capped at `MAX_INJECTION_CONTENT` (100 kB).

`listRunInjections(runId, { pendingOnly })` returns history ordered by creation time, exposing
author, masked content and consumption state. `pendingInjectionsForStep(runId, stepName)` returns
the not-yet-consumed injections addressed to a step.

`StepHandler` now receives `(step, context: StepContext)` where `StepContext.injections` holds
the injections for that step. `resumeRunSync` / `resumeRun` pass them before executing each step,
and after a successful step call `consumeInjections(ids, stepName, attempt)` to mark the
injections consumed exactly once (retry keeps them for the next attempt). `finalize` calls
`consumeOrphanInjections` so injections addressed to already-completed steps do not look pending
in the history, and supports `paused → passed` when no steps remain. `ResumeResult` gains
`injected: string[]`. `test-run-context.mjs` covers schema v7, pause-before-start / pause-between
steps / explicit targeting, comment + file + artifact with secret masking and author visibility,
single-consumption on resume, repeated resume without re-delivery, pause without context,
validation errors (missing/completed/running target, terminal run, no unfinished steps, empty
path, artifact without content, oversized content), async resume and cascade delete on run
removal.

### Pause and resume in the GUI (Sprint 36.8)

`src/core/run-panel-api.ts` is the GUI-facing facade over durable runs. `listRunPanel({ filter, limit })`
accepts `active` (pending/running/paused/failed), `all`, or a concrete run status, normalizes the
limit to 1..100 and returns compact `RunPanelRun` entries: status, progress (`doneSteps` /
`totalSteps`), first unfinished `currentStep` with a stable `anchor`, up to 20 context injections
(content preview capped at 500 characters, author, timestamps, consumer) and the count of pending
injections. `active` is also reported for the panel badge.

`pauseRunPanel(runId, { comment, author, stepName? })` delegates to `pauseRun`, returning
`{ success: false, error }` instead of throwing, so the GUI can show the database error next to the
button. `resumeRunPanel(runId)` only prepares the run: it accepts `paused` or `failed`, calls
`reopenRun` (status becomes `running`), and returns the next unfinished step from `findResumeStep`.
Actual step execution remains with `resumeRun` / the DAG executor; the facade never pretends that a
step ran.

RPC methods `list_durable_runs`, `pause_durable_run` and `resume_durable_run` are declared in
`src/rpc.ts`, implemented in `src/index.ts`, and audited as `run.pause` / `run.resume` (target is the
run id). The GUI section «⏯️ Запуски DAG» in `src/gui.tsx` renders the run list with status filter,
progress, current-step anchor link, a comment field, pause/resume buttons with confirmation, a
blocked pause plus warning while the current step is `running`, and the context history with author
and consumer. Locales ru/en/zh stay in sync. `test-pause-gui.mjs` verifies the RPC contract, locale
parity, current-step/progress output, pause with masked comment and author, active/paused filters,
resume preparation, rejection of a repeated resume, end-to-end comment delivery through
`resumeRun`, running-step rejection, failed-run resume and list limits.

## Interfaces

| Interface | Audience | Entry point |
| --- | --- | --- |
| Agent tools | AI agent | 26 tools registered via `ctx.tool.transform` |
| Agent skill | AI agent | `skills/scheduled-job-best-practices` |
| RPC | Sidebar GUI | `src/rpc.ts` contracts, 53 methods |
| Sidebar GUI | Human | `gui-experimental.cjs` |
| Web dashboard | Human | `startDashboardServer` (localhost, random/fixed port) |

## Localization

User-visible text lives in flat JSON catalogs: `locales/ru.json` (default),
`locales/en.json` and `locales/zh.json`. Keys are dot-separated and grouped by surface —
`gui.*`, `notify.*`, `tool.*`, `dryRun.*`, `matrix.*`, `schedule.*` — and all catalogs
must have the same key set with non-empty values.

`src/i18n.ts` loads the catalogs once and caches them. It exposes `t(key, params)`,
`setLocale(locale)`, `messageIn(locale, key)` and `hasKey(key, locale)`. Lookup order is
active locale → `en` → `ru` → the key itself, so a missing translation never renders as
an empty string. The `locale` setting (`ru` default, `en`/`zh` optional, `auto` follows
the OpenCode interface language) is applied immediately, without restarting OpenCode.
`auto` is resolved in the GUI through `ctx.locale.locale()` with BCP 47 prefix mapping
(`zh-CN` → `zh`, `en-GB` → `en`); the resolved value is sent to the server as `uiLocale`,
because the server process cannot see the window. The sidebar GUI embeds the catalogs at
build time via `registerCatalog`, because a webview bundle cannot read package files at
runtime.

The template subset is deliberately small and dependency-free:

- `{name}` — interpolation; the caller formats the value (duration, money, date).
- `{count, plural, one {…} few {…} many {…} other {…}}` — plural forms through
  `Intl.PluralRules` for the active locale (`ru` uses one/few/many, `en` one/other,
  `zh` only `other`).

Rules:

- a user-visible message is a whole phrase in the catalog, including punctuation; never
  concatenate translated fragments;
- store stable codes, not localized text, in the database; translate at render time;
- agent tool descriptions, schemas and API payloads stay English; `console.*`
  diagnostics stay Russian;
- add every new key to all catalogs. `test-docs.mjs` enforces parity and non-empty
  values; `npm run test:en` and `npm run test:zh` replay all suites under `en`/`zh` and
  CI runs them. `OPENCODE_SCHEDULER_LOCALE` only overrides the initial locale for tests
  and services — it is not a user-facing setting.

## Security model

- The dashboard has **no authentication** and binds to localhost. Do not expose it.
- A job definition is **code**: prompts, hooks, Quality Gates and wrappers all execute
  with your user privileges. Treat task creation like granting shell access.
- `allowedTools` / `deniedTools` are **enforced at the run-wrapper level** (Sprint 29.2).
  Before each `opencode run`, the wrapper passes `permissions` rules through
  `OPENCODE_CONFIG_CONTENT`: `deniedTools` are mapped to `effect: "deny"` for the
  corresponding OpenCode action (`shell`, `edit`, `glob`, `grep`, `webfetch`,
  `websearch`, `question`, `subagent`, `skill`), and `allowedTools` (if specified)
  additionally denies every action not in the list. No config file is written, so a
  project-level `opencode.jsonc` is preserved and parallel tasks in one workdir do not
  race. The wrapper passes `--auto` so non-denied permissions are auto-approved.
  `allowedTools`/`deniedTools` metadata is still recorded in history for audit.
- **Default policy (`src/core/permissions.ts`):** the baseline is
  `permissions.defaultPolicy` — `hybrid` (default) denies `shell` and `question` while
  allowing read/edit/glob/grep/subagent/skill/webfetch/websearch, `secure` allows only
  read/glob/grep/skill, `legacy` allows everything (1.5.x behaviour). Task `legacyShell`
  re-enables `shell` under `hybrid`; `deniedTools` still wins. Policy denials are
  audited as `tool.blocked` with `reason: "default-policy"`, and each wrapper logs
  `policy=<name>, denied=<actions>` before the run.
- **Audit of blocked tools (Sprint 29.4):** when a task definition is saved,
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
  32-byte key file `secrets.key` (mode 0600 on POSIX; on Windows an ACL that removes
  inheritance and grants the current user only, applied by `icacls` on create and
  re-applied on read for keys created before 1.5.5). Workspace `env` can reference them
  as `${secret:NAME}`; values are substituted at run time and masked in logs,
  history and audit.
- Workspace paths are validated, but hooks are not sandboxed: only schedule jobs from
  repositories you trust.

### Permission model

The effective policy is resolved in this order (later wins):

1. `permissions.defaultPolicy` — the baseline: `hybrid` (default, no `shell`/`question`),
   `secure` (read-only) or `legacy` (everything allowed, 1.5.x behaviour).
2. Task `legacyShell` — re-enables `shell` under `hybrid` only.
3. Task `allowedTools` — if present, every action not listed is denied; an explicitly
   listed action can override a policy denial.
4. Task `deniedTools` — always denied and takes priority over `allowedTools`.
5. The generated `OPENCODE_CONFIG_CONTENT` — passed in the wrapper environment; no file
   is written and the project config stays untouched.
6. Project `opencode.json(c)` and system config — merged by OpenCode; a closer or
   system-level config can weaken task-scoped denies (see limitations below).
7. `--auto` — auto-approves everything that remains, so no interactive prompts block
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

## Mission runtime и гибридные входы (план 38–40)

> Статус: спека. Что уже в коде, а что нет — [ROADMAP.md](../ROADMAP.md) §1.

Система гибридная: ядро (**mission runtime**) не знает про планировщик ОС.
Планировщик — адаптер входа, регистрация опциональна.

### Классы входа

| Класс | Вход | Регистрация в ОС | Реализация |
|---|---|---|---|
| Ad-hoc | `run_mission` / CLI / GUI / RPC | нет | план 38 |
| Внутренний | chain / DAG / retry / escalation | нет | сейчас через `backend.runTask` + force-маркер; план 40 — напрямую в runtime |
| Registered | cron / once / file / git / mcp-event / webhook | да (cron/once) | есть: `core/scheduler/*`, `file-watcher`, `git-trigger`, `integrations` |

### Объекты

| Объект | Содержимое | Таблица |
|---|---|---|
| Миссия | цель + scope + gate-спека + safety + бюджет | `missions` (план 38, опциональный шаблон) |
| Задача | миссия-шаблон + триггер | `tasks` (есть) |
| Запуск | durable-исполнение: шаги, попытки, вердикты | `runs` / `run_steps` (есть, SCHEMA_VERSION 7) |
| Исход гейта | вердикт + provenance + экономика | `gate_outcomes` (план 40) |

### Путь исполнения (целевой)

```
вход → intake (gate + safety → политика + бюджет) → createRun(trigger_kind)
     → planner → [route → context compile → execute → GATE]* → artifact → report
```

Существующий путь планировщика (`wrapper → opencode run → record-history → history`)
сохраняется для обратной совместимости; в 40 он подключается к runtime и создаёт
durable-run, а исходы гейта пишутся в ledger.

### Что переиспользуется

- Durable state: `db/runs-repo`, `run-journal`, `run-resume`, `step-idempotency`, `run-context`.
- Роутинг: `core/router/rules|dispatch|escalation|planner`, `db/capability-repo`.
- Права и секреты: `core/permissions`, `core/secrets` (scoped-инъекция).
- Телеметрия: `core/otel`, `core/prometheus`, `core/structured-log`.
- Пауза с инъекциями: `db/run-context` + `core/run-panel-api` → основа approval-гейта.
- Retrieval для scaffolding: подход bag-of-words из `notification_embeddings`.
