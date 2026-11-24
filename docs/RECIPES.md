# Gate-passed recipes (S-4)

A recipe is not a snippet "because examples are nice". It is a pipeline YAML
plus the **objective evidence that its gate actually passed**. The library only
contains recipes that survived `verifyRecipe()`: valid YAML, a declared
`qualityGate` on a step, and a matching `objective: true` / `passed: true`
record with a date and a commit.

`agent-steward/core` exports `listRecipes()`, `getRecipe()`, `verifyRecipe()`,
`verifyRecipeById()` and `verifyAllRecipes()`. The CLI exposes the same library:

```bash
agent-steward recipes list --json
agent-steward recipes list --task-type routing --json
agent-steward recipes verify --json
agent-steward recipes verify open-spec
```

`recipes verify` exits 0 only when every declared gate is covered by evidence.
It exits 1 for an unknown id, a mutated gate or an uncovered `qualityGate`, and
2 for bad CLI arguments.

## Library format

| Field | Meaning |
|---|---|
| `kind`, `version`, `format` | `recipe-library`, `1.0`, `agent-steward.gate-passed-recipes` |
| `recipeCount` / `recipes` | Number of entries and the entries themselves (sorted by `id`) |
| `recipes[].id`, `title`, `taskType`, `description`, `tags` | Stable identity and intent |
| `recipes[].yaml` | A complete `opencode.pipeline.yaml` document (validated by `parsePipelineYaml`) |
| `recipes[].gates[]` | One entry per objective gate: `stepId`, `command`, `evidence` |
| `gates[].evidence` | `command`, `passed: true`, `objective: true`, `source`, `recordedAt`, optional `commit` |
| `methodologyUrl` | Link to this section, always next to the verification result |

## Included recipes

| id | Task type | Objective gate | Evidence commit |
|---|---|---|---|
| `open-spec` | `pipeline-spec` | `node test-open-spec.mjs` | `9db0d75` (S-1) |
| `capability-router` | `routing` | `node test-router.mjs` | `bb9f567` (S-2) |
| `reliability-scorecard` | `metrics` | `node test-scorecard.mjs` | `16e5606` (S-3) |

The nightly `opencode.pipeline.yaml` example is deliberately **not** in the
library: its `npm test` gate currently fails on unrelated profile baselines
(B-3.1), so calling it gate-passed would be dishonest.

<a id="methodology"></a>

## Methodology

1. **Evidence before prose.** A recipe is admitted only with a recorded gate
   pass. The verifier requires `passed === true` and `objective === true`;
   a model saying "it worked" is not evidence.
2. **Command identity.** `gates[].command` must equal both
   `steps[].qualityGate` in the YAML and `evidence.command`. Whitespace is
   normalized, semantics are not guessed.
3. **No orphan gates.** Every `qualityGate` present in the YAML must have a
   matching evidence entry. Adding a new gate without a proof makes
   `verifyRecipe()` fail.
4. **Pure and deterministic.** `verifyRecipe()` parses YAML with the shared
   parser, reads no database and disk beyond its arguments, runs no commands,
   does not mutate inputs, and emits stable JSON suitable for CI artifacts.
5. **Snapshot, not a live claim.** The embedded evidence records a gate that
   passed at a known commit on 24.11.2026. The verifier proves the *recipe and
   its evidence agree*; it does not re-run the command. Re-run the gate in the
   target project before trusting it there. `docs/RELIABILITY.md` reports what
   actually happened in live runs.

New recipes are added with a real gate result from a merged change, plus a test
in `test-recipes.mjs` that exercises both the happy path and a tampered copy.
`test-docs.mjs` keeps the suite counters and module lists in sync.

Verified by `test-recipes.mjs` (44 checks): YAML validity, gate/command
identity, evidence fields, immutability, deterministic output, tamper cases and
the CLI contract.
