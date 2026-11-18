// Спринт 36.1.b: запись состояния шага на каждом переходе.
//
// Проверяем:
//  - старт шага коммитится до выполнения тела (виден из второго соединения);
//  - после kill -9 посреди шага на диске остаётся running с номером попытки;
//  - recoverInterruptedSteps помечает зависший шаг failed, сохраняя attempt;
//  - повторный переход (retry) не теряет attempt после переоткрытия БД;
//  - успех/ошибка шага фиксируются после выполнения;
//  - synchronous = NORMAL в WAL (коммит переживает падение процесса).
//
// Запуск: node test-run-journal.mjs (после npm run build).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sched-run-journal-"));
const dbPath = path.join(tempRoot, "scheduler.db");
process.env.APPDATA = tempRoot;
process.env.OPENCODE_SCHEDULER_DB = dbPath;

const assert = (cond, msg) => {
  if (!cond) {
    console.error("FAIL: " + msg);
    process.exitCode = 1;
  } else {
    console.log("OK: " + msg);
  }
};

const assertThrows = (fn, msg) => {
  try {
    fn();
  } catch {
    assert(true, msg);
    return;
  }
  assert(false, msg);
};

const { initDb, closeDb, getDb } = await import("./dist/db/index.js");
const repo = await import("./dist/db/runs-repo.js");
const journal = await import("./dist/db/run-journal.js");

const dbModuleUrl = pathToFileURL(path.join(process.cwd(), "dist", "db", "index.js")).href;
const journalModuleUrl = pathToFileURL(
  path.join(process.cwd(), "dist", "db", "run-journal.js"),
).href;

initDb(dbPath);

// --- Конфигурация хранилища -------------------------------------------------
const synchronous = getDb().prepare("PRAGMA synchronous;").get();
assert(Number(synchronous?.synchronous) === 1, "synchronous = NORMAL (1) для durable-коммитов");
const journalMode = getDb().prepare("PRAGMA journal_mode;").get();
assert(String(journalMode?.journal_mode).toLowerCase() === "wal", "journal_mode = wal");

// --- 1. Старт шага пишется до тела и переживает переоткрытие -----------------
const runA = repo.createRun({ taskName: "durable", steps: [{ stepName: "prepare" }] });

const started = journal.beginStepAttempt(runA.id, "prepare");
assert(started.status === "running", "beginStepAttempt: шаг перешёл в running");
assert(started.attempt === 1, "beginStepAttempt: attempt = 1");
assert(Boolean(started.startedAt), "beginStepAttempt: started_at заполнен");
assert(repo.getRun(runA.id)?.status === "running", "beginStepAttempt: запуск перешёл в running");

closeDb();
initDb(dbPath);
const afterRestart = repo.getStep(runA.id, "prepare");
assert(
  afterRestart?.status === "running" && afterRestart?.attempt === 1,
  "старт шага на диске: running, attempt = 1 после закрытия/открытия БД",
);

// B12: живой lease защищает шаг от recovery, пока процесс работает.
const expiredNow = () => new Date(Date.now() + journal.STEP_LEASE_MS + 1000);
assert(
  Boolean(afterRestart?.leaseUntil) && Date.parse(afterRestart.leaseUntil) > Date.now(),
  "B12: beginStepAttempt записал lease_until в будущем",
);
assert(
  afterRestart?.ownerId?.includes(String(process.pid)),
  "B12: owner_id содержит PID текущего процесса",
);
assert(
  journal.recoverInterruptedSteps(runA.id).length === 0 &&
    repo.getStep(runA.id, "prepare")?.status === "running",
  "B12: recovery не трогает шаг с живым lease",
);

// --- 2. Восстановление зависшего шага и повтор без потери attempt ------------
const recovered = journal.recoverInterruptedSteps(runA.id, { now: expiredNow() });
assert(recovered.length === 1, "recoverInterruptedSteps вернул один шаг");
assert(recovered[0].status === "failed", "зависший шаг помечен failed");
assert(recovered[0].attempt === 1, "recoverInterruptedSteps сохранил attempt = 1");
assert(
  recovered[0].error === journal.STEP_INTERRUPTED_ERROR,
  "причина восстановления записана в error",
);
assert(Boolean(recovered[0].finishedAt), "у восстановленного шага есть finished_at");
assert(journal.listRunningSteps().length === 0, "running-шагов не осталось");

const second = journal.beginStepAttempt(runA.id, "prepare");
assert(
  second.status === "running" && second.attempt === 2,
  "повтор после восстановления: running, attempt = 2",
);

closeDb();
initDb(dbPath);
assert(
  repo.getStep(runA.id, "prepare")?.attempt === 2,
  "attempt = 2 пережил переоткрытие БД (не потерян)",
);

journal.recoverInterruptedSteps(runA.id, { now: expiredNow() });
const third = journal.beginStepAttempt(runA.id, "prepare");
assert(
  third.status === "running" && third.attempt === 3,
  "второе падение: повторный переход даёт attempt = 3, а не 1",
);

journal.recordStepSuccess(runA.id, "prepare", { ok: true });
assert(
  repo.getStep(runA.id, "prepare")?.status === "passed",
  "recordStepSuccess: шаг завершён со статусом passed",
);

// --- 3. Тело шага видит running из второго соединения -----------------------
const DatabaseSync = createRequire(import.meta.url)("node:sqlite").DatabaseSync;
const runB = repo.createRun({ taskName: "journal", steps: [{ stepName: "build" }] });

const execution = journal.runStepStatefully(runB.id, "build", () => {
  const peek = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const row = peek
      .prepare("SELECT status, attempt FROM run_steps WHERE run_id = ? AND step_name = ?")
      .get(runB.id, "build");
    assert(
      String(row?.status) === "running" && Number(row?.attempt) === 1,
      "во время тела шага в БД уже лежит running, attempt = 1",
    );
  } finally {
    peek.close();
  }
  return { artifacts: 3 };
});

assert(execution.attempt === 1, "runStepStatefully вернул attempt = 1");
assert(execution.step.status === "passed", "runStepStatefully: шаг passed");
assert(Boolean(execution.step.finishedAt), "runStepStatefully: finished_at заполнен");
assert(
  JSON.stringify(execution.step.output) === JSON.stringify({ artifacts: 3 }),
  "runStepStatefully: output сохранён",
);

// --- 4. Ошибка тела фиксируется как failed и не глотается -------------------
const runC = repo.createRun({ taskName: "failure", steps: [{ stepName: "test" }] });

assertThrows(
  () =>
    journal.runStepStatefully(runC.id, "test", () => {
      throw new Error("boom");
    }),
  "runStepStatefully пробрасывает ошибку тела",
);
const failedStep = repo.getStep(runC.id, "test");
assert(failedStep?.status === "failed", "упавший шаг записан как failed");
assert(failedStep?.error === "boom", "текст ошибки сохранён");
assert(failedStep?.attempt === 1, "attempt упавшей попытки = 1");

const retried = journal.beginStepAttempt(runC.id, "test");
assert(
  retried.status === "running" && retried.attempt === 2,
  "повтор упавшего шага: running, attempt = 2",
);
journal.recordStepSuccess(runC.id, "test");
assert(
  repo.getStep(runC.id, "test")?.status === "passed" &&
    repo.getStep(runC.id, "test")?.attempt === 2,
  "успешный повтор сохранил attempt = 2",
);

// --- 5. Асинхронное тело шага ----------------------------------------------
const runD = repo.createRun({ taskName: "async", steps: [{ stepName: "deploy" }] });
const asyncExecution = await journal.runStepStatefullyAsync(runD.id, "deploy", async () => {
  await new Promise((resolve) => setTimeout(resolve, 10));
  return "deployed";
});
assert(asyncExecution.step.status === "passed", "async-шаг завершён passed");
assert(asyncExecution.result === "deployed", "async-шаг вернул результат тела");

// --- 5b. B12: heartbeat продлевает lease долгого async-шага -----------------
const runLease = repo.createRun({ taskName: "lease", steps: [{ stepName: "long" }] });
let observedLease = null;
const leaseExecution = await journal.runStepStatefullyAsync(
  runLease.id,
  "long",
  async () => {
    await new Promise((resolve) => setTimeout(resolve, 360));
    observedLease = repo.getStep(runLease.id, "long")?.leaseUntil ?? null;
    return "long-done";
  },
  { leaseMs: 120 },
);
assert(leaseExecution.step.status === "passed", "B12: долгий async-шаг завершён passed");
assert(
  Boolean(observedLease) && Date.parse(observedLease) > Date.now(),
  "B12: heartbeat продлил lease во время выполнения шага",
);

// --- 5c. B12: явное продление lease для синхронных шагов -------------------
const runRenew = repo.createRun({ taskName: "renew", steps: [{ stepName: "sync" }] });
const renewStart = journal.beginStepAttempt(runRenew.id, "sync", { leaseMs: 50 });
const renewed = journal.renewStepLease(runRenew.id, "sync", 5_000);
const afterRenew = repo.getStep(runRenew.id, "sync");
assert(renewed, "B12: renewStepLease вернул true для running-шага");
assert(
  Date.parse(afterRenew?.leaseUntil ?? "") > Date.parse(renewStart.leaseUntil ?? ""),
  "B12: renewStepLease сдвинул lease_until вперёд",
);
journal.recordStepSuccess(runRenew.id, "sync");
assert(
  journal.renewStepLease(runRenew.id, "sync") === false,
  "B12: renewStepLease не продлевает завершённый шаг",
);

// --- 6. Kill -9 посреди шага ------------------------------------------------
const runE = repo.createRun({ taskName: "crash", steps: [{ stepName: "crashy" }] });

const childFile = path.join(tempRoot, "crasher.mjs");
fs.writeFileSync(
  childFile,
  [
    `import { initDb } from ${JSON.stringify(dbModuleUrl)};`,
    `import { beginStepAttempt } from ${JSON.stringify(journalModuleUrl)};`,
    "const runId = process.argv[2];",
    "initDb(process.env.OPENCODE_SCHEDULER_DB);",
    'const step = beginStepAttempt(runId, "crashy");',
    "console.log(JSON.stringify({ status: step.status, attempt: step.attempt }));",
    'process.kill(process.pid, "SIGKILL");',
    "",
  ].join("\n"),
  "utf8",
);

// Закрываем соединение, чтобы дочерний процесс не ждал блокировку.
closeDb();
const child = spawnSync(process.execPath, [childFile, runE.id], {
  env: { ...process.env, OPENCODE_SCHEDULER_DB: dbPath },
  encoding: "utf8",
  timeout: 30000,
});
const childOutput = (child.stdout || "").trim().split(/\r?\n/).filter(Boolean).pop() || "";
assert(
  child.signal === "SIGKILL" || child.status !== 0,
  "дочерний процесс убит посреди шага",
);
assert(
  childOutput.includes('"status":"running"') && childOutput.includes('"attempt":1'),
  "перед убийством процесс успел закоммитить running, attempt = 1",
);

initDb(dbPath);
const crashed = repo.getStep(runE.id, "crashy");
assert(crashed?.status === "running", "после kill -9 на диске остался running");
assert(crashed?.attempt === 1, "после kill -9 attempt = 1 сохранён");
assert(Boolean(crashed?.startedAt), "после kill -9 started_at сохранён");
assert(journal.listRunningSteps(runE.id).length === 1, "listRunningSteps видит зависший шаг");

// B12: сразу после kill -9 lease ещё не истёк — шаг не финализируется вслепую.
assert(
  journal.recoverInterruptedSteps(runE.id).length === 0,
  "B12: recovery не убивает шаг до истечения lease",
);

const crashRecovered = journal.recoverInterruptedSteps(runE.id, { now: expiredNow() });
assert(
  crashRecovered[0]?.status === "failed" && crashRecovered[0]?.attempt === 1,
  "после kill -9 восстановление: failed, attempt = 1",
);

const afterCrashRetry = journal.beginStepAttempt(runE.id, "crashy");
assert(
  afterCrashRetry.status === "running" && afterCrashRetry.attempt === 2,
  "повторный переход после kill -9: attempt = 2 (не потерян)",
);
assert(
  repo.getRun(runE.id)?.status === "running",
  "запуск после падения остаётся running (для resume в 36.2)",
);

closeDb();
fs.rmSync(tempRoot, { recursive: true, force: true });

console.log(
  process.exitCode ? "\nЕсть ошибки журнала." : "\nВсе проверки журнала шагов пройдены.",
);
