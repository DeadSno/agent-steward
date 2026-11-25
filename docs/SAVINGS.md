# The "Saved $" counter

The dashboard and `get_analytics` show a **"Saved"** KPI. It is an **estimate**,
not an accounting fact: the amount is labelled as an estimate and links to this
page.

Translations: [Русский](SAVINGS.ru.md) · [中文](SAVINGS.zh.md)

## Methodology

The counterfactual is built from run history (`history` in SQLite).

1. Records from the analysis window are taken, except unfinished ones
   (`status = "running"`).
2. A run enters the estimate when it **has tokens** (`tokens > 0`) and **has no
   recorded cost** (`costUsd` empty or `0`). Usually this is a local model (Ollama)
   or an already paid subscription: tokens were spent but no money was charged.
3. For each such run a hypothetical cloud cost is computed:

   ```
   saved = tokens / 1000 × referenceCostPer1kTokensUsd
   ```

4. The total is summed across every run in the window and broken down by task
   (top 10 by savings).
5. Objective gate/eval checks are a real cost. Each check is keyed by a stable
   SHA-256 hash of `gate + prompt + inputs`; identical inputs are charged once,
   different inputs are charged separately. The cache is bounded (256 entries,
   oldest-first eviction), so memory cannot grow without limit. The default
   estimate is **$0.002 per unique check** (`VERIFICATION_COST_PER_CHECK_USD`).

   ```
   netEconomyUsd = savedUsd - totalCostUsd - verificationCostUsd
   ```

   The old counter reported `savedUsd - totalCostUsd`, which overstated the
   benefit by ignoring verification. `netEconomyUsd` is now the honest figure:
   repeated checks with identical input are not double-charged, so caching
   improves the result instead of hiding a cost.

The default reference price is **$0.01 per 1k tokens** (a mix of input and output
from a mid-tier cloud provider), the constant
`CLOUD_REFERENCE_COST_PER_1K_TOKENS_USD` in `src/core/savings.ts`. Runs with a
recorded cost do not enter the savings: money was already charged for them, so
there is nothing to compare.

## What the estimate does not account for

- prompt caching, discounts and batch pricing;
- the difference between input and output token prices;
- runs without tokens (for example a pure shell run): there may be no savings at
  all;
- runs where the cost was not recorded by mistake rather than because it was zero —
  such records inflate the estimate.

Verification cost **is** accounted for (step 5), including the cache of repeated
checks; only its per-check price is an estimate. `honestEconomy` in
`self_analysis` uses the same `netEconomyUsd` formula as `report.savings`.

So the counter answers "how much would this cost in the cloud at the reference
price", not "how much money came back to the account".

## What-If models and prices

The dashboard block "what if every run used model X" does not rely on a fixed
model list any more. Both the list and the prices come from OpenCode itself:

1. **Available models** — `opencode models`, i.e. exactly the models configured
   on this machine (providers, keys, local Ollama models). Models that already
   appear in the run history go first; after them there is one model per
   distinct price level (cheapest, middle, most expensive), at most five
   entries in total.
2. **Prices** — the models.dev catalogue that OpenCode caches in
   `<cache>/opencode/models.json` (`cost.input` / `cost.output`, USD per 1M
   tokens). History does not split tokens into input and output, so the
   estimate uses the average of the two prices.

Price lookup order: `OPENCODE_SCHEDULER_MODEL_PRICES` (JSON) → OpenCode
catalogue → built-in table → $3 per 1M tokens. Local providers (Ollama,
LM Studio) and `*-free` models cost zero.

| Variable | Meaning |
| --- | --- |
| `OPENCODE_SCHEDULER_WHAT_IF_MODELS` | explicit JSON list, replaces the selection |
| `OPENCODE_SCHEDULER_MODEL_PRICES` | explicit prices, for example `{"openai/gpt-4o": 2.5}` |
| `OPENCODE_SCHEDULER_MODELS_CACHE` | path to another `models.json` |
| `OPENCODE_SCHEDULER_MODEL_SOURCE=static` | never call OpenCode, use built-in values only |

If OpenCode is not reachable, the block falls back to the built-in list and
prices, so the dashboard keeps working.

## API

`get_analytics` returns `report.savings`:

| Field | Value |
| --- | --- |
| `kind` | always `estimate` |
| `savedUsd` | estimated savings, USD |
| `runs` | runs in the counterfactual |
| `tokens` | tokens in those runs |
| `actualCostUsd` | recorded cost of the same runs (usually 0) |
| `totalCostUsd` | recorded cost of all runs in the window |
| `verificationCostUsd` | cost of unique gate/eval checks in the window |
| `verificationCache` | `{ checks, unique, hits, misses, evicted, costUsd }` |
| `netEconomyUsd` | `savedUsd - totalCostUsd - verificationCostUsd` |
| `referenceCostPer1kTokensUsd` | reference price |
| `methodologyUrl` | link to this page |
| `byTask` | breakdown `{ taskName, runs, tokens, savedUsd }` |

The methodology is verified against fixed data in `test-savings.mjs` (including
the verification cache and net-economy regressions) and `test-budget.mjs`
(ANALYTICS exposure and MCP/RPC wiring).
