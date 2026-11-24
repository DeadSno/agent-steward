## 1. Start by looking at what already exists

Call `list_tasks` before creating anything. If a similar task exists, prefer `update_task`
(partial update, matrix clones are synchronized) over delete + create. Automation that
silently duplicates work is worse than no automation.

Check the returned fields: schedule, trigger, working directory, model, dependencies, matrix
summary, last run.

## 2. Choose the simplest shape that works

| User need | Shape | Why |
| --- | --- | --- |
| "Every morning / every hour / weekly" | `schedule_task` with cron | Durable OS-level schedule, survives restarts |
| "When this file changes" | `triggerType: "file"` + `watchPath` | No polling; the watcher debounces bursts |
| "When my MCP server reports an event" | `schedule_advanced` (admin profile) with `triggerType: "mcp-event"` + `mcpEvent` | Event-driven, no wasted runs; `mcpEvent` is excluded from the core `schedule_task` profile (PL-129) |
| "Same work in N repositories" | `matrix.workspaceIds` | One definition, isolated clones, aggregated status |
| "A then B then C" | `dependsOn` + `nextTaskOnSuccess` / `nextTaskOnError` | Explicit DAG, failures stop the line |
| "Try again if it fails" | `retryCount` + `retryDelay` | Handles flaky networks and rate limits |
| "Once a month / once a year" | `schedule_task` with `M H D M *` | Native `MONTHLY` (with `/m` for a fixed month), no minute polling |

**Cron-to-OS limitation (QV-10).** Windows Task Scheduler expresses `MINUTE`,
`HOURLY`, `DAILY`, `WEEKLY` and `MONTHLY`. Expressions outside this subset (lists,
ranges, `*/N` on day-of-month/weekday, a foreign IANA timezone) fall back to a
one-minute OS poll with a schedule gate in the wrapper. A yearly cron such as
`0 4 1 1 *` is now converted natively to `MONTHLY /d 1 /m JANUARY /st 04:00`,
so the OS does not tick every minute for a task that runs once a year.

`triggerType: "mcp-event"` (as well as `file`/`git`) is event-driven, but it **still
registers an enabled OS placeholder entry**: `ONCE 31.12.2099 00:00`, Status `Ready`
(`src/core/scheduler/windows.ts`, the non-cron branch). The OS never fires it on its own;
the entry exists only so manual start (`schtasks /run`), DAG dependencies and `runMatrix`
have an OS object to run, and it is removed together with the task by `delete_task`.
A fresh task `QV1-live-mcp-os-probe` created with `schedule_advanced` (admin profile) and `mcpEvent:{server:'qv1probe',event:'qv1.live.probe'}`
was verified in `schtasks` on 20.11.2026 (QV-1) — the `31.12.2099` date is intentional,
not an artifact of a paused task.

**Child run surface (QV-8).** The task wrapper exports `AGENT_STEWARD_CHILD_RUN=1`
before `opencode run` (PowerShell restores the previous value in `finally`). When the
plugin is loaded with that marker it skips V2/V1 registration: no scheduler tools, RPC,
skill or dashboard in the child process. A controlled check measured the tool registry at
32 tools in the parent vs 0 in child mode. This prevents a scheduled agent from seeing
the same 32 tools recursively and racing the parent for the dashboard port.

Do not use a 5-field cron for a one-off reminder. Do not build a pipeline with chained
prompts inside a single task when `dependsOn` exists: a failed step would be invisible.

**Task names (PL-9.1).** `schedule_task` validates the name: letters (including Cyrillic),
digits, space, dot, underscore and an **ASCII hyphen `-`** are allowed. The em dash `—`
and round brackets `()` are **rejected**. Rewrite the title with words and `-` before
creating the task so the original name is not silently replaced:
`QA-A2 - Full plugin typing epic`, not `Задача QA-A2 — Полная типизация (эпик)`.

## 3. Write prompts that survive without context

Every run starts from a clean slate: no chat history, no memory of the previous run, nobody
to answer questions. A good prompt states:

1. **Goal** — the outcome in one sentence.
2. **Scope** — exact paths, repositories or modules to touch.
3. **Constraints** — what must not change, tool limits, style rules.
4. **Verification** — the command that proves success (this is the Quality Gate).
5. **Output** — where to write the report and what to include (counts, links, failures).

Bad: `Check the repo and fix problems.`
Good: `In ./services/api run the test suite. If tests fail, fix only failures caused by
type errors, then re-run until green or 20 minutes elapse. Write a summary to
reports/nightly-api.md with the failing test names and the commit you started from.`

Never ask the agent to "ask the user" in a scheduled prompt — nobody is there. If a decision
is genuinely ambiguous, tell it to stop and write the question into the report.

### Prompt template for planning-document updates (PL-3.1)

When a prompt asks the agent to close tasks in `ROADMAP.md`, keep `TEST-PLAN.md` or
write a CHANGELOG entry, put the exact line format and the artifact checklist into
the prompt itself — do not rely on the agent to guess them:

````text
Roadmap line format (copy verbatim, one line per closed subtask):
- [x] <ID> <title>: <files> — <P0|P1|P2|P3>. Действие: <what to do>

Rule: wrap every EXISTING file path in backticks, e.g.
  - [x] TP-6 test plan gate: `test-test-plan.mjs`, `scripts/gen-test-plan-counters.mjs` — P3. Действие: ...
Never invent a file: a path that does not exist must not appear as an artifact and must
not be given backticks. Verify each path before writing the line.

Artifact checklist (copy into the prompt and tick before reporting done):
- [ ] ROADMAP.md: closed lines removed (or [x] only if the doc explicitly keeps them),
      no duplicate of a closed ID remains.
- [ ] CHANGELOG.md: one entry per closed detail/subtask with the ID and the result.
- [ ] TEST-PLAN.md: §5 row for each existing `test-*.mjs`, filename in backticks;
      no row for a missing file; counters match the code.
- [ ] If the task adds a NEW `test-*.mjs`, put `package.json`, `TEST-PLAN.md` and every
      counter file into SCOPE immediately: add `test:<name>` and the `node test-<name>.mjs`
      call to the `test` chain, a §5 row, and update the file/script/suite counters in
      README (all locales) and local `SKILL.md`. Otherwise `test-docs.mjs` and
      `test-test-plan.mjs` fail the Quality Gate after otherwise correct work (PL-67).
- [ ] reports/<name>.md: report written with statuses, verification commands and results.
- [ ] Verification commands actually run (build / target test / lint baseline).
````

This is the concrete form of items 4–5 above: "Verification" and "Output" must be
machine-checkable, not a wish. A line for a non-existent `test-feedback.mjs` is worse
than a missing line, because the gate then checks a file that will never appear.

