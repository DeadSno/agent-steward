// Backward-compatibility shim entry for opencode-windows-scheduler/gui-experimental.
// Re-exports the GUI bundle from agent-steward so OpenCode loading the legacy
// package under the old name gets the real GUI bundle, not the backend-only
// index.js.
module.exports = require("agent-steward/gui-experimental");
