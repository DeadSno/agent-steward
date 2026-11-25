/**
 * PL-7.2: CLI-обвязка для обёрток — пишет разделённые stdout/stderr хука
 * в структурированный журнал. Вызывается из сгенерированных PowerShell/bash
 * обёрток после pre-flight/post-flight и после прогона quality gate.
 *
 *Usage: node hook-output.js <preFlight|postFlight|qualityGate> <task> <exitCode> <stdoutFile> <stderrFile> [runId]
 */
import fs from "node:fs";
import { appendHookOutputLog, type HookPhase } from "./core/structured-log.js";

const [, , phaseArg, task, exitCodeArg, stdoutFile, stderrFile, runIdArg] = process.argv;

const HOOK_PHASES: readonly string[] = ["preFlight", "postFlight", "qualityGate"];

if (!phaseArg || !HOOK_PHASES.includes(phaseArg)) {
  console.error("hook-output: phase must be preFlight, postFlight or qualityGate");
  process.exit(2);
}
const phase = phaseArg as HookPhase;

function readIfPresent(file: string | undefined): string {
  if (!file) return "";
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return "";
  }
}

const parsedCode = Number.parseInt(exitCodeArg ?? "", 10);
const parsedRunId = Number.parseInt(runIdArg ?? "", 10);

appendHookOutputLog(
  phase,
  task ?? "",
  {
    exitCode: Number.isFinite(parsedCode) ? parsedCode : null,
    stdout: readIfPresent(stdoutFile),
    stderr: readIfPresent(stderrFile),
  },
  Number.isFinite(parsedRunId) ? parsedRunId : undefined,
);
