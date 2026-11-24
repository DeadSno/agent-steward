#!/usr/bin/env node
/**
 * CLI agent-steward (Спринт 32, Pipeline-as-code).
 *
 * Команды:
 *   agent-steward pipeline validate <file> [--json]
 *   agent-steward pipeline apply <file> [--dry-run] [--json]
 *   agent-steward pipeline export --pipeline <name> [--out <file>]
 *   agent-steward apply -f <file> [--dry-run] [--json]   # алиас pipeline apply
 *
 * Exit-коды: 0 — успех, 1 — ошибки валидации/применения, 2 — неверные аргументы.
 */
import { writeFileSync } from "node:fs";
import { stringify } from "yaml";
import { closeDb, initDb } from "./db/index.js";
import { listTasks } from "./db/tasks-repo.js";
import { loadPipelineFile } from "./core/pipeline-io.js";
import { executePipelineApply, planPipelineApply } from "./core/pipeline-apply.js";
import { tasksToPipelineSpec } from "./core/pipeline-map.js";
import { saveTaskDefinition, type TaskDefinition } from "./task-transfer.js";
import { listWorkspaces } from "./workspaces.js";
import { runMission, type MissionSpec } from "./core/mission.js";

const USAGE = `agent-steward — планировщик agent jobs

Использование:
  agent-steward pipeline validate <file> [--json]
  agent-steward pipeline apply <file> [--dry-run] [--json]
  agent-steward pipeline export --pipeline <name> [--out <file>]
  agent-steward apply -f <file> [--dry-run] [--json]
  agent-steward mcp
  agent-steward serve [--port <number>]

Команды:
  validate  проверить opencode.pipeline.yaml, не меняя задачи
  apply     создать/обновить задачи из файла (идемпотентно)
  export    выгрузить задачи pipeline из БД обратно в YAML
  mcp       поднять 34 инструмента как MCP-сервер на stdio
  serve     поднять локальный дашборд без OpenCode

Опции:
  --json        машинный вывод
  --dry-run     показать план apply без изменений
  -f, --file    файл pipeline для алиаса apply
  --pipeline    имя pipeline для export
  --out         файл для export (по умолчанию stdout)
`;

interface PrintedIssue {
  path: string;
  message: string;
}

function printIssueList(label: string, issues: PrintedIssue[]): void {
  if (issues.length === 0) return;
  console.error(label);
  for (const issue of issues) {
    console.error(`  - ${issue.path}: ${issue.message}`);
  }
}

function requireFile(args: string[]): string {
  const flagIndex = args.findIndex((arg) => arg === "-f" || arg === "--file");
  if (flagIndex !== -1) {
    const flagged = args[flagIndex + 1];
    if (!flagged || flagged.startsWith("-")) {
      console.error("Опция -f/--file требует значение.");
      console.error(USAGE);
      process.exit(2);
    }
    return flagged;
  }
  // P-2.3: старый позиционный путь (pipeline apply <file>) остаётся рабочим.
  const file = args.find((arg) => !arg.startsWith("-"));
  if (!file) {
    console.error("Не указан файл pipeline.\n");
    console.error(USAGE);
    process.exit(2);
  }
  return file;
}

function flagValue(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index === -1) return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith("--")) {
    console.error(`Опция ${name} требует значение.`);
    process.exit(2);
  }
  return value;
}

function workspaceResolver(): (value: string) => string | undefined {
  const workspaces = listWorkspaces();
  const byId = new Map(workspaces.map((ws) => [ws.id.toLowerCase(), ws.id]));
  const byName = new Map(workspaces.map((ws) => [ws.name.trim().toLowerCase(), ws.id]));
  return (value) => {
    const key = value.trim().toLowerCase();
    return byId.get(key) ?? byName.get(key);
  };
}

/** Создаёт задачу через общий путь schedulerCreateTask и сохраняет определение. */
async function persistDefinition(def: TaskDefinition): Promise<void> {
  const { schedulerCreateTask } = await import("./index.js");
  await schedulerCreateTask(
    def.name,
    def.schedule,
    def.prompt,
    def.timeoutSeconds,
    def.workingDirectory,
    def.retryCount,
    def.retryDelay,
    def.qualityGate,
    def.nextTaskOnSuccess,
    def.nextTaskOnError,
    def.triggerType,
    def.watchPath,
    def.dependsOn,
    def.model,
    def.priority,
    def.beforeScript,
    def.afterScript,
    def.mcpEvent,
    def.workspaceId,
    def.allowedTools,
    def.deniedTools,
    def.matrix,
    def.matrixParentId,
    "create",
    def.timezone,
    def.notBefore,
    def.notAfter,
    def.pausedUntil,
    def.runAt,
    def.session,
    def.sessionId,
    def.sessionMaxRuns,
    {
      activeDays: def.activeDays,
      windowPolicy: def.windowPolicy,
      watchGlobs: def.watchGlobs,
      watchIgnore: def.watchIgnore,
      gitBranch: def.gitBranch,
      gitPaths: def.gitPaths,
      gitIgnore: def.gitIgnore,
      gitPollSeconds: def.gitPollSeconds,
    },
    def.runWhenLoggedOff,
    def.paused,
    def.legacyShell,
  );
  await saveTaskDefinition(def);
}

async function runValidate(args: string[]): Promise<number> {
  const file = requireFile(args);
  const json = args.includes("--json");
  const result = await loadPipelineFile(file);

  if (json) {
    console.log(
      JSON.stringify(
        {
          ok: result.ok,
          errors: result.errors,
          warnings: result.warnings,
          steps: result.spec?.steps.length ?? 0,
        },
        null,
        2,
      ),
    );
  } else {
    printIssueList("Ошибки:", result.errors);
    printIssueList("Предупреждения:", result.warnings);
    if (result.ok && result.spec) {
      console.log(
        `OK: «${result.spec.name}», шагов: ${result.spec.steps.length}`,
      );
    }
  }

  return result.ok ? 0 : 1;
}

async function runExport(args: string[]): Promise<number> {
  const pipelineName = flagValue(args, "--pipeline");
  if (!pipelineName) {
    console.error("Для export укажите --pipeline <name>.\n");
    console.error(USAGE);
    return 2;
  }
  const out = flagValue(args, "--out");

  initDb();
  try {
    const exported = tasksToPipelineSpec(listTasks(), pipelineName);
    if (exported.spec.steps.length === 0) {
      console.error(`Pipeline «${pipelineName}» не найден в БД.`);
      return 1;
    }
    for (const warning of exported.warnings) console.error(`Предупреждение: ${warning}`);
    const yaml = stringify(exported.spec, { lineWidth: 0 });
    if (out) {
      writeFileSync(out, yaml, "utf8");
      console.log(`Записано: ${out} (шагов: ${exported.spec.steps.length})`);
    } else {
      process.stdout.write(yaml);
    }
    return 0;
  } finally {
    closeDb();
  }
}

async function runApply(args: string[]): Promise<number> {
  const file = requireFile(args);
  const dryRun = args.includes("--dry-run");
  const json = args.includes("--json");

  const parsed = await loadPipelineFile(file);
  if (!parsed.ok || !parsed.spec) {
    printIssueList("Ошибки:", parsed.errors);
    printIssueList("Предупреждения:", parsed.warnings);
    return 1;
  }

  initDb();
  try {
    const plan = planPipelineApply(parsed.spec, listTasks(), {
      resolveWorkspaceId: workspaceResolver(),
    });
    for (const warning of plan.warnings) console.error(`Предупреждение: ${warning}`);

    if (!dryRun) {
      await executePipelineApply(plan, {
        create: persistDefinition,
        update: persistDefinition,
      });
    }

    const summary = {
      pipeline: parsed.spec.name,
      dryRun,
      creates: plan.creates.map((task) => task.name),
      updates: plan.updates.map((entry) => entry.task.name),
      unchanged: plan.unchanged.map((task) => task.name),
      stale: plan.stale.map((task) => task.name),
    };
    if (json) {
      console.log(JSON.stringify(summary, null, 2));
    } else {
      const verb = dryRun ? "Будет создано" : "Создано";
      console.log(`${verb}: ${summary.creates.length}`);
      console.log(`Обновлено: ${summary.updates.length}`);
      console.log(`Без изменений: ${summary.unchanged.length}`);
      if (summary.stale.length > 0) {
        console.log(`Устаревшие (не удалены): ${summary.stale.join(", ")}`);
      }
      for (const name of summary.creates) console.log(`  + ${name}`);
      for (const name of summary.updates) console.log(`  ~ ${name}`);
    }
    return 0;
  } catch (err) {
    console.error(`Ошибка apply: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  } finally {
    closeDb();
  }
}

function listFlag(args: string[], name: string): string[] | undefined {
  const value = flagValue(args, name);
  if (value === undefined) return undefined;
  const list = value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  return list.length > 0 ? list : undefined;
}

/**
 * AB-8.2: `agent-steward run <prompt>` — ad-hoc миссия без регистрации в ОС.
 * Проходит тот же runtime, что и задачи: план → маршрут → GATE → ledger.
 */
async function runAdHoc(args: string[]): Promise<number> {
  const valueFlags = new Set([
    "--cwd",
    "--gate",
    "--task-type",
    "--model",
    "--timeout",
    "--policy",
    "--allow-tools",
    "--deny-tools",
    "--session",
    "--session-id",
    "--name",
  ]);
  let prompt: string | undefined;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg.startsWith("--")) {
      if (valueFlags.has(arg)) index++;
      continue;
    }
    prompt = arg;
    break;
  }
  if (!prompt?.trim()) {
    console.error(
      "agent-steward run <prompt> [--cwd <dir>] [--gate <cmd>] [--task-type <type>] " +
        "[--model <model>] [--timeout <sec>] [--policy hybrid|secure|legacy] " +
        "[--allow-tools a,b] [--deny-tools a,b] [--session new|reuse|last] " +
        "[--session-id ses_...] [--name <name>] [--dry-run] [--json]",
    );
    return 2;
  }

  const json = args.includes("--json");
  const timeoutRaw = flagValue(args, "--timeout");
  const timeoutSeconds = timeoutRaw === undefined ? undefined : Number(timeoutRaw);
  if (timeoutSeconds !== undefined && (!Number.isInteger(timeoutSeconds) || timeoutSeconds <= 0)) {
    console.error("--timeout должен быть целым положительным числом секунд.");
    return 2;
  }
  const policyRaw = flagValue(args, "--policy");
  if (policyRaw && !["hybrid", "secure", "legacy"].includes(policyRaw)) {
    console.error("--policy должен быть hybrid, secure или legacy.");
    return 2;
  }
  const sessionRaw = flagValue(args, "--session");
  if (sessionRaw && !["new", "reuse", "last"].includes(sessionRaw)) {
    console.error("--session должен быть new, reuse или last.");
    return 2;
  }

  const spec: MissionSpec = {
    prompt,
    cwd: flagValue(args, "--cwd"),
    taskName: flagValue(args, "--name"),
    taskType: flagValue(args, "--task-type"),
    model: flagValue(args, "--model"),
    session: sessionRaw as MissionSpec["session"],
    sessionId: flagValue(args, "--session-id"),
    timeoutSeconds,
    gate: flagValue(args, "--gate"),
    gateTimeoutSeconds: undefined,
    policy: policyRaw as MissionSpec["policy"],
    allowedTools: listFlag(args, "--allow-tools"),
    deniedTools: listFlag(args, "--deny-tools"),
    dryRun: args.includes("--dry-run"),
  };

  initDb();
  try {
    const result = await runMission(spec);
    if (json) {
      console.log(
        JSON.stringify(
          {
            success: result.success,
            dryRun: result.dryRun,
            runId: result.runId,
            status: result.status,
            description: result.description,
            error: result.error,
            logFile: result.logFile,
            steps: result.steps,
          },
          null,
          2,
        ),
      );
    } else {
      console.log(result.description);
      for (const step of result.steps) {
        console.log(`  ${step.stepName}: ${step.status} (attempt ${step.attempt})`);
      }
      if (result.error) console.error(`Ошибка: ${result.error}`);
      if (result.logFile) console.log(`Лог: ${result.logFile}`);
      if (result.runId) console.log(`Запуск: ${result.runId}`);
    }
    return result.success ? 0 : 1;
  } catch (err) {
    console.error(`Ошибка миссии: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  } finally {
    closeDb();
  }
}

async function main(argv: string[]): Promise<number> {
  const [group, command, ...rest] = argv;
  if (group === "--help" || group === "-h" || group === "help" || !group) {
    console.log(USAGE);
    return group ? 0 : 2;
  }
  if (group === "run") {
    return runAdHoc([command, ...rest].filter((value): value is string => Boolean(value)));
  }
  if (group === "mcp") {
    const { startMcpServer } = await import("./mcp.js");
    await startMcpServer();
    return 0;
  }
  if (group === "serve") {
    const { startStandaloneDashboard } = await import("./serve.js");
    // P-5.1: `command` — это первый аргумент после `serve` (например, --port),
    // а не подкоманда; терять его нельзя, иначе --port игнорируется.
    await startStandaloneDashboard(
      [command, ...rest].filter((value): value is string => Boolean(value)),
    );
    return 0;
  }
  // P-2.3: GitOps-алиас `agent-steward apply -f pipeline.yaml`.
  if (group === "apply") {
    if (command === "--help" || command === "-h" || command === "help") {
      console.log(USAGE);
      return 0;
    }
    return runApply([command, ...rest].filter((value): value is string => Boolean(value)));
  }
  if (group !== "pipeline") {
    console.error(`Неизвестная команда «${group}».\n`);
    console.error(USAGE);
    return 2;
  }
  switch (command) {
    case "--help":
    case "-h":
    case "help":
      console.log(USAGE);
      return 0;
    case "validate":
      return runValidate(rest);
    case "apply":
      return runApply(rest);
    case "export":
      return runExport(rest);
    default:
      console.error(`Неизвестная команда pipeline «${command ?? ""}».\n`);
      console.error(USAGE);
      return 2;
  }
}

main(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err) => {
    console.error(`Ошибка: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  });
