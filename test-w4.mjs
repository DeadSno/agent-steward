/**
 * W-4: тесты видимого статуса `skipped` для запусков, пропущенных guard'ами.
 * Запуск: node test-w4.mjs (после npm run build).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ws-scheduler-w4-"));
process.env.APPDATA = tempRoot;
process.env.OPENCODE_SCHEDULER_HOME = path.join(tempRoot, "opencode", "windows-scheduler");
fs.mkdirSync(process.env.OPENCODE_SCHEDULER_HOME, { recursive: true });

const { initDb, closeDb } = await import("./dist/db/index.js");
const { getHistory } = await import("./dist/db/history-repo.js");
const { getMetrics } = await import("./dist/db/metrics-repo.js");
const { saveTask } = await import("./dist/db/tasks-repo.js");
const { writeWrapperCmd, WRAPPER_SCRIPT } = await import("./dist/core/ps-wrapper.js");
const { buildBashWrapperScript } = await import("./dist/core/wrappers/bash.js");

initDb();

const results = [];
function check(name, cond) {
  results.push({ name, ok: !!cond });
  console.log(`${cond ? "OK  " : "FAIL"} ${name}`);
}

const recorder = path.resolve("dist/core/record-history.js");
const logFile = path.join(tempRoot, "task.log");
fs.writeFileSync(logFile, "", "utf8");
const b64 = (text) => Buffer.from(text, "utf8").toString("base64");
const runRecorder = (args) =>
  spawnSync(process.execPath, [recorder, ...args], {
    encoding: "utf8",
    env: { ...process.env, APPDATA: tempRoot },
    timeout: 30000,
  });

saveTask({ name: "Guard Task", schedule: "* * * * *", prompt: "guarded", workspaceId: "api" });

// --- 1. Recorder: --skip пишет историю и total-метрику ---------------------
const skipResult = runRecorder([
  "--skip",
  "Guard Task",
  b64("guard: branch mismatch"),
  logFile,
  "1500",
]);
check("recorder: --skip завершается кодом 0", skipResult.status === 0);
if (skipResult.status !== 0) console.error(skipResult.stderr);

const skipped = getHistory("Guard Task").filter((row) => row.status === "skipped");
check("recorder: запись skipped в истории", skipped.length === 1);
check(
  "recorder: причина сохранена в error",
  skipped.length === 1 && skipped[0].error === "guard: branch mismatch",
);
check(
  "recorder: длительность сохранена",
  skipped.length === 1 && skipped[0].durationMs === 1500,
);
const metrics = getMetrics("Guard Task");
check(
  "recorder: skipped увеличивает только total",
  !!metrics && metrics.total === 1 && metrics.success === 0 &&
    metrics.error === 0 && metrics.partial === 0,
);
check(
  "recorder: фильтр истории по skipped",
  getHistory("Guard Task", 20, "skipped").length === 1,
);
check(
  "recorder: workspace из определения задачи",
  skipped.length === 1 && skipped[0].workspaceId === "api",
);

// --- 2. Recorder: причины по умолчанию и защита от неверных аргументов -----
const defaultResult = runRecorder(["--skip", "Guard Task"]);
check("recorder: битой base64 → код 0", defaultResult.status === 0);
const defaultSkipped = getHistory("Guard Task").filter((row) => row.status === "skipped");
check(
  "recorder: причина по умолчанию",
  defaultSkipped.length === 2 &&
    defaultSkipped.some((row) => row.error === "guard conditions not met"),
);
check(
  "recorder: --skip без имени задачи → код 1",
  runRecorder(["--skip"]).status === 1,
);
check(
  "recorder: legacy-статус skipped принимается",
  runRecorder(["Guard Task", "skipped", new Date().toISOString(), "0", "-", "-1", "-", "-", "-", "-", logFile]).status === 0,
);
check(
  "recorder: --finish со статусом skipped принимается",
  (() => {
    const start = runRecorder(["--start", "Guard Task", new Date().toISOString()]);
    if (start.status !== 0) return false;
    const id = start.stdout.trim();
    const finish = runRecorder([
      "--finish", id, "Guard Task", "skipped", "0", "-", "-1", "-", "-", "-", "-", logFile,
    ]);
    return finish.status === 0;
  })(),
);
check(
  "recorder: skipped из --finish попал в историю",
  getHistory("Guard Task", 50, "skipped").length >= 4,
);

// --- 3. Обёртки: --skip вызывается только при guard-пропуске --------------
const guardedCmdPath = await writeWrapperCmd(
  "guard-task", "Guard Task", path.join(tempRoot, "prompt.txt"), 60,
  path.join(tempRoot, "task.lock"), tempRoot, logFile, recorder,
  undefined, undefined, undefined, undefined, undefined, undefined, undefined,
  undefined, undefined, undefined, undefined, undefined, undefined, undefined,
  undefined, false, undefined, { command: "false" }, path.resolve("dist/core/guard-run.js"),
);
const guardedCmd = fs.readFileSync(guardedCmdPath, "utf8");
check("Windows: .cmd содержит вызов recorder --skip", guardedCmd.includes("--skip"));
check(
  "Windows: --skip идёт до exit /b 0",
  guardedCmd.indexOf("--skip") < guardedCmd.lastIndexOf("exit /b 0"),
);
const plainCmdPath = await writeWrapperCmd(
  "plain-task", "Plain Task", path.join(tempRoot, "prompt.txt"), 60,
  path.join(tempRoot, "plain.lock"), tempRoot, logFile, recorder,
);
const plainCmd = fs.readFileSync(plainCmdPath, "utf8");
check("Windows: без guards нет --skip", !plainCmd.includes("--skip"));

const guardedBash = buildBashWrapperScript({
  sanitizedName: "guard-task",
  taskName: "Guard Task",
  promptFile: path.join(tempRoot, "prompt.txt"),
  timeoutSeconds: 60,
  lockFile: path.join(tempRoot, "guard.lock"),
  workdir: tempRoot,
  logFile,
  recorderFile: recorder,
  guards: { command: "false" },
  guardHelper: path.resolve("dist/core/guard-run.js"),
});
check("bash: guarded wrapper вызывает recorder --skip", guardedBash.includes("--skip"));
check(
  "bash: guard-пропуск → exit 0",
  guardedBash.includes("-eq 4") && guardedBash.includes("exit 0"),
);
const plainBash = buildBashWrapperScript({
  sanitizedName: "plain-task",
  taskName: "Plain Task",
  promptFile: path.join(tempRoot, "prompt.txt"),
  timeoutSeconds: 60,
  lockFile: path.join(tempRoot, "plain.lock"),
  workdir: tempRoot,
  logFile,
  recorderFile: recorder,
});
check("bash: без guards нет recorder --skip", !plainBash.includes("--skip"));
check("Windows: базовая обёртка без --skip", !WRAPPER_SCRIPT.includes("--skip"));

// --- 4. GUI и локали -------------------------------------------------------
const guiSource = fs.readFileSync("src/gui.tsx", "utf8");
check("GUI: JobStatus содержит skipped", guiSource.includes('"skipped" | "idle"'));
check("GUI: statusColor обрабатывает skipped", guiSource.includes('case "skipped"'));
check("GUI: метка задачи skipped", guiSource.includes('gt("gui.jobStatus.skipped")'));
check("GUI: метка истории skipped", guiSource.includes('gt("gui.history.skipped")'));

for (const locale of ["en", "ru", "zh"]) {
  const data = JSON.parse(fs.readFileSync(`locales/${locale}.json`, "utf8"));
  check(
    `locales/${locale}: ключи skipped`,
    typeof data["gui.jobStatus.skipped"] === "string" &&
      typeof data["gui.history.skipped"] === "string",
  );
}

// --- 5. Итог ---------------------------------------------------------------
const failed = results.filter((item) => !item.ok);
closeDb();
if (failed.length === 0) {
  fs.rmSync(tempRoot, { recursive: true, force: true });
}
console.log(`\nW-4: ${results.length - failed.length}/${results.length} проверок пройдено.`);
if (failed.length > 0) process.exitCode = 1;
