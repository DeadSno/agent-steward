# opencode-windows-scheduler (deprecated)

This package is deprecated. Use [`agent-steward`](https://www.npmjs.com/package/agent-steward) instead.

This package is a thin re-export of `agent-steward` and exists only for backward
compatibility during the rename milestone (2.0.0). It receives only critical patches
and will be deprecated on npm after download parity with `agent-steward` is reached
(planned for `>= 2.1`, per the project roadmap).

## Migration

No changes are needed to your OpenCode config — the `plugin id`
`opencode-windows-scheduler` is unchanged. Only the npm package name changed:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["opencode-windows-scheduler"]
}
```

New installs resolve to the `agent-steward` package automatically. See
[docs/MIGRATION.md](../docs/MIGRATION.md#from-opencode-windows-scheduler-to-agent-steward-rename)
for details.
