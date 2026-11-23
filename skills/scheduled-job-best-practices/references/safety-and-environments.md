## 4. Safety defaults

- **Least privilege**: the default `hybrid` policy already denies `shell` and `question`; keep it
  that way. Read-only monitoring jobs should not be allowed to `write` or run shell. Do not ask
  for `shell` just to run `git commit`, a build or tests — put those in `qualityGate`/`afterScript`,
  which the wrapper runs outside the agent. If a job truly needs shell, list `shell` in
  `allowedTools` (or set `legacyShell: true` for a migrated task) and explain why.
- **Self-check prompts (PL-2.1/PL-2.2)**: decide the tool policy at creation time. If the prompt
  says "run `node`", "`npm test`", "`pytest`" or otherwise verifies its own work, then either put
  `shell` into `allowedTools` immediately, or move every such check into `qualityGate`/`afterScript`
  so the wrapper runs it. Leaving shell denied while demanding a self-check produces
  `tool.blocked` in the audit log and a "verified" report that verified nothing. `dry_run` warns
  about this combination.
- **Timeout**: always set `timeoutSeconds` for jobs that call networks or models. Default
  timeouts are a safety net, not a plan.
- **Quality Gate**: pass `qualityGate` whenever a machine-checkable success criterion exists
  (`npm test`, `pytest -q`, `curl -f`, `git diff --quiet`). A run that "looks successful" is
  not evidence.
- **No secrets in prompts**: prompts are stored in plain text and appear in logs. Reference
  environment variables or files instead.
- **Idempotent by design**: a job may run twice (retry, catch-up after downtime, manual run).
  Prefer "ensure state" over "append" — e.g. rewrite a report file rather than appending.
- **Blast radius**: avoid `git push --force`, `rm -rf`, mass dependency upgrades or
  production deploys without a Quality Gate and a manual `run_task_now` smoke test first.
- **Model reference format (PL-74/PL-88)**: always pass `model` as `provider/model`
  (optionally `provider/model#variant`), e.g. `opencode/hy4-flash-free`. A bare
  `hy4-flash-free` is rejected by `schedule_task`/`update_task` and by `dry_run`:
  OpenCode would fail with `Invalid model reference: ...` before the agent starts.
  Discover valid values with `opencode models`.

### 4.1 Sub-agents on Free-tier providers (PL-72/PL-90)

A sub-agent is an optimisation, not a guarantee. On Free usage limits the provider
may refuse the spawn immediately, so never make a deliverable depend on it:

1. **Check the provider before spawning.** Run `opencode models` (or the plugin's
   availability check) and confirm the intended `provider/model` is present. For a
   scheduled task, run `dry_run` first: it now warns with `PL-76:` when the model is
   unavailable and names a fallback (preferring a free model of the same provider,
   e.g. `opencode/hy4-flash-free`).
2. **Fall back to the primary agent on `Free usage limit reached`.** If a sub-agent
   (`general`, `explore`, etc.) fails with `Free usage limit reached. Connect a
   provider or subscribe to OpenCode Go...`, do not retry it in a loop and do not
   abandon the work. Continue in the main agent session and finish the SCOPE.
3. **Keep the reason in the report.** Record in the task report (for this repository:
   `reports/steward-b2.md`) the sub-agent type, the exact error text, the model/provider
   that was attempted, the fact that work was completed by the main agent, and that
   the Quality Gate was still run unchanged. A silently dropped failure is worse than
   an honest environment note.
4. **Do not fake completion.** A tracking task with `runsTotal=0` stays "tracking
   closed in ROADMAP/CHANGELOG", never `✅ [ВЫПОЛНЕНО]`.

Confirmed again in the current session: the sub-agent launched for the DOC-2
architecture-diagram authoring failed with this exact `Free usage limit reached`
error (PL-90, a repeat of PL-72); the document was finished by the main agent and the
reason was kept in the report. This is an environment limit, not a repository bug.

### 4.2 Worktree environment setup (PL-109)

A fresh one-off git worktree contains tracked files only — no `node_modules/` and no `dist/`.
An agent that starts there and immediately runs `npm run build` or `node test-*.mjs` fails with
`tsc not found` / `Cannot find module`: dependencies and build output are not committed.
Prepare the environment before the first build — pick one of two Windows options.

**(a) Junction from the main checkout (fast, no install).** Build in the main checkout once,
then create directory junctions in the fresh worktree from `cmd`:

```cmd
cmd /c mklink /J "C:\path\to\worktree\node_modules" "C:\path\to\main-checkout\node_modules"
cmd /c mklink /J "C:\path\to\worktree\dist"       "C:\path\to\main-checkout\dist"
```

The link names must not already exist in the worktree; `dist/` must exist in the main checkout
first. Junctions are shared — a build inside the worktree rewrites the main checkout's `dist/`,
so do not build through the same junction from two runs concurrently.

**(b) `npm ci` inside the worktree (isolated, when junction is unavailable).**

```cmd
cd /d C:\path\to\worktree && npm ci && npm run build
```

This re-downloads dependencies but keeps the worktree self-contained. Without either option,
`npm run build` and `node test-*.mjs` in a fresh worktree fail — treat environment setup as
the first step of any task that runs in a worktree (the W-1 class of tasks).

Reproduced once more on 23.11.2026 in this repository: an explicit `explore` sub-agent refused to start with the exact `Free usage limit reached` error, while the main agent completed the same SCOPE and the Quality Gate was unchanged. Treat sub-agents as optional on Free tiers and record the attempt in `reports/steward-b2.md` (PL-108).

