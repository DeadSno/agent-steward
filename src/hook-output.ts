/**
 * PL-7.2: CLI-обвязка для обёрток — пишет разделённые stdout/stderr хука
 * в структурированный журнал. Вызывается из сгенерированных PowerShell/bash
 * обёрток после pre-flight/post-flight.
 *
 *Usage: node hook-output.js <preFlight|postFlight> <task> <exitCode> <stdoutFile> <stderrFile> [runId]
 */
import fs from "node:fs";
import { appendHookOutputLog } from "./core/structured-log.js";

const [, , phaseArg, task, exitCodeArg, stdoutFile, stderrFile, runIdArg] = process.argv;

if (phaseArg !== "preFlight" && phaseArg !== "postFlight") {
  console.error("hook-output: phase must be preFlight or postFlight");
  process.exit(2);
}

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
  phaseArg,
  task ?? "",
  {
    exitCode: Number.isFinite(parsedCode) ? parsedCode : null,
    stdout: readIfPresent(stdoutFile),
    stderr: readIfPresent(stderrFile),
  },
  Number.isFinite(parsedRunId) ? parsedRunId : undefined,
);
