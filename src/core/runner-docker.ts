import type {
  CommandInvoke,
  Runner,
  RunnerCommand,
  RunnerDeps,
  RunnerLaunch,
  RunnerResult,
} from "./runner.js";
import { binaryAvailable, spawnInvoke, validateLaunch } from "./runner.js";

export const DEFAULT_DOCKER_BINARY = "docker";

export interface DockerRunnerOptions {
  /** Образ контейнера, например `alpine:3.20`. */
  image: string;
  deps?: RunnerDeps;
}

/**
 * D-1.2: адаптер docker CLI. Команда собирается детерминированно (фиксированный
 * порядок флагов, сортировка env) и никогда не выполняется при resolve/dry-run;
 * выполнение происходит только в execute через явный транспорт.
 */
export function createDockerRunner(options: DockerRunnerOptions): Runner {
  const image = (options.image ?? "").trim();
  const deps = options.deps;
  const binary = deps?.dockerBinary ?? DEFAULT_DOCKER_BINARY;

  const runner: Runner = {
    name: "docker",
    available: () => Boolean(image) && binaryAvailable(binary, deps),
    buildCommand: (launch: RunnerLaunch): RunnerCommand => {
      if (!image) throw new Error("Docker runner: image is required");
      validateLaunch(launch);
      const args: string[] = ["run", "--rm"];
      if (launch.workdir) args.push("--workdir", launch.workdir);
      const env = launch.env ?? {};
      const keys = Object.keys(env)
        .filter((key) => env[key] !== undefined)
        .sort();
      for (const key of keys) args.push("--env", `${key}=${env[key] ?? ""}`);
      args.push(image, launch.command, ...launch.args);
      return { command: binary, args };
    },
    execute: (launch, invoke: CommandInvoke = spawnInvoke): Promise<RunnerResult> => {
      const built = runner.buildCommand(launch);
      return invoke(built.command, built.args);
    },
  };
  return runner;
}
