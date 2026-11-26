#!/usr/bin/env node
/**
 * P-2 — MCP-адаптер: полный реестр из 34 инструментов, но поверх stdio MCP.
 *
 * Точка входа: `agent-steward mcp`. Адаптер не знает про OpenCode: он берёт
 * спеки из публичного facade `tool-specs.ts` и регистрирует их в McpServer.
 */
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { createToolSpecs } from "./index.js";
import { getPluginVersion } from "./version.js";
import { BATCH_CALL_LIMIT, executeBatchCalls } from "./shared/batch-call.js";
import type { ToolSpec } from "./tool-specs.js";
import type { SchedulerRuntime } from "./runtime.js";
import { CHILD_RUN_ENV } from "./core/run-mode.js";

export const MCP_SKILL_URI = "skill://agent-steward/scheduled-job-best-practices/SKILL.md";

/** Спеки для MCP: всегда полные 34, независимо от профиля OpenCode. */
export function mcpToolSpecs(env: NodeJS.ProcessEnv = process.env): ToolSpec[] {
  return createToolSpecs(null as unknown as SchedulerRuntime, {
    ...env,
    [CHILD_RUN_ENV]: "",
    AGENT_STEWARD_TOOL_PROFILE: "all",
  });
}

function skillPath(): string {
  // dist/mcp.js → <root>/skills/...; при запуске из src — тот же относительный путь.
  return fileURLToPath(new URL("../skills/scheduled-job-best-practices/SKILL.md", import.meta.url));
}

export function createMcpServer(env: NodeJS.ProcessEnv = process.env): McpServer {
  // QA-FULL-02: версия MCP-сервера берётся из единого источника (package.json),
  // чтобы `initialize` совпадало с `/api/health` и `get_dashboard_info`.
  const server = new McpServer({ name: "agent-steward", version: getPluginVersion() });
  const specs = mcpToolSpecs(env);

  for (const spec of specs) {
    server.registerTool(
      spec.name,
      {
        description: spec.description,
        // zod v4 raw shape из той же спеки, что используют V1/V2 и RPC-контракт.
        inputSchema: (spec.input as z.ZodObject<z.ZodRawShape>).shape as never,
      },
      (async (args: unknown) => {
        try {
          const result = await (spec.execute as (a: unknown) => unknown)(args);
          const text = typeof result === "string"
            ? result
            : JSON.stringify(result ?? null, null, 2) ?? String(result);
          return { content: [{ type: "text" as const, text }] };
        } catch (err) {
          return {
            isError: true,
            content: [{ type: "text" as const, text: err instanceof Error ? err.message : String(err) }],
          };
        }
      }) as never,
    );
  }

  // D04 / IM-4: один MCP-вызов на несколько инструментов. Реестровые спеки
  // остаются прежними (34, совместимо с V1/V2 Plugin.define); батч — хелпер
  // транспорта, результаты изолированы по вызовам.
  server.registerTool(
    "batch_call",
    {
      description:
        "Выполнить до 20 инструментов agent-steward в одном сообщении. Каждый результат изолирован: ошибка одного вызова не отменяет остальные.",
      inputSchema: {
        calls: z
          .array(
            z.object({
              name: z.string().min(1),
              args: z.record(z.string(), z.unknown()),
            }),
          )
          .min(1)
          .max(BATCH_CALL_LIMIT) as never,
      },
    },
    (async (args: unknown) => {
      const calls = (args as { calls?: { name: string; args?: Record<string, unknown> }[] })?.calls ?? [];
      const results = await executeBatchCalls(
        specs,
        calls.map((call) => ({ name: call.name, args: call.args ?? {} })),
      );
      return {
        content: [{ type: "text" as const, text: JSON.stringify({ results }, null, 2) }],
      };
    }),
  );

  // P-2.2: SKILL.md как ресурс + как промпт.
  server.registerResource(
    "agent-steward-skill",
    MCP_SKILL_URI,
    { title: "scheduled-job-best-practices", description: "Rules for scheduling agent jobs", mimeType: "text/markdown" },
    async () => ({ contents: [{ uri: MCP_SKILL_URI, mimeType: "text/markdown", text: await readFile(skillPath(), "utf8") }] }),
  );
  server.registerPrompt(
    "agent-steward-skill",
    { title: "Agent Steward skill", description: "Load scheduling best practices" },
    async () => ({ messages: [{ role: "user" as const, content: { type: "text" as const, text: await readFile(skillPath(), "utf8") } }] }),
  );

  return server;
}

/** Запуск stdio-транспорта; используется CLI-командой `agent-steward mcp`. */
export async function startMcpServer(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const server = createMcpServer(env);
  await server.connect(new StdioServerTransport());
}
