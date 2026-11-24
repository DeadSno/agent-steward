/**
 * P-3.1: политика инструментов, адаптированная под конкретный harness.
 * Конфиг сериализуем — его можно положить в opencode.jsonc / dsh / ACP.
 */
import { TOOL_NAMES, type ToolName } from "../tool-specs.js";
import type { HarnessName } from "./agent-invoker.js";

export interface HarnessConfig {
  harness: HarnessName;
  profile: "core" | "all" | "restricted";
  allowedTools: string[];
  deniedTools: string[];
}

const RESTRICTED: Record<Exclude<HarnessName, "opencode">, ToolName[]> = {
  "dsh-headless": ["list_tasks", "get_history", "get_task_logs", "dry_run", "run_task_now", "emit_event"],
  acp: ["list_tasks", "get_task_logs", "get_history", "dry_run", "get_metrics"],
  "cursor-cli": ["list_tasks", "get_task_logs", "get_history", "dry_run", "get_dashboard_info"],
};

export class ToolPolicy {
  constructor(
    readonly harness: HarnessName,
    readonly allowed: readonly string[] = TOOL_NAMES,
  ) {}

  static forHarness(harness?: string | null): ToolPolicy {
    const name = (harness ?? "opencode") as HarnessName;
    if (name === "opencode") return new ToolPolicy("opencode", TOOL_NAMES);
    const allowed = RESTRICTED[name];
    return allowed ? new ToolPolicy(name, allowed) : new ToolPolicy("opencode", TOOL_NAMES);
  }

  isAllowed(tool: string): boolean {
    return this.allowed.includes(tool);
  }

  toHarnessConfig(): HarnessConfig {
    const allowedTools = [...this.allowed].sort();
    return {
      harness: this.harness,
      profile: this.harness === "opencode" ? "all" : "restricted",
      allowedTools,
      deniedTools: TOOL_NAMES.filter((name) => !allowedTools.includes(name)).sort(),
    };
  }
}
