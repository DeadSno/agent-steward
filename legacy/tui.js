// Backward-compatibility shim entry for opencode-windows-scheduler/tui.
// Re-exports the TUI module from agent-steward so OpenCode loading the legacy
// package under the old name gets the real TUI (v2Tui + tuiV1), not the
// backend-only index.js.
export * from "agent-steward/tui";
export { default } from "agent-steward/tui";
