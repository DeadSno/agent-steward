# Reliability scorecard (S-3)

A public, machine-readable metric built **only from verifiable facts**: outcomes
of objective gates and the run history (tokens and recorded cost). A model's own
claim that it succeeded never raises the score.

`agent-steward/core` exports `buildReliabilityScorecard()`. The CLI exposes the
same metric without writing code:

```bash
agent-steward scorecard reliability.json --json
agent-steward scorecard reliability.json
```

Input JSON is one object:

```json
{
  "runs": [
    { "taskName": "build", "status": "success", "startedAt": "2026-11-24T10:00:00Z", "tokens": 1000, "costUsd": 0 }
  ],
  "gates": [
    { "taskName": "build", "passed": true, "objective": true, "attempts": 1, "source": "test-build.mjs" },
    { "taskName": "review", "passed": true, "objective": false }
  ]
}
```

- `runs` uses the same shape as the savings ledger (`SavingsRecord`).
- `gates[].objective: true` means the verdict was produced by code (a command,
  test or source check). Omit it or set `false` for self-reports: they are
  counted in `gates.total` / `gates.subjective` but excluded from the score.
- `attempts` is optional; `1` (or absence) means success on the first pass.

## Output

| Field | Meaning |
|---|---|
| `kind`, `version`, `format` | `scorecard`, `1.0`, `agent-steward.reliability-scorecard` |
| `gates.objective` / `gates.subjective` | Code-verified outcomes / self-reports |
| `gates.passRate`, `gates.firstPassRate` | `passed / objective`, first-pass successes / `objective` |
| `gates.byTask` | Deterministic per-task breakdown (by objective count, then name) |
| `tokens.counted` / `tokens.saved` / `tokens.paid` | Completed runs with tokens / counterfactual tokens / paid tokens |
| `tokens.savedShare` | `saved / counted` |
| `savings` | The full estimate from [SAVINGS.md](SAVINGS.md) (`kind: "estimate"`) |
| `score` | `0..100` or `null` when there are fewer than 3 objective gates |
| `confidence` | `low` / `medium` / `high` by sample size |
| `sampleSize` | Number of objective gates, savings runs and counted tokens |
| `methodologyUrl` | Link to this section, always present next to the metric |

<a id="methodology"></a>

## Methodology

```
score = round(100 × (0.7 × gatePassRate + 0.3 × savedTokenShare))
```

1. **Only objective gates count.** `objective` must be exactly `true`. A gate
   with no code verifier is recorded as subjective and cannot inflate the score.
2. **First pass is reported, not hidden.** A success after retries still counts
   as `passed`, but lowers `firstPassRate`; both numbers are published.
3. **Tokens are an estimate.** `tokens.saved` comes from the counterfactual in
   `savings.ts`: runs with tokens but no recorded cost are priced at the
   reference cloud rate. This is not accounting — caches, subscriptions and
   discounts are invisible. The `savings` section is always `kind: "estimate"`
   and links to `docs/SAVINGS.md#methodology`.
4. **No sample, no score.** With fewer than `MIN_OBJECTIVE_GATES_FOR_SCORE`
   (3) objective gates the `score` is `null` and `confidence` is `low`. Passing
   one or two self-reported gates is not evidence of reliability.
5. **Deterministic and pure.** The function does not read a database, the
   clock, the OS or the network, does not mutate its inputs and produces stable
   JSON suitable for diffs and CI artifacts.

The formula is verified on fixed data by `test-scorecard.mjs` (43 checks),
including the empty input, the sample-size threshold and the CLI contract.

## Why this is not a model self-rating

An LLM can always say "tests passed". The scorecard ignores that sentence. It
needs a gate result from a verifier (`objective: true`) and run-level token
facts. The open pipeline spec ([OPEN-SPEC.md](OPEN-SPEC.md)) describes the
*intent* to have gates; this scorecard reports what actually happened.
