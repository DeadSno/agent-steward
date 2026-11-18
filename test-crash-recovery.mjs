// Спринт 13: Crash Recovery.
// Проверяем, что обёртки реально вызывают --start/--finish, а незавершённая
// запись (finished_at IS NULL) после «перезапуска» помечается как error.
//
// Запуск: node test-crash-recovery.mjs (после npm run build).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sched-crash-test-"));
process.env.APPDATA = tempRoot;
process.env.OPENCODE_SCHEDULER_HOME = path.join(tempRoot, "opencode", "windows-scheduler");

const pluginDir = path.join(tempRoot, "opencode", "windows-scheduler");
fs.mkdirSync(pluginDir, { recursive: true });

const assert = (cond, msg) => {
  if (!cond) {
    console.error("FAIL: " + msg);
    process.exitCode = 1;
  } else {
    console.log("OK: " + msg);
  }
};

const { initDb, closeDb, getDb } = await import("./dist/db/index.js");
const { saveTask, getTask } = await import("./dist/db/tasks-repo.js");
const { getHistory } = await import("./dist/db/history-repo.js");
const { recoverInterruptedRuns } = await import("./dist/db/recovery.js");
const { WRAPPER_SCRIPT } = await import("./dist/core/ps-wrapper.js");
const { buildBashWrapperScript } = await import("./dist/core/wrappers/bash.js");

initDb();

saveTask({ name: "Crash Task", schedule: "* * * * *", prompt: "crash" });
saveTask({ name: "Finish Task", schedule: "* * * * *", prompt: "finish" });

const recorder = path.resolve("dist/core/record-history.js");
const runRecorder = (args) =>
  spawnSync(process.execPath, [recorder, ...args], {
    encoding: "utf8",
    env: { ...process.env, APPDATA: tempRoot },
    timeout: 30000,
  });

// --- 1. Контракт обёрток ------------------------------------------------
assert(
  WRAPPER_SCRIPT.includes("--start") && WRAPPER_SCRIPT.includes("--finish"),
  "PowerShell-обёртка вызывает record-history --start и --finish"
);
assert(
  WRAPPER_SCRIPT.includes("Move-Item") &&
    !WRAPPER_SCRIPT.includes("Remove-Item -LiteralPath $LockFile -Force"),
  "PowerShell-обёртка вытесняет stale lock через Move-Item, а не Remove-Item"
);
assert(
  WRAPPER_SCRIPT.includes("[workspace]") && WRAPPER_SCRIPT.includes("$WorkspaceName"),
  "PowerShell-обёртка логирует workspace и принимает WorkspaceName"
);

const bashScript = buildBashWrapperScript({
  sanitizedName: "crash-task",
  taskName: "Crash Task",
  promptFile: "/tmp/prompt.txt",
  timeoutSeconds: 60,
  lockFile: "/tmp/task.lock",
  workdir: tempRoot,
  logFile: path.join(pluginDir, "crash.log"),
  recorderFile: recorder,
  workspaceName: "backend",
});
assert(
  bashScript.includes("--start") && bashScript.includes("--finish"),
  "bash-обёртка вызывает record-history --start и --finish"
);
assert(
  bashScript.includes('mv "$LOCK_FILE.d"') &&
    !bashScript.includes('rm -rf "$LOCK_FILE.d" 2>/dev/null || true'),
  "bash-обёртка вытесняет stale lock через mv, а не rm -rf"
);
assert(
  bashScript.includes("WORKSPACE_NAME") && bashScript.includes("[workspace]"),
  "bash-обёртка логирует workspace"
);
assert(
  (bashScript.match(/WD_SLEEP_PID=/g) || []).length >= 2,
  "bash-обёртка отслеживает pid sleep в обоих watchdog"
);
assert(
  (bashScript.match(/trap 'if \[ -n "\$WD_SLEEP_PID" \]/g) || []).length >= 2,
  "watchdog убивает собственный sleep по TERM и не оставляет сирот"
);

// --- 2. --start создаёт незавершённую запись ----------------------------
const start = runRecorder(["--start", "Crash Task", "2026-03-01T10:00:00.000Z"]);
assert(start.status === 0, "--start завершился успешно");
const crashedId = Number(String(start.stdout || "").trim());
assert(Number.isFinite(crashedId) && crashedId > 0, `--start вернул id записи (${crashedId})`);

let record = getHistory("Crash Task", 10)[0];
assert(record && record.id === crashedId, "незавершённая запись присутствует в history");
assert(record.status === "running", "статус незавершённой записи — running");
assert(record.finishedAt == null, "у незавершённой записи finished_at = NULL");

// B1.2: recorder пишет владельца — PID процесса-обёртки (здесь: этого теста).
const ownerRow = getDb()
  .prepare("SELECT owner_pid, owner_host, owner_started_at FROM history WHERE id = ?")
  .get(crashedId);
assert(
  Number(ownerRow.owner_pid) === process.pid,
  `--start записал owner_pid процесса-обёртки (${ownerRow.owner_pid})`
);
assert(
  String(ownerRow.owner_host) === os.hostname(),
  `--start записал owner_host (${ownerRow.owner_host})`
);
assert(
  typeof ownerRow.owner_started_at === "string" && ownerRow.owner_started_at.length > 0,
  "--start записал owner_started_at"
);

// --- 3. Имитация перезапуска плагина ------------------------------------
closeDb();
initDb();
recoverInterruptedRuns();

record = getHistory("Crash Task", 10)[0];
assert(record.status === "error", "после recovery запись помечена как error");
assert(
  record.error === "Прервано (сбой/перезагрузка)",
  `точное сообщение recovery (получено: ${JSON.stringify(record.error)})`
);
assert(record.finishedAt != null, "у восстановленной записи заполнен finished_at");
assert(
  typeof record.durationMs === "number" && record.durationMs >= 0,
  "у восстановленной записи рассчитан duration_ms"
);

// --- 4. Штатный --finish обновляет ту же строку -------------------------
const start2 = runRecorder(["--start", "Finish Task", "2026-03-01T11:00:00.000Z"]);
const finishId = Number(String(start2.stdout || "").trim());
assert(Number.isFinite(finishId) && finishId > 0, "--start для штатного завершения вернул id");

const finish = runRecorder([
  "--finish",
  String(finishId),
  "Finish Task",
  "success",
  "1500",
  "",
  "42",
  "0.0042",
  "test/model",
  "success",
  "skipped",
]);
assert(finish.status === 0, "--finish завершился успешно");

const finished = getHistory("Finish Task", 10)[0];
assert(finished.id === finishId, "--finish обновил именно ту запись, что вернул --start");
assert(finished.status === "success", "после --finish статус success");
assert(finished.durationMs === 1500, "после --finish сохранён duration_ms");
assert(finished.tokens === 42, "после --finish сохранены токены");

const task = getTask("Finish Task");
assert(task?.name === "Finish Task", "задача доступна после завершения записи");

closeDb();
console.log("\nCrash Recovery test completed.");
