// P-2.1/P-2.2/P-2.4: реальный stdio-прогон `agent-steward mcp`.
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const root = path.dirname(fileURLToPath(import.meta.url));
let checks = 0;
const check = (name, fn) => {
  try { fn(); checks++; }
  catch (err) { console.error(`FAIL ${name}: ${err.message}`); process.exitCode = 1; }
};

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [path.join(root, "dist", "cli.js"), "mcp"],
  cwd: root,
  env: { ...process.env, AGENT_STEWARD_CHILD_RUN: "" },
  stderr: "pipe",
});
const client = new Client({ name: "agent-steward-contract-test", version: "1.0.0" });

try {
  await client.connect(transport);

  const tools = await client.listTools();
  check("P-2.1: MCP registry отдаёт 34 инструмента", () => {
    assert.equal(tools.tools.length, 34);
    assert.equal(new Set(tools.tools.map((t) => t.name)).size, 34);
  });
  check("P-2.4: имена инструментов совпадают с контрактом", () => {
    const names = tools.tools.map((t) => t.name).sort();
    const expected = [
      "schedule_task", "schedule_advanced", "list_tasks", "update_task", "update_advanced",
      "delete_task", "run_task_now", "pause_task", "resume_task", "get_history", "get_task_logs",
      "dry_run", "pipeline_validate", "pipeline_apply", "pipeline_export", "manage_workspaces",
      "matrix_control", "get_metrics", "get_analytics", "self_analysis", "manage_settings",
      "manage_local_ai", "manage_templates", "manage_profiles", "transfer_tasks", "send_notification",
      "report_bug", "get_dashboard_info", "cleanup_history", "emit_event", "manage_secrets",
      "get_audit_log", "backup_db", "restore_db",
    ].sort();
    assert.deepEqual(names, expected);
  });
  check("P-2.1: каждый инструмент имеет описание и zod inputSchema", () => {
    for (const tool of tools.tools) {
      assert.ok(tool.description, `нет description у ${tool.name}`);
      assert.ok(tool.inputSchema && tool.inputSchema.type === "object", `нет inputSchema у ${tool.name}`);
    }
  });

  const resources = await client.listResources();
  check("P-2.2: SKILL.md зарегистрирован как MCP-ресурс", () => {
    assert.ok(resources.resources.some((r) => r.uri === "skill://agent-steward/scheduled-job-best-practices/SKILL.md"));
  });
  const skill = await client.readResource({ uri: "skill://agent-steward/scheduled-job-best-practices/SKILL.md" });
  check("P-2.2: ресурс отдаёт content SKILL.md", () => {
    assert.match(skill.contents[0].text, /scheduled-job-best-practices|Best practices/i);
  });
  const prompts = await client.listPrompts();
  check("P-2.2: SKILL.md доступен и как prompt", () => {
    assert.ok(prompts.prompts.some((p) => p.name === "agent-steward-skill"));
  });
} catch (err) {
  console.error(`FAIL MCP transport: ${err.stack ?? err}`);
  process.exitCode = 1;
} finally {
  await client.close().catch(() => {});
  transport.close?.();
}

console.log(`test-mcp-adapter: ${checks} checks passed`);
