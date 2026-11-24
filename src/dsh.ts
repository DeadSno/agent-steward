/**
 * P-4 — нативный адаптер DeepSeek Harness.
 *
 * Регистрирует те же 32 инструмента через `ctx.tools.register`, а фоновые
 * запуски отправляет в `ctx.jobs` (dsh developer preview API). Внешняя
 * зависимость от dsh отсутствует: адаптер работает с любым ctx, реализующим
 * минимальный контракт ниже.
 */
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { z } from "zod";
import { createToolSpecs } from "./index.js";
import type { ToolSpec } from "./tool-specs.js";
import type { SchedulerRuntime } from "./runtime.js";
import { CHILD_RUN_ENV } from "./core/run-mode.js";

/** developer preview ломает API — версия зафиксирована контрактным тестом. */
export const DSH_ADAPTER_VERSION = "dsh-developer-preview-2026-11";

export interface DshToolContext {
  tools: {
    register(
      name: string,
      spec: { description: string; inputSchema: unknown; handler: (args: unknown) => Promise<unknown> },
    ): void;
  };
  jobs: {
    submit(name: string, payload: Record<string, unknown>): Promise<unknown>;
  };
}

function specsForDsh(env: NodeJS.ProcessEnv = process.env): ToolSpec[] {
  return createToolSpecs(null as unknown as SchedulerRuntime, {
    ...env,
    [CHILD_RUN_ENV]: "",
    AGENT_STEWARD_TOOL_PROFILE: "all",
  });
}

export function defineDshTools(ctx: DshToolContext, env: NodeJS.ProcessEnv = process.env): string[] {
  const names: string[] = [];
  for (const spec of specsForDsh(env)) {
    ctx.tools.register(spec.name, {
      description: spec.description,
      inputSchema: (spec.input as z.ZodObject<z.ZodRawShape>).shape,
      handler: async (args: unknown) => {
        try {
          return await (spec.execute as (a: unknown) => unknown)(args);
        } catch (err) {
          return { isError: true, error: err instanceof Error ? err.message : String(err) };
        }
      },
    });
    names.push(spec.name);
  }
  return names;
}

/** Фоновый запуск задачи через dsh jobs (P-4.1). */
export function submitDshJob(ctx: DshToolContext, name: string, prompt: string): Promise<unknown> {
  return ctx.jobs.submit(name, { prompt, harness: "dsh-headless" });
}

export function skillTemplatePath(): string {
  return fileURLToPath(new URL("../.agents/skills/agent-steward/SKILL.md", import.meta.url));
}

export async function readDshSkill(): Promise<string> {
  return readFile(skillTemplatePath(), "utf8");
}
