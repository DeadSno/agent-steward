/**
 * P-3.1/P-3.3: единый контракт агент-инвокера.
 *
 * Инвокер отвечает только за сборку команды и запуск внешнего агента. Планировщик
 * (wrapper, quality gate, история) остаётся общим для всех harness-ов.
 */
import { spawn } from "node:child_process";

export type HarnessName = "opencode" | "dsh-headless" | "acp" | "cursor-cli";

export interface BuildCommandOptions {
  model?: string | null;
  sessionId?: string | null;
  sessionMode?: "reuse" | "last" | "new";
  prompt?: string;
  env?: NodeJS.ProcessEnv;
}

export interface BuiltCommand {
  commandPath: string;
  args: string[];
  /** Дополнительные переменные, которые должна выставить обёртка. */
  env: Record<string, string>;
}

export interface InvocationResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface AgentInvoker {
  readonly name: HarnessName;
  buildCommand(options?: BuildCommandOptions): BuiltCommand;
  invoke(options?: BuildCommandOptions): Promise<InvocationResult>;
}

function commonArgs(options: BuildCommandOptions): string[] {
  const args: string[] = [];
  if (options.model) args.push("--model", options.model);
  if (options.sessionMode === "reuse" && options.sessionId) {
    args.push("--session", options.sessionId);
  } else if (options.sessionMode === "last") {
    args.push("--continue");
  }
  if (options.prompt) args.push("--", options.prompt);
  return args;
}

abstract class BaseInvoker implements AgentInvoker {
  abstract readonly name: HarnessName;
  protected abstract readonly command: string;
  protected abstract readonly prefix: string[];

  buildCommand(options: BuildCommandOptions = {}): BuiltCommand {
    const env = options.env ?? process.env;
    const override = env.AGENT_COMMAND_PATH;
    return {
      commandPath: override || this.command,
      args: override
        ? (env.AGENT_ARGS ?? "").split(/\s+/).filter(Boolean).concat(commonArgs(options))
        : [...this.prefix, ...commonArgs(options)],
      env: override
        ? { AGENT_COMMAND_PATH: override, AGENT_ARGS: env.AGENT_ARGS ?? this.prefix.join(" ") }
        : {},
    };
  }

  invoke(options: BuildCommandOptions = {}): Promise<InvocationResult> {
    const cmd = this.buildCommand(options);
    return new Promise((resolve, reject) => {
      const child = spawn(cmd.commandPath, cmd.args, {
        cwd: options.env?.AGENT_CWD ?? process.cwd(),
        env: { ...process.env, ...cmd.env, AGENT_STEWARD_CHILD_RUN: "1" },
        shell: false,
      });
      let stdout = "";
      let stderr = "";
      child.stdout?.on("data", (chunk) => { stdout += String(chunk); });
      child.stderr?.on("data", (chunk) => { stderr += String(chunk); });
      child.on("error", reject);
      child.on("close", (code) => resolve({ exitCode: code ?? 1, stdout, stderr }));
    });
  }
}

/** OpenCode CLI — поведение по умолчанию, полностью совместимое с wrapper'ом. */
export class OpencodeCliInvoker extends BaseInvoker {
  readonly name = "opencode" as const;
  protected readonly command = "opencode";
  protected readonly prefix = ["run", "--auto"];
}

/** DeepSeek Harness в headless-режиме. */
export class DshHeadlessInvoker extends BaseInvoker {
  readonly name = "dsh-headless" as const;
  protected readonly command = "dsh";
  protected readonly prefix = ["--headless", "run"];
}

/** Agent Client Protocol. */
export class AcpInvoker extends BaseInvoker {
  readonly name = "acp" as const;
  protected readonly command = "acp";
  protected readonly prefix = ["run", "--stdio"];
}

/** Cursor CLI в неинтерактивном режиме. */
export class CursorCliInvoker extends BaseInvoker {
  readonly name = "cursor-cli" as const;
  protected readonly command = "cursor";
  protected readonly prefix = ["agent", "--print"];
}

export const INVOKERS: Record<HarnessName, () => AgentInvoker> = {
  opencode: () => new OpencodeCliInvoker(),
  "dsh-headless": () => new DshHeadlessInvoker(),
  acp: () => new AcpInvoker(),
  "cursor-cli": () => new CursorCliInvoker(),
};

/** P-3.4: неизвестное/отсутствующее значение всегда деградирует в opencode. */
export function resolveInvoker(harness?: string | null): AgentInvoker {
  const key = (harness ?? "opencode") as HarnessName;
  return (INVOKERS[key] ?? INVOKERS.opencode)();
}

export const HARNESS_NAMES = Object.keys(INVOKERS) as HarnessName[];
