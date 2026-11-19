# Pipeline as code

`opencode.pipeline.yaml` describes a whole workflow — triggers, DAG dependencies,
defaults and matrix fan-out — as one reviewable file. The scheduler validates it,
turns every step into a task, and applies it idempotently.

- [File format](#file-format)
- [Steps and dependencies](#steps-and-dependencies)
- [Triggers](#triggers)
- [Defaults](#defaults)
- [Matrix fan-out](#matrix-fan-out)
- [Validate, apply, export](#validate-apply-export)
- [Apply semantics](#apply-semantics)
- [Agent tools](#agent-tools)
- [Validation rules](#validation-rules)
- [Limitations](#limitations)

A ready-to-run example lives in [`opencode.pipeline.yaml`](../opencode.pipeline.yaml).

## File format

```yaml
version: 1
name: nightly-release
description: Lint, test and build the repository every night.

defaults:
  timeoutSeconds: 1800
  retryCount: 1
  retryDelay: 120

steps:
  - id: lint
    schedule: "0 2 * * *"
    prompt: Run the linter and fix what it reports.
    qualityGate: npm run lint

  - id: test
    needs: [lint]
    trigger: dag
    prompt: Run the tests and fix failures.
    qualityGate: npm test
```

| Field | Required | Meaning |
| --- | --- | --- |
| `version` | yes | Format version. Must be `1`. |
| `name` | yes | Pipeline name, 1–120 characters: letters, digits, space, `.`, `_`, `-`. |
| `description` | no | Free-form text for humans. |
| `defaults` | no | Values inherited by every step (see [Defaults](#defaults)). |
| `steps` | yes | 1–200 steps. |

Every step becomes a scheduler task. Unless the step sets `name`, the task is named
`<pipeline> <step id>` — for example `nightly-release test`. The name must pass the
normal task-name rules (letters, digits, space, `.`, `_`, `-`), so keep pipeline names
and step ids reasonably short.

## Steps and dependencies

| Field | Type | Meaning |
| --- | --- | --- |
| `id` | string | Stable step identifier, 1–64 characters. Unique within the pipeline, case-insensitive. |
| `name` | string | Task name override. Default: `<pipeline> <id>`. |
| `prompt` | string | Agent prompt. Required and non-empty. |
| `needs` | string[] | Step ids that must finish successfully first. Becomes `dependsOn`. |
| `schedule` | string | Cron expression for `trigger: cron`. |
| `trigger` | enum | `cron` (default), `once`, `dag`, `file`, `git`, `mcp-event`. |
| `runAt` | string | ISO-8601 start time for `trigger: once`. |
| `qualityGate` | string | Command that decides whether the run is successful. |
| `beforeScript` / `afterScript` | string | Hooks around the agent run. |
| `model` | string | `provider/model` (optionally `provider/model#variant`). |
| `priority` | integer | 0–10, higher runs first. |
| `timeoutSeconds` | integer | Hard timeout, at least 1. |
| `retryCount` / `retryDelay` | integer | Retries (≥ 0) and delay between them. |
| `workingDirectory` | string | Run directory for the step. |
| `workspaceId` | string | Run inside a workspace. Cannot be combined with `matrix`. |
| `allowedTools` / `deniedTools` | string[] | Per-step tool policy. A non-empty `allowedTools` is an allowlist. |
| `matrix` | object | Fan the step out over workspaces (see [Matrix fan-out](#matrix-fan-out)). |
| `timezone` | string | IANA timezone, e.g. `Europe/Moscow`. |
| `notBefore` / `notAfter` | string | Launch window as `HH:MM`; `notAfter` may be earlier (crosses midnight). |
| `activeDays` | integer[] | Allowed weekdays, `0` = Sunday. |
| `windowPolicy` | enum | `skip`, `postpone` (default) or `run` outside the window. |

Dependencies are declarative: a step listed in `needs` starts only after every
dependency's latest run succeeded. Cycles, unknown ids and self-references are rejected
before anything is created.

A step that has no trigger of its own uses `trigger: dag`:

```yaml
steps:
  - id: lint
    schedule: "0 2 * * *"
    prompt: Lint the repository.

  - id: test
    needs: [lint]
    trigger: dag
    prompt: Run the tests.
```

`dag` steps are stored as dependency-only tasks (`triggerType: "file"` with an empty
schedule), just like matrix parents: the DAG engine starts them, not the OS scheduler.
They must have a non-empty `needs`; otherwise they would never run.

## Triggers

| `trigger` | Requires | Behaviour |
| --- | --- | --- |
| `cron` (default) | `schedule` in the step or defaults | Registered with the native OS scheduler. |
| `once` | `runAt` (ISO-8601) | Runs once at the given moment; `schedule` is ignored. |
| `dag` | non-empty `needs` | Started by the DAG engine after dependencies succeed; `schedule` is ignored. |
| `file`, `git`, `mcp-event` | — | Accepted by the validator, but see [Limitations](#limitations). |

Cron expressions use the same parser as regular tasks: five fields, lists, ranges,
steps, month and weekday names, `@every 15m`, `L` and `FRI#3`. The validator calls that
parser, so an invalid expression is reported before apply.

A one-shot pipeline step:

```yaml
steps:
  - id: deploy
    trigger: once
    runAt: "2026-11-20T22:40:00+03:00"
    prompt: Deploy the current main branch.
```

## Defaults

`defaults` is inherited by every step that does not set the field itself. Supported
keys: `schedule`, `trigger`, `model`, `priority`, `timeoutSeconds`, `workingDirectory`,
`retryCount`, `retryDelay`, `allowedTools`, `deniedTools`, `timezone`.

Defaults do not include `matrix`, quality gates, hooks, launch windows or
`workspaceId` — set those per step. Unknown keys under `defaults` produce warnings so
typos are visible.

## Matrix fan-out

A step with `matrix` becomes a matrix parent: one clone per workspace, with the same
strategy, failure mode, concurrency and aggregation as a regular matrix task.

```yaml
steps:
  - id: deploy
    schedule: "0 3 * * *"
    prompt: Build, test and deploy this repository.
    matrix:
      workspaces: [frontend, backend]
      strategy: parallel
      failureMode: continue
      concurrency: 2
      aggregation: summary
      createAggregator: true
```

| `matrix` field | Default | Meaning |
| --- | --- | --- |
| `workspaces` | required | Workspace names or ids; non-empty and unique. |
| `strategy` | `parallel` | `sequential` starts the next clone after the previous one. |
| `failureMode` | `continue` | `stop` cancels the remaining clones after the first failure. |
| `concurrency` | unlimited | Maximum clones running at once. |
| `aggregation` | `summary` | `summary` writes one aggregate record for the parent. |
| `createAggregator` | `false` | Also create `<parent>-matrix-complete`. |

Workspace names are resolved when the file is applied. An unknown name produces a
warning and the step is rejected at apply time, so create workspaces first (or use
their ids). `matrix` cannot be combined with `workspaceId` on the same step.

## Validate, apply, export

The CLI ships with the package (`agent-steward` binary):

```bash
agent-steward pipeline validate opencode.pipeline.yaml
agent-steward pipeline apply opencode.pipeline.yaml --dry-run
agent-steward pipeline apply opencode.pipeline.yaml
agent-steward pipeline export --pipeline nightly-release
agent-steward pipeline export --pipeline nightly-release --out opencode.pipeline.yaml
```

| Command | Flags | Result |
| --- | --- | --- |
| `pipeline validate <file>` | `--json` | Parses and validates; never changes tasks. |
| `pipeline apply <file>` | `--dry-run`, `--json` | Creates and updates tasks; `--dry-run` only prints the plan. |
| `pipeline export` | `--pipeline <name>`, `--out <file>` | Rebuilds YAML from tasks; stdout unless `--out` is given. |

Exit codes: `0` success, `1` validation/apply errors (or an unknown pipeline on export),
`2` bad arguments. Human-readable output is in Russian; add `--json` for stable machine
output.

`validate --json` returns:

```json
{ "ok": true, "errors": [], "warnings": [], "steps": 3 }
```

`apply --json` returns the plan summary:

```json
{
  "pipeline": "nightly-release",
  "dryRun": false,
  "creates": ["nightly-release build"],
  "updates": ["nightly-release test"],
  "unchanged": ["nightly-release lint"],
  "stale": []
}
```

## Apply semantics

Apply is a three-way diff, not a blind rewrite:

1. Tasks of this pipeline are matched by the `pipelineName` + `pipelineStepId` markers
   stored in their definition. Matching is case-insensitive.
2. A step with no matching task is **created**.
3. A step whose significant fields changed is **updated**; the comparison covers the
   schedule, prompt, trigger, DAG dependencies, model, matrix, gates, hooks, tool
   policy, launch window and pipeline markers.
4. A step with an identical definition is **unchanged** and untouched.
5. A task of the same pipeline that is no longer in the file is reported as **stale**.
   It is never deleted automatically — delete it manually or return the step to the
   file.

Tasks that do not carry pipeline markers are never read, updated or deleted by apply.
Running `apply` twice in a row is safe: the second run reports `unchanged` for every
step.

Renaming `name` starts a new pipeline identity. The old tasks keep their old marker, so
they are not matched, not reported as stale and must be removed by hand.

`export` reverses the mapping: it restores `needs` from `dependsOn`,
`matrix.workspaces` from `matrix.workspaceIds`, and the trigger from `triggerType`.
A `file` task with no schedule, no watch path and non-empty `dependsOn` is exported as
`trigger: dag`. Dependencies that point outside the pipeline are dropped with a
warning, and the default `<pipeline> <step>` name is omitted.

## Agent tools

| Tool | Arguments | What it does |
| --- | --- | --- |
| `pipeline_validate` | `path?`, `source?` | Validates a file or inline YAML. Returns pipeline name, step count, errors and warnings. |
| `pipeline_apply` | `path?`, `source?`, `dryRun?` | Idempotent create/update. `dryRun: true` only reports the diff. |
| `pipeline_export` | `pipeline` | Returns the pipeline as YAML plus warnings. |

`pipeline_apply` writes an audit record with action `pipeline.apply`. Pass either
`path` or `source`; with neither, the tool returns an explicit error.

## Validation rules

Validation never throws: it returns `{ ok, errors, warnings }`, where every issue has a
`path` such as `steps[2].schedule` and a human-readable message. Errors block apply;
warnings do not.

| Area | Rule |
| --- | --- |
| Format | YAML up to 1 MiB, duplicate keys rejected, aliases limited to 100. |
| `version` | Exactly `1`. |
| `name` | Non-empty, ≤ 120 characters, no control characters, limited alphabet. |
| `steps` | 1–200 entries. |
| Step `id` | Non-empty, ≤ 64 characters, must start with a letter or digit, then letters, digits, `.`, `_`, `-`; unique case-insensitively. |
| `prompt` | Non-empty. |
| Task name | Explicit `name` must pass task-name validation; generated names must not collide case-insensitively. |
| `needs` | No duplicates, no self-reference, every id must exist, no cycles. |
| Cron | A cron step needs `schedule`; the expression must parse with the shared cron parser. |
| `once` | `runAt` must be valid ISO-8601. |
| `dag` | `needs` must be non-empty; `schedule` is ignored with a warning. |
| Other triggers | `schedule` on `file`, `git` or `mcp-event` is ignored with a warning. |
| Numbers | `priority` 0–10; `timeoutSeconds` ≥ 1; `retryCount` and `retryDelay` are non-negative integers; `concurrency` ≥ 1. |
| Tools | `allowedTools` must be a non-empty array of non-empty strings; `deniedTools` must be an array of strings. |
| Matrix | `workspaces` non-empty and unique; valid enum values; no `workspaceId` on the same step. |
| Timezone | Valid IANA zone name. |
| Window | `notBefore`/`notAfter` valid `HH:MM`; `activeDays` integers 0–6; `windowPolicy` one of the enum values. |
| Unknown keys | Reported as warnings at the root, in `defaults`, in a step and in `matrix`. |

## Limitations

- **File, git and MCP-event triggers are not fully expressible yet.** The validator
  accepts the trigger names, but the format has no fields for `watchPath`, globs, git
  filters or an MCP event name. Use `schedule_task` / `update_task` for those tasks in
  v1.
- **No automatic deletion.** Removed steps stay as stale tasks on purpose, so a bad
  edit cannot destroy a working schedule. Clean them up by hand.
- **Not in the format yet:** session continuity (`session` / `sessionMaxRuns`), `env`
  and secrets, chains (`nextTaskOnSuccess` / `nextTaskOnError`), incoming webhooks,
  `runWhenLoggedOff`, `paused`, and per-workspace matrix `overrides`. Use
  `schedule_task` for those, or manage them after apply.
- **One profile at a time.** Apply and export work against the active profile's
  database.
- **A pipeline is identified by `name`.** Treat the name as an immutable key; renaming
  it leaves the old task family behind.
