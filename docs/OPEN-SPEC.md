# Open pipeline spec (S-1)

`opencode.pipeline.yaml` is the authoring format. The **open spec** is the
vendor-neutral projection of that file: a description of the DAG, the objective
gates and the budgets, readable without knowing the scheduler internals.

```bash
agent-steward pipeline describe opencode.pipeline.yaml --json
```

The same projection is available programmatically:

```ts
import { parsePipelineYaml } from "agent-steward/core"; // or from dist/core/pipeline-io.js
import { toOpenPipelineSpec } from "agent-steward/core";

const parsed = parsePipelineYaml(source);
if (parsed.ok && parsed.spec) {
  const spec = toOpenPipelineSpec(parsed.spec);
}
```

## Shape

```json
{
  "format": "agent-steward.open-pipeline",
  "version": "1.0",
  "source": { "format": "opencode.pipeline.yaml", "version": 1 },
  "dag": {
    "nodes": [
      {
        "id": "build",
        "taskName": "nightly build",
        "trigger": "cron",
        "needs": [],
        "gates": ["node test-docs.mjs"],
        "budget": { "timeoutSeconds": 300, "retries": 1, "priority": 5, "model": null },
        "tools": { "allowed": ["read", "shell"], "denied": [] }
      }
    ],
    "edges": [{ "from": "build", "to": "test" }]
  },
  "gates": [{ "stepId": "build", "kind": "qualityGate", "command": "node test-docs.mjs" }],
  "budgets": {
    "steps": 3,
    "maxTimeoutSeconds": 300,
    "totalTimeoutSeconds": 660,
    "maxRetries": 1,
    "gates": 2
  },
  "methodologyUrl": "..."
}
```

Rules of the projection:

- `nodes` and `edges` come from `id`/`needs` only. Unknown `needs` targets are
  dropped from `edges` (the YAML validator already reports them as errors).
- `budget` resolves step values first, then `defaults`. `timeoutSeconds` and
  `priority` stay `null` when neither level defines them; `retries` defaults to 0.
- `gates` contains one entry per step with a non-empty `qualityGate`. A pipeline
  without gates has `gates: []` and `budgets.gates: 0` — no silent claim of
  objective verification.
- `budgets.totalTimeoutSeconds` sums resolved per-step timeouts; it is a budget
  description, not a guarantee that a run stays inside it.
- Output is deterministic (YAML step order) and suitable for diffs in PRs.

<a id="methodology"></a>

## Methodology

The open spec describes intent. It is not a quality gate and does not assert
that any gate passed. Actual gate outcomes, first-pass rates and token savings
are reported separately by the reliability scorecard (S-3) with their own
methodology.
