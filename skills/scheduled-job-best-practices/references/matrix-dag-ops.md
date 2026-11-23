## 5. Matrix builds (multi-repository)

Use a matrix when the same prompt must run in several workspaces:

- `matrix.workspaceIds` — the repositories, referenced by workspace ID (call
  `manage_workspaces` with `action: "list"` to discover them).
- `matrix.strategy` — `parallel` (default) or `sequential`.
- `matrix.failureMode` — `continue` (default, aggregated as `partial`) or `stop`.
- `matrix.concurrency` — cap simultaneous clones; respect machine and API limits. Keep it
  small (2–4) unless the work is purely local.
- `matrix.overrides` — per-workspace prompt/model/qualityGate/hooks when one repository
  differs (different package manager, stricter gate).
- `matrix.createAggregator` — creates a follow-up task that runs once after all clones.

Rules of thumb:

- The matrix parent never runs itself; only its clones do. Do not set `workspaceId` on the
  parent — it is a validation error to combine it with `matrix`.
- A dependency on a matrix parent waits for **all** clones to succeed.
- If clones are inherently independent (linting, docs), `failureMode: "continue"` gives a
  useful aggregate. If one failure makes the rest pointless (deploy), use `"stop"`.
- After editing a matrix parent with `update_task`, clones are diffed and synchronized;
  running clones are left alone.

## 6. DAG rules

- `dependsOn` lists task names that must have succeeded (their latest run) before this task
  starts.
- `nextTaskOnSuccess` / `nextTaskOnError` chain a single follow-up run; use them for
  notifications and rollbacks.
- **One transition, one mechanism (PL-5.1/PL-5.2).** For a linear `A → B` step use
  **either** `A.nextTaskOnSuccess = "B"` **or** `B.dependsOn = ["A"]`, never both.
  If both describe the same transition, `B` is triggered twice when `A` finishes — once
  as the chain target and once as a DAG dependent — producing duplicate runs. `dry_run`
  warns about this overlap, and the recorder now de-duplicates targets by name, but the
  configuration itself should be fixed.
- **A dependency completion is an event, not a one-shot latch (PL-40).** A task with two
  parents (`dependsOn: [A, B]`) is started whenever either parent finishes while all
  parents' latest records are successful — so two completions can mean two runs. A stale
  success also satisfies the gate. The dependent's own `startedAt` only suppresses a
  re-trigger when it is newer than the newest dependency `finishedAt`. If you need
  exactly one follow-up run, use `nextTaskOnSuccess` (a single-parent chain) instead of
  a multi-parent `dependsOn`.
- **Worktree snapshot for Quality Gate (PL-25).** When a task has a machine-checkable gate,
  the wrapper snapshots `HEAD` plus guarded-path status at task start into a sibling
  `*.worktree.json` and verifies it immediately before the gate. Foreign uncommitted edits
  in `src/` during the run fail closed: the gate is skipped and the run is marked as an
  error. Override guarded paths with `AGENT_STEWARD_GATE_GUARD_PATHS` (`|`/`;` separated).
- Keep chains short and named by intent (`deploy` → `smoke-tests` → `notify-release`).
- Cycles and self-dependencies are rejected; if a chain grows past 4–5 nodes, consider one
  task with an explicit internal checklist instead.

## 7. Validate before you commit

1. `dry_run` with the task name (or without a name for the whole pipeline): shows order,
   dependencies, matrix fan-out, estimated duration and cost. Nothing is executed.
2. Create the task with `schedule_task`.
3. `run_task_now` once and inspect `get_history` / `get_task_logs`. A schedule that has never
   run successfully is a liability.
4. Only then tell the user it is ready, and state the cron expression in plain language
   ("every weekday at 09:00 local time").

## 8. Diagnosing failures later

- `get_history` filtered by `taskName` and `status` — statuses: `running`, `success`, `error`,
  `timeout`, `partial`.
- `get_task_logs` with `lines` — tail of the wrapper log; use it to distinguish model failure,
  Quality Gate failure, timeout and lock-skip.
- Structured journal (`logs/runs.jsonl`, `hook.output` events, PL-7.2): post-flight stdout
  and stderr are stored in **separate** fields with the real `postFlightExitCode`. Git writes
  progress/diagnostics to stderr even on success, so compare the exit code and stdout — do
  not treat a non-empty stderr as a failed push. See `references/recipes.md` §11 for the
  commit/push wrapper that makes this reliable.
- Matrix problems: `matrix_control` with `action: "results"` for counters, `action: "cancel"`
  to stop pending clones, `action: "cleanup"` to remove clones whose parent is gone.
- A timeout usually means the prompt is too broad. Split it or raise `timeoutSeconds`
  deliberately.
- A skipped run (`already running`) means the previous run overran its interval; shorten the
  prompt, raise the interval, or set a smaller timeout.

## 9. Anti-patterns

| Anti-pattern | Consequence | Fix |
| --- | --- | --- |
| `* * * * *` with a heavy prompt | Runs overlap, lock-skips, cost spikes | Realistic interval + timeout |
| Prompt depending on chat context | Nonsense output at 03:00 | Self-contained prompt with paths |
| No Quality Gate on a "fixer" job | Broken code reported as success | `qualityGate: "npm test"` |
| `nextTaskOnSuccess` and `dependsOn` for one transition | Duplicate runs of the same step | Keep one mechanism only (PL-5.1/PL-5.2) |
| Prompt demands `node`/tests but shell is denied | `tool.blocked`, fake "verified" report | `shell` in `allowedTools` or checks in `qualityGate`/`afterScript` |
| Closed task left in `ROADMAP.md` with a missing/incorrect file name | Gate checks a file that does not exist | Exact line format + artifact checklist in the prompt (PL-3.1) |
| Matrix with 20 workspaces, no concurrency cap | Machine and API saturation | `matrix.concurrency: 2–4` |
| Secrets inside the prompt | Leak into DB, logs and dashboard | Env vars or files |
| Deleting a matrix parent's clone by hand | Orphaned history, broken aggregate | `update_task` on the parent |
| Creating a duplicate instead of updating | Double runs, conflicting writes | `update_task` |

## 10. Final checklist

Before saying the job is done, confirm:

- [ ] `list_tasks` checked; no duplicate exists.
- [ ] Trigger type matches the need (cron / file / MCP event).
- [ ] Prompt states goal, scope, constraints, verification and output; for doc updates it
      includes the exact line format and the artifact checklist from §3 (PL-3.1).
- [ ] `timeoutSeconds` set; `qualityGate` set when checkable.
- [ ] `allowedTools` / `deniedTools` follow least privilege; shell is absent unless justified.
      If the prompt demands a self-check, shell is in `allowedTools` or the check lives in
      `qualityGate`/`afterScript` — never both "no shell" and "verify with node/tests" (PL-2.1).
- [ ] Matrix: workspaces correct, concurrency capped, failure mode justified.
- [ ] `dry_run` reviewed.
- [ ] One successful `run_task_now` with clean `get_history`.
- [ ] Cron expressed in words for the user.

See `references/recipes.md` for complete examples.
