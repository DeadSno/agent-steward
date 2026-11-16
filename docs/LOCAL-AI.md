# Local assistant (triage)

The local assistant is an optional, fully offline classifier for run outcomes.
After a run finishes, the scheduler can ask a local model to classify the
outcome (quality, timeout, permission, network, unknown) and write the verdict
to the triage audit. It is **opt-in**: when no model is available the scheduler
keeps working exactly as before and notifications are never blocked.

Triage is not a scheduler feature by itself — it only affects notifications. It
never changes run status, retries, Quality Gates, DAG dependencies or history.

## How it works

```
run finished ──► triage chain ──► notify / skip / log-only (shadow)
                    │
                    ├─ llm   — local model classifies the failure
                    └─ rules - built-in patterns (timeout, permission, network, quality, cost, task)
```

- `off` — no triage; every notification is sent (default).
- `rules` — built-in rules only. No model, no network calls.
- `llm` — the configured local model only.
- `auto` — the model first, then the rules engine (recommended).

Rules semantics: if `rules` is omitted (`undefined`), the built-in rule set is
active. An explicit empty array (`rules: []`) disables the rules engine entirely.
A non-empty custom array replaces the built-in set; it does not extend it.

### Built-in rules

The built-in set classifies errors by text, status, cost and task name. All
built-in rules are notify-only: they never suppress a notification.

| Rule | Match | Severity |
| --- | --- | --- |
| `error-timeout` | timeout / deadline in the error text | high |
| `error-permission` | permission denied, access denied, forbidden | high |
| `error-network` | connection refused/reset, DNS, network error | high |
| `error-quality` | Quality Gate, failed tests, failed build, lint | high |
| `cost-high` | `costUsd >= 1` | high |
| `task-important` | task name contains deploy, release, publish, production, backup, restore or migration | high |
| `status-error` | status is `error` | high |
| `status-partial` | status is `partial` | medium |
| `status-success` | status is `success` | low |

A custom array replaces the built-in set. For example, this configuration
suppresses noisy nightly runs and marks runs costing $5 or more as high:

```json
"notifications": {
  "triage": {
    "mode": "rules",
    "rules": [
      { "id": "skip-nightly", "field": "task", "operator": "contains", "value": "nightly", "action": "skip", "priority": 50 },
      { "id": "expensive", "field": "cost", "operator": "gte", "value": 5, "severity": "high", "priority": 90 }
    ]
  }
}
```

The result is validated against a fixed JSON schema. Invalid JSON, an
unreachable endpoint, a timeout or low confidence all fall back to the rules
engine (fail-open). With `fallback: "notify"` the scheduler skips the rules step
and delivers the notification instead. The legacy name `"skip"` is still
accepted and normalized to `"notify"`.

The model only **classifies** a run: a valid verdict never suppresses a
notification on its own. Only a matching rule with `action: "skip"` can
suppress delivery. This is intentional: an uncertain small model must not be
able to hide a real failure.

## Delivery latency (async triage)

In `llm` and `auto` modes triage runs asynchronously. `record-history` delivers
the notification immediately and starts a detached worker for the model call;
the worker writes the verdict to `audit_log` with `async: true`. The configured
`timeoutMs` applies to that background request, not to delivery: a cold model
that takes 40 seconds cannot delay the webhook, chain triggers or the task lock.

Only `rules` mode triages synchronously, because rules are the only thing that
can suppress a notification. In `llm`/`auto` the model and its rules fallback
are advisory: the notification is already sent, so `action: "skip"` in the
audit means “would have been skipped”, not “was suppressed”. Use `rules` mode
if rules must actually suppress delivery. The GUI shows this warning when a
model mode is selected.

In shadow mode the worker records `shadow: true` and `suppressed: false`, so a
shadow report remains a safe preview of triage decisions.

## Requirements

- [Ollama](https://ollama.com/) running locally, or any OpenAI-compatible
  server (a `baseUrl` ending with `/v1` switches to the OpenAI protocol).
- One pulled model, for example `qwen3:4b`.
- No internet access is required after the model is downloaded.

```bash
ollama serve
ollama pull qwen3:4b
```

## Configuration

Triage settings live under `notifications.triage` and are edited from the GUI
side panel ("Local assistant") or through the `manage_local_ai` agent tool.

The panel shows a persistent connection status next to **Test connection**:
grey means "not checked", amber "checking", green "connected", red "no
connection" with the provider error. The test sends one synthetic
classification request (it is not saved) and reports the model, protocol and
latency. Status resets when `mode`, `baseUrl` or `model` changes, so a stale
green cannot hide a new endpoint. A red status never blocks notifications:
`llm`/`auto` triage is asynchronous and fail-open.

| Setting | Values | Default | Meaning |
| --- | --- | --- | --- |
| `mode` | `off` / `rules` / `llm` / `auto` | `off` | Triage strategy. |
| `baseUrl` | URL | `http://127.0.0.1:11434` | Ollama or OpenAI-compatible endpoint. |
| `model` | string | `""` | Model id, for example `qwen3:4b`. |
| `timeoutMs` | 1000..120000 | `60000` | Background request timeout in `llm`/`auto`; does not delay delivery. |
| `fallback` | `rules` / `notify` | `rules` | Behaviour when the model fails or is unsure. |
| `confidenceThreshold` | 0..1 | `0.6` | Minimum model confidence; below it the fallback applies. |
| `shadow.enabled` | boolean | `true` | Log decisions without suppressing notifications. |
| `shadow.days` | 1..365 | `14` | Shadow period length. |
| `shadow.startedAt` | ISO string / null | `null` | Start of the shadow period; `null` restarts it. |

`fallback: "skip"` is accepted as a legacy alias for `notify` and is normalized
on load, so old settings keep working without edits.

## Message summaries

`notifications.summary` turns a notification into at most three short lines for
Telegram and OS toasts. The same Ollama/OpenAI-compatible provider is used, but
the request is independent of triage and has its own timeout.

| Setting | Values | Default | Meaning |
| --- | --- | --- | --- |
| `summary.enabled` | boolean | `false` | Use the model summary instead of the template message. |
| `summary.maxLines` | 1..3 | `3` | Maximum number of lines. |
| `summary.maxCharsPerLine` | 20..500 | `120` | Hard cut per line. |
| `summary.timeoutMs` | 1000..120000 | `8000` | Summary request timeout. |

The model must answer with strict JSON `{"lines": ["...", "..."]}`. Any
failure — no provider, HTTP error, timeout, invalid JSON or schema — falls back
to a deterministic truncation: status and task name, the error text, then
runtime, tokens and cost. A summary never blocks or drops the notification:
delivery waits at most `timeoutMs`.

## Managing triage from the agent

The `manage_local_ai` tool has three actions.

Read the current state:

```json
{ "action": "get" }
```

Update one or more fields (merged with the current settings):

```json
{
  "action": "update",
  "mode": "auto",
  "baseUrl": "http://127.0.0.1:11434",
  "model": "qwen3:4b",
  "timeoutMs": 60000,
  "fallback": "rules",
  "confidenceThreshold": 0.6,
  "shadow": { "enabled": true, "days": 14 }
}
```

Send one classification request against the configured model (or a candidate
patch without saving it):

```json
{ "action": "test", "model": "qwen3:4b", "timeoutMs": 60000 }
```

`get` and `update` return a summary: `mode`, `baseUrl`, `model`, `timeoutMs`,
`fallback`, `confidenceThreshold`, `rules` (number of active rules or `null`),
`shadow`, `llmReady`, `shadowActive` and `protocol` (`ollama` or `openai`).

## Picking a model by RAM

The classifier is a small, structured task: a 4B model is usually enough. The
benchmark below prints a tier for the current machine.

| RAM | Tier | Recommended model | Notes |
| --- | --- | --- | --- |
| < 8 GB | rules-only | `qwen3:0.6b` | Prefer `mode: "rules"`; a tiny model may be too slow. |
| 8–15 GB | light | `qwen3:1.7b` | Fast, lower accuracy. |
| 15–30 GB | balanced | `qwen3:4b` | Recommended default. |
| > 30 GB | max | `qwen3:8b` | Better accuracy, more latency. |

## Benchmarking a machine

`scripts/bench-local.mjs` measures latency, schema validity and throughput
(tokens/s) for the configured model. It reuses the same triage prompt and JSON
schema as the scheduler.

```bash
npm run bench:local -- --model qwen3:4b --runs 3
npm run bench:local -- --model qwen3:4b --runs 5 --out bench.json
```

Options: `--base-url`, `--model`, `--runs` (1..50), `--timeout` (1000..600000),
`--out`, `--help`.

The report is a versioned JSON envelope (`schemaVersion: "1"`) suitable for
crowdsourcing results:

```json
{
  "schemaVersion": "1",
  "generatedAt": "2026-11-15T12:00:00.000Z",
  "available": true,
  "machine": { "platform": "win32", "arch": "x64", "cpu": "…", "cpuCount": 16, "ramGb": 15.9, "nodeVersion": "v24.21.0" },
  "tier": { "id": "balanced", "recommendedModel": "qwen3:4b", "reason": "…" },
  "model": "qwen3:4b",
  "runs": 3,
  "metrics": {
    "schemaValid": 3,
    "schemaValidRate": 1,
    "jsonValid": 3,
    "jsonValidRate": 1,
    "avgLatencyMs": 23785,
    "p95LatencyMs": 26904,
    "avgTokPerSec": 28.7,
    "p95TokPerSec": 28.98
  },
  "results": []
}
```

Exit codes: `0` when at least 70% of responses are schema-valid, `1` otherwise,
`2` when the endpoint or model is unavailable (the JSON report is still written
with `available: false`).

## Shadow mode

Shadow mode is the safe way to evaluate triage. Decisions are written to the
persistent audit journal (`audit_log`, action `triage.decision`), but no
notification is suppressed. In `llm`/`auto` the verdict arrives asynchronously
after delivery; in `rules` mode it is computed before delivery. Check the shadow
report before switching to `mode: "auto"`: it shows how many notifications
would have been skipped and whether any of those were false positives.

The journal survives restarts and runs in the short-lived `record-history`
process, unlike the old in-memory counters. Read individual decisions with
`get_audit_log` (`action: "triage.decision"`); the report is also available as
`rpc.get_shadow_report` (including the last 50 decisions). The report covers
the configured shadow window `[startedAt, startedAt + days]`; resetting it
deletes only shadow rows and keeps ordinary decision history.

Start with `mode: "auto"`, `shadow.enabled: true` and `shadow.days: 14`. After
the period, review the shadow report and only then disable shadow mode.

## Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| `connection refused` / `fetch failed` | Ollama is not running | `ollama serve` |
| `model not found` | Model not pulled | `ollama pull <model>`, then check `ollama list` |
| Requests time out | Model too large for the machine or context too long | Lower the model tier, raise `timeoutMs`, cap context (below) |
| `llmReady: false` in `manage_local_ai` `get` | Endpoint or model unavailable | Check `baseUrl` and `model` |
| Very slow first response | Cold model load | Run once to warm the model; the benchmark shows steady-state numbers |
| Invalid JSON from the model | Model too small or prompt drift | Use a larger model or `mode: "rules"` |

### OLLAMA_CONTEXT_LENGTH

Ollama allocates a large context window by default, which costs RAM and slows
CPU inference. For triage, a short context is enough. Set it in the environment
before starting the server:

```bash
# Windows (PowerShell)
$env:OLLAMA_CONTEXT_LENGTH = "2048"
ollama serve
```

```bash
# Linux / macOS
OLLAMA_CONTEXT_LENGTH=2048 ollama serve
```

Restart Ollama after changing the variable. If the model still does not fit,
choose a smaller tier or use `mode: "rules"`.

## Limits

- Triage only affects notifications. It never rewrites run results.
- The model runs locally; prompts and logs are not sent to a third party.
- A missing model never blocks scheduling: rules or direct delivery take over.
- The classifier is intentionally conservative. When in doubt it delivers the
  notification (fail-open).
- The benchmark measures a single machine; results are not a guarantee for other
  hardware.
