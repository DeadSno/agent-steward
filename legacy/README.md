# opencode-windows-scheduler (deprecated)

This package is deprecated. Use [`agent-steward`](https://www.npmjs.com/package/agent-steward) instead.

This package is a thin re-export of `agent-steward` and exists only for backward
compatibility during the rename milestone (Д7). **Since 1.5.8 it is deprecated on
npm** and receives only critical patches; new installs should use `agent-steward`
directly (it is pulled in automatically as a dependency).

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
[docs/MIGRATION.md](../docs/MIGRATION.md#from-opencode-windows-scheduler-to-agent-steward-package-rename)
for details.
