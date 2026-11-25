// P-2.1/P-2.2/P-2.4: реальный stdio-прогон `agent-steward mcp`.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { TOOL_NAMES } from "./dist/core-entry.js";

const root = path.dirname(fileURLToPath(import.meta.url));
let checks = 0;
const check = (name, fn) => {
  try { fn(); checks++; }
  catch (err) { console.error(`FAIL ${name}: ${err.message}`); process.exitCode = 1; }
};

// QA-PORT-8: junction dist/ резолвится по реальному пути, и child не находит
// @modelcontextprotocol/sdk в node_modules текущего worktree.
const distIsLink = fs.lstatSync(path.join(root, "dist")).isSymbolicLink();
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [
    ...(distIsLink ? ["--preserve-symlinks", "--preserve-symlinks-main"] : []),
    path.join(root, "dist", "cli.js"),
    "mcp",
  ],
  cwd: root,
  env: { ...process.env, AGENT_STEWARD_CHILD_RUN: "" },
  stderr: "pipe",
});
const client = new Client({ name: "agent-steward-contract-test", version: "1.0.0" });

try {
  await client.connect(transport);

  const tools = await client.listTools();
  // IM-4: `batch_call` — хелпер MCP-транспорта, а не агентский инструмент.
  // Контракт TOOL_NAMES (34) не меняется; реестр MCP содержит 34 + 1.
  const helperName = "batch_call";
  const agentTools = tools.tools.filter((t) => t.name !== helperName);
  check("P-2.1: MCP registry отдаёт 34 инструмента и хелпер batch_call", () => {
    assert.equal(tools.tools.length, TOOL_NAMES.length + 1);
    assert.equal(new Set(tools.tools.map((t) => t.name)).size, TOOL_NAMES.length + 1);
    assert.equal(agentTools.length, TOOL_NAMES.length);
  });
  check("P-2.4: имена инструментов совпадают с контрактом TOOL_NAMES", () => {
    const names = agentTools.map((t) => t.name).sort();
    assert.deepEqual(names, [...TOOL_NAMES].sort());
  });
  check("IM-4: batch_call изолирован от агентского реестра", () => {
    assert.equal(tools.tools.filter((t) => t.name === helperName).length, 1);
    assert.ok(!TOOL_NAMES.includes(helperName), "batch_call не должен входить в TOOL_NAMES");
    assert.ok(tools.tools.find((t) => t.name === helperName)?.description);
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

  // P-2.1: реестр должен не только объявлять инструменты, но и исполнять их.
  const listed = await client.callTool({ name: "list_tasks", arguments: {} });
  check("P-2.1: MCP исполняет list_tasks без OpenCode-контекста", () => {
    assert.notEqual(listed.isError, true, JSON.stringify(listed.content));
    assert.ok(Array.isArray(listed.content) && listed.content.length > 0);
  });

  // IM-4: реальный вызов хелпера — ошибка одного подвызова не отменяет остальные.
  const batched = await client.callTool({
    name: helperName,
    arguments: {
      calls: [
        { name: "list_tasks", args: {} },
        { name: "__qa_unknown_tool__", args: {} },
        { name: "get_task_logs", args: { name: "__qa_probe__", lines: "not-a-number" } },
      ],
    },
  });
  check("IM-4: batch_call изолирует ошибки подвызовов", () => {
    assert.notEqual(batched.isError, true, JSON.stringify(batched.content));
    const payload = JSON.parse(batched.content[0].text);
    assert.equal(payload.results.length, 3);
    assert.deepEqual(payload.results.map((r) => r.index), [0, 1, 2]);
    assert.equal(payload.results[0].ok, true);
    assert.equal(payload.results[0].name, "list_tasks");
    assert.equal(payload.results[1].ok, false);
    assert.match(payload.results[1].error, /неизвестный инструмент/);
    assert.equal(payload.results[2].ok, false, "невалидные аргументы должны провалить только свой подвызов");
  });
} catch (err) {
  console.error(`FAIL MCP transport: ${err.stack ?? err}`);
  process.exitCode = 1;
} finally {
  await client.close().catch(() => {});
  transport.close?.();
}

console.log(`test-mcp-adapter: ${checks} checks passed`);
