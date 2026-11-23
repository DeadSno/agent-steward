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
const { getHistory, recoverInterrupted } = await import("./dist/db/history-repo.js");
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

// --- 3. Recovery не трогает живой прогон (B1.3) -------------------------
closeDb();
initDb();
let outcome = recoverInterrupted();
assert(
  outcome.keptAlive === 1 && outcome.recovered === 0,
  `живой владелец: recovery оставил запись (${JSON.stringify(outcome)})`
);

record = getHistory("Crash Task", 10)[0];
assert(record.status === "running", "живой прогон остался running");
assert(record.finishedAt == null, "у живого прогона finished_at = NULL");

// --- 3b. Мёртвый владелец: recovery финализирует ------------------------
const dead = spawnSync(process.execPath, ["-e", "0"]);
getDb()
  .prepare("UPDATE history SET owner_pid = ? WHERE id = ?")
  .run(Number(dead.pid), crashedId);
outcome = recoverInterrupted();
assert(outcome.recovered === 1, `мёртвый владелец: запись восстановлена (${JSON.stringify(outcome)})`);

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

// --- 3b-2. PL-46: живой PID, но запись просрочена (schtasks /End) --------
const staleClock = new Date("2026-03-01T15:00:00.000Z");
const staleStart = new Date(staleClock.getTime() - 3 * 60 * 60 * 1000).toISOString();
getDb()
  .prepare(
    "INSERT INTO history (task_name, status, started_at, finished_at, owner_pid, owner_host, owner_started_at) VALUES (?, 'running', ?, NULL, ?, ?, ?)",
  )
  .run("Stale Live Owner", staleStart, process.pid, os.hostname(), staleStart);
const staleOutcome = recoverInterrupted({ now: staleClock, staleAfterMs: 60 * 60 * 1000 });
assert(
  staleOutcome.recovered === 1 && staleOutcome.keptAlive === 0,
  `PL-46: просроченная запись живого владельца финализирована (${JSON.stringify(staleOutcome)})`
);
const staleRecord = getHistory("Stale Live Owner", 1)[0];
assert(staleRecord?.status === "timeout", "PL-46: статус просроченного запуска — timeout");
assert(
  typeof staleRecord?.error === "string" && staleRecord.error.includes("schtasks /End"),
  "PL-46: причина указывает на завершение владельца"
);

// --- 3c. Legacy без владельца и чужой хост: решает возраст (B1.5) --------
const clock = new Date("2026-03-01T12:00:00.000Z");
const freshIso = new Date(clock.getTime() - 60_000).toISOString();
const oldIso = new Date(clock.getTime() - 25 * 60 * 60 * 1000).toISOString();
const insertLegacy = getDb().prepare(
  "INSERT INTO history (task_name, status, started_at, finished_at) VALUES (?, 'running', ?, NULL)"
);
insertLegacy.run("Legacy Fresh", freshIso);
insertLegacy.run("Legacy Old", oldIso);
const insertForeign = getDb().prepare(
  "INSERT INTO history (task_name, status, started_at, finished_at, owner_pid, owner_host, owner_started_at) VALUES (?, 'running', ?, NULL, ?, ?, ?)"
);
insertForeign.run("Foreign Fresh", freshIso, process.pid, "another-host", freshIso);
insertForeign.run("Foreign Old", oldIso, process.pid, "another-host", oldIso);

const legacyOutcome = recoverInterrupted({ now: clock });
assert(
  legacyOutcome.recovered === 2 && legacyOutcome.keptAlive === 2,
  `возраст решает для legacy и чужого хоста (${JSON.stringify(legacyOutcome)})`
);
assert(getHistory("Legacy Fresh", 1)[0]?.status === "running", "свежая legacy-строка осталась running");
assert(getHistory("Legacy Old", 1)[0]?.status === "error", "просроченная legacy-строка помечена error");
assert(getHistory("Foreign Fresh", 1)[0]?.status === "running", "свежая строка чужого хоста осталась running");
assert(getHistory("Foreign Old", 1)[0]?.status === "error", "просроченная строка чужого хоста помечена error");

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

// --- 5. PL-63: рекордер закрывает осиротевшие running-запуски -------------
// До правки просроченная запись оставалась running после --start (ARCH-7
// висел ~49 ч) и не несла меток partial/явного повтора.
const { createRun, getRun, getStep } = await import("./dist/db/runs-repo.js");
const { recoverStaleRunningOnRecorderStart } = await import("./dist/core/record-history.js");

const pl63Now = new Date();
const pl63StaleIso = new Date(pl63Now.getTime() - 3 * 60 * 60 * 1000).toISOString();
const pl63FreshIso = new Date(pl63Now.getTime() - 60_000).toISOString();
saveTask({ name: "PL-63 Short", schedule: "* * * * *", prompt: "x", timeoutSeconds: 60 });
saveTask({ name: "PL-63 Long", schedule: "* * * * *", prompt: "x", timeoutSeconds: 14400 });

const pl63InsertRunning = getDb().prepare(
  "INSERT INTO history (task_name, status, started_at, finished_at) VALUES (?, 'running', ?, NULL)",
);
pl63InsertRunning.run("PL-63 Stale", pl63StaleIso);
pl63InsertRunning.run("PL-63 Fresh", pl63FreshIso);
pl63InsertRunning.run("PL-63 Short", pl63StaleIso);
pl63InsertRunning.run("PL-63 Long", pl63StaleIso);
const pl63HistoryId = getHistory("PL-63 Stale", 1)[0].id;
const pl63Durable = createRun({
  taskName: "PL-63 Stale",
  status: "running",
  startedAt: pl63StaleIso,
  steps: [{ stepName: "PL-63 Stale", status: "running" }],
  metadata: { origin: "registered", registeredHistoryId: pl63HistoryId },
});

const pl63Start = runRecorder(["--start", "PL-63 Trigger", pl63Now.toISOString()]);
assert(pl63Start.status === 0, "PL-63: --start после просроченного запуска завершился успешно");

const pl63StaleRecord = getHistory("PL-63 Stale", 1)[0];
assert(
  pl63StaleRecord?.status === "interrupted",
  `PL-63: просроченный запуск закрыт как interrupted (фактически ${pl63StaleRecord?.status})`,
);
assert(
  typeof pl63StaleRecord?.error === "string" &&
    pl63StaleRecord.error.includes("Прервано") &&
    pl63StaleRecord.error.includes("частичные правки") &&
    pl63StaleRecord.error.includes("явный повтор"),
  "PL-63: причина помечает частичные правки и требует явный повтор",
);
assert(pl63StaleRecord?.finishedAt != null, "PL-63: заполнен finished_at прерванной записи");
assert(
  typeof pl63StaleRecord?.durationMs === "number" &&
    pl63StaleRecord.durationMs >= 3 * 60 * 60 * 1000,
  "PL-63: duration_ms посчитан от фактического времени старта",
);

// Порог — timeoutSeconds конкретной задачи, а не только значение по умолчанию.
assert(
  getHistory("PL-63 Fresh", 1)[0]?.status === "running",
  "PL-63: свежая запись (< timeoutSeconds по умолчанию) осталась running",
);
assert(
  getHistory("PL-63 Short", 1)[0]?.status === "interrupted",
  "PL-63: timeoutSeconds=60 задачи применён вместо порога по умолчанию",
);
assert(
  getHistory("PL-63 Long", 1)[0]?.status === "running",
  "PL-63: timeoutSeconds=14400 задачи защитил трёхчасовой запуск",
);

// Durable-слой: шаг прерван, запуск закрыт, metadata несёт пометки partial/повтора.
const pl63DurableRun = getRun(pl63Durable.id);
assert(pl63DurableRun?.status === "failed", "PL-63: durable-run закрыт как failed");
assert(
  typeof pl63DurableRun?.error === "string" && pl63DurableRun.error.includes("явный повтор"),
  "PL-63: причина durable-run требует явный повтор",
);
const pl63Meta = pl63DurableRun?.metadata;
assert(
  pl63Meta &&
    pl63Meta.interrupted === true &&
    pl63Meta.partialWorktreeEdits === true &&
    pl63Meta.explicitRetryRequired === true,
  "PL-63: metadata помечает interrupted/partial/явный повтор",
);
const pl63Step = getStep(pl63Durable.id, "PL-63 Stale");
assert(
  pl63Step?.status === "failed" && pl63Step.error === "Прервано падением процесса",
  "PL-63: осиротевший шаг журнала помечен прерванным",
);
assert(
  getHistory("PL-63 Stale", 10).length === 1,
  "PL-63: повтор не запущен автоматически — нужна явная повторная задача",
);

// Идемпотентность: второй вызов не перезакрывает уже завершённые записи.
const pl63Second = recoverStaleRunningOnRecorderStart({ now: pl63Now });
assert(
  pl63Second.recovered === 0 && pl63Second.keptAlive >= 2,
  `PL-63: повторный вызов ничего не закрыл (${JSON.stringify(pl63Second.recovered)}/${pl63Second.keptAlive})`,
);

const pl63Log = fs.readFileSync(path.join(pluginDir, "logs", "runs.jsonl"), "utf8");
assert(
  pl63Log.includes('"event":"run.interrupted_partial"'),
  "PL-63: событие partial-правки записано в runs.jsonl",
);

// --- 6. PL-124: подметка running-записи с мёртвым владельцем -------------
// Запись свежая (порог таймаута не истёк), но владелец уже завершился:
// старая age-логика PL-63 оставила бы её running. Проверяем, что рекордер
// закрывает её сразу и не трогает living-владельца на том же хосте.
const pl124DeadPid = Number(dead.pid);
const pl124Insert = getDb().prepare(
  "INSERT INTO history (task_name, status, started_at, finished_at, owner_pid, owner_host, owner_started_at) VALUES (?, 'running', ?, NULL, ?, ?, ?)",
);
pl124Insert.run("PL-124 Dead Owner", pl63FreshIso, pl124DeadPid, os.hostname(), pl63FreshIso);
pl124Insert.run("PL-124 Live Owner", pl63FreshIso, process.pid, os.hostname(), pl63FreshIso);

const pl124Result = recoverStaleRunningOnRecorderStart({
  now: pl63Now,
  isAlive: (pid) => pid === process.pid,
  hostname: os.hostname(),
});
assert(
  pl124Result.deadOwner === 1 && pl124Result.recovered === 1,
  `PL-124: мёртвый владелец подметён сразу (${JSON.stringify(pl124Result)})`,
);
assert(
  pl124Result.interrupted.some((item) => item.cause === "deadOwner"),
  "PL-124: причина закрытия помечена как deadOwner",
);
const pl124DeadRecord = getHistory("PL-124 Dead Owner", 1)[0];
assert(
  pl124DeadRecord?.status === "interrupted" && pl124DeadRecord.finishedAt != null,
  "PL-124: запись мёртвого владельца закрыта как interrupted",
);
assert(
  typeof pl124DeadRecord?.error === "string" &&
    pl124DeadRecord.error.includes("PL-124") &&
    pl124DeadRecord.error.includes("владелец завершён"),
  `PL-124: причина указывает на завершившегося владельца (${pl124DeadRecord?.error})`,
);
assert(
  getHistory("PL-124 Live Owner", 1)[0]?.status === "running",
  "PL-124: живой владелец с тем же хостом остался running (PL-63 не сломан)",
);
const pl124Log = fs.readFileSync(path.join(pluginDir, "logs", "runs.jsonl"), "utf8");
assert(
  pl124Log.includes('"event":"run.interrupted_dead_owner"'),
  "PL-124: событие подметки записано в runs.jsonl",
);

closeDb();
console.log("\nCrash Recovery test completed.");
