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

So the counter answers "how much would this cost in the cloud at the reference
price", not "how much money came back to the account".

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
| `referenceCostPer1kTokensUsd` | reference price |
| `methodologyUrl` | link to this page |
| `byTask` | breakdown `{ taskName, runs, tokens, savedUsd }` |

The methodology is verified against fixed data: `test-savings.mjs`, 14 checks.
