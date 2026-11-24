import type {
  CommandInvoke,
  Runner,
  RunnerCommand,
  RunnerDeps,
  RunnerLaunch,
  RunnerResult,
} from "./runner.js";
import { binaryAvailable, spawnInvoke, validateLaunch } from "./runner.js";

export const DEFAULT_SSH_BINARY = "ssh";

export interface SshRunnerOptions {
  host: string;
  user?: string;
  deps?: RunnerDeps;
}

/** Детерминированное POSIX-экранирование: одинарные кавычки и только они. */
export function quoteRemoteArg(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

/**
 * Сборка удалённой команды для ssh: `cd <workdir> && KEY='v' '<cmd>' '<arg>'`.
 * Порядок env-переменных фиксирован сортировкой ключей, без чтения часов
 * и без случайных чисел.
 */
export function buildRemoteCommand(launch: RunnerLaunch): string {
  validateLaunch(launch);
  const parts: string[] = [];
  if (launch.workdir) parts.push(`cd ${quoteRemoteArg(launch.workdir)} &&`);
  const env = launch.env ?? {};
  const keys = Object.keys(env)
    .filter((key) => env[key] !== undefined)
    .sort();
  for (const key of keys) parts.push(`${key}=${quoteRemoteArg(env[key] ?? "")}`);
  parts.push(quoteRemoteArg(launch.command));
  for (const arg of launch.args) parts.push(quoteRemoteArg(arg));
  return parts.join(" ");
}

/**
 * QW-12: ssh разбираетtarget как опцию, если он начинается с `-`. Такой хост
 * или пользователь может подсунуть `-oProxyCommand=...` и выполнить команду
 * до установки соединения. Отвергаем ведущий дефис у обеих частей.
 */
function isOptionLike(value: string): boolean {
  return value.startsWith("-");
}

/**
 * D-1.3: адаптер ssh CLI. Как и docker, выполняет только явный execute;
 * resolve/dry-run проверяют доступность ssh-бинарника и строят argv.
 */
export function createSSHRunner(options: SshRunnerOptions): Runner {
  const host = (options.host ?? "").trim();
  const deps = options.deps;
  const binary = deps?.sshBinary ?? DEFAULT_SSH_BINARY;
  const user = (options.user ?? "").trim();
  const target = user ? `${user}@${host}` : host;
  const invalidTarget =
    !host || isOptionLike(host) || isOptionLike(user) || /[\r\n\0]/.test(target);

  const runner: Runner = {
    name: "ssh",
    available: () => !invalidTarget && binaryAvailable(binary, deps),
    buildCommand: (launch: RunnerLaunch): RunnerCommand => {
      if (invalidTarget) {
        throw new Error("SSH runner: host/user is required and must not start with '-'");
      }
      return {
        command: binary,
        args: ["-o", "BatchMode=yes", target, buildRemoteCommand(launch)],
      };
    },
    execute: (launch, invoke: CommandInvoke = spawnInvoke): Promise<RunnerResult> => {
      const built = runner.buildCommand(launch);
      return invoke(built.command, built.args);
    },
  };
  return runner;
}
