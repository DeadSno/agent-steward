/**
 * P-4 — нативный адаптер DeepSeek Harness.
 *
 * Регистрирует те же 34 инструмента через `ctx.tools.register`, а фоновые
 * запуски отправляет в `ctx.jobs` (dsh developer preview API). Команда dsh
 * строится и запускается через единый контракт `AgentInvoker`: адаптер не
 * хардкодит argv и наследует runner (local/docker/ssh). Внешняя зависимость
 * от dsh отсутствует: адаптер работает с любым ctx, реализующим контракт ниже.
 */
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { z } from "zod";
import { createToolSpecs } from "./index.js";
import type { ToolSpec } from "./tool-specs.js";
import type { SchedulerRuntime } from "./runtime.js";
import { CHILD_RUN_ENV } from "./core/run-mode.js";
import {
  DshHeadlessInvoker,
  type BuildCommandOptions,
  type BuiltCommand,
  type InvocationResult,
} from "./invokers/agent-invoker.js";

/** developer preview ломает API — версия зафиксирована контрактным тестом. */
export const DSH_ADAPTER_VERSION = "dsh-developer-preview-2026-11";

/** P-4.1: имя харнесса берётся из контракта, а не из строки в адаптере. */
export const DSH_HARNESS = new DshHeadlessInvoker().name;

/** P-4.1: команда dsh и её запуск — через AgentInvoker (runner включён). */
export function buildDshCommand(options?: BuildCommandOptions): BuiltCommand {
  return new DshHeadlessInvoker().buildCommand(options);
}

export function invokeDsh(options?: BuildCommandOptions): Promise<InvocationResult> {
  return new DshHeadlessInvoker().invoke(options);
}

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
  return ctx.jobs.submit(name, { prompt, harness: DSH_HARNESS });
}

export function skillTemplatePath(): string {
  const fromModule = fileURLToPath(
    new URL("../.agents/skills/agent-steward/SKILL.md", import.meta.url),
  );
  if (existsSync(fromModule)) return fromModule;
  // PL-109: при junction `dist/` realpath модуля указывает в другой worktree,
  // где нет `.agents/`. Нужный файл лежит в текущем чек-ауте — ищем его там.
  const fromCwd = path.join(process.cwd(), ".agents/skills/agent-steward/SKILL.md");
  if (existsSync(fromCwd)) return fromCwd;
  return fromModule;
}

export async function readDshSkill(): Promise<string> {
  return readFile(skillTemplatePath(), "utf8");
}
