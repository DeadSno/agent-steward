---
name: Scheduled Job Best Practices
description: Use when the user wants recurring or event-driven automation (cron, file changes, MCP events), multi-repository fan-out, or agent pipelines. Covers safe defaults, prompt design, Quality Gates, matrix builds, DAG dependencies and post-incident diagnosis with the scheduler tools.
---

# Scheduled Job Best Practices

Use this skill for automation on a schedule, on a file change, on an MCP event,
or as a multi-step pipeline. The goal is automation that is safe, cheap,
idempotent and debuggable a month later.

Respond in the user's language. This document is in English for portability.
T-5: long tables and recipes moved to `references/`; this file keeps only
triggers and a short checklist.

## References — read the one that matches your job

- `references/triggers-and-prompts.md` — trigger shapes (cron/file/git/mcp-event/once),
  cron-to-OS limits, task-name rules (PL-9.1), self-contained prompt template (PL-3.1).
- `references/safety-and-environments.md` — least privilege, self-check prompts
  (PL-2.1/2.2), sub-agents on Free tier (PL-72/90), worktree setup (PL-109).
- `references/matrix-dag-ops.md` — matrix builds, DAG rules (PL-5.1/5.2, PL-40),
  validation, failure diagnosis, anti-patterns, final checklist.
- `references/recipes.md` — complete ready-to-copy task definitions.

## 1. Look before you create

Call `list_tasks` first. If a similar task exists, prefer `update_task` (partial
update; matrix clones are synchronized) over delete + create. Silent duplicates
are worse than no automation. Check schedule, trigger, working directory, model,
dependencies, matrix summary and last run.

## 2. Pick the simplest trigger

| Need | Shape |
| --- | --- |
| Every morning / hour / week | `schedule_task` with cron (durable OS schedule) |
| When a file changes | `triggerType: "file"` + `watchPath` |
| When an MCP server reports an event | `schedule_advanced` (admin profile) with `triggerType: "mcp-event"` + `mcpEvent` — not in core `schedule_task` |
| Same work in N repositories | `matrix.workspaceIds` |
| A then B then C | `dependsOn` or `nextTaskOnSuccess` — never both for one transition |
| Try again on failure | `retryCount` + `retryDelay` |

Triggers other than cron still register an enabled OS placeholder entry
(`ONCE 31.12.2099 00:00`, QV-1) so manual start, DAG and `runMatrix` have an OS
object to run. Cron expressions outside the Windows subset fall back to a
one-minute OS poll with a schedule gate (QV-10); a yearly cron is native
`MONTHLY /m ...` now.

**Child runs (QV-8):** the wrapper exports `AGENT_STEWARD_CHILD_RUN=1`, so the
plugin skips V2/V1 registration in the child process. The parent exposes
34 tools, the child sees 0 — this is intentional, not a missing tool. A scheduled
agent must not see the same 34 tools recursively and race the parent for the
dashboard port.

**Names (PL-9.1):** letters, digits, space, dot, underscore and ASCII hyphen are
allowed; em dash and round brackets are rejected. Use `QA-A2 - Full typing epic`.

## 3. Prompts that survive a clean start

Every run starts with no chat history. State: **Goal** (one sentence), **Scope**
(exact paths/modules), **Constraints** (what must not change), **Verification**
(machine-checkable command) and **Output** (report path and contents). Never ask
the user in a scheduled prompt; write the question into the report instead.

For tasks closing ROADMAP/CHANGELOG/TEST-PLAN items, put the exact line format and
the artifact checklist into the prompt verbatim (PL-3.1, see
`references/triggers-and-prompts.md`). A line for a non-existent `test-*.mjs` is
worse than a missing line. If you add a new `test-*.mjs`, update `package.json`,
the `test` chain, TEST-PLAN §5 and all counters immediately (PL-67).

## 4. Safety defaults

- Default `hybrid` policy denies `shell` and `question` — keep it that way.
  Put `npm test`/build/git in `qualityGate`/`afterScript`, not in the agent prompt.
- If the prompt demands a self-check, either allow `shell` or move the check into
  a hook — never "no shell" plus "verify with node/tests" (PL-2.1/2.2).
- Always set `timeoutSeconds` for network/model work; add a `qualityGate` whenever
  success is machine-checkable.
- No secrets in prompts (plain text in DB and logs). Prefer "ensure state" over
  "append" for idempotence. Avoid force-push, `rm -rf` and mass upgrades without
  a smoke run.
- Pass `model` as `provider/model`, e.g. `opencode/hy4-flash-free`; a bare model
  id is rejected (PL-74/PL-88).
- Free tiers may refuse sub-agents; optional only. Check availability, fall back
  to the main agent on `Free usage limit reached`, keep the reason in the report
  and never fake completion (PL-72/90/108).
- A fresh worktree has no `node_modules`/`dist`: create junctions or run `npm ci`
  before building (PL-109).

## 5. Matrix and DAG in one paragraph

Matrix: `matrix.workspaceIds`, `strategy: parallel|sequential`,
`failureMode: continue|stop`, small `concurrency` (2–4). The parent never runs
itself; a dependency on the parent waits for all clones; after `update_task` the
clones are re-diffed. DAG: use **either** `nextTaskOnSuccess` **or** `dependsOn`
for one transition, never both (PL-5.1/5.2); a multi-parent dependency can fire
more than once (PL-40). Keep chains short (≤4–5 nodes), never create cycles.
When a task has a machine-checkable gate, the wrapper guards the worktree
snapshot (PL-25).

## 6. Validate and diagnose

1. `dry_run` (whole pipeline or one task) — order, dependencies, estimated time.
2. `schedule_task`, then one `run_task_now` and inspect `get_history` / `get_task_logs`.
3. Only then call it ready; state the cron in plain language.

Diagnosis: filter `get_history` by task/status; tail the wrapper log to separate
model failure, gate failure, timeout and lock-skip. Structured journal stores
stdout/stderr **separately** with the real exit code (PL-7.2) — git writes to
stderr even on success. A timeout usually means an over-broad prompt; a skip
(`already running`) means the previous run overran its interval. For matrix
problems use `matrix_control` with `results`/`cancel`/`cleanup`.

## 7. Short checklist

- [ ] `list_tasks` checked; no duplicate; trigger type matches the need.
- [ ] Prompt states goal, scope, constraints, verification and output.
- [ ] `timeoutSeconds` set; `qualityGate` set when checkable.
- [ ] Least-privilege tools; self-check has shell or a hook.
- [ ] Matrix: workspaces, concurrency cap, failure mode.
- [ ] `dry_run` reviewed; one successful `run_task_now` with clean history.
- [ ] Cron also expressed in words for the user.

Full anti-patterns and recipes live in `references/matrix-dag-ops.md` and
`references/recipes.md`.
