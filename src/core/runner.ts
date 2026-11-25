import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { createDockerRunner } from "./runner-docker.js";
import { createSSHRunner } from "./runner-ssh.js";

/**
 * D-1.1: минимальный контракт runner'а. Выбор runner'а — конфигурация, а не имя ОС:
 * один и тот же интерфейс работает на Windows, Linux и macOS.
 */
export type RunnerKind = "local" | "docker" | "ssh";

/** Описание запуска: что исполнить и в каком контексте. */
export interface RunnerLaunch {
  /** Исполняемый файл в целевом окружении (например, `opencode`). */
  command: string;
  /** Аргументы в фиксированном порядке. */
  args: readonly string[];
  /** Рабочая директория в целевом окружении. */
  workdir?: string;
  /** Переменные окружения; ключи сортируются при построении команды. */
  env?: Readonly<Record<string, string | undefined>>;
  /**
   * QW-12: путь к файлу `KEY=VALUE` для docker. Когда задан, docker использует
   * `--env-file` вместо `--env K=V`, чтобы секреты не попадали в argv и
   * `docker inspect`. Несовместим с `env`.
   */
  envFile?: string;
  /**
   * QW-12: явные монтирования `host:container[:opts]` для docker. `--workdir`
   * сам по себе не монтирует каталог хоста, поэтому репозиторий нужно пробросить
   * через `volumes` (например, `${workdir}:${workdir}`).
   */
  volumes?: readonly string[];
}

/** Готовая команда: файл + аргументы, без оболочки и без выполнения. */
export interface RunnerCommand {
  command: string;
  args: string[];
}

export interface RunnerResult {
  exitCode: number;
  stdout?: string;
  stderr?: string;
}

/** Транспорт для явного выполнения; по умолчанию — spawn без shell. */
export type CommandInvoke = (
  command: string,
  args: readonly string[],
) => Promise<RunnerResult>;

/** Минимальный интерфейс Runner: имя, доступность, команда, выполнение. */
export interface Runner {
  readonly name: RunnerKind;
  /**
   * Чистый флаг доступности окружения/бинарника: resolve и dry-run его
   * проверяют, но никаких команд при этом не выполняют.
   */
  available(): boolean;
  /** Детерминированное построение команды без выполнения. */
  buildCommand(launch: RunnerLaunch): RunnerCommand;
  /** Выполнение — только по явному вызову (в resolve/dry-run не участвует). */
  execute(launch: RunnerLaunch, invoke?: CommandInvoke): Promise<RunnerResult>;
}

/** Зависимости проверки бинарника — подменяются в тестах без реальных вызовов. */
export interface RunnerDeps {
  env?: NodeJS.ProcessEnv;
  exists?: (file: string) => boolean;
  delimiter?: string;
  dockerBinary?: string;
  sshBinary?: string;
}

/** Спецификация выбора runner'а (`kind` по умолчанию `local`). */
export interface RunnerConfig {
  kind?: RunnerKind;
  /** Образ для docker. */
  image?: string;
  /** Хост для ssh. */
  host?: string;
  /** Пользователь для ssh. */
  user?: string;
  /** Явный opt-out: принудительный fail-open на local. */
  optOut?: boolean;
  deps?: RunnerDeps;
}

/** Байт-стабильное описание выбора и команды (D-3.1). */
export interface RunnerVerdict {
  requested: RunnerKind;
  runner: RunnerKind;
  fallback: boolean;
  reason: string;
  command: string;
  args: string[];
}

export interface ResolvedRunner {
  runner: Runner;
  requested: RunnerKind;
  fallback: boolean;
  reason: string;
  verdict(launch: RunnerLaunch): RunnerVerdict;
}

/** EX-1.1: единственный источник правды для поля `kind` в схемах и CLI. */
export const RUNNER_KINDS = ["local", "docker", "ssh"] as const;

/**
 * EX-1.1: нормализация runner из схемы задачи, CLI и RPC. Неизвестные значения
 * и неполные конфигурации деградируют в local через resolveRunner (fail-open).
 * `deps` намеренно не принимается: это тестовая инъекция, а не данные задачи.
 */
export function normalizeRunnerConfig(value: unknown): RunnerConfig | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  const config: RunnerConfig = {};
  if (raw.kind === "local" || raw.kind === "docker" || raw.kind === "ssh") {
    config.kind = raw.kind;
  }
  const clean = (key: "image" | "host" | "user"): void => {
    const rawValue = raw[key];
    if (typeof rawValue === "string" && rawValue.trim()) config[key] = rawValue.trim();
  };
  clean("image");
  clean("host");
  clean("user");
  if (raw.optOut === true) config.optOut = true;
  return config;
}

/** EX-1.1: что запекается в обёртку после сборки команды харнесса. */
export interface RunnerAgentDefaults {
  runner: RunnerConfig;
  /** Полный префикс команды агента; обёртка добавит только --model/--prompt. */
  harness: { commandPath: string; args: string[] };
}

/**
 * EX-1.1: кодирует выбор runner в один base64-токен без пробелов. Обе обёртки
 * (PowerShell и bash) передают такой аргумент как одно слово, поэтому выбор
 * транспорта переживает харнесс и не требует правки самих обёрток.
 */
export function encodeRunnerAgentDefaults(defaults: RunnerAgentDefaults): {
  commandPath: string;
  args: string[];
} {
  return {
    commandPath: process.execPath,
    args: [Buffer.from(JSON.stringify(defaults), "utf8").toString("base64")],
  };
}

/** EX-1.1: декодирование токена в runner-run CLI; rejects malformed input. */
export function decodeRunnerAgentDefaults(token: string): RunnerAgentDefaults {
  const parsed = JSON.parse(Buffer.from(token, "base64").toString("utf8")) as RunnerAgentDefaults;
  const normalized = normalizeRunnerConfig(parsed?.runner);
  if (!normalized || !parsed?.harness?.commandPath || !Array.isArray(parsed.harness.args)) {
    throw new Error("Runner: некорректная конфигурация запуска");
  }
  return {
    runner: normalized,
    harness: {
      commandPath: String(parsed.harness.commandPath),
      args: parsed.harness.args.map((arg) => String(arg)),
    },
  };
}

/** Возможные расширения исполняемого файла — проверяются на любой ОС. */
const BINARY_SUFFIXES = ["", ".exe", ".cmd", ".bat", ".com"] as const;

/**
 * Проверка бинарника по PATH без запуска команд и без привязки к ОС.
 * `exists` и `delimiter` внедряются в тестах, чтобы смоделировать отсутствие
 * docker/ssh, не трогая реальную файловую систему и сеть.
 */
export function binaryAvailable(binary: string, deps: RunnerDeps = {}): boolean {
  if (!binary) return false;
  const env = deps.env ?? process.env;
  const exists =
    deps.exists ??
    ((file: string) => {
      try {
        return existsSync(file);
      } catch {
        return false;
      }
    });
  if (binary.includes("/") || binary.includes("\\")) {
    return BINARY_SUFFIXES.some((suffix) => exists(binary + suffix));
  }
  const pathValue = env.PATH ?? env.Path ?? "";
  const delimiter = deps.delimiter ?? path.delimiter;
  return pathValue
    .split(delimiter)
    .filter(Boolean)
    .some((dir) => BINARY_SUFFIXES.some((suffix) => exists(path.join(dir, binary + suffix))));
}

/** Общая валидация описания запуска: без неё команда не собирается. */
export function validateLaunch(launch: RunnerLaunch): void {
  if (!launch.command || /[\r\n\0]/.test(launch.command)) {
    throw new Error("Runner: некорректная команда запуска");
  }
  if (launch.workdir !== undefined && /[\r\n\0]/.test(launch.workdir)) {
    throw new Error("Runner: некорректная рабочая директория");
  }
  for (const arg of launch.args) {
    if (/[\r\n\0]/.test(arg)) {
      throw new Error("Runner: аргумент содержит перевод строки или NUL");
    }
  }
  // QW-12: envFile/volumes тоже уходят в argv, поэтому проверяем их так же.
  if (launch.envFile !== undefined && (!launch.envFile || /[\r\n\0]/.test(launch.envFile))) {
    throw new Error("Runner: некорректный путь к env-файлу");
  }
  for (const volume of launch.volumes ?? []) {
    if (!volume || /[\r\n\0]/.test(volume)) {
      throw new Error("Runner: некорректное описание монтирования");
    }
  }
}

/** Транспорт по умолчанию: фиксированный argv, без оболочки и интерполяции. */
export const spawnInvoke: CommandInvoke = (command, args) =>
  new Promise<RunnerResult>((resolve, reject) => {
    const child = spawn(command, [...args], { shell: false, windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", reject);
    child.on("close", (exitCode) => resolve({ exitCode: exitCode ?? -1, stdout, stderr }));
  });

/** Локальный runner: тот же интерфейс, никаких docker/ssh-зависимостей. */
export function createLocalRunner(): Runner {
  const runner: Runner = {
    name: "local",
    available: () => true,
    buildCommand: (launch) => {
      validateLaunch(launch);
      return { command: launch.command, args: [...launch.args] };
    },
    execute: (launch, invoke = spawnInvoke) => {
      const built = runner.buildCommand(launch);
      return invoke(built.command, built.args);
    },
  };
  return runner;
}

/**
 * D-2.1/D-3.1: выбор runner'а по конфигурации. По умолчанию и при любом
 * fail-open (нет бинарника, нет обязательного параметра, явный opt-out)
 * возвращается local; вердикт зависит только от спеки и не использует часы
 * или случайные числа.
 */
export function resolveRunner(config: RunnerConfig = {}): ResolvedRunner {
  const requested = config.kind ?? "local";
  const deps = config.deps;

  const make = (runner: Runner, fallback: boolean, reason: string): ResolvedRunner => ({
    runner,
    requested,
    fallback,
    reason,
    verdict: (launch) => {
      const built = runner.buildCommand(launch);
      return {
        requested,
        runner: runner.name,
        fallback,
        reason,
        command: built.command,
        args: built.args,
      };
    },
  });

  if (requested === "local") return make(createLocalRunner(), false, "");

  if (config.optOut === true) {
    return make(createLocalRunner(), true, `${requested} opt-out`);
  }

  if (requested === "docker") {
    if (!config.image) return make(createLocalRunner(), true, "docker image missing");
    const runner = createDockerRunner({ image: config.image, deps });
    if (!runner.available()) {
      return make(createLocalRunner(), true, "docker binary not available");
    }
    return make(runner, false, "");
  }

  if (!config.host) return make(createLocalRunner(), true, "ssh host missing");
  const runner = createSSHRunner({ host: config.host, user: config.user, deps });
  if (!runner.available()) {
    return make(createLocalRunner(), true, "ssh binary not available");
  }
  return make(runner, false, "");
}
